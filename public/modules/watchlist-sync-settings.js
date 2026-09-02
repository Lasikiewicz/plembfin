import { state } from "./state.js";
import { escapeHtml } from "./utils.js";

const PROVIDERS = ["plex", "emby", "jellyfin"];
const PROVIDER_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
const REPRESENTATIONS = {
  plex: [["native", "Universal Watchlist"], ["rss", "RSS (read-only)"]],
  emby: [["playlist", "Plembfin playlist"], ["favorites", "Favorites compatibility"]],
  jellyfin: [["playlist", "Plembfin playlist"], ["favorites", "Favorites compatibility"]],
};

let callbacks = {};
let status = null;
let preview = null;
let refreshTimer = null;

function authHeaders() {
  return callbacks.authHeaders?.() || {};
}

function elements() {
  return {
    panel: document.querySelector("#watchlistSyncPanel"),
    enabled: document.querySelector("#watchlistSyncEnabled"),
    interval: document.querySelector("#watchlistSyncInterval"),
    save: document.querySelector("#watchlistSyncSaveButton"),
    providerRows: document.querySelector("#watchlistSyncProviderRows"),
    status: document.querySelector("#watchlistSyncStatus"),
    help: document.querySelector("#watchlistSyncHelp"),
    metrics: document.querySelector("#watchlistSyncMetrics"),
    target: document.querySelector("#settingsWatchlistSyncTarget"),
    previewButton: document.querySelector("#watchlistSyncPreviewButton"),
    run: document.querySelector("#watchlistSyncRunButton"),
    retry: document.querySelector("#watchlistSyncRetryButton"),
    publish: document.querySelector("#watchlistSyncPublishButton"),
    preview: document.querySelector("#watchlistSyncPreview"),
    activity: document.querySelector("#watchlistSyncActivity"),
  };
}

function defaultProviderConfig(provider) {
  return {
    enabled: false,
    representation: provider === "plex" ? "native" : "playlist",
    writeEnabled: false,
    publishConfirmedAt: 0,
  };
}

function currentConfig() {
  const saved = state.savedConfig?.watchlistSync || {};
  return {
    enabled: Boolean(saved.enabled),
    intervalMinutes: Math.max(5, Math.min(1440, Number(saved.intervalMinutes) || 5)),
    importRemoteAdditions: false,
    providers: Object.fromEntries(PROVIDERS.map((provider) => [
      provider,
      { ...defaultProviderConfig(provider), ...(saved.providers?.[provider] || {}) },
    ])),
  };
}

function selectedProviders() {
  const value = elements().target?.value || "all";
  return value === "all" ? [] : [value];
}

function formatWhen(value) {
  const timestamp = Number(value || 0);
  return timestamp > 0 ? new Date(timestamp).toLocaleString() : "Never";
}

function connectionLabel(entry) {
  const connection = entry.connection;
  if (!entry.configured) return "Not connected";
  const name = connection?.serverName || "Connected server";
  const user = connection?.remoteUsername || connection?.remoteUserId;
  return user ? `${name} · ${user}` : name;
}

