// Guided first-run setup (`/setup`). Talks to the /api/setup/* endpoints
// added alongside this module and reuses the same Settings building blocks
// wherever possible - openServiceEditModal() for every provider connect/test
// flow, and the webhook-guide functions - so setup and Settings never diverge
// in behavior, only in presentation.
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute } from "./utils.js";
import { openServiceEditModal } from "./settings-services.js";
import { plexWebhookSetup, embyWebhookSetup, jellyfinWebhookSetup, buildWebhookUrl } from "./help-content.js";
import { claimAdminAccount } from "./auth.js";

let _cb = {};
export function initOnboarding(callbacks = {}) {
  _cb = callbacks;
  document.addEventListener("click", handleSetupClick);
  document.addEventListener("change", handleSetupChange);
  // A Settings modal (connect/save/disconnect) can change server/metadata
  // state while the wizard is open behind it - refresh so the step reflects
  // it as soon as the modal closes, without polling.
  document.addEventListener("plembfin:config-changed", () => {
    if (state.activeView === "setup") loadSetupStatus().catch(() => {});
  });
  // See checkTraktFlow() - re-check immediately when the user switches back
  // from the trakt.tv activation tab instead of waiting on a throttled timer.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && traktFlow && state.activeView === "setup" && currentStep() === "trakt") {
      checkTraktFlow();
    }
  });
}

const authHeaders = (...args) => _cb.authHeaders?.(...args) || {};
const navigateTo = (...args) => _cb.navigateTo?.(...args);
const setMessage = (...args) => _cb.setMessage?.(...args);
const setUnlocked = (...args) => _cb.setUnlocked?.(...args);
const loadHistory = (...args) => _cb.loadHistory?.(...args) || Promise.resolve();
const loadSavedConfig = (...args) => _cb.loadSavedConfig?.(...args) || Promise.resolve();
const startHistoryPolling = (...args) => _cb.startHistoryPolling?.(...args);

export function setClaimRequired(isRequired) {
  elements.authPanelSignIn?.classList.toggle("hidden", isRequired);
  elements.claimPanel?.classList.toggle("hidden", !isRequired);
}

export async function claimWithForm(username, password, confirmPassword) {
  const cleanUsername = String(username || "").trim();
  if (!cleanUsername || !password) {
    elements.claimMessage.textContent = "Choose a username and password.";
    elements.claimMessage.dataset.tone = "error";
    return;
  }
  if (password !== confirmPassword) {
    elements.claimMessage.textContent = "Passwords do not match.";
    elements.claimMessage.dataset.tone = "error";
    return;
  }
  const result = await claimAdminAccount(cleanUsername, password, confirmPassword);
  state.currentUser = result.user;
  state.token = result.token;
  if (elements.settingsUsername) elements.settingsUsername.value = cleanUsername;
  localStorage.setItem("adminUsername", cleanUsername);
  setClaimRequired(false);
  setUnlocked(true);
  navigateTo("/setup");
  await loadHistory().catch(() => {});
  await loadSavedConfig().catch(() => {});
  startHistoryPolling();
}

// Called from dashboard.js's renderDashboard() - the checklist reflects
// server-derived state (cachedStatus.checklist), so it stays in sync with
// Settings without dashboard.js needing to know anything about onboarding.
export function renderDashboardChecklist() {
  const container = elements.dashboardChecklist;
  if (!container) return;
  const items = cachedStatus?.checklist || [];
  if (!items.length) { container.innerHTML = ""; return; }
  const descriptions = {
    connect_tmdb: "Add artwork, episode details, and discovery metadata.",
    connect_trakt: "Keep watched state synchronized with Trakt.",
    configure_seerr: "Connect media requests and availability.",
    create_backup: "Protect settings, connections, and watch history.",
    store_credential_key: "Keep recovery access outside this Plembfin server.",
  };
  container.innerHTML = `
    <section class="glass-panel dashboard-setup-checklist" id="dashboardChecklistPanel" aria-labelledby="dashboardChecklistTitle">
      <div class="dashboard-setup-checklist-head">
        <div class="dashboard-setup-checklist-title">
          <h2 id="dashboardChecklistTitle">Finish setting up Plembfin</h2>
          <p>${items.length} recommended task${items.length === 1 ? "" : "s"} remaining</p>
          <span class="badge">${items.length} remaining</span>
        </div>
        <button type="button" class="button-ghost" data-setup-dismiss-checklist="1" aria-label="Dismiss setup checklist">Dismiss</button>
      </div>
      <ol class="dashboard-setup-actions">
        ${items.map((item, index) => `
          <li>
            <a href="${escapeHtml(item.href)}" class="dashboard-setup-action">
              <span class="dashboard-setup-action-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
              <span class="dashboard-setup-action-copy"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(descriptions[item.id] || "Complete this recommended setup task.")}</span></span>
              <span class="dashboard-setup-action-arrow" aria-hidden="true">→</span>
            </a>
          </li>`).join("")}
      </ol>
    </section>`;
}

export function renderSetupResumeBanner() {
  const container = document.querySelector("#settings-view");
  if (!container) return;
  const existing = document.getElementById("setupResumeBanner");
  const html = setupResumeBannerHtml();
  if (!html) { existing?.remove(); return; }
  if (existing) { existing.outerHTML = html; return; }
  container.insertAdjacentHTML("afterbegin", html);
}

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
const STEPS = [
  { id: "overview", label: "Overview" },
  { id: "trakt", label: "Trakt" },
  { id: "metadata", label: "Metadata" },
  { id: "servers", label: "Media servers" },
  { id: "webhooks", label: "Webhooks" },
  { id: "backup", label: "Backup" },
  { id: "imports", label: "Import & sync" },
  { id: "review", label: "Review" },
];
const SKIPPABLE_STEPS = new Set(["servers", "metadata", "webhooks", "backup"]);
const STEP_TITLES = {
  overview: "Set up Plembfin",
  servers: "Connect media servers",
  metadata: "Add metadata",
  webhooks: "Enable reliable updates",
  trakt: "Connect Trakt",
  imports: "Import progress",
  backup: "Protect your Plembfin data",
  review: "Review and finish",
};

let cachedStatus = null;
let statusLoading = null;
let traktFlow = null;
let preferEarlierTraktDateChoice = true;
let traktPollTimer = null;
let importStatusPollTimer = null;
let backupSetupData = null;
let backupSetupLoading = null;

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Request failed");
    error.code = data.code || "";
    throw error;
  }
  return data;
}

export async function loadSetupStatus() {
  if (statusLoading) return statusLoading;
  statusLoading = api("/api/setup/status")
    .then((data) => {
      cachedStatus = data;
      renderSetupPage();
      return data;
    })
    .finally(() => { statusLoading = null; });
  return statusLoading;
}

