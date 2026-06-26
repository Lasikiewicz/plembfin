import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatNumber, formatDate, csvRows, normalizeHeader, platformName } from "./utils.js";
import { categorizeIssues } from "./sync.js";

// Callbacks injected by app.js at startup to avoid circular imports.
let _setMessage = () => {};
let _openConfirmDialog = async () => false;
let _showConfirmModal = () => {};
let _loadSavedConfig = async () => {};
let _loadHistory = async () => {};
let _loadActiveSessions = async () => {};
let _loadStats = async () => {};
let _clearDerivedUiCaches = () => {};
let _loadSyncJobs = async () => {};
let _loadSyncHistory = async () => {};

export function initTools(callbacks) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadSavedConfig) _loadSavedConfig = callbacks.loadSavedConfig;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.loadActiveSessions) _loadActiveSessions = callbacks.loadActiveSessions;
  if (callbacks.loadStats) _loadStats = callbacks.loadStats;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.loadSyncJobs) _loadSyncJobs = callbacks.loadSyncJobs;
  if (callbacks.loadSyncHistory) _loadSyncHistory = callbacks.loadSyncHistory;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

// ── Constants ──────────────────────────────────────────────────────────────

const IMPORT_BATCH_SIZE = 100;
const IMPORT_MAX_ATTEMPTS = 4;
const IMPORT_RETRY_BASE_MS = 1500;
const BACKUP_BATCH_SIZE = 250;
const BACKUP_MAX_REQUEST_BYTES = 512 * 1024;
const BACKUP_FORMAT = "plembfin-backup";
const BACKUP_VERSION = 1;
const BACKUP_COLLECTIONS = ["watchHistory", "playstate", "playbackProgress", "activeSessions", "liveTrackingCache", "syncHistory", "settings", "runtimeState", "loopKeys", "posterCache", "tmdbMetadataCache", "tmdbSearchCache", "tmdbSeasonCache", "tmdbPersonCache"];

// ── Backup transfer state ──────────────────────────────────────────────────

export function setBackupTransferState(label, tone = "muted", log = "") {
  if (elements.backupTransferStatus) {
    elements.backupTransferStatus.textContent = label;
    elements.backupTransferStatus.className = `status-pill status-${tone}`;
  }
  if (log && elements.backupTransferLog) {
    elements.backupTransferLog.textContent = log;
    elements.backupTransferLog.scrollTop = elements.backupTransferLog.scrollHeight;
  }
}

// ── Backup export ──────────────────────────────────────────────────────────

function downloadJsonFile(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function validatePlembfinBackup(value) {
  if (!value || value.format !== BACKUP_FORMAT || Number(value.version) !== BACKUP_VERSION) {
    throw new Error("This is not a supported Plembfin backup file.");
  }
  if (!value.collections || Array.isArray(value.collections) || typeof value.collections !== "object") {
    throw new Error("The backup does not contain a collections object.");
  }
  const included = BACKUP_COLLECTIONS.filter((name) => Object.hasOwn(value.collections, name));
  if (!included.length) throw new Error("The backup contains no supported collections.");
  for (const name of included) {
    const documents = value.collections[name];
    if (!Array.isArray(documents)) throw new Error(`${name} is not a valid document array.`);
    for (const document of documents) {
      if (!document || typeof document.id !== "string" || !document.id || typeof document.data !== "object" || document.data == null) {
        throw new Error(`${name} contains an invalid document.`);
      }
    }
  }
  return { backup: value, included };
}

function backupImportPayload(collection, documents, reset) {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    collection,
    documents,
    reset,
  });
}

function backupPayloadBytes(collection, documents) {
  return new TextEncoder().encode(backupImportPayload(collection, documents, false)).byteLength;
}

function createBackupImportBatches(collection, documents) {
  if (!documents.length) return [[]];
  const batches = [];
  let current = [];

  for (const document of documents) {
    const candidate = [...current, document];
    if (current.length && (candidate.length > BACKUP_BATCH_SIZE || backupPayloadBytes(collection, candidate) > BACKUP_MAX_REQUEST_BYTES)) {
      batches.push(current);
      current = [document];
    } else {
      current = candidate;
    }
  }

  if (current.length) batches.push(current);
  return batches;
}

async function sendBackupImportBatch(collection, documents, reset, onImported) {
  const response = await fetch("/api/backup/import", {
    method: "POST",
    headers: authHeaders(),
    body: backupImportPayload(collection, documents, reset),
  });

  if (response.status === 413 && documents.length > 1) {
    const midpoint = Math.ceil(documents.length / 2);
    await sendBackupImportBatch(collection, documents.slice(0, midpoint), reset, onImported);
    await sendBackupImportBatch(collection, documents.slice(midpoint), false, onImported);
    return;
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 413) {
      throw new Error(`${collection} contains a single document that exceeds the server request limit.`);
    }
    throw new Error(result.error || `${collection} import failed with ${response.status}`);
  }
  onImported(documents.length);
}

