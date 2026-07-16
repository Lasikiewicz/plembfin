import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatNumber, formatDate } from "./utils.js";
import { openSettingsEditModal, openSettingsPickerModal, renderServiceCardGrid } from "./settings-ui.js";

let _setMessage = () => {};
let _openConfirmDialog = async () => false;
let _showConfirmModal = () => {};
let _loadSavedConfig = async () => {};
let _loadHistory = async () => {};
let _loadActiveSessions = async () => {};
let _loadStats = async () => {};
let _clearDerivedUiCaches = () => {};

export function initBackupTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadSavedConfig) _loadSavedConfig = callbacks.loadSavedConfig;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.loadActiveSessions) _loadActiveSessions = callbacks.loadActiveSessions;
  if (callbacks.loadStats) _loadStats = callbacks.loadStats;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

const BACKUP_BATCH_SIZE = 250;
const BACKUP_MAX_REQUEST_BYTES = 512 * 1024;
const BACKUP_FORMAT = "plembfin-backup";
const BACKUP_VERSION = 1;
const ENCRYPTED_BACKUP_FORMAT = "plembfin-encrypted-backup";
const ENCRYPTED_BACKUP_VERSION = 1;
const BACKUP_KDF_ITERATIONS = 250000;
const BACKUP_COLLECTIONS = ["watchHistory", "playstate", "playbackProgress", "activeSessions", "liveTrackingCache", "syncHistory", "settings", "runtimeState", "loopKeys"];
// ── Backup transfer state ──────────────────────────────────────────────────
export function setBackupTransferState(label, tone = "muted", log = "", area = "restore") {
  const status = area === "export" ? elements.backupExportStatus : elements.backupRestoreStatus;
  const output = area === "export" ? elements.backupExportLog : elements.backupRestoreLog;
  if (status) {
    status.textContent = label;
    status.className = `status-pill status-${tone}`;
  }
  if (log && output) {
    output.textContent = log;
    output.scrollTop = output.scrollHeight;
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
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
function backupPassphrase(area = "restore") {
  const input = area === "export" ? elements.backupExportPassphrase : elements.backupRestorePassphrase;
  return String(input?.value || "").trim();
}
async function backupCryptoKey(passphrase, salt) {
  const cryptoApi = globalThis.crypto;
  const keyMaterial = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return cryptoApi.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: BACKUP_KDF_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function encryptPlembfinBackup(backup, passphrase) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("This browser does not support encrypted backups.");
  if (passphrase.length < 12) throw new Error("Use an encryption passphrase of at least 12 characters.");
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await backupCryptoKey(passphrase, salt);
  const payload = new TextEncoder().encode(JSON.stringify(backup));
  const encrypted = new Uint8Array(await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, key, payload));
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: ENCRYPTED_BACKUP_VERSION,
    encryptedAt: new Date().toISOString(),
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: BACKUP_KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    payload: bytesToBase64(encrypted),
  };
}
async function decryptPlembfinBackup(encryptedBackup, passphrase) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("This browser does not support encrypted backups.");
  if (!passphrase) throw new Error("Enter the passphrase used when this Plembfin backup was exported.");
  const encryption = encryptedBackup?.encryption || {};
  if (encryptedBackup?.format !== ENCRYPTED_BACKUP_FORMAT || Number(encryptedBackup?.version) !== ENCRYPTED_BACKUP_VERSION) {
    throw new Error("This is not a supported encrypted Plembfin backup file.");
  }
  if (encryption.algorithm !== "AES-256-GCM" || encryption.kdf !== "PBKDF2") {
    throw new Error("This encrypted backup uses an unsupported encryption method.");
  }
  try {
    const salt = base64ToBytes(encryption.salt);
    const iv = base64ToBytes(encryption.iv);
    const payload = base64ToBytes(encryptedBackup.payload);
    const key = await backupCryptoKey(passphrase, salt);
    const decrypted = await cryptoApi.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (error) {
    throw new Error("Could not decrypt this Plembfin backup. Check the passphrase and file.");
  }
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
  const passphrase = backupPassphrase("export");
  button.disabled = true;
  button.textContent = "Exporting...";
  setBackupTransferState("Exporting", "warning", "Collecting Plembfin data before browser-side encryption...", "export");
  try {
    if (passphrase.length < 12) throw new Error("Enter an encryption passphrase of at least 12 characters.");
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
        setBackupTransferState("Exporting", "warning", `Exporting ${collection}: ${formatNumber(documents.length)} documents\nTotal collected: ${formatNumber(totalDocuments + documents.length)}`, "export");
      }
      backup.collections[collection] = documents;
      totalDocuments += documents.length;
    }
    setBackupTransferState("Encrypting", "warning", `Encrypting ${formatNumber(totalDocuments)} documents in this browser...`, "export");
    const encryptedBackup = await encryptPlembfinBackup(backup, passphrase);
    downloadJsonFile(encryptedBackup, `plembfin-backup-${new Date().toISOString().slice(0, 10)}.encrypted.json`);
    setBackupTransferState("Downloaded", "ready", `Encrypted backup downloaded: ${formatNumber(totalDocuments)} documents across ${formatNumber(collectionNames.length)} collections.\nKeep the passphrase separately. Plembfin cannot recover it.`, "export");
    _setMessage("Encrypted Plembfin backup downloaded.", "success");
  } catch (error) {
    setBackupTransferState("Failed", "error", `Backup failed: ${error.message}`, "export");
    _setMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Export Plembfin Backup";
  }
}
export async function readPlembfinBackup(file) {
  const parsed = JSON.parse(await file.text());
  if (parsed?.format === ENCRYPTED_BACKUP_FORMAT) {
    return { ...validatePlembfinBackup(await decryptPlembfinBackup(parsed, backupPassphrase("restore"))), encrypted: true };
  }
  return { ...validatePlembfinBackup(parsed), encrypted: false };
}
export async function importPlembfinBackup() {
  if (!state.backupImport) return;
  const approved = await _openConfirmDialog({
    title: "Restore Plembfin backup?",
    body: "This replaces every collection included in the Plembfin backup. Your local admin username and password stay unchanged. Watch-history restores are safer for ordinary history rollback; use this for a full Plembfin move or rebuild.",
    confirmLabel: "Restore Plembfin Backup",
    danger: true,
  });
  if (!approved) return;
  const button = elements.backupImportButton;
  const input = elements.backupImportFile;
  const { backup, included } = state.backupImport;
  button.disabled = true;
  input.disabled = true;
  button.textContent = "Restoring...";
  setBackupTransferState("Restoring", "warning", "Starting Plembfin backup restore...", "restore");
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
          setBackupTransferState("Importing", "warning", `Imported ${collection}: ${formatNumber(collectionImported)} of ${formatNumber(documents.length)} documents\nTotal imported: ${formatNumber(totalDocuments)} documents`, "restore");
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
    setBackupTransferState("Complete", "ready", `Restore complete: ${formatNumber(totalDocuments)} documents across ${formatNumber(included.length)} collections.`, "restore");
    _setMessage("Plembfin backup restored.", "success");
  } catch (error) {
    setBackupTransferState("Failed", "error", `Restore failed: ${error.message}`, "restore");
    _setMessage(error.message, "error");
  } finally {
    input.disabled = false;
    button.disabled = !state.backupImport;
    button.textContent = "Restore Plembfin Backup";
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
    const loadingCopy = `<div class="empty-log"><b>${state.watchBackupsLoading ? "Loading backups..." : "Backups not loaded"}</b><span>Watch-history backups and Plembfin backups restore from separate sections.</span></div>`;
    elements.watchBackupList.innerHTML = loadingCopy;
    if (elements.remoteWatchBackupList) elements.remoteWatchBackupList.innerHTML = loadingCopy;
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
        <div class="backup-runtime-with-action">
          <span>Last restore</span>
          <b>${escapeHtml(watchBackupDate(runtime.lastRestoreAt))}</b>
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
    renderBackupDestinationCards();
    return;
  }
  const localEntries = files.map((f) => ({ ...f, source: "local", destId: null, destLabel: "Local" }));
  const remoteEntries = (state.remoteBackupFiles || []);
  const sortNewest = (entries) => [...entries].sort((a, b) => {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
  const cronPausedUntil = runtime.cronSyncPausedUntil;
  const cronPausedBanner = cronPausedUntil && Date.now() < cronPausedUntil
    ? `<div class="backup-runtime" style="margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3); background: rgba(255,165,0,0.08);">
        <span style="font-size: 0.85rem;">Cron sync is paused until ${escapeHtml(new Date(cronPausedUntil).toLocaleTimeString())} while restore work settles.</span>
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
      <div class="restore-clear-intro">Watch-history restore makes the selected backup the source of truth and pushes it to every connected app. Choose how Plembfin should handle existing app state first:</div>
      <label>
        <input type="radio" name="restoreClearMode" value="reconcile" ${clearMode === "reconcile" ? "checked" : ""} data-restore-clear-mode>
        <span><b>Reconcile tracked items</b> — push only items in this backup. Faster, and apps keep watched items that the backup does not know about.</span>
      </label>
      <label>
        <input type="radio" name="restoreClearMode" value="wipe" ${clearMode === "wipe" ? "checked" : ""} data-restore-clear-mode>
        <span><b>Full wipe then push</b> — first mark every watched item in each app as unwatched, then re-apply only this backup's watched set. Slower, but the apps end up matching the backup.</span>
      </label>
    </div>`;
  const renderEntries = (entries, emptyCopy) => {
    const sorted = sortNewest(entries);
    return sorted.length ? sorted.map((entry) => `
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
          Restore Watch History
        </button>
      </div>
    </article>
  `).join("") : emptyCopy;
  };
  const localEmpty = `<div class="empty-log"><b>No local watch-history backups</b><span>Use Back Up Now on the Backups tab or add a .json.gz file from your computer.</span></div>`;
  const remoteEmpty = state.remoteBackupFilesLoading
    ? ""
    : `<div class="empty-log"><b>No remote watch-history backups</b><span>Configure a remote destination on the Backups tab, then create a watch-history backup.</span></div>`;
  elements.watchBackupList.innerHTML = cronPausedBanner + (localEntries.length ? clearModeSelector : "") + renderEntries(localEntries, localEmpty);
  if (elements.remoteWatchBackupList) {
    elements.remoteWatchBackupList.innerHTML = remoteLoading + (remoteEntries.length ? clearModeSelector : "") + renderEntries(remoteEntries, remoteEmpty);
  }
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
    description: "Mirror backups to a Backblaze B2 bucket",
    settings: [
      { key: "region", label: "Region or endpoint", placeholder: "eu-central-003", help: "A region name or full S3 endpoint is accepted." },
      { key: "bucket", label: "Bucket name", placeholder: "yourname-plembfin" },
      { key: "accessKeyId", label: "Key ID", placeholder: "0035..." },
      { key: "prefix", label: "Key prefix", placeholder: "plembfin/", optional: true, help: "Optional folder-like prefix within the bucket." },
    ],
    secrets: [{ key: "secretAccessKey", label: "Application key", placeholder: "Backblaze application key" }],
    helpHtml: `
      <p class="tool-accordion-desc">Create a private bucket in Backblaze B2, then create an application key restricted to that bucket with read and write access.</p>
      <ol class="tool-accordion-desc settings-help-steps">
        <li>Open <b>Buckets</b> in Backblaze and note the bucket name.</li>
        <li>Open <b>Application Keys</b>, add a key for that bucket, and copy both the <b>keyID</b> and <b>applicationKey</b>.</li>
        <li>Copy the bucket region (for example <code>eu-central-003</code>) or its full S3 endpoint.</li>
      </ol>
      <p class="tool-accordion-desc">The application key is shown by Backblaze only once. Plembfin stores it securely and never sends it back to the browser.</p>
    `,
  },
};
function destinationBadges(destination, status) {
  const badges = [{ label: destination.enabled ? "Enabled" : "Disabled", tone: destination.enabled ? "ready" : "muted" }];
  if (status?.status === "success") badges.push({ label: "Connected", tone: "ready" });
  else if (status?.status === "error") badges.push({ label: "Last run failed", tone: "danger" });
  else badges.push({ label: "Not tested", tone: "warning" });
  return badges;
}