async function loadBackupSetupData({ force = false } = {}) {
  if (backupSetupLoading) return backupSetupLoading;
  if (backupSetupData && !force) return backupSetupData;
  backupSetupLoading = Promise.all([api("/api/plembfin-backups"), api("/api/watch-backups")])
    .then(([plembfin, watch]) => {
      backupSetupData = { plembfin, watch };
      if (currentStep() === "backup") renderSetupPage();
      return backupSetupData;
    })
    .catch((error) => {
      setMessage(error.message, "error");
      return null;
    })
    .finally(() => { backupSetupLoading = null; });
  return backupSetupLoading;
}

// Checked by default but not started until Continue is clicked on the
// servers step (see startPendingServerImports) - checking the box before
// then would defeat the point of being able to opt a server out first.
const pendingServerImportChoice = new Map();
let pendingTraktImportChoice = null;

function serverImportPending(provider) {
  if (pendingServerImportChoice.has(provider)) return pendingServerImportChoice.get(provider);
  const existing = importState(provider);
  return existing ? existing.enabled !== false : true;
}

async function startPendingServerImports() {
  for (const server of cachedStatus?.servers || []) {
    if (!server.tested) continue;
    if (!serverImportPending(server.provider)) continue;
    if (importState(server.provider)) continue; // already started/finished
    await api("/api/setup/import", { method: "POST", body: JSON.stringify({ target: server.provider, action: "start" }) }).catch(() => {});
  }
  pendingServerImportChoice.clear();
  await loadSetupStatus();
}

function traktImportPending() {
  if (pendingTraktImportChoice !== null) return pendingTraktImportChoice;
  const existing = cachedStatus?.onboarding?.backgroundImports?.trakt;
  return existing?.enabled !== false;
}

async function startPendingTraktImport() {
  const existing = cachedStatus?.onboarding?.backgroundImports?.trakt;
  if (!cachedStatus?.trakt?.connected || !traktImportPending() || (existing && existing.status !== "not_started")) {
    pendingTraktImportChoice = null;
    return true;
  }
  try {
    await api("/api/setup/import", { method: "POST", body: JSON.stringify({ target: "trakt", action: "start" }) });
    pendingTraktImportChoice = null;
    await loadSetupStatus();
    return true;
  } catch (error) {
    setMessage(error.message, "error");
    await loadSetupStatus();
    return false;
  }
}

function setCurrentStep(stepId) {
  if (!cachedStatus) return;
  cachedStatus.onboarding.currentStep = stepId;
  renderSetupPage();
  api("/api/setup/step", { method: "POST", body: JSON.stringify({ currentStep: stepId }) }).catch(() => {});
}

function currentStep() {
  return cachedStatus?.onboarding?.currentStep || "overview";
}

function stepDone(id) {
  if (!cachedStatus) return false;
  const { servers, trakt, metadata, onboarding } = cachedStatus;
  if (id === "overview") return true;
  if (id === "servers") return servers.some((s) => s.tested);
  if (id === "metadata") return Boolean(metadata.tmdbConfigured);
  if (id === "webhooks") return servers.filter((s) => s.tested && webhookSetupRequired(s.provider)).every((s) => onboarding.acknowledgements.webhooks?.[s.provider]);
  if (id === "trakt") return trakt.connected || onboarding.acknowledgements.traktSkipped;
  if (id === "imports") return true;
  if (id === "backup") return Boolean(backupSetupData?.plembfin?.config?.enabled);
  return false;
}

export function renderSetupPage() {
  const root = elements.setupPageRoot;
  if (!root) return;
  clearTimeout(importStatusPollTimer);
  importStatusPollTimer = null;
  if (!cachedStatus) {
    root.innerHTML = `<div class="settings-content"><p class="muted-copy">Loading setup...</p></div>`;
    return;
  }
  const step = currentStep();
  const canFinish = cachedStatus.servers.some((s) => s.tested);
  const logoSrc = document.documentElement.classList.contains("light-mode") ? "/plembfin_header_logo_light.png" : "/plembfin_header_logo_dark.png";
  root.innerHTML = `
    <div class="setup-brand">
      <img class="setup-brand-logo brand-logo" src="${logoSrc}" alt="Plembfin" />
    </div>
    <section class="glass-panel p-section setup-shell">
      <div class="section-heading">
        <div><h2>${escapeHtml(STEP_TITLES[step] || "Setup")}</h2></div>
        <div class="setup-header-actions">
          <span>Step ${STEPS.findIndex((s) => s.id === step) + 1} of ${STEPS.length}</span>
          <button type="button" class="button-ghost" data-setup-action="exit">Exit to Settings</button>
        </div>
      </div>
      <div class="setup-progress" role="tablist" aria-label="Setup progress">
        ${STEPS.map((s) => `<button type="button" class="segment-button setup-progress-step${s.id === step ? " active" : ""}${stepDone(s.id) ? " done" : ""}" data-setup-step="${s.id}">${escapeHtml(s.label)}</button>`).join("")}
      </div>
      <div class="setup-step-body">${renderStep(step, canFinish)}</div>
      <div class="setup-actions">
        <span style="display:flex; gap:8px;">
          ${step !== "overview" ? `<button type="button" class="button-ghost" data-setup-action="back">Back</button>` : ""}
        </span>
        ${step === "review"
          ? `<button type="button" class="button-primary" data-setup-action="complete" ${canFinish ? "" : "disabled"}>Open dashboard</button>`
          : step === "trakt" && !cachedStatus.trakt.connected && !traktFlow
            ? `<span style="display:flex; gap:8px;">
                <button type="button" class="button-ghost" data-setup-action="trakt-skip">Skip for now</button>
                <button type="button" class="button-primary" data-setup-action="continue">Continue</button>
              </span>`
            : SKIPPABLE_STEPS.has(step) && !stepDone(step)
              ? `<button type="button" class="button-ghost" data-setup-action="continue">Skip for now</button>`
              : `<button type="button" class="button-primary" data-setup-action="continue">Continue</button>`}
      </div>
    </section>`;
  if (step === "backup") updateBackupContinueAction();
  scheduleImportStatusRefresh(step);
  if (step === "backup" && !backupSetupData && !backupSetupLoading) loadBackupSetupData().catch(() => {});
}

function scheduleImportStatusRefresh(step) {
  if (step !== "imports" || state.activeView !== "setup") return;
  const serverImports = Object.values(cachedStatus?.onboarding?.backgroundImports?.servers || {});
  const traktImport = cachedStatus?.onboarding?.backgroundImports?.trakt;
  if (![...serverImports, traktImport].some((entry) => entry?.enabled !== false && entry?.status === "importing")) return;
  importStatusPollTimer = setTimeout(() => {
    importStatusPollTimer = null;
    if (state.activeView === "setup" && currentStep() === "imports") loadSetupStatus().catch(() => {});
  }, 1500);
}

function renderStep(step, canFinish) {
  if (step === "overview") return renderOverview();
  if (step === "servers") return renderServers();
  if (step === "metadata") return renderMetadata();
  if (step === "webhooks") return renderWebhooks();
  if (step === "trakt") return renderTrakt();
  if (step === "imports") return renderImports();
  if (step === "backup") return renderBackup();
  if (step === "review") return renderReview(canFinish);
  return "";
}