export async function exportPlembfinBackup() {
  const button = elements.backupExportButton;
  if (!button) return;
  button.disabled = true;
  button.textContent = "Exporting...";
  setBackupTransferState("Exporting", "warning", "Starting authenticated backup export...");

  try {
    const manifestResponse = await fetch("/api/backup/export", { headers: authHeaders() });
    const manifest = await manifestResponse.json().catch(() => ({}));
    if (!manifestResponse.ok) throw new Error(manifest.error || `Backup manifest failed with ${manifestResponse.status}`);

    const collectionNames = Array.isArray(manifest.collections) ? manifest.collections : [];
    const backup = { ...manifest, source: { ...manifest.source, origin: window.location.origin }, collections: {} };
    let totalDocuments = 0;

    for (const collection of collectionNames) {
      const documents = [];
      let cursor = "";
      let hasMore = true;
      while (hasMore) {
        const params = new URLSearchParams({ collection, limit: String(BACKUP_BATCH_SIZE) });
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/backup/export?${params}`, { headers: authHeaders() });
        const page = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(page.error || `${collection} export failed with ${response.status}`);
        documents.push(...(page.documents || []));
        cursor = page.nextCursor || "";
        hasMore = Boolean(page.hasMore && cursor);
        setBackupTransferState("Exporting", "warning", `Exporting ${collection}: ${formatNumber(documents.length)} documents\nTotal collected: ${formatNumber(totalDocuments + documents.length)}`);
      }
      backup.collections[collection] = documents;
      totalDocuments += documents.length;
    }

    downloadJsonFile(backup, `plembfin-backup-${new Date().toISOString().slice(0, 10)}.json`);
    setBackupTransferState("Downloaded", "ready", `Backup complete: ${formatNumber(totalDocuments)} documents across ${formatNumber(collectionNames.length)} collections.\nKeep this file secure because it can contain saved credentials.`);
    _setMessage("Plembfin backup downloaded.", "success");
  } catch (error) {
    setBackupTransferState("Failed", "error", `Backup failed: ${error.message}`);
    _setMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Export Backup";
  }
}

export async function readPlembfinBackup(file) {
  const parsed = JSON.parse(await file.text());
  return validatePlembfinBackup(parsed);
}

export async function importPlembfinBackup() {
  if (!state.backupImport) return;
  const approved = await _openConfirmDialog({
    title: "Replace Plembfin data?",
    body: "This import replaces every collection included in the backup. Your local admin username and password will stay unchanged.",
    confirmLabel: "Import Backup",
    danger: true,
  });
  if (!approved) return;

  const button = elements.backupImportButton;
  const input = elements.backupImportFile;
  const { backup, included } = state.backupImport;
  button.disabled = true;
  input.disabled = true;
  button.textContent = "Importing...";
  setBackupTransferState("Importing", "warning", "Starting backup import...");

  let totalDocuments = 0;
  try {
    for (const collection of included) {
      const documents = backup.collections[collection];
      const batches = createBackupImportBatches(collection, documents);
      let collectionImported = 0;
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        await sendBackupImportBatch(collection, batches[batchIndex], batchIndex === 0, (count) => {
          collectionImported += count;
          totalDocuments += count;
          setBackupTransferState("Importing", "warning", `Imported ${collection}: ${formatNumber(collectionImported)} of ${formatNumber(documents.length)} documents\nTotal imported: ${formatNumber(totalDocuments)} documents`);
        });
      }
    }

    _clearDerivedUiCaches();
    state.configLoaded = false;
    state.syncJobsLoaded = false;
    state.syncHistoryLoaded = false;
    await Promise.all([
      _loadSavedConfig(),
      _loadHistory({ force: true }),
      _loadActiveSessions(),
      _loadStats({ force: true }),
    ]);
    setBackupTransferState("Complete", "ready", `Import complete: ${formatNumber(totalDocuments)} documents across ${formatNumber(included.length)} collections.`);
    _setMessage("Plembfin backup imported.", "success");
  } catch (error) {
    setBackupTransferState("Failed", "error", `Import failed: ${error.message}`);
    _setMessage(error.message, "error");
  } finally {
    input.disabled = false;
    button.disabled = !state.backupImport;
    button.textContent = "Import Backup";
  }
}

// ── Watch-history backups ──────────────────────────────────────────────────

function watchBackupDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function renderWatchBackups() {
  if (!elements.watchBackupList) return;
  const data = state.watchBackups;
  if (!data) {
    elements.watchBackupSummary && (elements.watchBackupSummary.textContent = state.watchBackupsLoading ? "Loading" : "Not loaded");
    elements.watchBackupSummary && (elements.watchBackupSummary.className = `status-pill status-${state.watchBackupsLoading ? "warning" : "muted"}`);
    elements.watchBackupList.innerHTML = `<div class="empty-log"><b>${state.watchBackupsLoading ? "Loading backups..." : "Backups not loaded"}</b></div>`;
    return;
  }

  const config = data.config || {};
  const runtime = data.runtime || {};
  const files = Array.isArray(data.files) ? data.files : [];
  const isRestoreTab = state.activeBackupsTab === "restore";

  if (!isRestoreTab) {
    elements.watchBackupEnabled && (elements.watchBackupEnabled.checked = Boolean(config.enabled));
    elements.watchBackupTime && (elements.watchBackupTime.value = config.time || "03:00");
    elements.watchBackupRetention && (elements.watchBackupRetention.value = String(config.retention || 14));
    elements.watchBackupSummary && (elements.watchBackupSummary.textContent = config.enabled ? "Scheduled" : "Disabled");
    elements.watchBackupSummary && (elements.watchBackupSummary.className = `status-pill status-${config.enabled ? "ready" : "muted"}`);
    const localPathEl = document.querySelector("#watchBackupLocalPath");
    if (localPathEl && data.backupsDir) localPathEl.textContent = data.backupsDir;
    if (elements.watchBackupRuntime) {
      elements.watchBackupRuntime.innerHTML = `
        <div><span>Last successful backup</span><b>${escapeHtml(watchBackupDate(runtime.lastSuccessAt))}</b></div>
        <div style="display: flex; gap: 1rem; align-items: center;">
          <div style="flex: 1;"><span>Last restore</span><b>${escapeHtml(watchBackupDate(runtime.lastRestoreAt))}</b></div>
          ${runtime.lastRestoreAt ? `<button class="button-ghost" type="button" data-clear-restore-status>Clear Status</button>` : ""}
        </div>
        <div><span>Storage</span><b>${formatNumber(files.length)} file${files.length === 1 ? "" : "s"}</b></div>
        ${runtime.lastError ? `<p class="backup-runtime-error">${escapeHtml(runtime.lastError)}</p>` : ""}
      `;
    }
    elements.watchBackupList.innerHTML = files.length ? files.map((file) => `
      <article class="watch-backup-row">
        <div class="watch-backup-copy">
          <b>${escapeHtml(file.name)}</b>
          <span>${escapeHtml(watchBackupDate(file.createdAt))} · ${escapeHtml(formatBytes(file.sizeBytes))}</span>
        </div>
        <div class="watch-backup-actions">
          <button class="button-ghost" type="button" data-watch-backup-download="${escapeAttribute(file.name)}">Download</button>
          <button class="button-ghost" type="button" data-watch-backup-dry-run="${escapeAttribute(file.name)}">Validate</button>
        </div>
      </article>
    `).join("") : `<div class="empty-log"><b>No local backups yet</b><span>Use Back Up Now or enable the daily schedule.</span></div>`;
    renderWatchBackupDestinations(data);
    return;
  }

  const localEntries = files.map((f) => ({ ...f, source: "local", destId: null, destLabel: "Local" }));
  const remoteEntries = (state.remoteBackupFiles || []);
  const allEntries = [...localEntries, ...remoteEntries].sort((a, b) => {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  const cronPausedUntil = runtime.cronSyncPausedUntil;
  const cronPausedBanner = cronPausedUntil && Date.now() < cronPausedUntil
    ? `<div class="backup-runtime" style="margin-bottom: var(--space-3); border-left: 3px solid var(--accent); padding: var(--space-2) var(--space-3); background: rgba(255,165,0,0.08);">
        <span style="font-size: 0.85rem;">⏸ Cron sync manually paused until ${escapeHtml(new Date(cronPausedUntil).toLocaleTimeString())}.</span>
       </div>`
    : "";

  let remoteLoading = "";
  if (state.remoteBackupFilesLoading) {
    const destNames = Array.isArray(state.watchBackups?.destinations)
      ? state.watchBackups.destinations.map((d) => d.label || d.type).filter(Boolean)
      : [];
    const destText = destNames.length ? ` (${destNames.map(escapeHtml).join(", ")})` : "";
    remoteLoading = `<div class="remote-search-banner"><span class="remote-search-spinner"></span><span>Searching remote destinations${destText} for backups…</span></div>`;
  }

  const clearMode = state.restoreClearMode || "reconcile";
  const clearModeSelector = `
    <div class="restore-clear-mode" style="margin-bottom: var(--space-3);">
      <div class="restore-clear-intro">Restoring makes this backup the source of truth — it is pushed to every connected app. Choose how to clear the apps first:</div>
      <label>
        <input type="radio" name="restoreClearMode" value="reconcile" ${clearMode === "reconcile" ? "checked" : ""} data-restore-clear-mode>
        <span><b>Reconcile tracked items</b> — push only the items this backup knows about. Fast. Apps keep any extra watched items the backup never tracked.</span>
      </label>
      <label>
        <input type="radio" name="restoreClearMode" value="wipe" ${clearMode === "wipe" ? "checked" : ""} data-restore-clear-mode>
        <span><b>Full wipe then push</b> — mark every currently-watched item on each app as unwatched, then re-apply only the backup's watched set. Apps end up matching the backup exactly. Slower.</span>
      </label>
    </div>`;

  elements.watchBackupList.innerHTML = cronPausedBanner + (allEntries.length ? clearModeSelector : "") + remoteLoading + (allEntries.length ? allEntries.map((entry) => `
    <article class="watch-backup-row">
      <div class="watch-backup-copy">
        <b>${escapeHtml(entry.name)}</b>
        <span>
          ${escapeHtml(watchBackupDate(entry.createdAt))} · ${escapeHtml(formatBytes(entry.sizeBytes))}
          <span class="status-pill status-muted" style="font-size: 0.7rem; padding: 1px 6px; margin-left: 4px;">${escapeHtml(entry.destLabel || "Local")}</span>
        </span>
      </div>
      <div class="watch-backup-actions">
        <button class="button-primary" type="button"
          data-watch-backup-restore="${escapeAttribute(entry.name)}"
          ${entry.destId ? `data-restore-dest-id="${escapeAttribute(entry.destId)}"` : ""}>
          Watch History Wipe / Restore
        </button>
      </div>
    </article>
  `).join("") : (state.remoteBackupFilesLoading ? "" : `<div class="empty-log"><b>No backups found</b><span>Backups will appear here once created or after remote destinations are configured.</span></div>`));
}

export async function loadRemoteBackupsForRestoreTab() {
  const data = state.watchBackups;
  if (!data) return;
  const destinations = Array.isArray(data.destinations) ? data.destinations : [];
  if (!destinations.length) return;

  state.remoteBackupFilesLoading = true;
  state.remoteBackupFiles = [];
  renderWatchBackups();

  const results = await Promise.allSettled(
    destinations.map(async (dest) => {
      try {
        const result = await postWatchBackupAction({ action: "list-remote-backups", destinationId: dest.id });
        const files = Array.isArray(result.files) ? result.files : [];
        return files.map((f) => ({ ...f, source: "remote", destId: dest.id, destLabel: dest.label || dest.type || "Remote" }));
      } catch {
        return [];
      }
    })
  );

  state.remoteBackupFiles = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  state.remoteBackupFilesLoading = false;
  renderWatchBackups();
}

const DESTINATION_FORMS = {
  backblaze: {
    label: "Backblaze B2",
    settings: [
      { key: "region", label: "Region or endpoint (e.g. eu-central-003 — pasting the full endpoint is fine too)", placeholder: "eu-central-003" },
      { key: "bucket", label: "Bucket name", placeholder: "yourname-plembfin" },
      { key: "accessKeyId", label: "keyID", placeholder: "0035…" },
      { key: "prefix", label: "Key prefix (optional)", placeholder: "plembfin/" },
    ],
    secrets: [{ key: "secretAccessKey", label: "applicationKey" }],
    oauth: null,
  },
};

function destinationStatusPill(destination, status) {
  const connected = !destination.secretFlags || destination.secretFlags.refreshToken;
  const needsOauth = DESTINATION_FORMS[destination.type]?.oauth;
  if (needsOauth && !destination.secretFlags?.refreshToken) {
    return `<span class="status-pill status-warning">Not connected</span>`;
  }
  if (status?.status === "success") {
    return `<span class="status-pill status-ready">Synced ${escapeHtml(watchBackupDate(status.lastSuccessAt))}</span>`;
  }
  if (status?.status === "error") {
    return `<span class="status-pill status-danger">Last run failed</span>`;
  }
  return `<span class="status-pill status-muted">${connected ? "Not run yet" : "Not connected"}</span>`;
}

function renderDestinationField(destination, field) {
  const value = destination.settings?.[field.key];
  const span = field.full ? ' style="grid-column: 1 / -1;"' : "";
  if (field.type === "checkbox") {
    const checked = value === undefined ? field.default : Boolean(value);
    return `<label class="checkbox-label"${span}><input type="checkbox" data-dest-setting="${field.key}" ${checked ? "checked" : ""} /><span>${escapeHtml(field.label)}</span></label>`;
  }
  return `<label class="field-label"${span}>${escapeHtml(field.label)}
    <input class="field" data-dest-setting="${field.key}" value="${escapeAttribute(value || "")}" placeholder="${escapeAttribute(field.placeholder || "")}" />
  </label>`;
}

function renderDestinationSecret(destination, field) {
  const isSet = destination.secretFlags?.[field.key];
  return `<label class="field-label">${escapeHtml(field.label)}
    <input class="field" type="password" autocomplete="new-password" data-dest-secret="${field.key}" placeholder="${isSet ? "•••••••• (saved — leave blank to keep)" : ""}" />
  </label>`;
}

function renderWatchBackupDestinations(data) {
  const host = elements.watchBackupDestinations;
  if (!host) return;
  if (!data) {
    host.innerHTML = `<div class="empty-log"><b>Destinations not loaded</b></div>`;
    return;
  }
  const destinations = Array.isArray(data.destinations) ? data.destinations : [];
  const statusMap = data.runtime?.destinations || {};
  if (!destinations.length) {
    host.innerHTML = `<div class="empty-log"><b>No remote destinations</b><span>Pick a type above and choose Add destination to mirror backups off-box.</span></div>`;
    return;
  }
  host.innerHTML = destinations.map((destination) => {
    const form = DESTINATION_FORMS[destination.type] || { label: destination.type, settings: [], secrets: [], oauth: null };
    const fields = form.settings.map((field) => renderDestinationField(destination, field)).join("");
    const secrets = form.secrets.map((field) => renderDestinationSecret(destination, field)).join("");
    const connected = destination.secretFlags?.refreshToken;
    const status = statusMap[destination.id];
    return `
      <article class="watch-backup-destination" data-dest-id="${escapeAttribute(destination.id)}" data-dest-type="${escapeAttribute(destination.type)}">
        <div class="destination-head">
          <span class="destination-badge">${escapeHtml(form.label)}</span>
          <input class="field destination-label" data-dest-meta="label" value="${escapeAttribute(destination.label || form.label)}" />
          <label class="checkbox-label"><input type="checkbox" data-dest-meta="enabled" ${destination.enabled ? "checked" : ""} /><span>Enabled</span></label>
          ${destinationStatusPill(destination, status)}
        </div>
        <div class="destination-fields">
          ${fields}
          ${secrets}
        </div>
        ${form.help || ""}
        <div class="destination-feedback" data-dest-feedback>${status?.status === "error" && status.lastError ? escapeHtml(status.lastError) : ""}</div>
        <div class="destination-actions">
          <button class="button-primary" type="button" data-dest-action="save">Save</button>
          <button class="button-ghost" type="button" data-dest-action="test">Test</button>
          ${form.oauth ? `<button class="button-ghost" type="button" data-dest-action="connect">${connected ? "Reconnect" : "Connect"}</button>` : ""}
          <button class="button-ghost" type="button" data-dest-action="restore-list">Restore from here</button>
          <button class="button-danger" type="button" data-dest-action="remove">Remove</button>
        </div>
        <div class="destination-restore" data-dest-restore hidden></div>
      </article>
    `;
  }).join("");
}

function collectDestination(card) {
  const settings = {};
  card.querySelectorAll("[data-dest-setting]").forEach((input) => {
    settings[input.dataset.destSetting] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
  const secrets = {};
  card.querySelectorAll("[data-dest-secret]").forEach((input) => {
    if (input.value) secrets[input.dataset.destSecret] = input.value;
  });
  return {
    id: card.dataset.destId,
    type: card.dataset.destType,
    label: card.querySelector('[data-dest-meta="label"]')?.value?.trim() || card.dataset.destType,
    enabled: Boolean(card.querySelector('[data-dest-meta="enabled"]')?.checked),
    settings,
    secrets,
  };
}

export async function addBackupDestination() {
  const type = elements.watchBackupDestinationType?.value || "backblaze";
  const label = DESTINATION_FORMS[type]?.label || type;
  await postWatchBackupAction({ action: "save-destination", destination: { type, label, enabled: false, settings: {}, secrets: {} } });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  _setMessage(`Added ${label} destination — fill in the details and Save.`, "success");
}

export async function saveBackupDestinationCard(card) {
  await postWatchBackupAction({ action: "save-destination", destination: collectDestination(card) });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  _setMessage("Destination saved.", "success");
}

export async function testBackupDestinationCard(card) {
  const destination = collectDestination(card);
  await postWatchBackupAction({ action: "save-destination", destination });
  const result = await postWatchBackupAction({ action: "test-destination", destinationId: destination.id });
  _setMessage(`Connection OK — ${result.result?.detail || "reachable"}.`, "success");
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
}

export async function removeBackupDestinationCard(card) {
  const approved = await _openConfirmDialog({
    title: "Remove destination?",
    body: "Stop mirroring backups here? Files already uploaded to the remote are left untouched.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!approved) return;
  await postWatchBackupAction({ action: "remove-destination", destinationId: card.dataset.destId });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  _setMessage("Destination removed.", "success");
}

export async function listRemoteBackupsForCard(card) {
  const panel = card.querySelector("[data-dest-restore]");
  if (!panel) return;
  if (!panel.hidden) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  await postWatchBackupAction({ action: "save-destination", destination: collectDestination(card) });
  panel.hidden = false;
  panel.innerHTML = `<div class="empty-log"><b>Loading backups…</b></div>`;
  const result = await postWatchBackupAction({ action: "list-remote-backups", destinationId: card.dataset.destId });
  const files = Array.isArray(result.files) ? result.files : [];
  if (!files.length) {
    panel.innerHTML = `<div class="empty-log"><b>No backups found on this destination</b><span>Run "Back Up Now" first, or recheck the credentials.</span></div>`;
    return;
  }
  panel.innerHTML = `
    <div class="destination-restore-head">Backups on this destination — newest first</div>
    ${files.map((file) => `
      <div class="watch-backup-row">
        <div class="watch-backup-copy">
          <b>${escapeHtml(file.name)}</b>
          <span>${escapeHtml(watchBackupDate(file.createdAt))} · ${escapeHtml(formatBytes(file.sizeBytes))}</span>
        </div>
        <div class="watch-backup-actions">
          <button class="button-danger" type="button" data-dest-restore-file="${escapeAttribute(file.name)}">Wipe / Restore</button>
        </div>
      </div>
    `).join("")}
  `;
}

export async function restoreRemoteBackupFromCard(card, filename, clearMode = "reconcile") {
  const wipe = clearMode === "wipe";
  const approved = await _openConfirmDialog({
    title: "⚠️ Watch History Wipe / Restore",
    body: `⚠️ AUTHORITATIVE RESTORE — this backup becomes the source of truth.\n\nWill DELETE all current watch history, playstate and resume progress, restore from:\n\n${filename}\n\nand push that state to every connected app.\n\n${wipe
      ? "Clear mode: FULL WIPE — every currently-watched item on each app is first marked unwatched."
      : "Clear mode: RECONCILE — only items tracked by the backup are pushed."}\n\nThis cannot be undone.`,
    confirmLabel: wipe ? "Wipe Apps and Restore" : "Restore and Push",
    danger: true,
  });
  if (!approved) return;
  await runAuthoritativeRestore({ action: "restore-remote-backup", destinationId: card.dataset.destId, filename, clearMode });
}

export async function connectBackupDestinationCard(card) {
  const destination = collectDestination(card);
  await postWatchBackupAction({ action: "save-destination", destination });
}

// ── Cache stats ────────────────────────────────────────────────────────────

function fmtCacheBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export async function loadCacheStats({ force = false } = {}) {
  if (!state.token || state.cacheStatsLoading || (state.cacheStats && !force)) return state.cacheStats;
  state.cacheStatsLoading = true;
  renderCachePanel();
  try {
    const response = await fetch("/api/cache-stats", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Cache stats failed with ${response.status}`);
    state.cacheStats = body;
    return body;
  } finally {
    state.cacheStatsLoading = false;
    renderCachePanel();
  }
}

async function clearCacheType(type) {
  try {
    const response = await fetch("/api/clear-cache", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Cache clear failed with ${response.status}`);
    const label = type === "all" ? "all images" : type;
    _setMessage(`Cleared ${body.deleted} file${body.deleted !== 1 ? "s" : ""} (${fmtCacheBytes(body.freed)} freed) from ${label}.`, "success");
    state.cacheStats = null;
    loadCacheStats().catch((error) => _setMessage(error.message, "error"));
  } catch (error) {
    _setMessage(error.message, "error");
  }
}

export function renderCachePanel() {
  const panel = document.getElementById("cacheStatsPanel");
  if (!panel) return;

  if (state.cacheStatsLoading && !state.cacheStats) {
    panel.innerHTML = `<p class="muted-text" style="padding:var(--space-3) 0;">Loading...</p>`;
    return;
  }

  if (!state.cacheStats) {
    panel.innerHTML = `<p class="muted-text" style="padding:var(--space-3) 0;">No data loaded.</p>`;
    return;
  }

  const { disk } = state.cacheStats;
  const rows = [
    { key: "posters", label: "Posters" },
    { key: "backdrops", label: "Backdrops" },
    { key: "profiles", label: "Profiles" },
  ];
  const totalCount = rows.reduce((sum, r) => sum + (disk[r.key]?.count || 0), 0);
  const totalSize = rows.reduce((sum, r) => sum + (disk[r.key]?.size || 0), 0);

  panel.innerHTML = `
    <table style="width:100%;border-collapse:collapse;margin-top:var(--space-3);">
      <thead>
        <tr>
          <th style="text-align:left;padding:var(--space-2) 0;font-size:0.78rem;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);">Type</th>
          <th style="text-align:right;padding:var(--space-2) 0;font-size:0.78rem;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);">Files</th>
          <th style="text-align:right;padding:var(--space-2) 0;font-size:0.78rem;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);">Size</th>
          <th style="border-bottom:1px solid var(--border);"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({ key, label }) => `
          <tr>
            <td style="padding:var(--space-3) 0;border-bottom:1px solid var(--border);"><b>${label}</b></td>
            <td style="text-align:right;padding:var(--space-3) 0;border-bottom:1px solid var(--border);">${(disk[key]?.count || 0).toLocaleString()}</td>
            <td style="text-align:right;padding:var(--space-3) 0;border-bottom:1px solid var(--border);">${fmtCacheBytes(disk[key]?.size || 0)}</td>
            <td style="text-align:right;padding:var(--space-3) 0;border-bottom:1px solid var(--border);">
              <button class="button-ghost" type="button" style="font-size:0.8rem;padding:0.2em 0.7em;" data-clear-cache="${key}">Clear</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td style="padding:var(--space-3) 0;font-weight:600;">Total</td>
          <td style="text-align:right;padding:var(--space-3) 0;font-weight:600;">${totalCount.toLocaleString()}</td>
          <td style="text-align:right;padding:var(--space-3) 0;font-weight:600;">${fmtCacheBytes(totalSize)}</td>
          <td style="text-align:right;padding:var(--space-3) 0;">
            <button class="button-primary" type="button" style="font-size:0.8rem;padding:0.2em 0.7em;" data-clear-cache="all">Clear All</button>
          </td>
        </tr>
      </tfoot>
    </table>
  `;

  for (const btn of panel.querySelectorAll("[data-clear-cache]")) {
    btn.addEventListener("click", () => clearCacheType(btn.dataset.clearCache));
  }
}

export async function loadWatchBackups({ force = false } = {}) {
  if (!state.token || state.watchBackupsLoading || (state.watchBackups && !force)) return state.watchBackups;
  state.watchBackupsLoading = true;
  renderWatchBackups();
  try {
    const response = await fetch("/api/watch-backups", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Backup status failed with ${response.status}`);
    state.watchBackups = body;
    return body;
  } finally {
    state.watchBackupsLoading = false;
    renderWatchBackups();
  }
}

export async function postWatchBackupAction(payload) {
  const response = await fetch("/api/watch-backups", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Backup action failed with ${response.status}`);
  return body;
}

// ── Appearance settings ────────────────────────────────────────────────────

export const APPEARANCE_DEFAULTS = {
  showLogoArt: true,
  showCast: true,
  showTrailers: true,
  showReviews: true,
  showImages: true,
  showRelated: true,
};

export function applyAppearanceToBody(prefs) {
  document.body.classList.toggle("hide-logo-art", !prefs.showLogoArt);
  document.body.classList.toggle("hide-cast", !prefs.showCast);
  document.body.classList.toggle("hide-trailers", !prefs.showTrailers);
  document.body.classList.toggle("hide-reviews", !prefs.showReviews);
  document.body.classList.toggle("hide-images", !prefs.showImages);
  document.body.classList.toggle("hide-related", !prefs.showRelated);
}

function populateAppearanceForm(prefs) {
  if (elements.appearShowLogoArt) elements.appearShowLogoArt.checked = prefs.showLogoArt;
  if (elements.appearShowCast) elements.appearShowCast.checked = prefs.showCast;
  if (elements.appearShowTrailers) elements.appearShowTrailers.checked = prefs.showTrailers;
  if (elements.appearShowReviews) elements.appearShowReviews.checked = prefs.showReviews;
  if (elements.appearShowImages) elements.appearShowImages.checked = prefs.showImages;
  if (elements.appearShowRelated) elements.appearShowRelated.checked = prefs.showRelated;
}

export async function loadAppearanceSettings() {
  const response = await fetch("/api/appearance", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return;
  const prefs = { ...APPEARANCE_DEFAULTS, ...(body.appearance || {}) };
  applyAppearanceToBody(prefs);
  populateAppearanceForm(prefs);
}

export async function saveAppearanceSettings() {
  const prefs = {
    showLogoArt: elements.appearShowLogoArt?.checked ?? true,
    showCast: elements.appearShowCast?.checked ?? true,
    showTrailers: elements.appearShowTrailers?.checked ?? true,
    showReviews: elements.appearShowReviews?.checked ?? true,
    showImages: elements.appearShowImages?.checked ?? true,
    showRelated: elements.appearShowRelated?.checked ?? true,
  };
  applyAppearanceToBody(prefs);
  await fetch("/api/appearance", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(prefs),
  }).catch(() => null);
}

export async function saveWatchBackupSettings() {
  const config = {
    enabled: elements.watchBackupEnabled.checked,
    time: elements.watchBackupTime.value || "03:00",
    retention: Number(elements.watchBackupRetention.value) || 14,
  };
  await postWatchBackupAction({ action: "configure", config });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  _setMessage("Watch-history backup schedule saved.", "success");
}

export async function createWatchBackupNow() {
  const button = elements.createWatchBackupButton;
  button.disabled = true;
  button.textContent = "Backing up...";
  try {
    const result = await postWatchBackupAction({ action: "create" });
    state.watchBackups = null;
    await loadWatchBackups({ force: true });
    _setMessage(`Created ${result.backup?.name || "watch-history backup"}.`, "success");
  } finally {
    button.disabled = false;
    button.textContent = "Back Up Now";
  }
}

export async function downloadWatchBackup(filename) {
  const response = await fetch(`/api/watch-backups?download=${encodeURIComponent(filename)}`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Backup download failed with ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function uploadWatchBackupFile(file) {
  if (!file) return;
  const name = String(file.name || "");
  if (!name.toLowerCase().endsWith(".gz")) {
    throw new Error("Choose a Plembfin watch-history .json.gz backup file.");
  }

  if (elements.watchBackupUploadStatus) elements.watchBackupUploadStatus.textContent = `Uploading ${name}...`;
  const response = await fetch(`/api/watch-backups?upload=1&filename=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/gzip",
    },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Backup upload failed with ${response.status}`);

  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  if (elements.watchBackupUploadStatus) elements.watchBackupUploadStatus.textContent = `Ready: ${body.file?.name || name}`;
  _setMessage(`Backup file added: ${body.file?.name || name}.`, "success");
  return body.file;
}

export async function restoreWatchBackup(filename, clearMode = "reconcile", dryRun = false) {
  if (dryRun) {
    const result = await postWatchBackupAction({ action: "restore", filename, dryRun: true });
    const summary = result.restore || {};
    _setMessage(`Backup valid: ${summary.watchHistory || 0} history, ${summary.playstate || 0} playstate, ${summary.playbackProgress || 0} progress rows.`, "success");
    return;
  }

  const wipe = clearMode === "wipe";
  const approved = await _openConfirmDialog({
    title: "⚠️ Wipe and restore watch history?",
    body: `⚠️ AUTHORITATIVE RESTORE — this backup becomes the source of truth.\n\nWill DELETE all current watch history, playstate and resume progress, restore from ${filename}, and push that state to every connected app (Plex/Emby/Jellyfin).\n\n${wipe
      ? "Clear mode: FULL WIPE — every currently-watched item on each app is first marked unwatched, so the apps end up matching the backup exactly."
      : "Clear mode: RECONCILE — only items tracked by the backup are pushed; extra watched items on the apps are left as-is."}\n\nThis cannot be undone.`,
    confirmLabel: wipe ? "Wipe Apps and Restore" : "Restore and Push",
    danger: true,
  });
  if (!approved) return;

  await runAuthoritativeRestore({ action: "restore", filename, clearMode });
}

// Shared driver for both local and remote authoritative restores: kick off the background job,
// stream its log into the restore terminal, then refresh the UI.
async function runAuthoritativeRestore(payload) {
  const terminal = document.querySelector("#restoreProgressTerminal");
  if (terminal) {
    terminal.classList.remove("hidden");
    terminal.textContent = "[Starting] Preparing authoritative restore...\n";
  }

  try {
    const result = await postWatchBackupAction(payload);
    const summary = result.restore || {};
    if (terminal) {
      terminal.textContent += `[${new Date().toLocaleTimeString()}] Restored ${summary.watchHistory || 0} history, ${summary.playstate || 0} playstate, ${summary.playbackProgress || 0} progress records\n`;
      terminal.textContent += `[${new Date().toLocaleTimeString()}] Pushing to connected apps (clear mode: ${result.clearMode || payload.clearMode || "reconcile"})...\n`;
    }

    const jobResult = await pollRestoreProgress(terminal);

    _clearDerivedUiCaches();
    await Promise.all([_loadHistory({ force: true }), _loadStats({ force: true })]);
    state.watchBackups = null;
    await loadWatchBackups({ force: true });

    if (jobResult && jobResult.success === false) {
      _setMessage(`Restore finished with errors: ${jobResult.error || "see terminal"}.`, "error");
    } else {
      _setMessage(`Watch history restored from ${payload.filename} and pushed to connected apps.`, "success");
    }
  } catch (error) {
    if (terminal) terminal.textContent += `[ERROR] ${error.message}\n`;
    throw error;
  }
}

// Poll the watch-backups status endpoint, appending new restore-job log lines to the terminal
// until the job is actually finished (restoreSync.active === false). A large restore can run a
// long time, so we keep following it (high safety cap ~3h) instead of giving up early.
async function pollRestoreProgress(terminal) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MAX_TICKS = 5400; // ~3h at 2s
  let printed = 0;
  for (let i = 0; i < MAX_TICKS; i++) {
    let data;
    try {
      const response = await fetch("/api/watch-backups", { headers: authHeaders(), cache: "no-store" });
      data = await response.json().catch(() => ({}));
    } catch {
      await sleep(2000);
      continue;
    }
    const rs = data.restoreSync || {};
    const log = Array.isArray(rs.log) ? rs.log : [];
    if (terminal && log.length > printed) {
      for (let j = printed; j < log.length; j++) terminal.textContent += `${log[j]}\n`;
      terminal.scrollTop = terminal.scrollHeight;
      printed = log.length;
    }
    if (rs.active !== true) {
      if (terminal && rs.result && rs.result.success === false) {
        terminal.textContent += `[ERROR] ${rs.result.error || "Restore reconcile failed"}\n`;
      }
      return rs.result || null;
    }
    await sleep(2000);
  }
  if (terminal) terminal.textContent += "[Note] Still running — stopped following the log. Check the server logs for completion.\n";
  return null;
}

// ── Trakt / CSV import ─────────────────────────────────────────────────────

export async function parseSelectedFiles(files) {
  const selectedFiles = [...files];
  const parsedRecords = [];
  resetImportActivity();
  appendImportLog(`Selected ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}.`);

  for (const [index, file] of selectedFiles.entries()) {
    appendImportLog(`Reading ${file.name}...`);
    const text = await file.text();
    const extension = file.name.split(".").pop().toLowerCase();
    const records = extension === "json" ? parseJsonExport(text) : parseCsvExport(text);
    const mapped = records.map(mapImportRecord).filter(Boolean);
    parsedRecords.push(...mapped);
    appendImportLog(`Parsed ${formatNumber(mapped.length)} usable records from ${file.name}.`);
    setImportProgress(((index + 1) / selectedFiles.length) * 100);
  }

  state.importRecords = parsedRecords;
  state.importFileNames = selectedFiles.map((file) => file.name);
  appendImportLog(`Ready: ${formatNumber(parsedRecords.length)} total records queued.`);
  renderImportPreview();
}

function parseJsonExport(text) {
  const json = JSON.parse(text);
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.history)) return json.history;
  if (Array.isArray(json.watched)) return json.watched;
  return [json];
}

function parseCsvExport(text) {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => normalizeHeader(header));
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] || "";
    });
    return record;
  });
}

