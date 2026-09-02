import { state } from "./state.js";
import { escapeHtml } from "./utils.js";

const PROVIDERS = ["plex", "emby", "jellyfin", "trakt"];
const PROVIDER_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin", trakt: "Trakt" };
const DIRECTIONS = [
  ["bidirectional", "Two-way sync"],
  ["off", "Off"],
];

let callbacks = {};
let status = null;
let refreshTimer = null;

function authHeaders() {
  return callbacks.authHeaders?.() || {};
}

function elements() {
  return {
    panel: document.querySelector("#ratingSyncPanel"),
    enabled: document.querySelector("#ratingSyncEnabled"),
    interval: document.querySelector("#ratingSyncInterval"),
    initialMode: document.querySelector("#ratingSyncInitialMode"),
    conflictPolicy: document.querySelector("#ratingSyncConflictPolicy"),
    save: document.querySelector("#ratingSyncSaveButton"),
    providerRows: document.querySelector("#ratingSyncProviderRows"),
    status: document.querySelector("#ratingSyncStatus"),
    help: document.querySelector("#ratingSyncHelp"),
    target: document.querySelector("#settingsRatingSyncTarget"),
    run: document.querySelector("#ratingSyncRunButton"),
    push: document.querySelector("#ratingSyncPushButton"),
  };
}

function currentConfig() {
  const saved = state.savedConfig?.ratingSync || {};
  const enabled = Boolean(saved.enabled);
  const allSavedOff = PROVIDERS.every((p) => !saved.providers?.[p] || saved.providers?.[p] === "off");
  return {
    enabled,
    intervalMinutes: Number(saved.intervalMinutes) || 15,
    initialSyncMode: saved.initialSyncMode === "import" ? "import" : "baseline",
    conflictPolicy: saved.conflictPolicy === "remote_wins" ? "remote_wins" : "local_wins",
    providers: Object.fromEntries(PROVIDERS.map((provider) => {
      if (!enabled) return [provider, saved.providers?.[provider] || "off"];
      if (allSavedOff) return [provider, "bidirectional"];
      const val = saved.providers?.[provider];
      return [provider, val === "off" ? "off" : "bidirectional"];
    })),
  };
}

function renderProviderRows(config = currentConfig()) {
  const ui = elements();
  if (!ui.providerRows) return;
  const entries = status?.providers || PROVIDERS.map((provider) => ({ provider, configured: false, connectionStatus: "not_connected", queue: {} }));
  ui.providerRows.innerHTML = entries.map((entry) => {
    const provider = entry.provider;
    const connection = entry.configured ? (entry.connectionStatus || "configured") : "Not connected";
    const direction = config.providers[provider] || (config.enabled ? "bidirectional" : "off");
    const pending = Number(entry.queue?.pending || 0) + Number(entry.queue?.processing || 0);
    const queueDetails = [
      pending ? `${pending} queued` : "",
      ...queueIssueDetails(entry.queue),
    ].filter(Boolean);
    return `<label class="personal-rating-sync-provider">
      <strong>${escapeHtml(PROVIDER_LABELS[provider] || provider)}</strong>
      <small>${escapeHtml([connection, ...queueDetails].join(" · "))}</small>
      <select data-rating-sync-provider="${provider}" aria-label="${escapeHtml(PROVIDER_LABELS[provider] || provider)} rating sync direction">
        ${DIRECTIONS.map(([value, label]) => `<option value="${value}" ${direction === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </label>`;
  }).join("");
}

function applyControls(config = currentConfig()) {
  const ui = elements();
  if (!ui.enabled) return;
  ui.enabled.checked = Boolean(config.enabled);
  if (ui.interval) ui.interval.value = String(config.intervalMinutes || 15);
  if (ui.initialMode) ui.initialMode.value = config.initialSyncMode || "baseline";
  if (ui.conflictPolicy) ui.conflictPolicy.value = config.conflictPolicy || "local_wins";
  renderProviderRows(config);
}

function selectedConfig() {
  const ui = elements();
  const enabled = Boolean(ui.enabled?.checked);
  return {
    enabled,
    intervalMinutes: Math.max(5, Math.min(1440, Math.round(Number(ui.interval?.value) || 15))),
    initialSyncMode: ui.initialMode?.value === "import" ? "import" : "baseline",
    conflictPolicy: ui.conflictPolicy?.value === "remote_wins" ? "remote_wins" : "local_wins",
    providers: Object.fromEntries(PROVIDERS.map((provider) => {
      const selectVal = ui.providerRows?.querySelector(`[data-rating-sync-provider="${provider}"]`)?.value;
      if (!enabled) return [provider, "off"];
      return [provider, selectVal === "off" ? "off" : "bidirectional"];
    })),
  };
}

function selectedProviders() {
  const value = elements().target?.value || "all";
  return value === "all" ? [] : [value];
}

function queueIssueCount(queue = {}) {
  return Number(queue.failed || 0)
    + Number(queue.not_found ?? queue.notFound ?? 0)
    + Number(queue.reauth_required ?? queue.reauthRequired ?? 0);
}

function queueIssueDetails(queue = {}) {
  const details = [];
  const failed = Number(queue.failed || 0);
  const notFound = Number(queue.not_found ?? queue.notFound ?? 0);
  const reauthRequired = Number(queue.reauth_required ?? queue.reauthRequired ?? 0);
  if (failed) details.push(`${failed} failed`);
  if (notFound) details.push(`${notFound} not found`);
  if (reauthRequired) details.push(`${reauthRequired} need re-auth`);
  return details;
}

function setBusy(busy) {
  const ui = elements();
  for (const button of [ui.save, ui.run, ui.push]) {
    if (button) button.disabled = Boolean(busy);
  }
  ui.panel?.toggleAttribute("aria-busy", Boolean(busy));
}

function renderStatus(nextStatus = status) {
  const ui = elements();
  if (!ui.panel || !nextStatus) return;
  const config = nextStatus.config || currentConfig();
  if (nextStatus.running) {
    if (ui.status) ui.status.textContent = "Running…";
  } else if (!config.enabled) {
    if (ui.status) ui.status.textContent = "Disabled";
  } else {
    const pending = Number(nextStatus.queue?.pending || 0) + Number(nextStatus.queue?.processing || 0);
    const issues = queueIssueCount(nextStatus.queue);
    if (ui.status) ui.status.textContent = issues
      ? `${issues} sync issue${issues === 1 ? "" : "s"}`
      : pending ? `${pending} queued` : "Two-way Active";
  }
  const configured = (nextStatus.providers || []).filter((entry) => entry.configured && entry.direction !== "off").length;
  const issues = queueIssueCount(nextStatus.queue);
  if (ui.help) {
    ui.help.textContent = !config.enabled
      ? "Disabled: ratings stay in Plembfin and are not sent to any provider."
      : issues
        ? "Some ratings need attention. Review the provider rows and run sync again."
        : configured
        ? `Two-way rating sync active across ${configured} connected provider${configured === 1 ? "" : "s"}.`
        : "Connect at least one media server or Trakt to sync ratings.";
  }
  ui.run && (ui.run.disabled = !config.enabled || nextStatus.running);
  ui.push && (ui.push.disabled = !config.enabled || nextStatus.running);
}

export function applyRatingSyncConfig(config = {}) {
  if (config?.ratingSync) {
    state.savedConfig = { ...state.savedConfig, ratingSync: config.ratingSync };
  }
  applyControls(currentConfig());
  renderStatus(status);
}

export async function refreshRatingSyncStatus() {
  if (!state.token) return null;
  const response = await fetch("/api/rating-sync/status", { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Rating sync status failed with ${response.status}`);
  status = body;
  if (body.config) {
    state.savedConfig = { ...state.savedConfig, ratingSync: body.config };
    applyControls(body.config);
  }
  renderStatus(body);
  return body;
}

async function saveSettings() {
  const ui = elements();
  const payload = selectedConfig();
  setBusy(true);
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ratingSync: payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (body.details || []).join("; ") || `Rating settings save failed with ${response.status}`);
    if (body.config) {
      state.savedConfig = body.config;
      callbacks.onConfig?.(body.config);
      applyControls(body.config.ratingSync || payload);
    }
    callbacks.setMessage?.("Personal rating sync settings saved.", "success");
    await refreshRatingSyncStatus().catch(() => null);
  } finally {
    setBusy(false);
  }
}