const OVERVIEW_STEPS = [
  {
    title: "Trakt", tag: "Optional",
    detail: "Connect Trakt for two-way watch-state sync, including individual rewatches, using Plembfin's built-in app credentials - no personal API key or VIP required. Connecting here first lets its watch dates take priority when your media servers are imported next.",
  },
  {
    title: "Metadata", tag: "Recommended",
    detail: "Add a free TMDB key for posters, backdrops, cast, and episode details. TheTVDB and Fanart.tv already work out of the box with a shared key for accurate episode numbering and extra artwork.",
  },
  {
    title: "Media servers", tag: "Required",
    detail: "Connect and test at least one Plex, Emby, or Jellyfin server so Plembfin can read your library and current watch state. You can connect more than one server at once.",
  },
  {
    title: "Webhooks", tag: "Recommended",
    detail: "Plex sends watch-state changes to Plembfin automatically. Emby and Jellyfin need a webhook configured on the server so changes arrive instantly instead of waiting on the next scheduled check.",
  },
  {
    title: "Backup", tag: "Optional",
    detail: "Schedule encrypted local backups of settings, connections, and watch history, with an optional Backblaze B2 mirror for off-server storage.",
  },
  {
    title: "Import & sync", tag: "Optional",
    detail: "Choose whether to import each server's existing watched history, so Plembfin starts with your full watch history instead of only tracking new activity from today.",
  },
];

function renderOverview() {
  return `
    <p class="muted-copy">Connect the media servers that hold your library, add the metadata that powers artwork and discovery, and choose how Plembfin should stay in sync. Everything here can be revisited later from Settings, and progress saves automatically as you go.</p>
    <div class="settings-card-grid setup-overview-list">
      ${OVERVIEW_STEPS.map((item) => `
        <div class="settings-card setup-overview-item">
          <div class="setup-overview-item-heading">
            <b>${escapeHtml(item.title)}</b>
            <span class="badge${item.tag === "Required" ? " badge-warning" : ""}">${escapeHtml(item.tag)}</span>
          </div>
          <p class="muted-copy">${escapeHtml(item.detail)}</p>
        </div>`).join("")}
    </div>`;
}

function serverStatusBadge(server) {
  if (server.tested) return `<span class="badge badge-success">Connected</span>`;
  if (server.connected) return `<span class="badge badge-warning">Saved, not tested</span>`;
  return `<span class="badge">Not connected</span>`;
}

function importState(provider) {
  return cachedStatus.onboarding.backgroundImports.servers[provider] || null;
}

function importStatusLine(importInfo) {
  if (!importInfo || importInfo.enabled === false) return "";
  if (importInfo.status === "importing") return `<p class="muted-copy setup-import-status-line">Importing... ${importInfo.itemCount ?? 0} items so far.</p>`;
  if (importInfo.status === "complete") return `<p class="muted-copy setup-import-status-line">Import complete: ${importInfo.itemCount ?? 0} items.</p>`;
  if (importInfo.status === "failed") return `<p class="muted-copy setup-import-status-line is-error">Import failed: ${escapeHtml(importInfo.error || "unknown error")}. <a href="#" data-setup-import-retry="1">Retry</a></p>`;
  return "";
}

const SERVER_BLURBS = {
  plex: "Connect your Plex account and pick your server.",
  emby: "Sign in with your Emby username and password.",
  jellyfin: "Use Quick Connect, or sign in directly.",
};

// Trakt is a more durable record of when something was actually watched than
// a media server's own "last watched" date (see loadTraktWatchedDateIndex in
// mediaForceSync.js) - but that preference can only apply if Trakt's own
// import has already finished by the time these servers are pulled. Trakt
// connects earlier in the wizard now specifically so this can be true; this
// banner tells the user whether that's actually the case yet.
function traktSyncStatusBanner() {
  const trakt = cachedStatus.trakt;
  const traktImport = cachedStatus.onboarding.backgroundImports.trakt;
  if (!trakt.connected) {
    return `<div class="guide-callout setup-trakt-sync-note">Trakt isn't connected, so these imports will use each server's own watched dates as-is. Go back to the Trakt step first if you'd rather its dates take priority.</div>`;
  }
  if (traktImport?.enabled !== false && traktImport?.status === "importing") {
    return `<div class="guide-callout setup-trakt-sync-note">Trakt is still importing your watch history${traktImport.itemCount != null ? ` (${traktImport.itemCount} items so far)` : ""}. Continuing will queue these server imports until Trakt finishes, so its watch dates take priority over the servers' own.</div>`;
  }
  if (traktImport?.enabled !== false && traktImport?.status === "complete") {
    return `<div class="guide-callout setup-trakt-sync-note">Trakt sync is complete - these server imports will start right away and use Trakt's watch dates wherever they're earlier.</div>`;
  }
  return `<div class="guide-callout setup-trakt-sync-note">Trakt is connected but its watch history import was skipped, so these imports will use each server's own watched dates as-is.</div>`;
}

function renderServers() {
  const rows = MEDIA_SERVERS.map((provider) => {
    const server = cachedStatus.servers.find((s) => s.provider === provider);
    const importInfo = importState(provider);
    const checked = serverImportPending(provider);
    return `
      <div class="settings-card setup-server-row" data-setup-server="${provider}">
        <div class="setup-server-row-main">
          <div>
            <div class="setup-server-row-title">
              <b class="setup-server-name">${escapeHtml(server.serverName || provider)}</b>
              ${serverStatusBadge(server)}
            </div>
            ${server.baseUrl ? `
              <p class="muted-copy setup-server-detail">Server - ${escapeHtml(server.baseUrl)}</p>
              ${server.remoteUsername ? `<p class="muted-copy setup-server-detail">User - ${escapeHtml(server.remoteUsername)}</p>` : ""}
            ` : `<p class="muted-copy setup-server-detail">${SERVER_BLURBS[provider]}</p>`}
          </div>
          <button type="button" class="button-primary" data-setup-connect="${provider}">${server.connected ? "Edit connection" : "Set up"}</button>
        </div>
        ${server.tested ? `
          <label class="field-label setup-import-toggle-label">
            <input type="checkbox" data-setup-import-toggle="${provider}" ${checked ? "checked" : ""} />
            Import watched status from ${escapeHtml(server.serverName || provider)}
          </label>
          ${importStatusLine(importInfo)}
        ` : ""}
      </div>`;
  }).join("");
  return `
    <p class="muted-copy">Connect and test at least one server to continue. You can connect more than one.</p>
    ${traktSyncStatusBanner()}
    <div class="setup-server-rows">${rows}</div>`;
}