function destinationFields(destination, form) {
  return [
    { key: "label", label: "Name", value: destination.label || form.label, help: "A recognizable name for this backup target." },
    { key: "enabled", label: "Enable", type: "checkbox", value: Boolean(destination.enabled) },
    ...form.settings.map((field) => ({ ...field, value: destination.settings?.[field.key] || "" })),
    ...form.secrets.map((field) => ({
      ...field,
      type: "password",
      secret: true,
      configured: Boolean(destination.secretFlags?.[field.key]),
      configuredPlaceholder: `Configured - enter a new ${field.label.toLowerCase()} to replace it`,
    })),
  ];
}

function destinationFromValues(destination, form, values) {
  const settings = Object.fromEntries(form.settings.map((field) => [field.key, values[field.key]]));
  const secrets = {};
  for (const field of form.secrets) {
    if (values[field.key]) secrets[field.key] = values[field.key];
  }
  return {
    ...(destination.id ? { id: destination.id } : {}),
    type: destination.type,
    label: values.label || form.label,
    enabled: Boolean(values.enabled),
    settings,
    secrets,
  };
}

async function refreshBackupDestinations() {
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
}

async function saveDestinationValues(destination, form, values) {
  const body = await postWatchBackupAction({
    action: "save-destination",
    destination: destinationFromValues(destination, form, values),
  });
  if (body.destination) Object.assign(destination, body.destination);
  return body.destination;
}