async function runAction(action) {
  const ui = elements();
  setBusy(true);
  try {
    const response = await fetch("/api/rating-sync/run", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action, providers: selectedProviders() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Personal rating sync failed with ${response.status}`);
    const issues = queueIssueCount(body.queue);
    const partial = body.status === "partial" || issues > 0;
    const actionLabel = action === "push" ? "Local rating push" : "Personal rating sync";
    callbacks.setMessage?.(partial
      ? `${actionLabel} completed with ${issues || "some"} sync issue${issues === 1 ? "" : "s"}. Review Settings → Sync Tools.`
      : action === "push" ? "Local ratings pushed to the selected provider(s)." : "Personal rating sync completed.", partial ? "muted" : "success");
    await refreshRatingSyncStatus().catch(() => null);
  } catch (error) {
    callbacks.setMessage?.(error.message || "Personal rating sync failed.", "error");
  } finally {
    setBusy(false);
    renderStatus(status);
  }
}

export function initRatingSyncSettings(nextCallbacks = {}) {
  callbacks = nextCallbacks;
  const ui = elements();
  if (!ui.panel || ui.panel.dataset.bound === "1") return;
  ui.panel.dataset.bound = "1";
  applyControls(currentConfig());
  ui.enabled?.addEventListener("change", () => {
    const isEnabled = Boolean(ui.enabled.checked);
    for (const provider of PROVIDERS) {
      const select = ui.providerRows?.querySelector(`[data-rating-sync-provider="${provider}"]`);
      if (select) {
        select.value = isEnabled ? "bidirectional" : "off";
      }
    }
    renderStatus({ ...(status || {}), config: selectedConfig() });
  });
  ui.save?.addEventListener("click", () => saveSettings().catch((error) => callbacks.setMessage?.(error.message, "error")));
  ui.run?.addEventListener("click", () => runAction("run"));
  ui.push?.addEventListener("click", () => runAction("push"));
  ui.panel.addEventListener("change", (event) => {
    if (event.target.matches("[data-rating-sync-provider]")) renderStatus({ ...(status || {}), config: selectedConfig() });
  });
  document.addEventListener("plembfin:config-changed", () => {
    applyControls(currentConfig());
    refreshRatingSyncStatus().catch(() => null);
  });
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && state.token) refreshRatingSyncStatus().catch(() => null);
  }, 30_000);
}

export function stopRatingSyncSettings() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}