function renderMetadata() {
  const tmdbConfigured = cachedStatus.metadata.tmdbConfigured;
  const built = cachedStatus.metadata.builtInAvailable;
  return `
    <p class="muted-copy">TMDB powers posters, backdrops, episode details, and search.</p>
    <div class="settings-card setup-metadata-card">
      <div class="setup-metadata-heading">
        <b>TMDB</b>
        ${tmdbConfigured ? `<span class="badge badge-success">Configured</span>` : `<span class="badge">Not configured</span>`}
      </div>
      <div class="setup-metadata-actions">
        <button type="button" class="button-ghost" data-setup-connect="tmdb">${tmdbConfigured ? "Edit" : "Add TMDB key"}</button>
        <a class="button-ghost" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">Get a free TMDB key</a>
      </div>
    </div>
    <details class="setup-metadata-optional" open>
      <summary>Optional metadata providers</summary>
      <p class="muted-copy setup-metadata-optional-intro">TheTVDB and Fanart.tv already work out of the box with a shared key - add a personal key for higher rate limits. OMDb and YouTube are off until you add a free key.</p>
      <div class="settings-card-grid setup-metadata-optional-grid">
        <div class="settings-card">
          <b>TheTVDB</b>
          <p class="muted-copy setup-metadata-provider-desc">Episode ordering and air dates - more accurate season/episode numbering than TMDB alone.</p>
          <p class="muted-copy setup-metadata-provider-status">${built.tvdb ? "Using built-in access" : "Not configured"}</p>
          <button type="button" class="button-ghost" data-setup-connect="tvdb">Add personal key</button>
        </div>
        <div class="settings-card">
          <b>Fanart.tv</b>
          <p class="muted-copy setup-metadata-provider-desc">Fallback posters, backdrops, and logos when TMDB has no artwork for a title.</p>
          <p class="muted-copy setup-metadata-provider-status">${built.fanart ? "Using built-in access" : "Not configured"}</p>
          <button type="button" class="button-ghost" data-setup-connect="fanart">Add personal key</button>
        </div>
        <div class="settings-card">
          <b>OMDb</b>
          <p class="muted-copy setup-metadata-provider-desc">IMDb ratings shown next to the TMDB score on movie pages. Free key, 1,000 requests/day.</p>
          <button type="button" class="button-ghost" data-setup-connect="omdb">Add key</button>
        </div>
        <div class="settings-card">
          <b>YouTube</b>
          <p class="muted-copy setup-metadata-provider-desc">Trailer titles, descriptions, and durations for the trailer player.</p>
          <button type="button" class="button-ghost" data-setup-connect="youtube">Add key</button>
        </div>
      </div>
    </details>`;
}

function webhookGuideFor(provider) {
  if (provider === "plex") return plexWebhookSetup();
  if (provider === "emby") return embyWebhookSetup();
  return jellyfinWebhookSetup();
}

function webhookSetupRequired(provider) {
  return provider === "emby" || provider === "jellyfin";
}

function webhookProviderName(provider) {
  if (provider === "plex") return "Plex";
  if (provider === "emby") return "Emby";
  return "Jellyfin";
}

function renderWebhooks() {
  const testedServers = cachedStatus.servers.filter((s) => s.tested);
  if (!testedServers.length) {
    return `<p class="muted-copy">Connect and test a media server first, then come back here to set up its webhook.</p>`;
  }
  const cards = testedServers.map((server) => {
    const requiresSetup = webhookSetupRequired(server.provider);
    const acked = Boolean(cachedStatus.onboarding.acknowledgements.webhooks?.[server.provider]);
    const title = `<span class="setup-webhook-title"><b>${escapeHtml(webhookProviderName(server.provider))}</b><span>&nbsp;- ${escapeHtml(server.serverName || `${webhookProviderName(server.provider)} server`)}</span></span>`;
    if (!requiresSetup) {
      return `
        <section class="settings-card setup-webhook-row setup-webhook-row--automatic" data-setup-webhook-provider="${escapeHtml(server.provider)}">
          <div class="setup-webhook-row-heading">
            ${title}
            <span class="badge badge-success">Automatic</span>
          </div>
          <p class="setup-webhook-automatic-copy"><b>No webhook setup required.</b> Plembfin receives Plex watch-state changes directly and checks playback progress every minute.</p>
        </section>`;
    }
    return `
      <details class="settings-card setup-webhook-row setup-webhook-accordion" data-setup-webhook-provider="${escapeHtml(server.provider)}">
        <summary class="setup-webhook-row-heading">
          <span class="setup-webhook-summary-main">
            <span class="setup-webhook-chevron" aria-hidden="true">›</span>
            ${title}
          </span>
          ${acked ? `<span class="badge badge-success">Configured</span>` : `<span class="badge badge-warning">Setup needed</span>`}
        </summary>
        <div class="setup-webhook-accordion-body">
          ${webhookGuideFor(server.provider)}
          <label class="field-label setup-webhook-confirmation">
            <input type="checkbox" data-setup-webhook-ack="${server.provider}" ${acked ? "checked" : ""} />
            I have configured the ${escapeHtml(webhookProviderName(server.provider))} webhook
          </label>
        </div>
      </details>`;
  }).join("");
  return `
    <p class="muted-copy setup-step-intro">Plex updates are automatic. Emby and Jellyfin need a webhook to send playback changes instantly; scheduled polling still runs every minute as a backstop. See <a href="/#help/webhooks">the webhook guide</a> for more detail.</p>
    <div class="setup-webhook-rows">${cards}</div>`;
}

function renderTrakt() {
  const trakt = cachedStatus.trakt;
  const traktImport = cachedStatus.onboarding.backgroundImports.trakt;
  if (trakt.connected) {
    return `
      <div class="settings-card setup-trakt-card">
        <div class="setup-trakt-heading">
          <b>Connected as ${escapeHtml(trakt.username || "Trakt user")}</b>
          <span class="badge badge-success">Connected</span>
        </div>
        <label class="field-label setup-import-toggle-label">
          <input type="checkbox" data-setup-import-toggle="trakt" ${traktImportPending() ? "checked" : ""} />
          Import watch history from Trakt
        </label>
        ${importStatusLine(traktImport)}
      </div>`;
  }
  if (traktFlow) {
    return `
      <div class="settings-card setup-trakt-flow">
        <p>Go to <a href="${escapeHtml(traktFlow.verificationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(traktFlow.verificationUrl)}</a> and enter this code:</p>
        <p class="setup-trakt-code">${escapeHtml(traktFlow.userCode)}</p>
        <p class="muted-copy setup-trakt-waiting">Waiting for confirmation...</p>
      </div>`;
  }
  return `
    <div class="settings-card setup-trakt-card">
      <p class="muted-copy">Trakt keeps watch state in sync both ways, including individual rewatches, using Plembfin's built-in app credentials - no personal API key or VIP required.</p>
      <label class="checkbox-label setup-trakt-date-pref">
        <input type="checkbox" data-setup-trakt-date-pref="1" ${preferEarlierTraktDateChoice ? "checked" : ""} />
        <span>Prefer Trakt's watched date when it is earlier than a media server's</span>
      </label>
      <p class="muted-copy setup-trakt-date-pref-help">A media server's own "last watched" date can be reset by a library rebuild or rescan. When this is on, Force Sync and imports use Trakt's date instead if it already has an earlier one for the same item.</p>
      <div class="setup-trakt-actions">
        <button type="button" class="button-primary" data-setup-action="trakt-connect">Connect Trakt</button>
      </div>
    </div>`;
}