function mapImportRecord(record) {
  const source = record.source || "trakt_import";
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};
  const ids = record.ids || movie.ids || show.ids || episode.ids || {};
  const rawType = record.media_type || record.mediatype || record.type || record["type"] || "";
  const mediaType = inferMediaType(rawType, record);
  const title = importTitle(record, mediaType);
  const watchedAt =
    record.watched_at ||
    record.watched_at_utc ||
    record.watchedAt ||
    record.last_watched_at ||
    record.lastWatchedAt ||
    record.scrobbled_at ||
    record.collected_at ||
    record.date ||
    record.watched_date ||
    record.Date ||
    "";

  if (!title || !watchedAt) return undefined;

  return {
    title,
    media_type: mediaType,
    watched_at: watchedAt,
    source,
    imdb_id: record.imdb_id || record.imdb || record.imdbid || ids.imdb || "",
    tmdb_id: record.tmdb_id || record.tmdb || record.tmdbid || ids.tmdb || "",
    tvdb_id: record.tvdb_id || record.tvdb || record.tvdbid || ids.tvdb || "",
    season: record.season || episode.season || "",
    episode: record.episode_number || episode.number || (typeof record.episode === "object" ? "" : record.episode) || "",
  };
}

function importTitle(record, mediaType) {
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};

  if (mediaType === "episode") {
    const showTitle = record.show_title || show.title || record.show || "";
    const season = record.season || episode.season || "";
    const episodeNumber = record.episode_number || episode.number || (typeof record.episode === "object" ? "" : record.episode) || "";
    if (showTitle && (season || episodeNumber)) {
      return `${showTitle} - S${String(season || "?").padStart(2, "0")}E${String(episodeNumber || "?").padStart(2, "0")}`;
    }
  }

  return (
    record.title ||
    record.name ||
    record.movie_title ||
    record.show_title ||
    movie.title ||
    show.title ||
    episode.title ||
    record.show ||
    record.movie ||
    record.Title ||
    ""
  );
}