export function openBackupDestinationModal(destination = {}) {
  const type = destination.type || "backblaze";
  const form = DESTINATION_FORMS[type];
  if (!form) throw new Error(`Unsupported destination type: ${type}`);
  const target = { type, settings: {}, secretFlags: {}, ...destination };
  openSettingsEditModal({
    title: target.id ? `Edit ${target.label || form.label}` : `Add ${form.label}`,
    fields: destinationFields(target, form),
    enabledKey: "enabled",
    saveDisabledLabel: "Save & disable",
    helpHtml: form.helpHtml,
    onSave: async (values) => {
      await saveDestinationValues(target, form, values);
      await refreshBackupDestinations();
      _setMessage("Backup destination saved.", "success");
    },
    onTest: async (values) => {
      const saved = await saveDestinationValues(target, form, values);
      const result = await postWatchBackupAction({ action: "test-destination", destinationId: saved.id });
      await refreshBackupDestinations();
      return `Connection OK - ${result.result?.detail || "reachable"}.`;
    },
    onDelete: target.id ? async () => {
      const approved = await _openConfirmDialog({
        title: "Remove destination?",
        body: "Stop mirroring backups here? Files already uploaded to the remote are left untouched.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!approved) return false;
      await postWatchBackupAction({ action: "remove-destination", destinationId: target.id });
      await refreshBackupDestinations();
      _setMessage("Destination removed.", "success");
    } : undefined,
  });
}

function openBackupDestinationPicker() {
  openSettingsPickerModal({
    title: "Add Backup Destination",
    intro: "Choose where Plembfin should mirror scheduled backups.",
    items: Object.entries(DESTINATION_FORMS).map(([id, form]) => ({ id, name: form.label, description: form.description })),
    onPick: (type) => openBackupDestinationModal({ type }),
  });
}

export function renderBackupDestinationCards() {
  const destinations = Array.isArray(state.watchBackups?.destinations) ? state.watchBackups.destinations : [];
  const statusMap = state.watchBackups?.runtime?.destinations || {};
  renderServiceCardGrid(elements.backupDestinationCards, {
    items: destinations.map((destination) => ({
      id: destination.id,
      name: destination.label || DESTINATION_FORMS[destination.type]?.label || destination.type,
      description: DESTINATION_FORMS[destination.type]?.description || "Remote backup destination",
      badges: destinationBadges(destination, statusMap[destination.id]),
    })),
    onSelect: (id) => openBackupDestinationModal(destinations.find((destination) => destination.id === id)),
    onAdd: openBackupDestinationPicker,
    addLabel: "Add backup destination",
  });
}
export async function restoreRemoteBackupFromCard(card, filename, clearMode = "reconcile") {
  const wipe = clearMode === "wipe";
  const approved = await _openConfirmDialog({
    title: "Restore watch history?",
    body: `⚠️ AUTHORITATIVE RESTORE — this backup becomes the source of truth.\n\nWill DELETE all current watch history, playstate and resume progress, restore from:\n\n${filename}\n\nand push that state to every connected app.\n\n${wipe
      ? "Clear mode: FULL WIPE — every currently-watched item on each app is first marked unwatched."
      : "Clear mode: RECONCILE — only items tracked by the backup are pushed."}\n\nThis cannot be undone.`,
    confirmLabel: wipe ? "Wipe Apps and Restore" : "Restore and Push",
    danger: true,
  });
  if (!approved) return;
  await runAuthoritativeRestore({ action: "restore-remote-backup", destinationId: card.dataset.destId, filename, clearMode });
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
export async function loadPlembfinBackups({ force = false } = {}) {
  if (!state.token || state.plembfinBackupsLoading || (state.plembfinBackups && !force)) return state.plembfinBackups;
  state.plembfinBackupsLoading = true;
  renderPlembfinBackups();
  try {
    const response = await fetch("/api/plembfin-backups", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Plembfin backup status failed with ${response.status}`);
    state.plembfinBackups = body;
    return body;
  } finally {
    state.plembfinBackupsLoading = false;
    renderPlembfinBackups();
  }
}
export async function postPlembfinBackupAction(payload) {
  const response = await fetch("/api/plembfin-backups", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Plembfin backup action failed with ${response.status}`);
  return body;
}
export function updatePlembfinButtonsState() {
  const config = state.plembfinBackups?.config || {};
  const passphrase = elements.backupExportPassphrase?.value.trim() || "";
  const remember = Boolean(elements.backupExportRememberPassphrase?.checked);
  const hasStoredPassphrase = Boolean(config.passphraseStored);
  const hasLocalPassphrase = passphrase.length >= 12 || (remember && hasStoredPassphrase);
  const localScheduleEnabled = Boolean(elements.plembfinBackupEnabled?.checked);
  if (elements.savePlembfinBackupConfigButton) {
    elements.savePlembfinBackupConfigButton.disabled = localScheduleEnabled && (!remember || !hasLocalPassphrase);
  }
  if (elements.createPlembfinBackupButton) elements.createPlembfinBackupButton.disabled = !hasLocalPassphrase && passphrase.length < 12;

  const remotePassphrase = elements.plembfinBackupRemotePassphrase?.value.trim() || "";
  const remoteRemember = Boolean(elements.plembfinBackupRemoteRememberPassphrase?.checked);
  const hasStoredRemotePassphrase = Boolean(config.remotePassphraseStored);
  const hasRemotePassphrase = remotePassphrase.length >= 12 || (remoteRemember && hasStoredRemotePassphrase);
  const remoteScheduleEnabled = Boolean(elements.plembfinBackupRemoteEnabled?.checked);
  if (elements.savePlembfinBackupRemoteButton) {
    elements.savePlembfinBackupRemoteButton.disabled = remoteScheduleEnabled && !hasLocalPassphrase && (!remoteRemember || !hasRemotePassphrase);
  }
}
export function renderPlembfinBackups() {
  if (!elements.plembfinBackupList) return;
  const data = state.plembfinBackups;
  if (!data) {
    elements.plembfinBackupSummary && (elements.plembfinBackupSummary.textContent = state.plembfinBackupsLoading ? "Loading" : "Not loaded");
    elements.plembfinBackupSummary && (elements.plembfinBackupSummary.className = `status-pill status-${state.plembfinBackupsLoading ? "warning" : "muted"}`);
    const loadingCopy = `<div class="empty-log"><b>${state.plembfinBackupsLoading ? "Loading backups..." : "Backups not loaded"}</b><span>Watch-history backups and Plembfin backups restore from separate sections.</span></div>`;
    elements.plembfinBackupList.innerHTML = loadingCopy;
    return;
  }
  const config = data.config || {};
  const runtime = data.runtime || {};
  const files = Array.isArray(data.files) ? data.files : [];
  
  elements.plembfinBackupEnabled && (elements.plembfinBackupEnabled.checked = Boolean(config.enabled));
  elements.plembfinBackupTime && (elements.plembfinBackupTime.value = config.time || "03:00");
  elements.plembfinBackupRetention && (elements.plembfinBackupRetention.value = String(config.retention || 7));
  if (elements.backupExportRememberPassphrase) {
    elements.backupExportRememberPassphrase.checked = Boolean(config.rememberPassphrase || config.passphraseStored);
  }
  if (elements.backupExportPassphrase) {
    elements.backupExportPassphrase.placeholder = config.passphraseStored ? "Saved - leave blank to keep" : "";
  }

  elements.plembfinBackupRemoteEnabled && (elements.plembfinBackupRemoteEnabled.checked = Boolean(config.remoteEnabled));
  if (elements.plembfinBackupRemoteRememberPassphrase) {
    elements.plembfinBackupRemoteRememberPassphrase.checked = Boolean(config.remoteRememberPassphrase || config.remotePassphraseStored);
  }
  if (elements.plembfinBackupRemotePassphrase) {
    elements.plembfinBackupRemotePassphrase.placeholder = config.remotePassphraseStored ? "Saved - leave blank to keep" : "";
  }
  
  elements.plembfinBackupSummary && (elements.plembfinBackupSummary.textContent = config.enabled ? "Scheduled" : "Disabled");
  elements.plembfinBackupSummary && (elements.plembfinBackupSummary.className = `status-pill status-${config.enabled ? "ready" : "muted"}`);
  
  if (elements.plembfinBackupRuntime) {
    elements.plembfinBackupRuntime.innerHTML = `
      <div><span>Last successful backup</span><b>${escapeHtml(watchBackupDate(runtime.lastSuccessAt))}</b></div>
      <div class="backup-runtime-with-action">
        <span>Last restore</span>
        <b>${escapeHtml(watchBackupDate(runtime.lastRestoreAt))}</b>
      </div>
      <div><span>Storage</span><b>${formatNumber(files.length)} file${files.length === 1 ? "" : "s"}</b></div>
      ${runtime.lastError ? `<p class="backup-runtime-error">${escapeHtml(runtime.lastError)}</p>` : ""}
    `;
  }

  if (elements.plembfinBackupRemoteRuntime) {
    let remoteHtml = "";
    if (runtime.lastRemoteAttemptAt) {
      if (!runtime.lastRemoteError) {
        remoteHtml = `
          <div><span>Last successful sync</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteSuccessAt))}</b></div>
          <div><span>Last attempt</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteAttemptAt))} (Success)</b></div>
          <div><span>Status</span><b>Connected</b></div>
        `;
      } else {
        remoteHtml = `
          <div><span>Last successful sync</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteSuccessAt))}</b></div>
          <div><span>Last attempt</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteAttemptAt))} (Error)</b></div>
          <div><span>Status</span><b style="color: var(--red);">Not connected</b></div>
          <p class="backup-runtime-error">${escapeHtml(runtime.lastRemoteError)}</p>
        `;
      }
    } else {
      remoteHtml = `
        <div><span>Last successful sync</span><b>Never</b></div>
        <div><span>Last attempt</span><b>Never</b></div>
        <div><span>Status</span><b>Not connected</b></div>
      `;
    }
    elements.plembfinBackupRemoteRuntime.innerHTML = remoteHtml;
  }
  
  elements.plembfinBackupList.innerHTML = files.length ? files.map((file) => `
    <article class="watch-backup-row">
      <div class="watch-backup-copy">
        <b>${escapeHtml(file.name)}</b>
        <span>${escapeHtml(watchBackupDate(file.createdAt))} · ${escapeHtml(formatBytes(file.sizeBytes))}</span>
      </div>
      <div class="watch-backup-actions">
        <button class="button-ghost" type="button" data-plembfin-backup-download="${escapeAttribute(file.name)}">Download</button>
        <button class="button-primary" type="button" data-plembfin-backup-restore="${escapeAttribute(file.name)}">Restore</button>
        <button class="button-ghost" type="button" data-plembfin-backup-delete="${escapeAttribute(file.name)}">Delete</button>
      </div>
    </article>
  `).join("") : `<div class="empty-log"><b>No scheduled Plembfin backups yet</b><span>Use Back Up Now or enable the daily schedule.</span></div>`;

  updatePlembfinButtonsState();
}
export async function savePlembfinBackupSettings() {
  const rememberPassphrase = Boolean(elements.backupExportRememberPassphrase?.checked);
  const config = {
    ...state.plembfinBackups?.config,
    enabled: elements.plembfinBackupEnabled.checked,
    time: elements.plembfinBackupTime.value || "03:00",
    retention: Number(elements.plembfinBackupRetention.value) || 7,
    rememberPassphrase,
    passphrase: rememberPassphrase ? elements.backupExportPassphrase.value.trim() : "",
  };
  await postPlembfinBackupAction({ action: "configure", config });
  state.plembfinBackups = null;
  await loadPlembfinBackups({ force: true });
  _setMessage("Plembfin backup schedule saved.", "success");
}
export async function savePlembfinBackupRemoteSettings() {
  const remoteRememberPassphrase = Boolean(elements.plembfinBackupRemoteRememberPassphrase?.checked);
  const config = {
    ...state.plembfinBackups?.config,
    remoteEnabled: elements.plembfinBackupRemoteEnabled.checked,
    remoteRememberPassphrase,
    remotePassphrase: remoteRememberPassphrase ? elements.plembfinBackupRemotePassphrase.value.trim() : "",
  };
  await postPlembfinBackupAction({ action: "configure", config });
  state.plembfinBackups = null;
  await loadPlembfinBackups({ force: true });
  _setMessage("Remote Plembfin backup settings saved.", "success");
}
export async function createPlembfinBackupNow() {
  const button = elements.createPlembfinBackupButton;
  button.disabled = true;
  button.textContent = "Backing up...";
  try {
    const result = await postPlembfinBackupAction({
      action: "create",
      passphrase: elements.backupExportPassphrase.value.trim()
    });
    state.plembfinBackups = null;
    await loadPlembfinBackups({ force: true });
    _setMessage(`Created ${result.backup?.name || "Plembfin backup"}.`, "success");
  } finally {
    button.disabled = false;
    button.textContent = "Back Up Now";
    updatePlembfinButtonsState();
  }
}
export async function downloadPlembfinBackup(filename) {
  const response = await fetch(`/api/plembfin-backups?download=${encodeURIComponent(filename)}`, { headers: authHeaders() });
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
export async function deletePlembfinBackupFile(filename) {
  const approved = await _openConfirmDialog({
    title: "Delete Plembfin backup?",
    body: `Are you sure you want to permanently delete the backup file ${filename} from the server?`,
    confirmLabel: "Delete Backup",
    danger: true,
  });
  if (!approved) return;
  await postPlembfinBackupAction({ action: "delete", filename });
  state.plembfinBackups = null;
  await loadPlembfinBackups({ force: true });
  _setMessage("Backup deleted successfully.", "success");
}
export async function restorePlembfinBackupFromServer(filename) {
  const passphrase = elements.backupRestorePassphrase?.value.trim() || "";
  if (passphrase.length < 12) {
    throw new Error("Enter a restore passphrase of at least 12 characters.");
  }
  setBackupTransferState("Downloading", "warning", "Downloading encrypted backup from server...", "restore");
  try {
    const response = await fetch(`/api/plembfin-backups?download=${encodeURIComponent(filename)}`, { headers: authHeaders() });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Failed to download backup file from server`);
    }
    const encryptedBackup = await response.json();
    setBackupTransferState("Decrypting", "warning", "Decrypting backup file in browser...", "restore");
    const decrypted = await decryptPlembfinBackup(encryptedBackup, passphrase);
    state.backupImport = {
      backup: decrypted,
      included: BACKUP_COLLECTIONS.filter((name) => Object.hasOwn(decrypted.collections, name)),
      encrypted: true
    };
    await importPlembfinBackup();
  } catch (error) {
    setBackupTransferState("Failed", "error", `Restore failed: ${error.message}`, "restore");
    _setMessage(error.message, "error");
  }
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