function renderImports() {
  const rows = [];
  // Trakt listed first and imports before the media servers (see the Trakt
  // and Media servers step order) - keeping it first here too so its status
  // is the first thing explaining why the servers below might still be
  // queued rather than actively pulling.
  const traktInfo = cachedStatus.onboarding.backgroundImports.trakt;
  if (cachedStatus.trakt.connected) {
    rows.push(importProgressRow("trakt", cachedStatus.trakt.username || "Trakt account", traktInfo));
  }
  for (const provider of MEDIA_SERVERS.filter((p) => cachedStatus.servers.find((s) => s.provider === p)?.tested)) {
    const server = cachedStatus.servers.find((entry) => entry.provider === provider);
    const info = importState(provider);
    // Server pulls are queued client-side behind Trakt (see the servers step's
    // continue handler) and don't call the start API - and so have no
    // backgroundImports entry at all - until Trakt clears. Without this, a
    // genuinely selected-but-still-queued server reads identically to one the
    // user never checked in the first place.
    rows.push(importProgressRow(provider, server?.serverName || provider, info, serverImportPending(provider)));
  }
  return `
    <div class="guide-callout setup-import-note">These imports will continue in the background - go ahead and continue with setup.</div>
    <div class="setup-import-list">${rows.join("") || `<p class="muted-copy">No imports were requested. Plembfin will track new activity from this point forward.</p>`}</div>`;
}

function importProgressBar(status) {
  if (status === "importing") return `<div class="setup-import-progress" role="progressbar" aria-label="Importing"><div class="setup-import-progress-fill is-indeterminate"></div></div>`;
  if (status === "complete") return `<div class="setup-import-progress"><div class="setup-import-progress-fill is-complete" style="width:100%"></div></div>`;
  if (status === "failed") return `<div class="setup-import-progress"><div class="setup-import-progress-fill is-failed" style="width:100%"></div></div>`;
  return "";
}

function importProgressRow(provider, name, info, pending = false) {
  const providerLabel = provider === "trakt" ? "Trakt" : webhookProviderName(provider);
  // A server pull selected on the previous step but still queued behind
  // Trakt (see the comment at this function's caller) has no backgroundImports
  // entry yet - treat that the same as "importing" with no progress yet
  // rather than falling through to the "not selected" default below.
  const status = info?.enabled === false ? "not_requested" : (info?.status || (pending ? "importing" : "not_started"));
  let badge = `<span class="badge">Not requested</span>`;
  let detail = "This source was not selected for import.";
  if (status === "importing") {
    // The media-server pulls intentionally wait for the routine scheduled
    // sync tick (which is what's actively polling Trakt while its own
    // reconcile is running) to clear before they start - see
    // startServerImport in onboardingImportCoordinator.js. itemCount stays
    // null while queued like this, only becoming a number once the pull
    // actually begins.
    const traktInfo = cachedStatus.onboarding.backgroundImports.trakt;
    const waitingOnTrakt = provider !== "trakt" && (info?.itemCount == null) && traktInfo?.enabled !== false && traktInfo?.status !== "complete";
    badge = `<span class="badge badge-warning">${waitingOnTrakt ? "Waiting" : "Importing"}</span>`;
    detail = waitingOnTrakt
      ? "Waiting for Trakt import to complete."
      : (info?.itemCount == null ? "Fetching watch history in the background." : `${info.itemCount} items imported so far.`);
  } else if (status === "complete") {
    badge = `<span class="badge badge-success">Complete</span>`;
    detail = info.itemCount == null ? "Watch history import finished." : `${info.itemCount} items imported.`;
  } else if (status === "failed") {
    badge = `<span class="badge badge-error">Failed</span>`;
    detail = `${escapeHtml(info.error || "The import could not be completed.")} <a href="#" data-setup-import-retry="1">Retry</a>`;
  } else if (status === "cancelled") {
    badge = `<span class="badge">Cancelled</span>`;
    detail = "The import was cancelled.";
  }
  return `
    <div class="setup-import-row" data-setup-server="${escapeHtml(provider)}">
      <div class="setup-import-source"><b>${escapeHtml(providerLabel)}</b><span>&nbsp;- ${escapeHtml(name)}</span></div>
      <div class="setup-import-result">
        <div class="setup-import-result-head">${badge}<span class="muted-copy">${detail}</span></div>
        ${importProgressBar(status)}
      </div>
    </div>`;
}

function backblazeDestination() {
  return backupSetupData?.watch?.destinations?.find((destination) => destination.type === "backblaze") || null;
}