function inferMediaType(type, record) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("movie")) return "movie";
  if (normalized.includes("episode") || normalized.includes("show") || normalized.includes("tv")) return "episode";
  if (record.season || record.episode) return "episode";
  return "movie";
}

export function renderImportPreview() {
  elements.startImportButton.disabled = !state.importRecords.length || state.importActive;
  elements.clearImportButton.disabled = state.importActive;
  elements.importFile.disabled = state.importActive;
  if (!state.importActive) {
    elements.importProgress.textContent = state.importRecords.length
      ? `${formatNumber(state.importRecords.length)} parsed from ${formatNumber(state.importFileNames.length || 1)} file${state.importFileNames.length === 1 ? "" : "s"}`
      : "Idle";
  }
  renderImportActivity();

  if (!state.importRecords.length) {
    elements.importPreview.innerHTML = "";
    return;
  }

  elements.importPreview.innerHTML = `
    <div class="table-row table-head">
      <span>Preview title</span>
      <span>Type</span>
      <span>Watched</span>
    </div>
    ${state.importRecords
      .slice(0, 5)
      .map(
        (record) => `
          <article class="table-row">
            <b>${escapeHtml(record.title)}</b>
            <span>${escapeHtml(record.media_type)}</span>
            <time>${formatDate(record.watched_at)}</time>
          </article>
        `,
      )
      .join("")}
  `;
}