function representationOptions(provider, selected) {
  return REPRESENTATIONS[provider].map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function renderProviderRows(config = currentConfig()) {
  const ui = elements();
  if (!ui.providerRows) return;
  const entries = status?.providers || PROVIDERS.map((provider) => ({ provider, configured: false, connection: null, capability: "unavailable", queue: {} }));
  ui.providerRows.innerHTML = entries.map((entry) => {
    const provider = entry.provider;
    const saved = config.providers[provider] || defaultProviderConfig(provider);
    const pending = Number(entry.pending || 0);
    const capability = entry.awaitingPublish
      ? "Publish required"
      : entry.capability === "full"
        ? "Ready"
        : entry.capability === "read_only"
          ? "Read-only"
          : entry.reason || entry.capability || "Unavailable";
    return `<div class="personal-watchlist-sync-provider">
      <div class="personal-watchlist-sync-provider-copy">
        <strong>${escapeHtml(PROVIDER_LABELS[provider] || provider)}</strong>
        <small>${escapeHtml(connectionLabel(entry))} · ${escapeHtml(capability)}${pending ? ` · ${pending} queued` : ""}${Number(entry.unavailable || 0) ? ` · ${Number(entry.unavailable)} unavailable` : ""}</small>
      </div>
      <label class="checkbox-label"><input type="checkbox" data-watchlist-sync-enabled="${provider}" ${saved.enabled ? "checked" : ""}> Enable</label>
      <label class="personal-watchlist-sync-representation">Representation
        <select class="field" data-watchlist-sync-representation="${provider}" aria-label="${escapeHtml(PROVIDER_LABELS[provider] || provider)} watchlist representation">
          ${representationOptions(provider, saved.representation)}
        </select>
      </label>
      ${provider === "plex" ? `<label class="checkbox-label"><input type="checkbox" data-watchlist-sync-write="plex" ${saved.writeEnabled ? "checked" : ""}> Allow account writes</label>` : ""}
    </div>`;
  }).join("");
}

function applyControls(config = currentConfig()) {
  const ui = elements();
  if (!ui.enabled) return;
  ui.enabled.checked = Boolean(config.enabled);
  if (ui.interval) ui.interval.value = String(config.intervalMinutes || 5);
  renderProviderRows(config);
}

function selectedConfig() {
  const ui = elements();
  const saved = currentConfig();
  return {
    enabled: Boolean(ui.enabled?.checked),
    intervalMinutes: Math.max(5, Math.min(1440, Math.round(Number(ui.interval?.value) || 5))),
    importRemoteAdditions: false,
    providers: Object.fromEntries(PROVIDERS.map((provider) => [
      provider,
      {
        enabled: Boolean(ui.providerRows?.querySelector(`[data-watchlist-sync-enabled="${provider}"]`)?.checked),
        representation: ui.providerRows?.querySelector(`[data-watchlist-sync-representation="${provider}"]`)?.value || saved.providers[provider].representation,
        ...(provider === "plex" ? { writeEnabled: Boolean(ui.providerRows?.querySelector(`[data-watchlist-sync-write="${provider}"]`)?.checked) } : {}),
        publishConfirmedAt: Number(saved.providers[provider].publishConfirmedAt || 0),
      },
    ])),
  };
}

function setBusy(busy) {
  const ui = elements();
  for (const button of [ui.save, ui.previewButton, ui.run, ui.retry, ui.publish]) {
    if (button) button.disabled = Boolean(busy);
  }
  ui.panel?.toggleAttribute("aria-busy", Boolean(busy));
}

function renderPreview(nextPreview = preview) {
  const ui = elements();
  if (!ui.preview) return;
  if (!nextPreview) {
    ui.preview.classList.add("hidden");
    ui.preview.innerHTML = "";
    return;
  }
  const rows = (nextPreview.providers || []).map((entry) => {
    const missing = Array.isArray(entry.localMissing) ? entry.localMissing : [];
    const additions = Array.isArray(entry.remoteAdditions) ? entry.remoteAdditions : [];
    const unavailable = missing.filter((item) => !item.available || item.ambiguous).length;
    return `<article class="watchlist-sync-preview-provider">
      <div><strong>${escapeHtml(PROVIDER_LABELS[entry.provider] || entry.provider)}</strong><span>${escapeHtml(entry.connection?.serverName || entry.capability || "Unavailable")}</span></div>
      ${entry.error ? `<p class="watchlist-sync-error">${escapeHtml(entry.error)}</p>` : ""}
      <p>${missing.length ? `${missing.length} local item${missing.length === 1 ? "" : "s"} will be published${unavailable ? `; ${unavailable} need attention` : ""}.` : "No local items need publishing."} ${additions.length ? `${additions.length} provider-only item${additions.length === 1 ? "" : "s"} found.` : ""}</p>
    </article>`;
  }).join("");
  ui.preview.innerHTML = `<div class="watchlist-sync-preview-head"><strong>Publish preview</strong><small>Provider additions stay unmanaged by default. Only a Plembfin-owned playlist is eligible for cleanup after confirmation.</small></div>${rows || `<p>No enabled provider is ready for preview.</p>`}`;
  ui.preview.classList.remove("hidden");
}

function renderActivity(rows = []) {
  const ui = elements();
  if (!ui.activity) return;
  if (!rows.length) {
    ui.activity.innerHTML = "<small>No watchlist activity yet.</small>";
    return;
  }
  ui.activity.innerHTML = rows.slice(0, 6).map((row) => `<div class="watchlist-sync-activity-row">
    <span>${escapeHtml(row.action || "sync")}</span>
    <strong>${escapeHtml(row.media?.title || row.details || "Watchlist")}</strong>
    <small>${escapeHtml(row.provider ? PROVIDER_LABELS[row.provider] || row.provider : "Plembfin")} · ${escapeHtml(row.status || "info")} · ${escapeHtml(formatWhen(row.created_at))}</small>
  </div>`).join("");
}

function renderStatus(nextStatus = status) {
  const ui = elements();
  if (!ui.panel || !nextStatus) return;
  const config = currentConfig();
  const pending = Number(nextStatus.queue?.pending || 0) + Number(nextStatus.queue?.processing || 0);
  if (nextStatus.restorePending) ui.status && (ui.status.textContent = "Publish restored list");
  else if (!config.enabled) ui.status && (ui.status.textContent = "Disabled");
  else if (pending) ui.status && (ui.status.textContent = `${pending} queued`);
  else ui.status && (ui.status.textContent = "Ready");

  if (ui.metrics) {
    const unavailable = (nextStatus.providers || []).reduce((sum, provider) => sum + Number(provider.unavailable || 0), 0);
    const lastComplete = (nextStatus.providers || []).map((provider) => provider.lastRun).filter((run) => run?.complete_snapshot && run.status === "succeeded").sort((a, b) => Number(b.completed_at || 0) - Number(a.completed_at || 0))[0];
    ui.metrics.innerHTML = `<div><span>Canonical items</span><b>${Number(nextStatus.canonicalCount || 0)}</b></div><div><span>Pending delivery</span><b>${pending}</b></div><div><span>Unavailable</span><b>${unavailable}</b></div><div><span>Last complete snapshot</span><b>${escapeHtml(formatWhen(lastComplete?.completed_at))}</b></div>`;
  }
  const enabled = (nextStatus.providers || []).filter((entry) => entry.enabled).length;
  const publishable = (nextStatus.providers || []).filter((entry) => entry.enabled && entry.add && entry.remove).length;
  const awaiting = (nextStatus.providers || []).filter((entry) => entry.enabled && !entry.publishConfirmedAt).length;
  if (ui.help) {
    ui.help.textContent = nextStatus.restorePending
      ? "A restore is waiting here. Review the provider preview, then explicitly publish the restored local watchlist."
      : !config.enabled
        ? "Plembfin remains the canonical list. Enable the feature and choose a provider projection to begin."
        : awaiting
          ? `${awaiting} provider${awaiting === 1 ? " is" : "s are"} waiting for an initial publish confirmation. Provider removals are global.`
          : enabled
            ? "Plembfin controls additions; a confirmed provider removal or completed watch removes the item everywhere."
            : "Enable at least one connected provider. Local watchlist actions always save in Plembfin first.";
  }
  ui.run && (ui.run.disabled = !config.enabled || nextStatus.restorePending || !enabled);
  ui.retry && (ui.retry.disabled = !config.enabled || nextStatus.restorePending || !enabled);
  ui.publish && (ui.publish.disabled = !config.enabled || !publishable);
  renderProviderRows(config);
}

export function applyWatchlistSyncConfig(config = {}) {
  if (config?.watchlistSync) state.savedConfig = { ...state.savedConfig, watchlistSync: config.watchlistSync };
  applyControls(currentConfig());
  renderStatus(status);
}

async function requestStatus() {
  const response = await fetch("/api/watchlist-sync/status", { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Watchlist sync status failed with ${response.status}`);
  status = body;
  renderStatus(body);
  return body;
}

export async function refreshWatchlistSyncStatus() {
  if (!state.token) return null;
  const body = await requestStatus();
  const activityResponse = await fetch("/api/watchlist-sync/activity?limit=6", { headers: authHeaders(), cache: "no-store" });
  const activityBody = await activityResponse.json().catch(() => ({}));
  if (activityResponse.ok) renderActivity(activityBody.activity || []);
  return body;
}

async function saveSettings() {
  const ui = elements();
  setBusy(true);
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ watchlistSync: selectedConfig() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (body.details || []).join("; ") || `Watchlist settings save failed with ${response.status}`);
    if (body.config) {
      state.savedConfig = body.config;
      callbacks.onConfig?.(body.config);
      applyControls(body.config.watchlistSync || currentConfig());
    }
    preview = null;
    renderPreview();
    callbacks.setMessage?.("Personal watchlist sync settings saved.", "success");
    await refreshWatchlistSyncStatus().catch(() => null);
  } finally {
    setBusy(false);
  }
}

async function requestPreview() {
  const response = await fetch("/api/watchlist-sync/preview", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ providers: selectedProviders() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Watchlist preview failed with ${response.status}`);
  preview = body;
  renderPreview();
  return body;
}

async function runAction(action) {
  const ui = elements();
  setBusy(true);
  try {
    if (action === "preview") {
      await requestPreview();
      callbacks.setMessage?.("Watchlist publish preview refreshed.", "success");
      return;
    }
    if (action === "publish") {
      const currentPreview = preview || await requestPreview();
      const remoteItems = (currentPreview.providers || []).reduce((sum, entry) => sum + (entry.remoteAdditions || []).length, 0);
      const localItems = Number(currentPreview.canonicalCount || 0);
      const approved = await callbacks.openConfirmDialog?.({
        title: "Publish Plembfin watchlist?",
        body: localItems === 0
          ? `Plembfin has no local watchlist items. This will clear only Plembfin-owned playlist entries on the selected provider${remoteItems ? ` and leave ${remoteItems} unmanaged provider item${remoteItems === 1 ? "" : "s"}` : ""}. Continue?`
          : `Publish ${localItems} canonical Plembfin item${localItems === 1 ? "" : "s"} to the selected provider${remoteItems ? `; ${remoteItems} provider-only item${remoteItems === 1 ? "" : "s"} were found` : ""}. Provider removals are global. Continue?`,
        confirmLabel: "Publish watchlist",
        cancelLabel: "Review later",
        danger: localItems === 0,
      });
      if (!approved) return;
    }
    const response = await fetch("/api/watchlist-sync/run", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action, confirm: action === "publish", providers: selectedProviders() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Personal watchlist sync failed with ${response.status}`);
    if (body.requiresPublish) callbacks.setMessage?.("Restore completed locally. Publish the restored watchlist before provider delivery.", "muted");
    else callbacks.setMessage?.(action === "publish" ? "Plembfin watchlist published." : action === "retry" ? "Watchlist retries started." : "Personal watchlist sync completed.", body.ok === false ? "muted" : "success");
    await refreshWatchlistSyncStatus().catch(() => null);
  } catch (error) {
    callbacks.setMessage?.(error.message || "Personal watchlist sync failed.", "error");
  } finally {
    setBusy(false);
    renderStatus(status);
    ui.panel?.removeAttribute("aria-busy");
  }
}

export function initWatchlistSyncSettings(nextCallbacks = {}) {
  callbacks = nextCallbacks;
  const ui = elements();
  if (!ui.panel || ui.panel.dataset.bound === "1") return;
  ui.panel.dataset.bound = "1";
  applyControls(currentConfig());
  ui.save?.addEventListener("click", () => saveSettings().catch((error) => callbacks.setMessage?.(error.message, "error")));
  ui.previewButton?.addEventListener("click", () => runAction("preview"));
  ui.run?.addEventListener("click", () => runAction("run"));
  ui.retry?.addEventListener("click", () => runAction("retry"));
  ui.publish?.addEventListener("click", () => runAction("publish"));
  ui.panel.addEventListener("change", (event) => {
    if (event.target.matches("[data-watchlist-sync-enabled], [data-watchlist-sync-representation], [data-watchlist-sync-write]")) {
      ui.panel.dataset.dirty = "1";
      if (ui.save) ui.save.disabled = false;
    }
  });
  document.addEventListener("plembfin:config-changed", () => {
    applyControls(currentConfig());
    refreshWatchlistSyncStatus().catch(() => null);
  });
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && state.token) refreshWatchlistSyncStatus().catch(() => null);
  }, 30_000);
}

export function stopWatchlistSyncSettings() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}