function renderBackup() {
  if (!backupSetupData) return `<p class="muted-copy">Loading backup settings...</p>`;
  const config = backupSetupData.plembfin?.config || {};
  const destination = backblazeDestination();
  const settings = destination?.settings || {};
  const secretConfigured = Boolean(destination?.secretFlags?.secretAccessKey);
  return `
    <p class="muted-copy setup-step-intro">Schedule encrypted local backups so Plembfin's settings, connections, and watch data can be recovered. Remote storage is optional.</p>
    <section class="settings-card setup-backup-card setup-backup-section">
      <div class="setup-backup-heading">
        <div><b>Local encrypted backup</b><p class="muted-copy">Stored on this Plembfin server.</p></div>
        ${config.enabled ? `<span class="badge badge-success">Scheduled</span>` : `<span class="badge">Not scheduled</span>`}
      </div>
      <label class="checkbox-label"><input type="checkbox" data-setup-backup-field="enabled" ${config.enabled ? "checked" : ""} /><span>Enable daily local backups</span></label>
      <div class="setup-backup-fields">
        <label class="field-label">Backup time<input class="field" type="time" data-setup-backup-field="time" value="${escapeAttribute(config.time || "03:00")}" /></label>
        <label class="field-label">Backups to retain<input class="field" type="number" min="1" max="365" data-setup-backup-field="retention" value="${escapeAttribute(String(config.retention || 7))}" /></label>
        <div class="setup-backup-security">
          <label class="field-label setup-backup-passphrase"><span class="setup-backup-label-line">Encryption passphrase <span class="muted-copy">(at least 12 characters)</span></span><input class="field" type="password" autocomplete="new-password" data-setup-backup-field="passphrase" placeholder="${config.passphraseStored ? "Saved - leave blank to keep" : ""}" /></label>
          <label class="checkbox-label setup-backup-remember"><input type="checkbox" data-setup-backup-field="rememberPassphrase" ${config.rememberPassphrase || config.passphraseStored ? "checked" : ""} /><span>Remember the passphrase for scheduled backups</span></label>
          <p class="muted-copy setup-backup-passphrase-help">This passphrase encrypts every backup, local or remote. It has to be entered and "remembered" here before daily or remote backups can be scheduled, since a scheduled backup runs unattended with nobody there to type it in.</p>
        </div>
      </div>
    </section>
    <details class="settings-card setup-backup-card setup-backup-remote" ${destination ? "open" : ""}>
      <summary class="setup-backup-heading"><b>Backblaze B2</b>${destination ? `<span class="badge ${destination.enabled ? "badge-success" : ""}">${destination.enabled ? "Configured" : "Disabled"}</span>` : `<span class="badge">Not configured</span>`}</summary>
      <div class="setup-backup-remote-body">
        <p class="muted-copy setup-backblaze-signup"><a href="https://www.backblaze.com/sign-up/cloud-storage" target="_blank" rel="noopener noreferrer">Create a free Backblaze B2 account</a>, then set up a bucket and key for Plembfin:</p>
        <div class="setup-backblaze-workflow">
          <section class="setup-backblaze-stage">
            <div class="setup-backblaze-guide">
              <h3>Create a private bucket</h3>
              <ol class="muted-copy setup-backblaze-steps">
                <li>Click <b>Create a Bucket</b>.</li>
                <li>Choose a unique name.</li>
                <li>Set the bucket to <b>Private</b>.</li>
                <li>Leave Default Encryption disabled.</li>
                <li>Leave Object Lock disabled.</li>
                <li>Click <b>Create a Bucket</b> to confirm.</li>
                <li>Copy the bucket name and paste it into <b>Bucket name</b> on the right.</li>
                <li>Copy the endpoint and paste it into <b>Region or S3 endpoint</b> on the right.</li>
              </ol>
            </div>
            <div class="setup-backblaze-stage-fields">
              <label class="field-label">Bucket name<input class="field" data-setup-backblaze-field="bucket" value="${escapeAttribute(settings.bucket || "")}" /></label>
              <label class="field-label">Region or S3 endpoint<input class="field" data-setup-backblaze-field="region" value="${escapeAttribute(settings.region || "")}" placeholder="eu-central-003" /></label>
            </div>
          </section>
          <section class="setup-backblaze-stage">
            <div class="setup-backblaze-guide">
              <h3>Create a restricted application key</h3>
              <ol class="muted-copy setup-backblaze-steps" start="9">
                <li>Click <b>App Keys</b> in the left menu.</li>
                <li>Click <b>Add a New Application Key</b> (not "Generate a New Master Application Key").</li>
                <li>Name the key.</li>
                <li>Allow access to the bucket you just created.</li>
                <li>Leave Read and Write access selected.</li>
                <li>Click <b>Create New Key</b>.</li>
                <li>Copy the keyID and paste it into <b>Key ID</b> on the right.</li>
                <li>Copy the applicationKey and paste it into <b>Application key</b> on the right.</li>
              </ol>
            </div>
            <div class="setup-backblaze-stage-fields">
              <label class="field-label">Key ID <span class="muted-copy">(Application Key ID, not the master Account ID)</span><input class="field" data-setup-backblaze-field="accessKeyId" value="${escapeAttribute(settings.accessKeyId || "")}" /></label>
              <label class="field-label">Application key<input class="field" type="password" autocomplete="new-password" data-setup-backblaze-field="secretAccessKey" placeholder="${secretConfigured ? "Configured - leave blank to keep" : ""}" /></label>
              <label class="field-label"><span class="setup-backup-label-line">Key prefix <span class="muted-copy">(optional)</span></span><input class="field" data-setup-backblaze-field="prefix" value="${escapeAttribute(settings.prefix || "plembfin/")}" /></label>
              <p class="muted-copy setup-backblaze-key-note">Backblaze shows the Application Key only once. Copy it when the key is created.</p>
            </div>
          </section>
        </div>
        <div class="setup-backblaze-toggles">
          <label class="checkbox-label"><input type="checkbox" data-setup-backblaze-field="enabled" ${destination?.enabled ? "checked" : ""} /><span>Enable this Backblaze destination</span></label>
          <label class="checkbox-label"><input type="checkbox" data-setup-backup-field="remoteEnabled" ${config.remoteEnabled ? "checked" : ""} /><span>Upload scheduled encrypted Plembfin backups to Backblaze</span></label>
        </div>
        <div class="setup-backblaze-actions">
          <button type="button" class="button-ghost" data-setup-action="backblaze-save">Save</button>
          <button type="button" class="button-ghost" data-setup-action="backblaze-test">Test</button>
        </div>
      </div>
    </details>`;
}

function updateBackupContinueAction() {
  const button = elements.setupPageRoot?.querySelector('[data-setup-action="continue"]');
  if (!button || currentStep() !== "backup") return;
  const shouldSave = setupFieldChecked('[data-setup-backup-field="enabled"]')
    || setupFieldChecked('[data-setup-backup-field="remoteEnabled"]')
    || setupFieldChecked('[data-setup-backblaze-field="enabled"]');
  button.textContent = shouldSave ? "Save and continue" : "Skip for now";
  button.classList.toggle("button-primary", shouldSave);
  button.classList.toggle("button-ghost", !shouldSave);
}

function setupFieldValue(selector) {
  return elements.setupPageRoot?.querySelector(selector)?.value?.trim() || "";
}

function setupFieldChecked(selector) {
  return Boolean(elements.setupPageRoot?.querySelector(selector)?.checked);
}

function setPassphraseError(active) {
  elements.setupPageRoot?.querySelector(".setup-backup-security")?.classList.toggle("setup-field-error", Boolean(active));
}

function passphraseSatisfied(previous, rememberPassphrase, passphrase) {
  return rememberPassphrase && (previous.passphraseStored || passphrase.length >= 12);
}

async function saveBackblazeDestinationFromFields({ requireComplete } = {}) {
  const destination = backblazeDestination();
  const destinationEnabled = setupFieldChecked('[data-setup-backblaze-field="enabled"]');
  const shouldValidate = requireComplete ?? destinationEnabled;
  const region = setupFieldValue('[data-setup-backblaze-field="region"]');
  const bucket = setupFieldValue('[data-setup-backblaze-field="bucket"]');
  const accessKeyId = setupFieldValue('[data-setup-backblaze-field="accessKeyId"]');
  const secretAccessKey = setupFieldValue('[data-setup-backblaze-field="secretAccessKey"]');
  if (shouldValidate && (!region || !bucket || !accessKeyId || (!destination?.secretFlags?.secretAccessKey && !secretAccessKey))) {
    setMessage("Complete the Backblaze region, bucket, Key ID, and application key.", "error");
    return null;
  }
  if (!shouldValidate && !destination?.id) return null;
  const body = await api("/api/watch-backups", {
    method: "POST",
    body: JSON.stringify({
      action: "save-destination",
      destination: shouldValidate
        ? {
            ...(destination?.id ? { id: destination.id } : {}), type: "backblaze", label: "Backblaze B2", enabled: destinationEnabled,
            settings: { region, bucket, accessKeyId, prefix: setupFieldValue('[data-setup-backblaze-field="prefix"]') },
            secrets: secretAccessKey ? { secretAccessKey } : {},
          }
        : {
            id: destination.id, type: "backblaze", label: destination.label || "Backblaze B2", enabled: false,
            settings: { ...destination.settings }, secrets: {},
          },
    }),
  });
  return body.destination;
}