function resetImportActivity() {
  state.importLogs = [];
  setImportProgress(0);
}

function appendImportLog(message) {
  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  state.importLogs.push(`[${timestamp}] ${message}`);
  if (state.importLogs.length > 250) state.importLogs = state.importLogs.slice(-250);
  renderImportActivity();
}

function setImportProgress(value) {
  state.importProgressValue = Math.max(0, Math.min(100, Number(value || 0)));
  renderImportActivity();
}

export function renderImportActivity() {
  const progress = Math.round(state.importProgressValue || 0);
  if (elements.importProgressFill) {
    elements.importProgressFill.style.width = `${progress}%`;
    elements.importProgressFill.parentElement?.setAttribute("aria-valuenow", String(progress));
  }
  if (elements.importProgressPercent) {
    elements.importProgressPercent.textContent = `${progress}%`;
  }
  if (elements.importTerminal) {
    elements.importTerminal.textContent = state.importLogs.length ? state.importLogs.join("\n") : "[idle] Waiting for files.";
    elements.importTerminal.scrollTop = elements.importTerminal.scrollHeight;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatImportFailure(body, status) {
  return [body?.error, body?.details].filter(Boolean).join(": ") || `Import failed with ${status}`;
}

async function sendImportBatch(records, batchNumber, totalBatches) {
  for (let attempt = 1; attempt <= IMPORT_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch("/api/import", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ records }),
      });
    } catch (error) {
      if (attempt >= IMPORT_MAX_ATTEMPTS) {
        appendImportLog(`Batch ${batchNumber}/${totalBatches} failed after ${IMPORT_MAX_ATTEMPTS} attempts: ${error.message}.`);
        throw error;
      }

      const delay = IMPORT_RETRY_BASE_MS * attempt;
      appendImportLog(`Batch ${batchNumber}/${totalBatches} attempt ${attempt} failed: ${error.message}. Retrying in ${Math.round(delay / 1000)}s.`);
      await wait(delay);
      continue;
    }

    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;

    const failure = formatImportFailure(body, response.status);
    if (response.status < 500) {
      appendImportLog(`Batch ${batchNumber}/${totalBatches} failed: ${failure}.`);
      throw new Error(failure);
    }

    if (attempt >= IMPORT_MAX_ATTEMPTS) {
      appendImportLog(`Batch ${batchNumber}/${totalBatches} failed after ${IMPORT_MAX_ATTEMPTS} attempts: ${failure}.`);
      throw new Error(failure);
    }

    const delay = IMPORT_RETRY_BASE_MS * attempt;
    appendImportLog(`Batch ${batchNumber}/${totalBatches} attempt ${attempt} failed: ${failure}. Retrying in ${Math.round(delay / 1000)}s.`);
    await wait(delay);
  }

  throw new Error("Import batch failed");
}

export async function startImport() {
  if (!state.importRecords.length) return;

  state.importActive = true;
  elements.startImportButton.disabled = true;
  elements.clearImportButton.disabled = true;
  elements.importFile.disabled = true;
  setImportProgress(0);
  appendImportLog(`Starting import of ${formatNumber(state.importRecords.length)} records in chunks of ${IMPORT_BATCH_SIZE}.`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let rejected = 0;
  const totalBatches = Math.ceil(state.importRecords.length / IMPORT_BATCH_SIZE);

  try {
    for (let index = 0; index < state.importRecords.length; index += IMPORT_BATCH_SIZE) {
      const records = state.importRecords.slice(index, index + IMPORT_BATCH_SIZE);
      const batchNumber = Math.floor(index / IMPORT_BATCH_SIZE) + 1;
      const rangeEnd = Math.min(index + records.length, state.importRecords.length);
      elements.importProgress.textContent = `Importing ${index + 1}-${rangeEnd}`;
      appendImportLog(`Sending batch ${batchNumber}/${totalBatches}: records ${index + 1}-${rangeEnd}.`);

      const body = await sendImportBatch(records, batchNumber, totalBatches);
      const batchInserted = Number(body.inserted || 0);
      const batchUpdated = Number(body.updated || 0);
      const batchSkipped = Number(body.skipped || 0);
      const batchRejected = Array.isArray(body.rejected) ? body.rejected.length : 0;
      inserted += batchInserted;
      updated += batchUpdated;
      skipped += batchSkipped;
      rejected += batchRejected;
      appendImportLog(`Batch ${batchNumber}/${totalBatches} done: ${batchInserted} inserted, ${batchUpdated} updated, ${batchSkipped} skipped, ${batchRejected} rejected.`);
      setImportProgress((rangeEnd / state.importRecords.length) * 100);
    }

    elements.importProgress.textContent = `${formatNumber(inserted)} inserted / ${formatNumber(updated)} updated`;
    appendImportLog(`Import complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${rejected} rejected.`);
    _setMessage(`Import complete. Inserted ${inserted}, updated ${updated}, skipped ${skipped}, rejected ${rejected}.`, "success");
    _clearDerivedUiCaches();
    await _loadHistory();
  } catch (error) {
    appendImportLog(`Import failed: ${error.message}`);
    throw error;
  } finally {
    state.importActive = false;
    elements.startImportButton.disabled = !state.importRecords.length;
    elements.clearImportButton.disabled = false;
    elements.importFile.disabled = false;
    renderImportActivity();
  }
}

// ── Maintenance tools ──────────────────────────────────────────────────────

export async function runRepairWorkflow() {
  const button = elements.runRepairButton;
  const status = elements.repairStatus;
  if (!button || !status) return;

  button.disabled = true;
  button.textContent = "Repairing History...";
  status.textContent = "Starting history repair...";

  const maxIterations = 20;
  let totalConverted = 0;
  let totalBackfilled = 0;

  const appendLog = (text) => {
    const now = new Date().toISOString();
    if (elements.repairLog) {
      elements.repairLog.textContent = `${now} - ${text}\n` + elements.repairLog.textContent;
      elements.repairLog.scrollTop = 0;
    } else {
      status.textContent = text;
    }
  };

  for (let i = 1; i <= maxIterations; i++) {
    const passLabel = `Repair pass ${i}`;
    appendLog(`${passLabel} started`);
    try {
      const res = await fetch("/api/admin-fix-history", { method: "POST", headers: authHeaders() });
      let body;
      try { body = await res.json(); } catch (e) { body = { text: await res.text() }; }
      const converted = Number(body.converted || 0);
      const backfilled = Number(body.backfilled || 0);
      totalConverted += converted;
      totalBackfilled += backfilled;

      appendLog(`${passLabel} result: retyped=${Number(body.retyped || 0)}, converted=${converted}, backfilled=${backfilled}${body.note ? `, note=${body.note}` : ''}`);

      if (!converted && !backfilled) {
        appendLog(`${passLabel} made no changes; stopping.`);
        break;
      }

      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      appendLog(`ERROR: ${err?.message || String(err)}`);
      status.textContent = `Repair failed: ${err?.message || String(err)}`;
      button.disabled = false;
      throw err;
    }
  }

  status.textContent = `Done: retyped history, converted ${totalConverted}, backfilled ${totalBackfilled}.`;
  button.disabled = false;
  button.textContent = "Repair History Now";
  _clearDerivedUiCaches();
  await _loadHistory().catch(() => { });
  return { converted: totalConverted, backfilled: totalBackfilled };
}

export async function runDedupHistory() {
  const button = elements.dedupHistoryButton;
  const status = elements.dedupHistoryStatus;
  const logEl = elements.dedupHistoryLog;
  if (!button) return;

  button.disabled = true;
  button.textContent = "Running...";
  if (status) status.textContent = "Running deduplication...";
  if (logEl) logEl.textContent = "";

  try {
    const response = await fetch("/api/dedup-history", {
      method: "POST",
      headers: authHeaders(),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResult = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("RESULT: ")) {
          try { finalResult = JSON.parse(trimmed.substring(8)); } catch (_) { }
        } else {
          if (logEl) logEl.textContent += trimmed + "\n";
        }
      }
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }

    if (finalResult) {
      const msg = `Complete — deleted ${finalResult.deleted} duplicate(s) from ${finalResult.scanned} records.`;
      if (status) status.textContent = msg;
      if (logEl) logEl.textContent += msg + "\n";
    } else {
      if (status) status.textContent = "Complete.";
    }
  } catch (error) {
    const msg = `Error: ${error.message}`;
    if (status) status.textContent = msg;
    if (logEl) logEl.textContent += msg + "\n";
  } finally {
    button.disabled = false;
    button.textContent = "Clean Duplicates";
  }
}

export async function runTraktBackfill() {
  const button = elements.traktBackfillButton;
  const status = elements.traktBackfillStatus;
  const logEl = elements.traktBackfillLog;
  if (!button || !status) return;

  const limit = Math.max(1, Number(elements.traktBackfillLimit?.value || 500));
  const rate = Math.max(50, Number(elements.traktBackfillRate?.value || 300));

  button.disabled = true;
  button.textContent = "Backfilling Trakt Imports...";
  status.textContent = `Starting Trakt import backfill (limit=${limit}, rate=${rate}ms)`;
  if (logEl) logEl.textContent = `Starting Trakt import backfill at ${new Date().toISOString()}\n`;

  try {
    const maxBatches = 2000;
    let batch = 0;
    let totalBackfilled = 0;
    let lastBackfilled = -1;

    for (; batch < maxBatches; batch++) {
      status.textContent = `Running batch #${batch + 1}...`;
      const resp = await fetch(`/api/admin-backfill-trakt`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ limit, rateMs: rate }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = body.error || `Backfill failed (${resp.status})`;
        if (logEl) logEl.textContent = `${new Date().toISOString()} - ERROR: ${msg}\n` + logEl.textContent;
        status.textContent = `Error: ${msg}`;
        break;
      }

      const tried = Number(body.tried || 0);
      const backfilled = Number(body.backfilled || 0);
      totalBackfilled += backfilled;

      const now = new Date().toISOString();
      if (logEl) {
        logEl.textContent = `${now} - Batch ${batch + 1}: tried=${tried} backfilled=${backfilled}\n` + logEl.textContent;
      }

      let remaining = null;
      try {
        const st = await fetch(`/api/admin-backfill-status`, { headers: authHeaders() });
        const stBody = await st.json().catch(() => ({}));
        remaining = Number(stBody.remaining ?? stBody.missing ?? null);
      } catch (err) {
        // ignore
      }

      status.textContent = remaining != null ? `Batch ${batch + 1}: backfilled ${backfilled}. Remaining: ${remaining}` : `Batch ${batch + 1}: backfilled ${backfilled}`;

      if ((backfilled === 0 && lastBackfilled === 0) || (remaining === 0)) {
        if (logEl) logEl.textContent = `${new Date().toISOString()} - No further progress; stopping.\n` + logEl.textContent;
        break;
      }
      lastBackfilled = backfilled;

      await new Promise((r) => setTimeout(r, 300));
    }

    status.textContent = `Completed: total backfilled ${totalBackfilled} after ${batch + 1} batches`;
  } catch (err) {
    const msg = err?.message || String(err);
    if (logEl) logEl.textContent = `${new Date().toISOString()} - ERROR: ${msg}\n` + logEl.textContent;
    status.textContent = `Error: ${msg}`;
    throw err;
  } finally {
    button.disabled = false;
    button.textContent = "Backfill Trakt Imports";
  }
}