async function saveBackblazeAction() {
  const saved = await saveBackblazeDestinationFromFields({ requireComplete: true }).catch((error) => {
    setMessage(error.message, "error");
    return null;
  });
  if (!saved) return;
  await loadBackupSetupData({ force: true });
  setMessage("Backblaze destination saved.", "success");
}

async function testBackblazeAction() {
  try {
    const saved = await saveBackblazeDestinationFromFields({ requireComplete: true });
    if (!saved) return;
    const result = await api("/api/watch-backups", {
      method: "POST",
      body: JSON.stringify({ action: "test-destination", destinationId: saved.id }),
    });
    await loadBackupSetupData({ force: true });
    setMessage(`Connection OK - ${result.result?.detail || "reachable"}.`, "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function saveBackupSetup() {
  if (!backupSetupData) return false;
  const previous = backupSetupData.plembfin?.config || {};
  const enabled = setupFieldChecked('[data-setup-backup-field="enabled"]');
  const remoteEnabled = setupFieldChecked('[data-setup-backup-field="remoteEnabled"]');
  const rememberPassphrase = setupFieldChecked('[data-setup-backup-field="rememberPassphrase"]');
  const passphrase = setupFieldValue('[data-setup-backup-field="passphrase"]');
  const destinationEnabled = setupFieldChecked('[data-setup-backblaze-field="enabled"]');
  setPassphraseError(false);
  if (enabled && !passphraseSatisfied(previous, rememberPassphrase, passphrase)) {
    setPassphraseError(true);
    setMessage("Enter and remember an encryption passphrase of at least 12 characters before enabling scheduled backups.", "error");
    return false;
  }
  if (remoteEnabled && !previous.remotePassphraseStored && !passphraseSatisfied(previous, rememberPassphrase, passphrase)) {
    setPassphraseError(true);
    setMessage("Enter and remember an encryption passphrase of at least 12 characters before enabling scheduled remote backups.", "error");
    return false;
  }
  if (remoteEnabled && !destinationEnabled) {
    setMessage("Enable and configure the Backblaze destination before turning on remote backups.", "error");
    return false;
  }
  if (destinationEnabled || backblazeDestination()?.id) {
    const saved = await saveBackblazeDestinationFromFields();
    if (!saved) return false;
  }
  await api("/api/plembfin-backups", {
    method: "POST",
    body: JSON.stringify({ action: "configure", config: {
      ...previous, enabled, remoteEnabled,
      time: setupFieldValue('[data-setup-backup-field="time"]') || "03:00",
      retention: Number(setupFieldValue('[data-setup-backup-field="retention"]')) || 7,
      rememberPassphrase,
      passphrase: rememberPassphrase ? passphrase : "",
    } }),
  });
  await loadBackupSetupData({ force: true });
  return true;
}

function renderReview(canFinish) {
  const s = cachedStatus;
  const testedServers = s.servers.filter((server) => server.tested);
  const requiredWebhookServers = testedServers.filter((server) => webhookSetupRequired(server.provider));
  const webhooksReady = requiredWebhookServers.every((server) => s.onboarding.acknowledgements.webhooks?.[server.provider]);
  const imports = [
    ...Object.values(s.onboarding.backgroundImports.servers || {}),
    ...(s.trakt.connected ? [s.onboarding.backgroundImports.trakt] : []),
  ].filter((entry) => entry?.enabled !== false && entry?.status !== "not_started");
  const completedImports = imports.filter((entry) => entry.status === "complete").length;
  const runningImports = imports.filter((entry) => entry.status === "importing").length;
  const backupConfig = backupSetupData?.plembfin?.config || {};
  const rows = [
    { label: "Account security", detail: "Administrator account secured", status: "Ready", tone: "success" },
    {
      label: "Media servers",
      detail: testedServers.map((server) => server.serverName || webhookProviderName(server.provider)).join(", ") || "No tested server",
      status: `${testedServers.length} connected`, tone: testedServers.length ? "success" : "error",
    },
    {
      label: "Metadata", detail: s.metadata.tmdbConfigured ? "TMDB is configured for artwork and discovery" : "TMDB has not been configured",
      status: s.metadata.tmdbConfigured ? "Configured" : "Not configured", tone: s.metadata.tmdbConfigured ? "success" : "muted",
    },
    {
      label: "Updates", detail: webhooksReady ? "Plex automatic updates and configured server webhooks are ready" : "An Emby or Jellyfin webhook still needs confirmation",
      status: webhooksReady ? "Ready" : "Setup pending", tone: webhooksReady ? "success" : "warning",
    },
    {
      label: "Trakt", detail: s.trakt.connected ? `Connected${s.trakt.username ? ` as ${s.trakt.username}` : " account"}` : "Two-way Trakt sync was skipped",
      status: s.trakt.connected ? "Connected" : "Optional", tone: s.trakt.connected ? "success" : "muted",
    },
    {
      label: "Imports",
      detail: runningImports ? `${runningImports} import${runningImports === 1 ? " is" : "s are"} still running in the background` : (imports.length ? "Selected watch-history imports finished" : "No history imports were requested"),
      status: runningImports ? `${runningImports} running` : `${completedImports} complete`, tone: runningImports ? "warning" : "success",
    },
    {
      label: "Backups",
      detail: backupConfig.enabled
        ? `Daily encrypted backup at ${backupConfig.time || "03:00"}${backupConfig.remoteEnabled ? ", mirrored to Backblaze B2" : ", stored locally"}`
        : "Not scheduled; this can be configured later in Settings",
      status: backupConfig.enabled ? "Scheduled" : "Optional", tone: backupConfig.enabled ? "success" : "muted",
    },
  ];
  return `
    <div class="setup-review-lead ${canFinish ? "is-ready" : "needs-attention"}">
      <span class="setup-review-mark" aria-hidden="true">${canFinish ? "✓" : "!"}</span>
      <div><b>${canFinish ? "Plembfin is ready" : "One required step remains"}</b><p>${canFinish ? "Review your connections and open the dashboard when everything looks right." : "Connect and test at least one media server before finishing setup."}</p></div>
    </div>
    <div class="setup-review-list">
      ${rows.map((row) => `
        <div class="setup-review-row">
          <div class="setup-review-copy"><b>${escapeHtml(row.label)}</b><span>${escapeHtml(row.detail)}</span></div>
          <span class="badge ${row.tone === "success" ? "badge-success" : row.tone === "warning" ? "badge-warning" : row.tone === "error" ? "badge-error" : ""}">${escapeHtml(row.status)}</span>
        </div>`).join("")}
    </div>`;
}

function stepNeighbor(direction) {
  const ids = STEPS.map((s) => s.id);
  const index = ids.indexOf(currentStep());
  const next = ids[index + direction];
  return next || ids[index];
}

async function startTraktConnect() {
  try {
    const flow = await api("/api/tracker-auth/trakt/start", {
      method: "POST",
      body: JSON.stringify({ preferEarlierWatchedDate: preferEarlierTraktDateChoice }),
    });
    traktFlow = flow;
    renderSetupPage();
    pollTraktFlow();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function pollTraktFlow() {
  clearTimeout(traktPollTimer);
  if (!traktFlow) return;
  traktPollTimer = setTimeout(checkTraktFlow, (traktFlow.intervalSeconds || 5) * 1000);
}

// The trakt.tv activation page opens in a separate tab, backgrounding this
// one - browsers throttle setTimeout in hidden tabs well beyond the nominal
// poll interval, so a user who confirms the code and switches straight back
// can be stuck waiting on a delayed timer. Checking immediately on return
// fixes that; the server's own lastPolledAt guard (trackerAuth.js) already
// makes an extra/early check a no-op against Trakt's own rate limit.
async function checkTraktFlow() {
  clearTimeout(traktPollTimer);
  if (!traktFlow) return;
  try {
    const result = await api(`/api/tracker-auth/trakt/${traktFlow.flowId}/status`);
    if (result.status === "completed") {
      traktFlow = null;
      await loadSetupStatus();
      return;
    }
    if (result.status === "expired" || result.status === "denied") {
      traktFlow = null;
      setMessage("Trakt authorization expired or was denied. Try again.", "error");
      renderSetupPage();
      return;
    }
    pollTraktFlow();
  } catch {
    pollTraktFlow();
  }
}

async function toggleImport(target, enabled) {
  try {
    await api("/api/setup/import", { method: "POST", body: JSON.stringify({ target, action: enabled ? "start" : "cancel" }) });
  } catch (error) {
    setMessage(error.message, "error");
  }
  await loadSetupStatus();
}

function handleSetupChange(event) {
  if (!elements.setupPageRoot?.contains(event.target)) return;
  if (event.target.matches("[data-setup-backup-field], [data-setup-backblaze-field]")) {
    if (event.target.matches('[data-setup-backup-field="passphrase"], [data-setup-backup-field="rememberPassphrase"]')) setPassphraseError(false);
    updateBackupContinueAction();
    return;
  }
  if (event.target.matches("[data-setup-trakt-date-pref]")) {
    preferEarlierTraktDateChoice = event.target.checked;
    return;
  }
  const importToggle = event.target.closest("[data-setup-import-toggle]");
  if (importToggle) {
    const target = importToggle.dataset.setupImportToggle;
    if (MEDIA_SERVERS.includes(target)) {
      // Servers wait for Continue (startPendingServerImports); only record intent here.
      pendingServerImportChoice.set(target, importToggle.checked);
      renderSetupPage();
    } else {
      pendingTraktImportChoice = importToggle.checked;
      renderSetupPage();
    }
    return;
  }
  const webhookAck = event.target.closest("[data-setup-webhook-ack]");
  if (webhookAck) {
    const provider = webhookAck.dataset.setupWebhookAck;
    api("/api/setup/step", { method: "POST", body: JSON.stringify({ webhookAck: { provider } }) })
      .then(() => loadSetupStatus())
      .catch((error) => setMessage(error.message, "error"));
  }
}

async function handleSetupClick(event) {
  const dismissBanner = event.target.closest("[data-setup-dismiss-banner]");
  if (dismissBanner) {
    document.getElementById("setupResumeBanner")?.remove();
    return;
  }
  const dismissChecklist = event.target.closest("[data-setup-dismiss-checklist]");
  if (dismissChecklist) {
    api("/api/setup/checklist/dismiss", { method: "POST" }).then(() => loadSetupStatus()).then(() => renderDashboardChecklist()).catch(() => {});
    return;
  }
  if (!elements.setupPageRoot?.contains(event.target)) return;
  const stepButton = event.target.closest("[data-setup-step]");
  if (stepButton) {
    setCurrentStep(stepButton.dataset.setupStep);
    return;
  }
  const connectButton = event.target.closest("[data-setup-connect]");
  if (connectButton) {
    openServiceEditModal(connectButton.dataset.setupConnect);
    return;
  }
  const retryButton = event.target.closest("[data-setup-import-retry]");
  if (retryButton) {
    event.preventDefault();
    const card = retryButton.closest("[data-setup-server]");
    const provider = card?.dataset.setupServer;
    if (provider) toggleImport(provider, true);
    return;
  }
  const action = event.target.closest("[data-setup-action]")?.dataset.setupAction;
  if (!action) return;
  if (action === "continue") {
    if (currentStep() === "servers") {
      // startServerImport (server-side) now waits out an in-progress Trakt
      // reconcile itself via its own retrying timer, so this always fires
      // immediately - the wait survives a page reload this way, unlike the
      // old client-side polling loop that silently vanished on one.
      await startPendingServerImports().catch(() => {});
    }
    if (currentStep() === "trakt") {
      const started = await startPendingTraktImport();
      if (!started) return;
    }
    if (currentStep() === "backup") {
      try {
        const saved = await saveBackupSetup();
        if (!saved) return;
      } catch (error) {
        setMessage(error.message, "error");
        return;
      }
    }
    setCurrentStep(stepNeighbor(1));
  } else if (action === "back") {
    setCurrentStep(stepNeighbor(-1));
  } else if (action === "exit") {
    navigateTo("/settings");
  } else if (action === "trakt-connect") {
    startTraktConnect();
  } else if (action === "backblaze-save") {
    saveBackblazeAction();
  } else if (action === "backblaze-test") {
    testBackblazeAction();
  } else if (action === "trakt-skip") {
    api("/api/setup/step", { method: "POST", body: JSON.stringify({ traktSkipped: true }) })
      .then(() => { setCurrentStep(stepNeighbor(1)); })
      .catch((error) => setMessage(error.message, "error"));
  } else if (action === "complete") {
    api("/api/setup/complete", { method: "POST" })
      .then(() => navigateTo("/"))
      .catch((error) => setMessage(error.message, "error"));
  }
}

export function setupResumeBannerHtml() {
  if (!cachedStatus || cachedStatus.onboarding.runState !== "in_progress") return "";
  return `
    <div id="setupResumeBanner" class="guide-callout" style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
      <span>Setup is in progress.</span>
      <span style="display:flex; gap:8px;">
        <a class="button-ghost" href="/setup">Resume Setup Guide</a>
        <button type="button" class="button-ghost" data-setup-dismiss-banner="1">Dismiss</button>
      </span>
    </div>`;
}