function appendFullSyncLog(message) {
  if (!elements.fullSyncLog) return;
  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  elements.fullSyncLog.textContent = `[${timestamp}] ${message}\n${elements.fullSyncLog.textContent || ""}`.trim();
  elements.fullSyncLog.scrollTop = 0;
}

function summarizeFullSyncPhase(summary = {}) {
  return Object.entries(summary)
    .map(([target, counts]) => {
      const success = Number(counts.success || 0);
      const notFound = Number(counts.notFound || 0);
      const skipped = Number(counts.skipped || 0);
      const error = Number(counts.error || 0);
      return `${platformName(target)} ${success} ok, ${notFound} not found, ${skipped} skipped, ${error} errors`;
    })
    .join(" | ");
}

export async function runFullSyncWatchstates() {
  if (state.fullSyncActive) return;
  const button = elements.fullSyncButton;
  const status = elements.fullSyncStatus;
  if (!button || !status) return;

  state.fullSyncActive = true;
  button.disabled = true;
  button.textContent = "Syncing...";
  status.textContent = "Running";
  status.className = "status-pill status-ready";
  if (elements.fullSyncLog) elements.fullSyncLog.textContent = "";

  const limit = 25;
  const phases = ["watched", "progress"];
  const totals = {
    watched: { processed: 0 },
    progress: { processed: 0 },
  };

  try {
    for (const phase of phases) {
      let offset = 0;
      let batch = 1;
      let hasMore = true;
      appendFullSyncLog(`Starting ${phase} restore.`);
      while (hasMore) {
        const response = await fetch("/api/full-sync-watchstates", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ phase, offset, limit }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Full sync failed with ${response.status}`);

        totals[phase].processed += Number(body.processed || 0);
        appendFullSyncLog(`${phase} batch ${batch}: processed ${Number(body.processed || 0)} of ${Number(body.total || 0)}. ${summarizeFullSyncPhase(body.summary || {})}`);
        if (Array.isArray(body.errors) && body.errors.length) {
          appendFullSyncLog(`${phase} batch ${batch}: ${body.errors.length} platform errors captured.`);
        }

        offset = Number(body.nextOffset || offset + Number(body.processed || 0));
        hasMore = Boolean(body.hasMore) && Number(body.processed || 0) > 0;
        batch += 1;
      }
    }

    _clearDerivedUiCaches();
    status.textContent = "Complete";
    status.className = "status-pill status-ready";
    _setMessage(`Full sync complete. Watched rows: ${totals.watched.processed}. Progress rows: ${totals.progress.processed}.`, "success");
  } catch (error) {
    status.textContent = "Error";
    status.className = "status-pill status-error";
    appendFullSyncLog(`ERROR: ${error.message}`);
    _setMessage(`Full sync failed: ${error.message}`, "error");
    throw error;
  } finally {
    state.fullSyncActive = false;
    button.disabled = false;
    button.textContent = "Full Sync Watchstates";
  }
}

// ── System integrity check ─────────────────────────────────────────────────

export async function runSystemIntegrityCheck() {
  const button = elements.runCompleteCheckButton;
  const container = elements.completeCheckResults;
  if (!button || !container) return;

  button.disabled = true;
  button.textContent = "Running diagnostics...";
  container.classList.remove("hidden");
  container.innerHTML = `<div class="idle-state"><b>Running integrity checks...</b></div>`;

  const results = [];

  try {
    const startTime = Date.now();
    const response = await fetch("/api/history?limit=1", { headers: authHeaders() });
    const elapsed = Date.now() - startTime;
    if (response.ok) {
      results.push({ name: "Watch History API", status: "success", detail: `Connected successfully. Response time: ${elapsed}ms.` });
    } else {
      results.push({ name: "Watch History API", status: "error", detail: `Server responded with HTTP ${response.status}.` });
    }
  } catch (error) {
    results.push({ name: "Watch History API", status: "error", detail: `Connection failed: ${error.message}` });
  }

  try {
    await _loadSavedConfig();
    results.push({ name: "Server Configuration", status: "success", detail: "Read server-side media configuration successfully." });
  } catch (error) {
    results.push({ name: "Server Configuration", status: "error", detail: `Failed to read config: ${error.message}` });
  }

  let webhookEndpointStatus = "error";
  let webhookEndpointDetail = "Unavailable";
  try {
    const startTime = Date.now();
    const response = await fetch("/api/webhook", { method: "OPTIONS" });
    if (response.ok) {
      webhookEndpointStatus = "success";
      const elapsed = Date.now() - startTime;
      if (state.lastWebhook && state.lastWebhook.timestamp) {
        webhookEndpointDetail = `Active. Last event: ${platformName(state.lastWebhook.source)} watched "${state.lastWebhook.title}" at ${formatDate(state.lastWebhook.timestamp)}.`;
      } else {
        webhookEndpointDetail = `Active & online. No events received yet (${elapsed}ms).`;
      }
    } else {
      webhookEndpointDetail = `Responded with HTTP ${response.status}`;
    }
  } catch (error) {
    webhookEndpointDetail = `Ping failed: ${error.message}`;
  }
  results.push({ name: "Webhook Listener Endpoint", status: webhookEndpointStatus, detail: webhookEndpointDetail });

  if (state.lastCron) {
    const diff = Date.now() - Number(state.lastCron);
    const fiveMinutesMs = 5 * 60 * 1000;
    if (diff <= fiveMinutesMs) {
      results.push({ name: "Scheduled Cron Job", status: "success", detail: `Active. Last run: ${formatDate(state.lastCron)} (${Math.round(diff / 1000)}s ago).` });
    } else {
      results.push({ name: "Scheduled Cron Job", status: "warning", detail: `Warnings - Delayed execution. Last run: ${formatDate(state.lastCron)} (${Math.round(diff / 60000)}m ago).` });
    }
  } else {
    results.push({ name: "Scheduled Cron Job", status: "skipped", detail: "Not Configured - No execution logged." });
  }

  let historyToCheck = state.history || [];
  if (!historyToCheck.length) {
    try {
      const response = await fetch("/api/history?limit=5", { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(body.history)) historyToCheck = body.history;
    } catch (e) { /* ignore */ }
  }

  if (!historyToCheck.length) {
    results.push({ name: "Outbound Playstate Sync", status: "skipped", detail: "Not Configured - No watch history logged to scan." });
  } else {
    const recentRows = historyToCheck.slice(0, 5);
    let errorCount = 0;
    let totalChecked = 0;
    for (const row of recentRows) {
      if (row.sync_dispatch_telemetry) {
        totalChecked++;
        const tel = String(row.sync_dispatch_telemetry).toLowerCase();
        if (tel.includes("status: error") || tel.includes("failed") || tel.includes("propagation failed")) errorCount++;
      }
    }
    if (totalChecked === 0) {
      results.push({ name: "Outbound Playstate Sync", status: "success", detail: "Active. No recent outbound dispatches to check." });
    } else if (errorCount > 0) {
      results.push({ name: "Outbound Playstate Sync", status: "warning", detail: `Warnings - ${errorCount} of ${totalChecked} recent syncs failed. Check logs.` });
    } else {
      results.push({ name: "Outbound Playstate Sync", status: "success", detail: `All ${totalChecked} recent outbound syncs completed successfully.` });
    }
  }

  const plexUrl = elements.plexServerUrl?.value?.trim() || "";
  const plexToken = elements.plexToken?.value?.trim() || "";
  const embyUrl = elements.embyServerUrl?.value?.trim() || "";
  const embyApiKey = elements.embyApiKey?.value?.trim() || "";
  const jellyfinUrl = elements.jellyfinServerUrl?.value?.trim() || "";
  const jellyfinApiKey = elements.jellyfinApiKey?.value?.trim() || "";

  const testConnection = async (type, url, token, name) => {
    if (!url || !token) { results.push({ name, status: "skipped", detail: "Skipped - URL or token not provided." }); return; }
    try {
      const startTime = Date.now();
      const response = await fetch("/api/test-connection", { method: "POST", headers: authHeaders(), body: JSON.stringify({ type, url, token }) });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name, status: "success", detail: `${body.detail || "Server identity verified"} in ${body.elapsedMs || elapsed}ms.` });
      } else {
        results.push({ name, status: "error", detail: body.error || `Connection failed (HTTP ${response.status}).` });
      }
    } catch (error) {
      results.push({ name, status: "error", detail: `Check failed: ${error.message}` });
    }
  };

  await testConnection("plex", plexUrl, plexToken, "Plex Media Server");

  if (plexUrl && plexToken) {
    try {
      const startTime = Date.now();
      const response = await fetch("/api/test-plex-notifications", { method: "POST", headers: authHeaders(), body: JSON.stringify({ url: plexUrl, token: plexToken }) });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name: "Plex Realtime Notifications", status: "success", detail: `Notification WebSocket connected in ${body.elapsedMs || elapsed}ms. Event-driven unwatch detection is active.` });
      } else {
        results.push({ name: "Plex Realtime Notifications", status: "warning", detail: `${body.error || `Unavailable (HTTP ${response.status})`}. Unwatch sync falls back to the periodic poll.` });
      }
    } catch (error) {
      results.push({ name: "Plex Realtime Notifications", status: "warning", detail: `Check failed: ${error.message}. Unwatch sync falls back to the periodic poll.` });
    }
  } else {
    results.push({ name: "Plex Realtime Notifications", status: "skipped", detail: "Skipped - Plex URL or token not provided." });
  }

  await testConnection("emby", embyUrl, embyApiKey, "Emby Media Server");
  await testConnection("jellyfin", jellyfinUrl, jellyfinApiKey, "Jellyfin Media Server");

  container.innerHTML = results.map((res) => {
    let statusLabel = "Skipped";
    let pillStyle = "border-color: var(--line); background: var(--panel-3); color: var(--muted);";
    let fixInstruction = "";
    let settingsLink = "";

    if (res.status === "success") { statusLabel = "Online"; pillStyle = "border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.12); color: var(--green);"; }
    else if (res.status === "error") { statusLabel = "Failed"; pillStyle = "border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); color: var(--red);"; }
    else if (res.status === "skipped") { statusLabel = "Not Configured"; pillStyle = "border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.12); color: var(--yellow);"; }
    else if (res.status === "warning") { statusLabel = "Warnings Detected"; pillStyle = "border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12); color: var(--yellow);"; }

    if (res.status !== "success") {
      if (res.name === "Scheduled Cron Job") { fixInstruction = "Fix: The background sync worker runs in-process every minute. If it hasn't fired, confirm the server is running and check the server logs for errors. You can also trigger it manually via /api/cron-sync."; settingsLink = "sync"; }
      else if (res.name === "Watch History API") { fixInstruction = "Fix: The SQLite database may be locked or the data directory may not be writable. Check the server logs and confirm DATA_DIR is set correctly."; }
      else if (res.name === "Server Configuration") { fixInstruction = "Fix: Try saving your configuration again in Settings → Apps. If the error persists, check that data/config.json is writable."; }
      else if (res.name === "Webhook Listener Endpoint") { fixInstruction = "Fix: Confirm the server is running and accessible at the expected host and port. Check for firewall or reverse-proxy rules blocking /api/webhook."; }
      else if (res.name === "Outbound Playstate Sync") { fixInstruction = "Fix: Open the latest history row debug details, review sync_dispatch_telemetry, then correct the failed platform credentials or provider-ID match."; }
      else if (res.name === "Plex Media Server") { fixInstruction = "Fix: Enter the Plex Server URL and Plex Token in Settings → Apps, then confirm the server is reachable from the machine running Plembfin."; }
      else if (res.name === "Plex Realtime Notifications") { fixInstruction = "Fix: Ensure any reverse proxy / Cloudflare in front of Plex forwards WebSocket upgrades on /:/websockets/notifications, or set the Plex Server URL to the direct LAN address (e.g. http://192.168.x.x:32400). Unwatch sync still works via the fallback poll until this is fixed."; settingsLink = "apps"; }
      else if (res.name === "Emby Media Server") { fixInstruction = "Fix: Enter the Emby Server URL, API Key, and User ID in Settings → Apps, then confirm the server is reachable from the machine running Plembfin."; }
      else if (res.name === "Jellyfin Media Server") { fixInstruction = "Fix: Enter the Jellyfin Server URL, API Key, and User ID in Settings → Apps, then confirm the server is reachable from the machine running Plembfin."; }
    }

    return `
      <div class="ranking-row" style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-3); width: 100%;">
        <div style="display: grid; gap: 2px;">
          <b>${escapeHtml(res.name)}</b>
          <span style="font-size: 0.8rem; color: var(--muted);">${escapeHtml(res.detail)}</span>
          ${fixInstruction ? `<span style="font-size: 0.8rem; color: var(--text);">${escapeHtml(fixInstruction)}</span>` : ""}
          ${settingsLink ? `<button type="button" data-settings-link="${escapeAttribute(settingsLink)}" style="width: fit-content; border: 1px solid var(--line); background: var(--panel-3); color: var(--text); border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.78rem; font-weight: 800;">Open setup guide</button>` : ""}
        </div>
        <span class="target-pill" style="padding: 0.2rem 0.5rem; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; border: 1px solid; border-radius: 999px; ${pillStyle}">${statusLabel}</span>
      </div>
    `;
  }).join("");

  button.disabled = false;
  button.textContent = "Run System Diagnostic";
}

// ── Clear missing telemetry ────────────────────────────────────────────────

export async function triggerClearMissingTelemetry(button) {
  const btn = button || elements.clearMissingTelemetryButton || document.querySelector('[data-action="clearMissingTelemetry"]');
  if (!btn) return;

  _showConfirmModal(
    "Clear missing dispatch telemetry records?\n\nThis will mark records with missing telemetry as resolved, removing them from the outstanding jobs list. This is safe — it only affects logging, not actual sync functionality.",
    async () => {
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Clearing...";

      const titleEl = document.getElementById("terminalModalTitle");
      if (titleEl) titleEl.textContent = "Clear Telemetry Terminal";

      elements.terminalModal?.classList.remove("hidden");
      if (elements.retryTerminalOutput) elements.retryTerminalOutput.innerHTML = "";

      function termLog(text, tone = "info") {
        if (!elements.retryTerminalOutput) return;
        const span = document.createElement("span");
        if (tone === "error") { span.style.color = "#fb7185"; span.style.fontWeight = "bold"; }
        else if (tone === "success") { span.style.color = "#34d399"; span.style.fontWeight = "bold"; }
        else if (tone === "warn") { span.style.color = "#f59e0b"; }
        else if (tone === "header") { span.style.color = "#38bdf8"; span.style.fontWeight = "bold"; }
        else { span.style.color = "#e8edf2"; }
        span.textContent = text + "\n";
        elements.retryTerminalOutput.appendChild(span);
        elements.retryTerminalOutput.scrollTop = elements.retryTerminalOutput.scrollHeight;
      }

      termLog("plembfin@server:~$ ./clear-missing-telemetry", "header");
      termLog("Initiating request to clear missing dispatch telemetry...", "info");
      termLog("POST /api/clear-missing-telemetry HTTP/1.1", "info");

      try {
        const response = await fetch("/api/clear-missing-telemetry", { method: "POST", headers: authHeaders() });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          termLog("[ERROR] Clear request failed with status: " + response.status, "error");
          if (body.error) termLog("Reason: " + body.error, "error");
          throw new Error(body.error || `Failed with HTTP ${response.status}`);
        }
        termLog("Response received: HTTP 200 OK", "success");
        termLog(`Successfully cleared ${body.cleared || 0} watch history record(s) with missing telemetry.`, "success");
        termLog("\n✨ Done!", "success");
        _setMessage(`Cleared ${body.cleared || 0} records`, "success");
        await _loadSyncJobs({ force: true });
      } catch (error) {
        termLog(`\n[FATAL ERROR] Clear process aborted: ${error.message}`, "error");
        _setMessage(`Error: ${error.message}`, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  );
}

// ── Retry all in category ──────────────────────────────────────────────────

export async function triggerRetryAllCategory(categoryName, button) {
  if (!categoryName || !state.syncJobs) return;

  const categories = categorizeIssues(state.syncJobs);
  const jobsInCategory = categories[categoryName] || [];

  if (!jobsInCategory.length) { _setMessage("No issues to retry in this category", "info"); return; }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = `Retrying ${jobsInCategory.length}...`;

  const categoryLabels = {
    plexMismatch: "Plex Match",
    targetMismatch: "Emby/Jellyfin Match",
    otherIssues: "Unresolved",
    missingTelemetry: "Missing Telemetry",
  };
  const categoryLabel = categoryLabels[categoryName] || categoryName;

  _showConfirmModal(
    `Retry all ${jobsInCategory.length} ${categoryLabel} issues?\n\nThis will sequentially retry each item. The process may take a minute or two.`,
    async () => {
      try {
        _setMessage(`Retrying ${jobsInCategory.length} items...`, "info");
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < jobsInCategory.length; i++) {
          const job = jobsInCategory[i];
          try {
            const response = await fetch("/api/retry-sync", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ id: job.id }),
            });
            if (response.ok) {
              const data = await response.json();
              if (data.status === "success" || String(data.status || "").includes("success")) successCount++;
              else failCount++;
            } else { failCount++; }
          } catch (err) {
            console.error(`Failed to retry ${job.id}:`, err);
            failCount++;
          }
          if (i % 5 === 0 || i === jobsInCategory.length - 1) {
            _setMessage(`Retrying... ${i + 1}/${jobsInCategory.length} (${successCount} passed)`, "info");
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        await _loadSyncJobs({ force: true });
        await _loadSyncHistory({ force: true });
        const resultMsg = `Completed ${jobsInCategory.length} retries. ${successCount} passed, ${failCount} had issues.`;
        _setMessage(resultMsg, successCount > failCount ? "success" : "warning");
      } catch (error) {
        _setMessage(`Error during retry: ${error.message}`, "error");
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  );
}
