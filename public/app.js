import { buildAuthHeaders, buildNowPlayingUrl, currentUser, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./modules/auth.js";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./modules/logs.js";
import { connectionLabel, connectionPayloadFromElements } from "./modules/settings.js";
import { state, elements, ACTIVE_VIEW_KEY, ACTIVE_SETTINGS_TAB_KEY, EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS, EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS, HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS, HISTORY_VIEW_KEY, HISTORY_FILTER_KEY, HISTORY_VIEW_MODES, HISTORY_FILTERS, PRIMARY_VIEWS, SETTINGS_TABS } from "./modules/state.js";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, slug, movieSlug, movieHref, showName, showTitleFrom, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDate, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader } from "./modules/utils.js";
import { adminTokenGuide, plexCredentialGuide, embyCredentialGuide, jellyfinCredentialGuide, buildWebhookUrl, plexWebhookSetup, embyWebhookSetup, jellyfinWebhookSetup, webhookWarning, cronSyncGuide, renderSettingsInlineHelp, visibleHelpTopics, HELP_TOPICS } from "./modules/help-content.js";
import { isCachedStorageImageUrl, compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, rememberPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, tmdbProfile } from "./modules/images.js";
import { initTools, APPEARANCE_DEFAULTS, setBackupTransferState, exportPlembfinBackup, readPlembfinBackup, importPlembfinBackup, renderWatchBackups, loadRemoteBackupsForRestoreTab, addBackupDestination, saveBackupDestinationCard, testBackupDestinationCard, removeBackupDestinationCard, listRemoteBackupsForCard, restoreRemoteBackupFromCard, connectBackupDestinationCard, loadCacheStats, renderCachePanel, loadWatchBackups, postWatchBackupAction, applyAppearanceToBody, loadAppearanceSettings, saveAppearanceSettings, saveWatchBackupSettings, createWatchBackupNow, downloadWatchBackup, uploadWatchBackupFile, restoreWatchBackup, parseSelectedFiles, renderImportPreview, renderImportActivity, startImport, runRepairWorkflow, runDedupHistory, runTraktBackfill, runFullSyncWatchstates } from "./modules/tools.js";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, showAvailIssuePopup, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling } from "./modules/sync.js";
import { initDashboard, getRowFitLimit, mediaRecordIdentity, dedupeMediaRecords, progressRecordIdentity, dedupePlaybackProgress, renderHistoryCard, observeDashboardPosters, renderDashboard, updateDashboardSplitState, resetPartWatchedView, renderPartWatchedCard, renderPartWatched, loadPartWatched } from "./modules/dashboard.js";
import { initStats, formatListDate, futureListDate, showStatusLabel, nextAiringDateValue, nextAiringCell, statsReports, statsPeriodLabel, syncStatsPeriodOptions, selectedStatsReport, statsFilteredRows, statsPeriodNoun, statsTrackingSpanText, statsPlatformLabel, statsSelectedMediaLabel, statsIntroCards, renderStatsKpis, renderStatsLeaderboard, renderStatsMoviesTvSplit, renderStatsPlatformRows, renderStatsBookends, renderMonthChart, renderStats, loadStats, renderRankingTable } from "./modules/stats.js";
import { initExplorer, syncExplorerControlsState, syncInlineMediaDetailHeading, triggerSearchPage, renderSearchPage, renderExplorer, explorerQueryKey, updateAlphaFilter, handleAlphaFilterClick, resetMovieExplorer, resetShowExplorer, renderExplorerSentinel, observeExplorerSentinel, observeExplorerTmdbPrefetch, scheduleNextAirResort, currentExplorerView, currentExplorerSort, setCurrentExplorerSort, applyExplorerPosterWidth, applyListHeaderSort, renderMovieCard, renderMovieExplorer, loadExplorerMovies, applyHistoryPosterWidth, resetHistoryView, renderHistoryItems, renderHistoryView, loadHistoryView, observeHistorySentinel, renderShowExplorer, loadExplorerShows, mergeShowDetail, loadShowDetail, matchesExplorerSearch, sortExplorerItems, renderShowRecord, renderShowFolder, renderSeasonFolder, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, emptyExplorer, FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver } from "./modules/explorer.js";

// Warm the backend the moment the app loads (no auth needed), so the Cloud
// Function is hot by the time the user clicks into anything. A light keep-alive
// holds it warm while the tab is open. This gives warm-instance latency without
// the 24/7 cost of minInstances — we only ping while someone is actually here.
const BACKEND_KEEPALIVE_MS = 4 * 60 * 1000;
function warmUpBackend() {
  try {
    fetch("/api/ping", { cache: "no-store", keepalive: true }).catch(() => { });
  } catch { /* non-fatal */ }
}
warmUpBackend();
setInterval(() => {
  if (document.visibilityState === "visible") warmUpBackend();
}, BACKEND_KEEPALIVE_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") warmUpBackend();
});

// Theme initialization
const THEME_KEY = "plembfin:theme";

function updateThemeIcon() {
  const isLightMode = document.documentElement.classList.contains("light-mode");
  const logo = document.querySelector(".brand-logo");
  if (logo) {
    logo.src = isLightMode ? "/plembfin_header_logo_light.png" : "/plembfin_header_logo_dark.png";
  }
}

function initializeTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const shouldUseLightMode = savedTheme === "light" || (savedTheme === null && !prefersDark);

  if (shouldUseLightMode) {
    document.documentElement.classList.add("light-mode");
  } else {
    document.documentElement.classList.remove("light-mode");
  }
  updateThemeIcon();
}

function toggleTheme() {
  const isLightMode = document.documentElement.classList.contains("light-mode");
  if (isLightMode) {
    document.documentElement.classList.remove("light-mode");
    localStorage.setItem(THEME_KEY, "dark");
  } else {
    document.documentElement.classList.add("light-mode");
    localStorage.setItem(THEME_KEY, "light");
  }
  updateThemeIcon();
}

initializeTheme();

const TOKEN_KEY = "adminToken";
const LEGACY_UPPER_TOKEN_KEY = "ADMIN_TOKEN";
const LEGACY_TOKEN_KEY = "sync_admin_token";
const NOW_PLAYING_POLL_MS = 10000;
const NOW_PLAYING_EMPTY_POLL_MS = 2 * 60 * 1000;
const NOW_PLAYING_REENTRY_CACHE_MS = 20 * 1000;
const DASHBOARD_HISTORY_CACHE_KEY = "plembfin:dashboardHistory:v1";
const DASHBOARD_HISTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_PREVIEW_LIMIT = 120;
const DASHBOARD_HISTORY_ROWS = 2;
const EXPLORER_PAGE_SIZE = 240;
const MANUAL_WATCH_BATCH_SIZE = 100;
const EXPLORER_CACHE_TTL_MS = 30 * 60 * 1000;
const EXPLORER_PERSISTED_CACHE_KEY = "plembfin:explorerPageCache:v3";
const EXPLORER_PERSISTED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const EXPLORER_PERSISTED_CACHE_LIMIT = 24;

function bindElements() {
  Object.assign(elements, {
    appShell: document.querySelector("#appShell"),
    appVersion: document.querySelector("#appVersion"),
    changelogPanel: document.querySelector("#changelogPanel"),
    changelogRefreshButton: document.querySelector("#changelogRefreshButton"),
    authForm: document.querySelector("#authForm"),
    authPanel: document.querySelector("#authPanel"),
    adminToken: document.querySelector("#adminToken"),
    adminEmail: document.querySelector("#adminEmail"),
    adminCredentialsForm: document.querySelector("#adminCredentialsForm"),
    adminCredentialsStatus: document.querySelector("#adminCredentialsStatus"),
    currentAdminPassword: document.querySelector("#currentAdminPassword"),
    newAdminPassword: document.querySelector("#newAdminPassword"),
    confirmAdminPassword: document.querySelector("#confirmAdminPassword"),
    clearImportButton: document.querySelector("#clearImportButton"),
    closeModalButton: document.querySelector("#closeModalButton"),
    confirmModal: document.querySelector("#confirmModal"),
    confirmModalMessage: document.querySelector("#confirmModalMessage"),
    approveConfirmButton: document.querySelector("#approveConfirmButton"),
    cancelConfirmButton: document.querySelector("#cancelConfirmButton"),
    closeConfirmModalButton: document.querySelector("#closeConfirmModalButton"),
    copyToast: document.querySelector("#copyToast"),
    clearLogsButton: document.querySelector("#clearLogsButton"),
    copyLogsButton: document.querySelector("#copyLogsButton"),
    dbStatus: document.querySelector("#dbStatus"),
    debugModal: document.querySelector("#debugModal"),
    explorerPanel: document.querySelector("#explorerPanel"),
    pageTopbar: document.querySelector("#pageTopbar"),
    pageTopbarActions: document.querySelector("#pageTopbarActions"),
    topbarControlsMenu: document.querySelector("#topbarControlsMenu"),
    topbarControlsPanel: document.querySelector("#topbarControlsPanel"),
    settingsSubMenu: document.querySelector("#sidebarSettingsMenu"),
    helpSubMenu: document.querySelector("#helpMenu"),
    historyPanel: document.querySelector("#historyPanel"),
    alphaFilterNav: document.querySelector("#alphaFilterNav"),
    explorerSearchInput: document.querySelector("#explorerSearchInput"),
    historySearchInput: document.querySelector("#historySearchInput"),
    historyFilterButtons: [...document.querySelectorAll("[data-history-filter]")],
    historyViewButtons: [...document.querySelectorAll("[data-history-view]")],
    explorerPosterSize: document.querySelector("#explorerPosterSize"),
    historyPosterSize: document.querySelector("#historyPosterSize"),
    partWatchedPanel: document.querySelector("#partWatchedRow"),
    partWatchedSection: document.querySelector("#partWatchedDashboardSection"),
    explorerPosterSizeLabel: document.querySelector(".explorer-size-slider"),
    explorerSort: document.querySelector("#explorerSort"),
    explorerHideWatchedLabel: document.querySelector("#explorerHideWatchedLabel"),
    explorerHideWatched: document.querySelector("#explorerHideWatched"),
    explorerHideEndedLabel: document.querySelector("#explorerHideEndedLabel"),
    explorerHideEnded: document.querySelector("#explorerHideEnded"),
    explorerViewButtons: [...document.querySelectorAll("[data-explorer-view]")],
    explorerTopbarControls: document.querySelector("#explorerTopbarControls"),
    historyTopbarControls: document.querySelector("#historyTopbarControls"),
    searchTopbarControls: document.querySelector("#searchTopbarControls"),
    statsTopbarControls: document.querySelector("#statsTopbarControls"),
    explorerSubtitle: document.querySelector("#explorerSubtitle"),
    explorerTitle: document.querySelector("#explorerTitle"),
    terminalModal: document.querySelector("#terminalModal"),
    closeTerminalModalButton: document.querySelector("#closeTerminalModalButton"),
    retryTerminalOutput: document.querySelector("#retryTerminalOutput"),
    globalSearchInput: document.querySelector("#globalSearchInput"),
    fullSyncButton: document.querySelector("#fullSyncButton"),
    fullSyncLog: document.querySelector("#fullSyncLog"),
    fullSyncStatus: document.querySelector("#fullSyncStatus"),
    backupExportButton: document.querySelector("#backupExportButton"),
    backupImportButton: document.querySelector("#backupImportButton"),
    backupImportFile: document.querySelector("#backupImportFile"),
    backupTransferLog: document.querySelector("#backupTransferLog"),
    backupTransferStatus: document.querySelector("#backupTransferStatus"),
    watchBackupSummary: document.querySelector("#watchBackupSummary"),
    watchBackupEnabled: document.querySelector("#watchBackupEnabled"),
    watchBackupTime: document.querySelector("#watchBackupTime"),
    watchBackupRetention: document.querySelector("#watchBackupRetention"),
    saveWatchBackupConfigButton: document.querySelector("#saveWatchBackupConfigButton"),
    createWatchBackupButton: document.querySelector("#createWatchBackupButton"),
    chooseWatchBackupFileButton: document.querySelector("#chooseWatchBackupFileButton"),
    watchBackupUploadFile: document.querySelector("#watchBackupUploadFile"),
    watchBackupUploadStatus: document.querySelector("#watchBackupUploadStatus"),
    refreshWatchBackupsButton: document.querySelector("#refreshWatchBackupsButton"),
    watchBackupRuntime: document.querySelector("#watchBackupRuntime"),
    watchBackupList: document.querySelector("#watchBackupList"),
    watchBackupDestinations: document.querySelector("#watchBackupDestinations"),
    watchBackupDestinationType: document.querySelector("#watchBackupDestinationType"),
    addWatchBackupDestinationButton: document.querySelector("#addWatchBackupDestinationButton"),
    appearShowLogoArt: document.querySelector("#appearShowLogoArt"),
    appearShowCast: document.querySelector("#appearShowCast"),
    appearShowTrailers: document.querySelector("#appearShowTrailers"),
    appearShowReviews: document.querySelector("#appearShowReviews"),
    appearShowImages: document.querySelector("#appearShowImages"),
    appearShowRelated: document.querySelector("#appearShowRelated"),
    helpCanvas: document.querySelector("#helpCanvas"),
    helpMenu: document.querySelector("#helpMenu"),
    tvHistoryRow: document.querySelector("#tvHistoryRow"),
    movieHistoryRow: document.querySelector("#movieHistoryRow"),
    importFile: document.querySelector("#importFile"),
    importPreview: document.querySelector("#importPreview"),
    importProgress: document.querySelector("#importProgress"),
    importProgressFill: document.querySelector("#importProgressFill"),
    importProgressPercent: document.querySelector("#importProgressPercent"),
    importTerminal: document.querySelector("#importTerminal"),
    lockButton: document.querySelector("#lockButton"),
    logsTerminal: document.querySelector("#logsTerminal"),
    themeToggleButton: document.querySelector("#themeToggleButton"),
    message: document.querySelector("#message"),
    modalBody: document.querySelector("#modalBody"),
    monthChart: document.querySelector("#monthChart"),
    nowPlayingGrid: document.querySelector("#nowPlayingGrid"),
    nowPlayingStatus: document.querySelector("#nowPlayingStatus"),
    timelineView: document.querySelector("#timeline-view"),
    refreshSyncButton: document.querySelector("#refreshSyncButton"),
    runCronSyncButton: document.querySelector("#runCronSyncButton"),
    forceSyncButton: document.querySelector("#forceSyncButton"),
    stopSyncButton: document.querySelector("#stopSyncButton"),
    forceSyncTerminal: document.querySelector("#forceSyncTerminal"),
    syncIssuesToggle: document.querySelector("#syncIssuesToggle"),
    syncIssuesContent: document.querySelector("#syncIssuesContent"),
    syncIssuesToggleIcon: document.querySelector("#syncIssuesToggleIcon"),
    syncHistoryToggle: document.querySelector("#syncHistoryToggle"),
    syncHistoryContent: document.querySelector("#syncHistoryContent"),
    syncHistoryToggleIcon: document.querySelector("#syncHistoryToggleIcon"),
    syncToolsToggle: document.querySelector("#syncToolsToggle"),
    syncToolsContent: document.querySelector("#syncToolsContent"),
    syncToolsToggleIcon: document.querySelector("#syncToolsToggleIcon"),
    plexEnabled: document.querySelector("#plexEnabled"),
    plexServerUrl: document.querySelector("#plexServerUrl"),
    plexToken: document.querySelector("#plexToken"),
    plexUsername: document.querySelector("#plexUsername"),
    tmdbApiKey: document.querySelector("#tmdbApiKey"),
    youtubeApiKey: document.querySelector("#youtubeApiKey"),
    fanartApiKey: document.querySelector("#fanartApiKey"),
    omdbApiKey: document.querySelector("#omdbApiKey"),
    embyEnabled: document.querySelector("#embyEnabled"),
    embyServerUrl: document.querySelector("#embyServerUrl"),
    embyApiKey: document.querySelector("#embyApiKey"),
    embyUserId: document.querySelector("#embyUserId"),
    jellyfinEnabled: document.querySelector("#jellyfinEnabled"),
    jellyfinServerUrl: document.querySelector("#jellyfinServerUrl"),
    jellyfinApiKey: document.querySelector("#jellyfinApiKey"),
    jellyfinUserId: document.querySelector("#jellyfinUserId"),
    seerrEnabled: document.querySelector("#seerrEnabled"),
    seerrServerUrl: document.querySelector("#seerrServerUrl"),
    seerrApiKey: document.querySelector("#seerrApiKey"),
    saveSeerrConfigButton: document.querySelector("#saveSeerrConfigButton"),
    seerrConfigStatus: document.querySelector("#seerrConfigStatus"),
    cronSyncUrl: document.querySelector("#cronSyncUrl"),
    runRepairButton: document.querySelector("#runRepairButton"),
    repairStatus: document.querySelector("#repairStatus"),
    repairLog: document.querySelector("#repairLog"),
    traktBackfillButton: document.querySelector("#traktBackfillButton"),
    traktBackfillLimit: document.querySelector("#traktBackfillLimit"),
    traktBackfillRate: document.querySelector("#traktBackfillRate"),
    traktBackfillStatus: document.querySelector("#traktBackfillStatus"),
    traktBackfillLog: document.querySelector("#traktBackfillLog"),
    dedupHistoryButton: document.querySelector("#dedupHistoryButton"),
    dedupHistoryStatus: document.querySelector("#dedupHistoryStatus"),
    dedupHistoryLog: document.querySelector("#dedupHistoryLog"),
    refreshMetadataButton: document.querySelector("#refreshMetadataButton"),
    refreshMetadataStatus: document.querySelector("#refreshMetadataStatus"),
    refreshMetadataLog: document.querySelector("#refreshMetadataLog"),
    settingsUsername: document.querySelector("#settingsUsername"),
    settingsForm: document.querySelector("#settingsForm"),
    settingsStatus: document.querySelector("#settingsStatus"),
    settingsTabButtons: [...document.querySelectorAll("[data-settings-tab]")],
    settingsPanels: [...document.querySelectorAll("[data-settings-panel]")],
    backupsSubTabButtons: [...document.querySelectorAll("[data-backups-tab]")],
    backupsPanels: [...document.querySelectorAll("[data-backups-panel]")],
    sourceRanking: document.querySelector("#sourceRanking"),
    statsMediaFilter: document.querySelector("#statsMediaFilter"),
    statsPeriodType: document.querySelector("#statsPeriodType"),
    statsPeriodValue: document.querySelector("#statsPeriodValue"),
    statsActivityTitle: document.querySelector("#statsActivityTitle"),
    statsActivitySubtitle: document.querySelector("#statsActivitySubtitle"),
    statsLeaderboardSubtitle: document.querySelector("#statsLeaderboardSubtitle"),
    topMediaReport: document.querySelector("#topMediaReport"),
    statsKpiStrip: document.querySelector("#statsKpiStrip"),
    statsLeaderboard: document.querySelector("#statsLeaderboard"),
    statsMoviesTvSplit: document.querySelector("#statsMoviesTvSplit"),
    statsBookends: document.querySelector("#statsBookends"),
    startImportButton: document.querySelector("#startImportButton"),
    statusPill: document.querySelector("#statusPill"),
    totalMovies: document.querySelector("#totalMovies"),
    totalEpisodes: document.querySelector("#totalEpisodes"),
    totalWatches: document.querySelector("#totalWatches"),
    topPlatform: document.querySelector("#topPlatform"),
    dbSize: document.querySelector("#dbSize"),
    trackingSpan: document.querySelector("#trackingSpan"),
    saveConfigButton: document.querySelector("#saveConfigButton"),
    savePlexConfigButton: document.querySelector("#savePlexConfigButton"),
    plexConfigStatus: document.querySelector("#plexConfigStatus"),
    saveEmbyConfigButton: document.querySelector("#saveEmbyConfigButton"),
    embyConfigStatus: document.querySelector("#embyConfigStatus"),
    saveJellyfinConfigButton: document.querySelector("#saveJellyfinConfigButton"),
    jellyfinConfigStatus: document.querySelector("#jellyfinConfigStatus"),
    saveTmdbConfigButton: document.querySelector("#saveTmdbConfigButton"),
    tmdbConfigStatus: document.querySelector("#tmdbConfigStatus"),
    saveYoutubeConfigButton: document.querySelector("#saveYoutubeConfigButton"),
    youtubeConfigStatus: document.querySelector("#youtubeConfigStatus"),
    saveFanartConfigButton: document.querySelector("#saveFanartConfigButton"),
    fanartConfigStatus: document.querySelector("#fanartConfigStatus"),
    saveOmdbConfigButton: document.querySelector("#saveOmdbConfigButton"),
    omdbConfigStatus: document.querySelector("#omdbConfigStatus"),
    saveSeerrConfigButton: document.querySelector("#saveSeerrConfigButton") || elements.saveSeerrConfigButton,
    seerrConfigStatus: document.querySelector("#seerrConfigStatus") || elements.seerrConfigStatus,
    saveAdminCredentialsButton: document.querySelector("#saveAdminCredentialsButton"),
    checkSessionButton: document.querySelector("#checkSessionButton"),
    webhookUrl: document.querySelector("#webhookUrl"),
    rotateWebhookButton: document.querySelector("#rotateWebhookButton"),
    runCompleteCheckButton: document.querySelector("#runCompleteCheckButton"),
    refreshCacheStatsButton: document.querySelector("#refreshCacheStatsButton"),
    completeCheckResults: document.querySelector("#completeCheckResults"),
    testConnectionButtons: [...document.querySelectorAll("[data-test-connection]")],
    testConnectionStatuses: [...document.querySelectorAll("[data-test-status]")],
    syncHistoryPanel: document.querySelector("#syncHistoryPanel"),
    syncHistorySummary: document.querySelector("#syncHistorySummary"),
    syncJobsPanel: document.querySelector("#syncJobsPanel"),
    syncSummary: document.querySelector("#syncSummary"),
    tabButtons: [...document.querySelectorAll("[data-view]")],
    explorerButtons: [...document.querySelectorAll("[data-explorer-mode]")],
    viewPanels: [...document.querySelectorAll("[data-view-panel]")],
    closePersonModalButton: document.querySelector("#closePersonModalButton"),
    personModal: document.querySelector("#personModal"),
    personModalBody: document.querySelector("#personModalBody"),
    personModalTitle: document.querySelector("#personModalTitle"),
  });
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function updateVersionBadge(data) {
  if (!elements.appVersion || !data?.current) return;
  elements.appVersion.textContent = data.updateAvailable
    ? `v${data.current} - Update available`
    : `v${data.current}`;
  elements.appVersion.classList.toggle("app-version-update", Boolean(data.updateAvailable));
  elements.appVersion.title = data.updateAvailable
    ? `Update available — v${data.latest || data.current}. Open changelog`
    : "Open changelog";
}

// Quick update check on dashboard load: refreshes the GitHub update status so
// the sidebar badge flags new releases as soon as the changelog commit lands.
async function loadAppVersion() {
  if (!elements.appVersion) return;
  try {
    const response = await fetch("/api/changelog?refresh=1", { cache: "no-store", headers: authHeaders() });
    const data = await response.json();
    if (response.ok) {
      state.changelog = data;
      updateVersionBadge(data);
      if (state.activeView === "settings" && state.activeSettingsTab === "changelog") renderChangelog().catch(() => { });
    }
  } catch {
    // Keep the HTML fallback version when release metadata is unavailable.
  }
}

function compareChangelogVersions(a, b) {
  const parse = (value) => {
    const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// Pulls the published changelog from GitHub (proxied by the server) so we can show
// the user's current build version alongside any newer releases.
async function loadChangelogData(force = false) {
  const response = await fetch(`/api/changelog${force ? "?refresh=1" : ""}`, {
    cache: "no-store",
    headers: authHeaders(),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `Changelog unavailable (${response.status})`);
  state.changelog = data;
  updateVersionBadge(data);
  return data;
}

async function renderChangelog(force = false) {
  if (!elements.changelogPanel) return;
  elements.changelogPanel.innerHTML = `<div class="idle-state"><b>Loading changelog...</b></div>`;
  try {
    const data = await loadChangelogData(force);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const current = data.current || null;
    const latest = data.latest || current;
    const newerCount = Array.isArray(data.newer) ? data.newer.length : 0;

    let banner;
    if (!data.remoteAvailable) {
      banner = `
        <div class="changelog-status changelog-status-muted">
          <b>Current version v${escapeHtml(current || "?")}</b>
          <span>Couldn't reach GitHub to check for newer releases${data.remoteError ? ` (${escapeHtml(data.remoteError)})` : ""}.</span>
        </div>`;
    } else if (data.updateAvailable) {
      banner = `
        <div class="changelog-status changelog-status-update">
          <b>Update available — v${escapeHtml(latest)}</b>
          <span>You're running v${escapeHtml(current || "?")}. ${newerCount} newer release${newerCount === 1 ? "" : "s"} listed below.</span>
        </div>`;
    } else {
      banner = `
        <div class="changelog-status changelog-status-ok">
          <b>You're up to date — v${escapeHtml(current || "?")}</b>
          <span>Running the latest published release.</span>
        </div>`;
    }

    if (!entries.length) {
      elements.changelogPanel.innerHTML = `${banner}<div class="idle-state"><b>No changelog entries found.</b></div>`;
      return;
    }

    const renderEntry = (entry) => {
      const details = Array.isArray(entry.details) ? entry.details.filter(Boolean) : [];
      const isCurrent = current && entry.version === current;
      const isNewer = current && compareChangelogVersions(entry.version, current) > 0;
      const tag = isNewer
        ? `<span class="changelog-tag changelog-tag-new">New</span>`
        : isCurrent
          ? `<span class="changelog-tag changelog-tag-current">Current</span>`
          : "";
      const cls = `changelog-entry${isNewer ? " changelog-entry-new" : ""}${isCurrent ? " changelog-entry-current" : ""}`;
      return `
        <article class="${cls}">
          <div class="changelog-entry-head">
            <b>v${escapeHtml(entry.version || "")}${tag}</b>
            <time>${escapeHtml(formatListDate(entry.date) || entry.date || "")}</time>
          </div>
          <p>${escapeHtml(entry.message || "Release update")}</p>
          ${details.length ? `<ul>${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : ""}
        </article>
      `;
    };

    elements.changelogPanel.innerHTML = banner + entries.map(renderEntry).join("");
  } catch (error) {
    elements.changelogPanel.innerHTML = `<div class="idle-state"><b>${escapeHtml(error.message || "Unable to load changelog.")}</b></div>`;
  }
}


async function apiUpdateWatch(id, fields) {
  const res = await fetch("/api/update-watch", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ id, ...fields }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Convert a watched_at ISO string to a value suitable for datetime-local input
function watchedAtToInputValue(watchedAt) {
  if (!watchedAt) return "";
  try {
    const d = new Date(watchedAt);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
}

// Show inline edit-date dialog inside `container`, saves to record `id`
function openEditDateDialog(_container, id, currentWatchedAt, onSaved, options = {}) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const releaseDate = String(options.releaseDate || "").slice(0, 10);
  const releaseLabel = releaseDate ? formatTmdbDate(releaseDate) : "Release date unavailable";
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel">
      <h3>Edit Watch Date</h3>
      <div class="watch-date-section-label">Quick choices</div>
      <div class="watch-date-options">
        <button class="watch-date-pick edit-date-choice" type="button" data-edit-date-choice="release"${releaseDate ? "" : " disabled"}>
          <span class="watch-date-pick-title">On release date</span>
          <span class="watch-date-pick-sub">${escapeHtml(releaseLabel)}</span>
        </button>
        <button class="watch-date-pick edit-date-choice" type="button" data-edit-date-choice="now">
          <span class="watch-date-pick-title">Now</span>
          <span class="watch-date-pick-sub">Today, ${escapeHtml(formatTmdbDate(new Date().toISOString().slice(0, 10)))}</span>
        </button>
      </div>
      <label class="field-label">
        Or pick a specific time
        <input type="datetime-local" class="field edit-date-input" value="${escapeAttribute(watchedAtToInputValue(currentWatchedAt))}" />
      </label>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll("[data-edit-date-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = overlay.querySelector(".edit-date-input");
      if (!input) return;
      const choice = button.dataset.editDateChoice;
      if (choice === "release" && releaseDate) input.value = watchedAtToInputValue(dateAtMiddayIso(releaseDate));
      if (choice === "now") input.value = watchedAtToInputValue(new Date().toISOString());
    });
  });
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const input = overlay.querySelector(".edit-date-input");
    const status = overlay.querySelector(".edit-dialog-status");
    const value = input.value;
    if (!value) { status.textContent = "Please enter a date."; return; }
    const iso = new Date(value).toISOString();
    status.textContent = "Saving…";
    try {
      await apiUpdateWatch(id, { watched_at: iso });
      overlay.remove();
      onSaved?.({ watched_at: iso });
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  document.body.appendChild(overlay);
}

function fullShowWatchedRows(showTitle = "", fallbackRows = []) {
  const showKey = slug(showTitle);
  const show = state.showsRaw.find((item) => slug(item.title) === showKey);
  const rows = [];
  const seen = new Set();

  const addRow = (row) => {
    if (!row?.id || !isWatchedHistoryAction(row) || seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  };

  for (const episode of show?.episodes || []) addRow(episode);
  for (const episode of fallbackRows || []) addRow(episode);
  for (const row of state.history || []) {
    if (row.media_type !== "episode") continue;
    const rowShowTitle = row.show_title || showTitleFrom(row.title);
    if (slug(rowShowTitle) === showKey) addRow(row);
  }

  return rows;
}

function openEditShowDateDialog(showTitle, watchedRows = []) {
  const rows = fullShowWatchedRows(showTitle, watchedRows);
  if (!rows.length) {
    setMessage("There are no watched episodes to update.", "error");
    return;
  }

  const latest = rows.reduce((value, row) => row.watched_at > value ? row.watched_at : value, rows[0].watched_at || "");
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel">
      <h3>Edit Show Watch Date</h3>
      <p class="muted-copy">Updates ${rows.length} watched episode date${rows.length === 1 ? "" : "s"} for ${escapeHtml(showTitle || "this show")}.</p>
      <label class="field-label">
        Watched at
        <input type="datetime-local" class="field edit-date-input" value="${escapeAttribute(watchedAtToInputValue(latest))}" />
      </label>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const input = overlay.querySelector(".edit-date-input");
    const status = overlay.querySelector(".edit-dialog-status");
    const saveButton = overlay.querySelector(".edit-dialog-save");
    const value = input.value;
    if (!value) { status.textContent = "Please enter a date."; return; }

    const watched_at = new Date(value).toISOString();
    saveButton.disabled = true;
    status.textContent = `Saving 0/${rows.length}...`;
    try {
      let saved = 0;
      for (const row of rows) {
        await apiUpdateWatch(row.id, { watched_at });
        saved += 1;
        status.textContent = `Saving ${saved}/${rows.length}...`;
      }

      for (const row of rows) row.watched_at = watched_at;
      const showKey = slug(showTitle);
      const show = state.showsRaw.find((item) => slug(item.title) === showKey);
      if (show?.episodes) {
        const ids = new Set(rows.map((row) => row.id));
        for (const episode of show.episodes) {
          if (ids.has(episode.id)) episode.watched_at = watched_at;
        }
        show.latest_watched_at = show.episodes.reduce((value, episode) => episode.watched_at > value ? episode.watched_at : value, "");
        show.earliest_watched_at = show.episodes.reduce((value, episode) => !value || episode.watched_at < value ? episode.watched_at : value, "");
      }

      clearDerivedUiCaches({ resetExplorer: false });
      if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
      if (state.activeShowModalKey) {
        renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else if (state.activeShowTmdbId) {
        await openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      }
      overlay.remove();
      setMessage(`Updated ${rows.length} watched episode date${rows.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      saveButton.disabled = false;
      setMessage(`Show watch date update failed: ${error.message}`, "error");
      status.textContent = `Error: ${error.message}`;
    }
  });

  document.body.appendChild(overlay);
}

function openEditSeasonDateDialog(showTitle, seasonNum, watchedEpisodes = []) {
  if (!watchedEpisodes.length) {
    setMessage("There are no watched episodes in this season to update.", "error");
    return;
  }

  const latest = watchedEpisodes.reduce((value, row) => row.watched_at > value ? row.watched_at : value, watchedEpisodes[0].watched_at || "");
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel">
      <h3>Edit Season Watch Date</h3>
      <p class="muted-copy">Updates ${watchedEpisodes.length} watched episode date${watchedEpisodes.length === 1 ? "" : "s"} for Season ${seasonNum} of ${escapeHtml(showTitle || "this show")}.</p>
      <label class="field-label">
        Watched at
        <input type="datetime-local" class="field edit-date-input" value="${escapeAttribute(watchedAtToInputValue(latest))}" />
      </label>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const input = overlay.querySelector(".edit-date-input");
    const status = overlay.querySelector(".edit-dialog-status");
    const saveButton = overlay.querySelector(".edit-dialog-save");
    const value = input.value;
    if (!value) { status.textContent = "Please enter a date."; return; }

    const watched_at = new Date(value).toISOString();
    saveButton.disabled = true;
    status.textContent = `Saving 0/${watchedEpisodes.length}...`;
    try {
      let saved = 0;
      for (const row of watchedEpisodes) {
        await apiUpdateWatch(row.id, { watched_at });
        saved += 1;
        status.textContent = `Saving ${saved}/${watchedEpisodes.length}...`;
      }

      for (const row of watchedEpisodes) row.watched_at = watched_at;
      const showKey = slug(showTitle);
      const show = state.showsRaw.find((item) => slug(item.title) === showKey);
      if (show?.episodes) {
        const ids = new Set(watchedEpisodes.map((row) => row.id));
        for (const episode of show.episodes) {
          if (ids.has(episode.id)) episode.watched_at = watched_at;
        }
        show.latest_watched_at = show.episodes.reduce((value, episode) => episode.watched_at > value ? episode.watched_at : value, "");
        show.earliest_watched_at = show.episodes.reduce((value, episode) => !value || episode.watched_at < value ? episode.watched_at : value, "");
      }

      clearDerivedUiCaches({ resetExplorer: false });
      if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
      if (state.activeShowModalKey) {
        renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else if (state.activeShowTmdbId) {
        await openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      }
      overlay.remove();
      setMessage(`Updated ${watchedEpisodes.length} episode date${watchedEpisodes.length === 1 ? "" : "s"} for Season ${seasonNum}.`, "success");
    } catch (error) {
      saveButton.disabled = false;
      setMessage(`Season watch date update failed: ${error.message}`, "error");
      status.textContent = `Error: ${error.message}`;
    }
  });

  document.body.appendChild(overlay);
}

function openConfirmDialog({ title = "Are you sure?", body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    document.querySelectorAll(".confirm-dialog-overlay").forEach((el) => el.remove());
    const overlay = document.createElement("div");
    overlay.className = "edit-dialog-overlay confirm-dialog-overlay";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
    overlay.innerHTML = `
      <div class="edit-dialog">
        <h3>${escapeHtml(title)}</h3>
        ${body ? `<p class="confirm-dialog-body">${escapeHtml(body)}</p>` : ""}
        <div class="edit-dialog-actions">
          <button class="${danger ? "button-danger" : "button-primary"} confirm-dialog-confirm" type="button">${escapeHtml(confirmLabel)}</button>
          <button class="button-ghost confirm-dialog-cancel" type="button">${escapeHtml(cancelLabel)}</button>
        </div>
      </div>
    `;
    overlay.querySelector(".confirm-dialog-confirm").addEventListener("click", () => finish(true));
    overlay.querySelector(".confirm-dialog-cancel").addEventListener("click", () => finish(false));
    document.body.appendChild(overlay);
    overlay.querySelector(".confirm-dialog-confirm").focus();
  });
}

function closeGlobalSearchDropdown() {
  document.getElementById("globalSearchDropdown")?.remove();
}

function renderGlobalSearchDropdown(query) {
  closeGlobalSearchDropdown();
  const q = query.toLowerCase();

  const movies = [];
  const shows = [];
  const people = [];

  const seenMovies = new Set();
  const seenShows = new Set();
  const seenPeople = new Set();

  // 1. Local TV shows (deduplicated by title)
  for (const s of (state.showsRaw || [])) {
    if (shows.length >= 5) break;
    if (!(s.title || "").toLowerCase().includes(q)) continue;
    if (seenShows.has(s.title.toLowerCase())) continue;
    seenShows.add(s.title.toLowerCase());
    shows.push({
      _type: "show",
      title: s.title,
      poster: s.poster_url || s.posterUrl || "",
      href: `/tvshow/${slug(s.title)}`,
      sub: "TV Show",
      overview: "",
      isLocal: true
    });
  }

  // 2. Local Movies
  for (const m of (state.history || [])) {
    if (movies.length >= 5) break;
    if (m.media_type !== "movie") continue;
    if (!(m.title || "").toLowerCase().includes(q)) continue;
    if (seenMovies.has(m.title.toLowerCase())) continue;
    seenMovies.add(m.title.toLowerCase());
    movies.push({
      _type: "movie",
      title: m.title,
      poster: m.poster_url || "",
      href: movieHref(m),
      sub: "Movie",
      overview: "",
      isLocal: true
    });
  }

  // 3. Local Episodes (search episode title)
  for (const e of (state.history || [])) {
    if (shows.length >= 5) break;
    if (e.media_type !== "episode") continue;
    const epTitle = e.title || "";
    if (!epTitle.toLowerCase().includes(q)) continue;
    const key = `${e.show_title}|${epTitle}`.toLowerCase();
    if (seenShows.has(key)) continue;
    seenShows.add(key);
    const showTitle = e.show_title || showTitleFrom(epTitle);
    const showEntry = (state.showsRaw || []).find((s) => slug(s.title) === slug(showTitle));
    const poster = showEntry?.poster_url || showEntry?.posterUrl || e.poster_url || "";
    const sNum = e.season ? `S${String(e.season).padStart(2, "0")}` : "";
    const eNum = e.episode ? `E${String(e.episode).padStart(2, "0")}` : "";
    const coord = [sNum, eNum].filter(Boolean).join("·");
    const sub = [showTitle, coord, "Episode"].filter(Boolean).join(" · ");
    shows.push({
      _type: "episode",
      title: epTitle,
      poster,
      href: `/tvshow/${slug(showTitle)}`,
      sub,
      overview: "",
      isLocal: true
    });
  }

  // 4. TMDB Discovery
  const discoveryState = state.globalDiscoveryResults.get(q.trim());
  for (const item of (discoveryState?.results || [])) {
    const mediaType = item.media_type || (item.title ? "movie" : "tv");
    if (!["movie", "tv", "person"].includes(mediaType)) continue;

    const title = item.title || item.name || "Unknown title";
    const overview = item.overview || (item.known_for ? `Known for: ${item.known_for.map(x => x.title || x.name).filter(Boolean).join(", ")}` : "");
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);

    if (mediaType === "movie") {
      if (movies.length >= 5) continue;
      if (seenMovies.has(title.toLowerCase())) {
        const existing = movies.find(m => m.title.toLowerCase() === title.toLowerCase());
        if (existing && !existing.overview && overview) existing.overview = overview;
        continue;
      }
      seenMovies.add(title.toLowerCase());
      movies.push({
        _type: "movie",
        title,
        poster: tmdbPoster(item.poster_path, item.id, "movie"),
        href: `/movie/tmdb/${item.id}`,
        sub: `Movie${year ? ` · ${year}` : ""} · TMDB`,
        overview,
        isLocal: false
      });
    } else if (mediaType === "tv") {
      if (shows.length >= 5) continue;
      if (seenShows.has(title.toLowerCase())) {
        const existing = shows.find(s => s.title.toLowerCase() === title.toLowerCase());
        if (existing && !existing.overview && overview) existing.overview = overview;
        continue;
      }
      seenShows.add(title.toLowerCase());
      shows.push({
        _type: "show",
        title,
        poster: tmdbPoster(item.poster_path, item.id, "tv"),
        href: `/tvshow/tmdb/${item.id}`,
        sub: `TV Show${year ? ` · ${year}` : ""} · TMDB`,
        overview,
        isLocal: false
      });
    } else if (mediaType === "person") {
      if (seenPeople.has(title.toLowerCase())) continue;
      seenPeople.add(title.toLowerCase());
      people.push({
        _type: "person",
        title,
        poster: tmdbProfile(item.profile_path) || tmdbPoster(item.profile_path),
        href: `/person/${item.id}`,
        sub: "Cast Member",
        overview,
        isLocal: false
      });
    }
  }

  // Prioritize actor matching query at the top of the people list
  people.sort((a, b) => {
    const aIsMatch = a.title.toLowerCase() === q;
    const bIsMatch = b.title.toLowerCase() === q;
    if (aIsMatch && !bIsMatch) return -1;
    if (!aIsMatch && bIsMatch) return 1;

    const aIsPartial = a.title.toLowerCase().includes(q);
    const bIsPartial = b.title.toLowerCase().includes(q);
    if (aIsPartial && !bIsPartial) return -1;
    if (!aIsPartial && bIsPartial) return 1;

    return 0; // Maintain original order
  });

  const finalPeople = people.slice(0, 5);

  if (!movies.length && !shows.length && !finalPeople.length && !discoveryState?.loading) return;

  const anchor = document.querySelector(".global-search");
  if (!anchor) return;

  const renderItem = (r) => `
    <button class="global-search-result" data-href="${escapeAttribute(r.href)}" tabindex="0">
      ${r.poster ? `<img src="${escapeAttribute(r.poster)}" alt="" class="gsr-thumb" loading="lazy">` : `<span class="gsr-thumb gsr-thumb--empty"></span>`}
      <span class="gsr-text">
        <span class="gsr-title">${escapeHtml(r.title)}</span>
        <span class="gsr-sub">${escapeHtml(r.sub)}</span>
        ${r.overview ? `<span class="gsr-overview">${escapeHtml(r.overview)}</span>` : ""}
      </span>
    </button>`;

  const dd = document.createElement("div");
  dd.id = "globalSearchDropdown";
  dd.innerHTML = `
    <div class="gsd-header">Top Results for "<strong>${escapeHtml(query)}</strong>"</div>
    <div class="gsd-columns">
      <div class="gsd-column">
        <div class="gsd-column-header">Movies</div>
        <div class="gsd-column-list">
          ${movies.length ? movies.map(renderItem).join("") : '<div class="gsd-column-empty">No matching movies</div>'}
        </div>
      </div>
      <div class="gsd-column">
        <div class="gsd-column-header">TV Shows</div>
        <div class="gsd-column-list">
          ${shows.length ? shows.map(renderItem).join("") : '<div class="gsd-column-empty">No matching TV shows</div>'}
        </div>
      </div>
      <div class="gsd-column">
        <div class="gsd-column-header">People</div>
        <div class="gsd-column-list">
          ${finalPeople.length ? finalPeople.map(renderItem).join("") : '<div class="gsd-column-empty">No matching people</div>'}
        </div>
      </div>
    </div>
    ${discoveryState?.loading ? `<div class="gsd-loading">Searching TMDB…</div>` : ""}
    <button class="gsd-more" data-search="${escapeAttribute(query)}">View All Results</button>
  `;

  anchor.appendChild(dd);

  dd.addEventListener("click", (e) => {
    const more = e.target.closest(".gsd-more");
    if (more) {
      closeGlobalSearchDropdown();
      navigateTo(`/search?q=${encodeURIComponent(more.dataset.search)}`);
      return;
    }
    const btn = e.target.closest(".global-search-result");
    if (!btn) return;
    closeGlobalSearchDropdown();
    elements.globalSearchInput.value = "";
    navigateTo(btn.dataset.href);
  });

  dd.addEventListener("keydown", (e) => {
    const btns = [...dd.querySelectorAll(".global-search-result, .gsd-more")];
    const idx = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(idx + 1) % btns.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (idx > 0 ? btns[idx - 1] : elements.globalSearchInput)?.focus(); }
    else if (e.key === "Enter" && idx >= 0) { btns[idx].click(); }
    else if (e.key === "Escape") { closeGlobalSearchDropdown(); elements.globalSearchInput.focus(); }
  });
}

async function loadGlobalDiscovery(query) {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2 || !state.savedConfig.tmdb?.configured) return;
  const token = ++state.globalSearchRequestToken;
  state.globalDiscoveryResults.set(normalized, { loading: true, results: [] });
  renderGlobalSearchDropdown(query);
  try {
    const response = await fetch(`/api/tmdb-search?query=${encodeURIComponent(query)}&mediaType=multi`, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Search failed with ${response.status}`);
    state.globalDiscoveryResults.set(normalized, { loading: false, results: body.results || [] });
  } catch (error) {
    state.globalDiscoveryResults.set(normalized, { loading: false, results: [] });
    console.error("TMDB discovery search failed", error);
  }
  if (token === state.globalSearchRequestToken && elements.globalSearchInput?.value.trim().toLowerCase() === normalized) {
    renderGlobalSearchDropdown(query);
  }
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v") || null;
  } catch { /* invalid URL */ }
  return null;
}

function openEditImageDialog(_container, id, currentPosterUrl, tmdbData, onSaved) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  let activeTab = "poster";

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide glass-panel">
      <div class="edit-image-tabs">
        <button class="edit-image-tab active" type="button" data-tab="poster">Poster</button>
        <button class="edit-image-tab" type="button" data-tab="logo">Logo / Title Art</button>
        <button class="edit-image-tab" type="button" data-tab="youtube">YouTube Show</button>
        <button class="edit-image-tab" type="button" data-tab="custom">Custom Image</button>
      </div>
      <p class="edit-dialog-status" style="margin:0;"></p>
      <div class="edit-image-grid poster-search-grid"></div>
      <div class="edit-image-yt-row" style="display:none;">
        <label class="field-label" style="margin-top: 0.75rem;">
          YouTube URL <span class="muted-copy" style="font-weight:normal;">(paste to fetch thumbnails)</span>
          <div style="display:flex;gap:0.5rem;">
            <input type="url" class="field yt-url-input" placeholder="https://www.youtube.com/watch?v=..." style="flex:1;" />
            <button class="button-ghost yt-fetch-btn" type="button">Fetch</button>
          </div>
        </label>
      </div>
      <div class="edit-image-custom-row" style="display:none;">
        <label class="field-label" style="margin-top: 0.5rem;">
          Custom image URL
          <input type="url" class="field edit-image-custom-input" placeholder="https://..." value="" />
        </label>
      </div>
      <input type="hidden" class="edit-image-input" value="" />
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save poster</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;

  const gridEl = overlay.querySelector(".poster-search-grid");
  const status = overlay.querySelector(".edit-dialog-status");
  const urlInput = overlay.querySelector(".edit-image-input");
  const ytRow = overlay.querySelector(".edit-image-yt-row");
  const customRow = overlay.querySelector(".edit-image-custom-row");
  const customInput = overlay.querySelector(".edit-image-custom-input");
  const ytInput = overlay.querySelector(".yt-url-input");
  const ytFetchBtn = overlay.querySelector(".yt-fetch-btn");
  const saveBtn = overlay.querySelector(".edit-dialog-save");

  customInput.addEventListener("input", () => { urlInput.value = customInput.value; });

  const renderGrid = (items, isLogo = false, selectFirst = true) => {
    gridEl.classList.toggle("edit-image-grid--logo", isLogo);
    gridEl.innerHTML = items.map((item, i) => {
      const url = typeof item === "string" ? item : item.url;
      const lang = typeof item === "object" && item.lang ? item.lang : null;
      const source = typeof item === "object" && item.source ? item.source : null;
      const hasBadges = lang || source;
      return `
        <button class="edit-image-option${isLogo ? " edit-image-option--logo" : ""}" type="button" data-url="${escapeAttribute(url)}">
          <img src="${escapeAttribute(url)}" alt="${isLogo ? "Logo" : "Poster"} ${i + 1}" loading="lazy" data-err="hide-closest-btn" />
          ${hasBadges ? `<span class="edit-image-badge-row">${lang ? `<span class="edit-image-logo-lang">${escapeAttribute(lang.toUpperCase())}</span>` : ""}${source ? `<span class="edit-image-source-badge edit-image-source-badge--${escapeAttribute(source.toLowerCase())}">${escapeAttribute(source)}</span>` : ""}</span>` : ""}
        </button>
      `;
    }).join("");
    gridEl.querySelectorAll(".edit-image-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        urlInput.value = btn.dataset.url;
        gridEl.querySelectorAll(".edit-image-option").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });
    const firstUrl = typeof items[0] === "string" ? items[0] : items[0]?.url;
    if (selectFirst && firstUrl) {
      urlInput.value = firstUrl;
      gridEl.querySelector(".edit-image-option")?.classList.add("selected");
    }
  };

  const fetchYouTubeThumbnails = async () => {
    const videoId = extractYouTubeId(ytInput.value.trim());
    if (!videoId) { status.textContent = "Could not find a YouTube video ID in that URL."; return; }
    status.textContent = "Fetching YouTube thumbnails…";
    const candidates = [
      `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    ];
    const valid = await Promise.all(candidates.map((url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > 120 ? url : null);
      img.onerror = () => resolve(null);
      img.src = url;
    })));
    const found = valid.filter(Boolean);
    if (!found.length) { status.textContent = "No thumbnails found for that video."; return; }
    status.textContent = "";
    renderGrid(found, false);
  };

  ytFetchBtn.addEventListener("click", fetchYouTubeThumbnails);
  ytInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchYouTubeThumbnails(); } });

  let tmdbImages = null;
  const getTmdbImages = async () => {
    if (tmdbImages) return tmdbImages;
    const tmdbId = tmdbData?.id;
    const mediaType = tmdbData?.title !== undefined ? "movie" : "tv";
    if (state.savedConfig?.tmdb?.configured && tmdbId) {
      try {
        const res = await fetch(`/api/tmdb-images?mediaType=${encodeURIComponent(mediaType)}&tmdbId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() });
        tmdbImages = await res.json();
      } catch { tmdbImages = {}; }
    } else {
      tmdbImages = {};
    }
    return tmdbImages;
  };

  let fanartImages = null;
  const getFanartImages = async () => {
    if (fanartImages) return fanartImages;
    const tmdbId = tmdbData?.id;
    const mediaType = tmdbData?.title !== undefined ? "movie" : "tv";
    if (tmdbId) {
      try {
        const res = await fetch(`/api/fanart-images?mediaType=${encodeURIComponent(mediaType)}&tmdbId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() });
        fanartImages = await res.json();
      } catch { fanartImages = {}; }
    } else {
      fanartImages = {};
    }
    return fanartImages;
  };

  const loadPosters = async () => {
    status.textContent = "Loading posters…";
    urlInput.value = "";
    const [tmdbData_, fanartData] = await Promise.all([getTmdbImages(), getFanartImages()]);
    const seen = new Set();
    const items = [];
    for (const p of (tmdbData_.posters || []).slice(0, 20)) {
      const url = tmdbPoster(p.file_path);
      if (!seen.has(url)) { seen.add(url); items.push({ url, source: "TMDB" }); }
    }
    for (const p of (fanartData?.posters || [])) {
      if (p.url && !seen.has(p.url)) { seen.add(p.url); items.push({ url: p.url, lang: p.lang || "", source: "Fanart" }); }
    }
    if (items.length) { status.textContent = ""; renderGrid(items, false); return; }
    const fallback = [];
    if (tmdbData?.poster_path) fallback.push(tmdbPoster(tmdbData.poster_path));
    if (tmdbData?.backdrop_path) fallback.push(`https://image.tmdb.org/t/p/w780${tmdbData.backdrop_path}`);
    if (currentPosterUrl) fallback.push(currentPosterUrl);
    if (fallback.length) { status.textContent = ""; renderGrid(fallback, false); }
    else { status.textContent = state.savedConfig?.tmdb?.configured ? "No posters found." : "Configure a TMDB API key to browse posters."; gridEl.innerHTML = ""; }
  };

  const loadLogos = async () => {
    status.textContent = "Loading logos…";
    urlInput.value = "";
    gridEl.innerHTML = "";
    const [tmdbData_, fanartData] = await Promise.all([getTmdbImages(), getFanartImages()]);
    const seen = new Set();
    const items = [];
    const logos = (tmdbData_.logos || []);
    const enLogos = logos.filter(l => l.iso_639_1 === "en");
    const otherLogos = logos.filter(l => l.iso_639_1 !== "en");
    for (const l of [...enLogos, ...otherLogos].slice(0, 16)) {
      const url = tmdbImage(l.file_path, "original");
      if (!seen.has(url)) {
        seen.add(url);
        items.push({ url, lang: l.iso_639_1 ? l.iso_639_1.toUpperCase() : "—", source: "TMDB" });
      }
    }
    for (const l of (fanartData?.logos || [])) {
      if (l.url && !seen.has(l.url)) {
        seen.add(l.url);
        items.push({ url: l.url, lang: l.lang ? l.lang.toUpperCase() : "", source: "Fanart" });
      }
    }
    if (items.length) {
      const hasEnTmdb = enLogos.length > 0;
      const hasEnFanart = (fanartData?.logos || []).some(l => l.lang === "en");
      status.textContent = (!hasEnTmdb && !hasEnFanart && items.length > 0) ? "No English logo found — showing other languages." : "";
      renderGrid(items, true, true);
      return;
    }
    status.textContent = state.savedConfig?.tmdb?.configured ? "No logo art found for this title." : "Configure a TMDB API key to browse logos.";
  };

  const switchTab = (tab) => {
    activeTab = tab;
    overlay.querySelectorAll(".edit-image-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tab));
    urlInput.value = "";
    gridEl.style.display = "";
    gridEl.classList.remove("edit-image-grid--logo");
    ytRow.style.display = "none";
    customRow.style.display = "none";
    if (tab === "poster") {
      saveBtn.textContent = "Save poster";
      loadPosters();
    } else if (tab === "logo") {
      saveBtn.textContent = "Save logo";
      loadLogos();
    } else if (tab === "youtube") {
      saveBtn.textContent = "Save poster";
      gridEl.innerHTML = "";
      status.textContent = "";
      ytRow.style.display = "";
    } else if (tab === "custom") {
      saveBtn.textContent = "Save image";
      gridEl.style.display = "none";
      status.textContent = "";
      customRow.style.display = "";
      customInput.value = "";
    }
  };

  overlay.querySelectorAll(".edit-image-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  saveBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) { status.textContent = "Please select or enter an image URL."; return; }
    status.textContent = "Saving…";
    try {
      const field = activeTab === "logo" ? "logo_url" : "poster_url";
      const saved = await apiUpdateWatch(id, { [field]: url });
      overlay.remove();
      onSaved?.({ [field]: url, storage_url: saved?.poster_url, updated_ids: saved?.updated_ids });
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  document.body.appendChild(overlay);
  loadPosters();
}

function openFixMatchDialog(_container, id, currentTitle, mediaType, onSaved) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide glass-panel">
      <h3>Fix Match</h3>
      <p class="muted-copy" style="margin-bottom: 0.75rem;">Search TMDB to link the correct ${mediaType === "movie" ? "movie" : "TV show"}, or match to a YouTube video.</p>
      <div style="display: flex; gap: 0.5rem;">
        <input type="search" class="field fix-match-input" placeholder="${escapeAttribute(currentTitle || "Search title…")}" value="${escapeAttribute(currentTitle || "")}" style="flex: 1;" />
        <button class="button-primary fix-match-search-btn" type="button">Search TMDB</button>
      </div>
      <div class="fix-match-results"></div>

      <hr style="border:0;border-top:1px solid var(--border);margin:1rem 0 0.75rem;" />
      <p class="muted-copy" style="margin-bottom:0.5rem;">YouTube content not on TMDB? Paste the video URL below.</p>
      <div style="display:flex;gap:0.5rem;">
        <input type="url" class="field fix-match-yt-input" placeholder="https://www.youtube.com/watch?v=..." style="flex:1;" />
        <button class="button-ghost fix-match-yt-fetch-btn" type="button">Fetch</button>
      </div>
      <div class="fix-match-yt-preview" style="display:none;margin-top:0.75rem;"></div>

      <p class="edit-dialog-status"></p>
      <div class="edit-dialog-actions" style="margin-top: 0.5rem;">
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;

  const resultsEl = overlay.querySelector(".fix-match-results");
  const status = overlay.querySelector(".edit-dialog-status");
  const input = overlay.querySelector(".fix-match-input");
  const ytInput = overlay.querySelector(".fix-match-yt-input");
  const ytFetchBtn = overlay.querySelector(".fix-match-yt-fetch-btn");
  const ytPreview = overlay.querySelector(".fix-match-yt-preview");
  const tmdbType = mediaType === "movie" ? "movie" : "tv";

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;
    status.textContent = "Searching…";
    resultsEl.innerHTML = "";
    try {
      if (!state.savedConfig?.tmdb?.configured) { status.textContent = "TMDB API key not configured."; return; }
      const res = await fetch(`/api/tmdb-search?mediaType=${encodeURIComponent(tmdbType)}&query=${encodeURIComponent(query)}`, { headers: authHeaders() });
      const data = await res.json();
      const results = data.results || [];
      status.textContent = results.length ? "" : "No results found.";
      resultsEl.innerHTML = results.slice(0, 10).map((item) => {
        const poster = tmdbPoster(item.poster_path) || "/favicon.svg";
        const title = item.title || item.name || "Unknown";
        const year = (item.release_date || item.first_air_date || "").slice(0, 4);
        return `
          <button class="fix-match-result" type="button" data-tmdb-id="${item.id}" data-title="${escapeAttribute(title)}">
            <img src="${escapeAttribute(poster)}" alt="" data-err="fav" />
            <span>${escapeHtml(title)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
          </button>
        `;
      }).join("");

      resultsEl.querySelectorAll(".fix-match-result").forEach((btn) => {
        btn.addEventListener("click", async () => {
          status.textContent = "Saving…";
          try {
            await apiUpdateWatch(id, { tmdb_id: btn.dataset.tmdbId });
            state.tmdbDetailsCache.clear();
            overlay.remove();
            onSaved?.({ tmdb_id: btn.dataset.tmdbId, title: btn.dataset.title });
          } catch (err) {
            status.textContent = `Error: ${err.message}`;
          }
        });
      });
    } catch (err) {
      status.textContent = `Search failed: ${err.message}`;
    }
  };

  const doYtFetch = async () => {
    const url = ytInput.value.trim();
    const videoId = extractYouTubeId(url);
    if (!videoId) { status.textContent = "Could not find a YouTube video ID in that URL."; return; }
    status.textContent = "Fetching YouTube metadata…";
    ytPreview.style.display = "none";
    try {
      const res = await fetch(`/api/youtube-meta?url=${encodeURIComponent(url)}`, { headers: authHeaders() });
      const meta = await res.json();
      if (meta.error) { status.textContent = `YouTube: ${meta.error}`; return; }
      status.textContent = "";

      const thumbHtml = meta.thumbnails?.length
        ? `<img src="${escapeAttribute(meta.thumbnails[0])}" alt="thumbnail" style="width:120px;height:68px;object-fit:cover;border-radius:4px;flex-shrink:0;" data-err="hide" />`
        : "";
      const descHtml = meta.description
        ? `<p style="font-size:0.8rem;color:var(--muted);margin:0.4rem 0 0;max-height:4.5rem;overflow:hidden;">${escapeHtml(meta.description)}</p>`
        : "";
      const dateHtml = meta.publishedAt ? `<small style="color:var(--muted);">${escapeHtml(meta.publishedAt.slice(0, 10))}</small>` : "";

      ytPreview.style.display = "block";
      ytPreview.innerHTML = `
        <div style="display:flex;gap:0.75rem;align-items:flex-start;background:var(--surface-raised,rgba(255,255,255,0.04));border-radius:8px;padding:0.6rem;">
          ${thumbHtml}
          <div style="flex:1;min-width:0;">
            <b style="display:block;">${escapeHtml(meta.title || "Unknown title")}</b>
            <small style="color:var(--muted);">${escapeHtml(meta.channelName || "")}${dateHtml ? " &middot; " + dateHtml : ""}</small>
            ${descHtml}
          </div>
        </div>
        <button class="button-primary fix-match-yt-confirm-btn" type="button" style="margin-top:0.6rem;width:100%;">Match as YouTube video</button>
      `;

      ytPreview.querySelector(".fix-match-yt-confirm-btn").addEventListener("click", async () => {
        status.textContent = "Saving…";
        try {
          const updates = { youtube_url: url, poster_url: meta.thumbnails?.[0] || "" };
          if (meta.title && meta.title !== currentTitle) updates.title = meta.title;
          await apiUpdateWatch(id, updates);
          state.tmdbDetailsCache.clear();
          overlay.remove();
          onSaved?.({ youtube_url: url, poster_url: updates.poster_url, title: updates.title || currentTitle });
        } catch (err) {
          status.textContent = `Error: ${err.message}`;
        }
      });
    } catch (err) {
      status.textContent = `Fetch failed: ${err.message}`;
    }
  };

  overlay.querySelector(".fix-match-search-btn").addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  ytFetchBtn.addEventListener("click", doYtFetch);
  ytInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doYtFetch(); } });
  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());

  document.body.appendChild(overlay);
  doSearch();
}

function openMergeShowDialog(targetTitle) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide glass-panel">
      <h3>Merge Into "${escapeHtml(targetTitle)}"</h3>
      <p class="muted-copy" style="margin-bottom: 0.75rem;">Select a duplicate show to merge into this one. Its episodes will be moved here and the duplicate removed.</p>
      <div style="display: flex; gap: 0.5rem;">
        <input type="search" class="field merge-show-input" placeholder="Search shows…" value="${escapeAttribute(targetTitle)}" style="flex: 1;" />
        <button class="button-primary merge-show-search-btn" type="button">Search</button>
      </div>
      <div class="fix-match-results merge-show-results"></div>
      <p class="edit-dialog-status"></p>
      <div class="edit-dialog-actions" style="margin-top: 0.5rem;">
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;

  const resultsEl = overlay.querySelector(".merge-show-results");
  const status = overlay.querySelector(".edit-dialog-status");
  const input = overlay.querySelector(".merge-show-input");

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;
    status.textContent = "Searching…";
    resultsEl.innerHTML = "";
    try {
      const res = await fetch(`/api/shows?search=${encodeURIComponent(query)}&limit=20`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      const shows = (body.shows || []).filter((s) => (sanitizeTitle(s.title) || "").toLowerCase() !== targetTitle.toLowerCase());
      status.textContent = shows.length ? "" : "No other shows found.";
      resultsEl.innerHTML = shows.map((s) => {
        const title = sanitizeTitle(s.title) || "Unknown Show";
        const count = s.episode_count || s.episodes?.length || 0;
        const posterUrl = s.poster_url || "";
        return `
          <button class="fix-match-result" type="button" data-source-title="${escapeAttribute(title)}">
            ${posterUrl ? `<img src="${escapeAttribute(posterUrl)}" alt="" data-err="hide" />` : ""}
            <span>${escapeHtml(title)}${count ? ` <small>(${count} eps)</small>` : ""}</span>
          </button>
        `;
      }).join("");

      resultsEl.querySelectorAll(".fix-match-result").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const sourceTitle = btn.dataset.sourceTitle;
          if (!confirm(`Merge "${sourceTitle}" into "${targetTitle}"? This cannot be undone.`)) return;
          status.textContent = "Merging…";
          try {
            const r = await fetch("/api/merge-shows", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ source_title: sourceTitle, target_title: targetTitle }),
            });
            const result = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(result.error || "Merge failed");
            overlay.remove();
            state.showsRaw = state.showsRaw.filter((s) => (sanitizeTitle(s.title) || "") !== sourceTitle);
            setMessage(`Merged "${sourceTitle}" into "${targetTitle}"`, "success");
            navigateTo("/tvshows");
          } catch (err) {
            status.textContent = `Error: ${err.message}`;
          }
        });
      });
    } catch (err) {
      status.textContent = `Search failed: ${err.message}`;
    }
  };

  overlay.querySelector(".merge-show-search-btn").addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());

  document.body.appendChild(overlay);
  doSearch();
}

function logDebug(message, details) {
  state.debugLogs = appendDebugLog(state.debugLogs, message, details);
  renderLogs().catch(() => { });
  return state.debugLogs.at(-1);
}

function logsText() {
  return logsToText(state.debugLogs);
}


function bootstrapTokenFromUrl() {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const hasAuthParams = /(?:[?&#](?:adminToken|username|token)=)|(?:^#(?:adminToken|username|token)=)/i.test(`${search}${hash}`);

  if (!hasAuthParams) return;

  scrubTokenFromLocation();
}

bootstrapTokenFromUrl();



function historyVersionFromRows(rows = []) {
  const newest = rows.reduce((latest, row) => {
    const watchedAt = String(row?.watched_at || "");
    return watchedAt > latest ? watchedAt : latest;
  }, "");
  return newest ? `rows:${newest}:${rows.length}` : "empty";
}

function persistentDashboardHistoryCacheKey() {
  const userKey = state.currentUser?.uid || state.currentUser?.email || "local";
  return `${DASHBOARD_HISTORY_CACHE_KEY}:${userKey}`;
}

function readPersistentDashboardHistory() {
  try {
    const raw = localStorage.getItem(persistentDashboardHistoryCacheKey());
    const parsed = raw ? JSON.parse(raw) : {};
    if (!Array.isArray(parsed.history)) return null;
    if (Date.now() - Number(parsed.savedAt || 0) > DASHBOARD_HISTORY_CACHE_TTL_MS) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function rememberDashboardHistory(history, historyVersion) {
  try {
    localStorage.setItem(persistentDashboardHistoryCacheKey(), JSON.stringify({
      savedAt: Date.now(),
      historyVersion: historyVersion || historyVersionFromRows(history),
      history,
    }));
  } catch (error) {
    // Dashboard cache is best-effort; the API remains the source of truth.
  }
}

function applyCachedDashboardHistory() {
  if (state.history.length) return true;
  const cached = readPersistentDashboardHistory();
  if (!cached?.history?.length) return false;
  state.history = cached.history;
  state.historyVersion = String(cached.historyVersion || historyVersionFromRows(cached.history));
  renderDashboard();
  return true;
}

function explorerCacheVersion() {
  return String(state.historyVersion || historyVersionFromRows(state.history));
}

function persistentExplorerCacheKey() {
  const userKey = state.currentUser?.uid || state.currentUser?.email || "local";
  return `${EXPLORER_PERSISTED_CACHE_KEY}:${userKey}`;
}

function readPersistentExplorerCache() {
  try {
    const raw = localStorage.getItem(persistentExplorerCacheKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    return [];
  }
}

function writePersistentExplorerCache(entries) {
  try {
    localStorage.setItem(persistentExplorerCacheKey(), JSON.stringify({ entries }));
  } catch (error) {
    // Storage is best-effort; the in-memory cache and API remain available.
  }
}

function clearPersistentExplorerPageCache() {
  try {
    localStorage.removeItem(persistentExplorerCacheKey());
  } catch (error) { }
}

function cachedExplorerPage(key) {
  const version = explorerCacheVersion();
  const cached = state.explorerPageCache.get(key);
  if (cached && cached.version === version && Date.now() - cached.savedAt <= EXPLORER_CACHE_TTL_MS) {
    return cached.body;
  }
  if (cached) {
    state.explorerPageCache.delete(key);
  }

  const now = Date.now();
  const entries = readPersistentExplorerCache().filter((entry) => now - Number(entry.savedAt || 0) <= EXPLORER_PERSISTED_CACHE_TTL_MS);
  const persisted = entries.find((entry) => entry.key === key && entry.version === version);
  if (!persisted) {
    if (entries.length) writePersistentExplorerCache(entries);
    return null;
  }

  state.explorerPageCache.set(key, { savedAt: now, version, body: persisted.body });
  return persisted.body;
}

function rememberExplorerPage(key, body) {
  const savedAt = Date.now();
  const version = explorerCacheVersion();
  state.explorerPageCache.set(key, { savedAt, version, body });
  if (state.explorerPageCache.size > 40) {
    const oldestKey = state.explorerPageCache.keys().next().value;
    state.explorerPageCache.delete(oldestKey);
  }

  const nextEntries = readPersistentExplorerCache()
    .filter((entry) => entry.key !== key && savedAt - Number(entry.savedAt || 0) <= EXPLORER_PERSISTED_CACHE_TTL_MS)
    .concat({ key, version, savedAt, body })
    .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0))
    .slice(0, EXPLORER_PERSISTED_CACHE_LIMIT);
  writePersistentExplorerCache(nextEntries);
}



function setMessage(text, tone = "muted") {
  elements.message.textContent = text;
  elements.message.dataset.tone = tone;
}

function setUnlocked(isUnlocked) {
  elements.authPanel.classList.toggle("hidden", isUnlocked);
  elements.appShell.classList.toggle("hidden", !isUnlocked);
  elements.lockButton.classList.toggle("hidden", !isUnlocked);
  if (elements.statusPill) {
    elements.statusPill.className = `session-dot ${isUnlocked ? "unlocked" : "locked"}`;
    elements.statusPill.setAttribute("aria-label", isUnlocked ? "Unlocked session" : "Locked session");
    elements.statusPill.title = isUnlocked ? "Unlocked" : "Locked";
  }
}

const PW_BANNER_ID = "pw-change-required-banner";

function applyMustChangePassword() {
  const existing = document.getElementById(PW_BANNER_ID);
  if (state.mustChangePassword) {
    if (!existing) {
      const banner = document.createElement("div");
      banner.id = PW_BANNER_ID;
      banner.setAttribute("role", "alert");
      banner.style.cssText =
        "background:#b91c1c;color:#fff;padding:10px 16px;font-size:0.9rem;" +
        "font-weight:600;text-align:center;position:sticky;top:0;z-index:9999;" +
        "letter-spacing:0.01em;";
      banner.textContent =
        "Security notice: You are using the default admin password. " +
        "Change it below before using the dashboard.";
      elements.appShell?.prepend(banner);
    }
    state.activeView = "settings";
    state.activeSettingsTab = "general";
    document.body.classList.add("pw-change-required");
  } else {
    existing?.remove();
    document.body.classList.remove("pw-change-required");
  }
}

function isConfigSensitiveRoute(path = "") {
  return path.startsWith("/movie/") || path.startsWith("/tvshow/") || path.startsWith("/person/") || path.startsWith("/search");
}

function handleRouting(path) {
  const parts = path.split('#');
  const pathPart = parts[0];
  const hashPart = parts[1] || "";

  const pathPartNoQuery = pathPart.split('?')[0];
  const pathname = pathPartNoQuery.endsWith("/") && pathPartNoQuery.length > 1 ? pathPartNoQuery.slice(0, -1) : pathPartNoQuery;
  const previousExplorerListRoute = state.activeView === "explorer" && !state.mediaDetailInline
    ? (state.explorerMode === "shows" ? "/tvshows" : "/movies")
    : "";
  const isExplorerListRoute = pathname === "/movies" || pathname === "/tvshows";
  if (!isExplorerListRoute || (previousExplorerListRoute && previousExplorerListRoute !== pathname)) clearSearchInputs();

  if (!pathname.startsWith("/person")) {
    state.personProfileName = "";
    if (elements.personModal) {
      elements.personModal.classList.add("hidden");
    }
  }

  const personMatch = pathname.match(/^\/person\/(\d+)$/);
  const movieTmdbMatch = pathname.match(/^\/movie\/tmdb\/(\d+)$/);
  const tvshowTmdbMatch = pathname.match(/^\/tvshow\/tmdb\/(\d+)(?:\/season\/(\d+))?(?:\/episode\/(\d+))?$/);
  const movieMatch = pathname.match(/^\/movie\/([^/]+)$/);
  const tvshowMatch = pathname.match(/^\/tvshow\/([^/]+)(?:\/season\/(\d+))?(?:\/episode\/(\d+))?$/);

  if (personMatch) {
    const personId = personMatch[1];
    if (!state.activeView) {
      state.activeView = "dashboard";
    }
    loadCastMemberDetails(personId).catch((error) => console.error("Error loading cast member", error));
  } else if (movieTmdbMatch) {
    const tmdbId = movieTmdbMatch[1];
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = state.explorerMode || "movies";
    }
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.activeMovieModalId = null;
    state.activeMovieTmdbId = String(tmdbId);
    openMovieImmersiveModalByTmdbId(tmdbId).catch((error) => setMessage(error.message, "error"));
  } else if (tvshowTmdbMatch) {
    const tmdbId = tvshowTmdbMatch[1];
    let seasonNum = null;
    let episodeNum = null;
    if (hashPart) {
      const hashMatch = hashPart.match(/^season(\d+)(?:ep(\d+))?$/);
      if (hashMatch) {
        seasonNum = Number(hashMatch[1]);
        episodeNum = hashMatch[2] ? Number(hashMatch[2]) : null;
      }
    }
    if (seasonNum === null) {
      seasonNum = tvshowTmdbMatch[2] ? Number(tvshowTmdbMatch[2]) : null;
      episodeNum = tvshowTmdbMatch[3] ? Number(tvshowTmdbMatch[3]) : null;
    }
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = state.explorerMode || "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = null;
    state.activeShowTmdbId = String(tmdbId);
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    openShowImmersiveModalByTmdbId(tmdbId).catch((error) => setMessage(error.message, "error"));
  } else if (movieMatch) {
    const movieKey = decodeURIComponent(movieMatch[1]);
    const movie = movieBySlugOrId(movieKey);
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = state.explorerMode || "movies";
    }
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.activeMovieModalId = movie?.id || movieKey;
    openMovieInlineDetail(movie?.id || movieKey).catch((error) => setMessage(error.message, "error"));
  } else if (tvshowMatch) {
    const showKey = tvshowMatch[1];
    let seasonNum = null;
    let episodeNum = null;
    if (hashPart) {
      const hashMatch = hashPart.match(/^season(\d+)(?:ep(\d+))?$/);
      if (hashMatch) {
        seasonNum = Number(hashMatch[1]);
        episodeNum = hashMatch[2] ? Number(hashMatch[2]) : null;
      }
    }
    if (seasonNum === null) {
      seasonNum = tvshowMatch[2] ? Number(tvshowMatch[2]) : null;
      episodeNum = tvshowMatch[3] ? Number(tvshowMatch[3]) : null;
    }
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = state.explorerMode || "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = showKey;
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    openShowInlineDetail(showKey, seasonNum, episodeNum).catch((error) => {
      console.error("Failed to open show detail", error);
      setMessage(error.message, "error");
    });
  } else if (pathname === "/" || pathname === "" || pathname === "/dashboard") {
    state.activeView = "dashboard";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/movies") {
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/tvshows") {
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/stats") {
    state.activeView = "stats";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/history") {
    state.activeView = "history";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/search") {
    state.activeView = "search";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    let query = "";
    try {
      const u = new URL(path, window.location.origin);
      query = u.searchParams.get("q") || u.searchParams.get("query") || "";
    } catch {
      const searchParams = new URLSearchParams(window.location.search);
      query = searchParams.get("q") || searchParams.get("query") || "";
    }
    triggerSearchPage(query);
  } else if (pathname === "/sync") {
    state.activeView = "settings";
    state.activeSettingsTab = "sync";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/logs") {
    state.activeView = "settings";
    state.activeSettingsTab = "logs";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname.startsWith("/settings")) {
    state.activeView = "settings";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    const parts = pathname.split("/");
    if (parts[2] && SETTINGS_TABS.includes(parts[2])) {
      state.activeSettingsTab = parts[2];
    } else {
      state.activeSettingsTab = "general";
    }
  } else if (pathname.startsWith("/help")) {
    state.activeView = "help";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    const parts = pathname.split("/");
    const topics = visibleHelpTopics();
    if (parts[2] && topics.some((topic) => topic.id === parts[2])) {
      state.activeHelpTopic = parts[2];
    } else {
      state.activeHelpTopic = topics[0]?.id || "getting-started";
    }
  } else {
    state.activeView = "dashboard";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  }
}

function clearSearchInputs() {
  window.clearTimeout(state.explorerSearchTimer);
  window.clearTimeout(state.globalSearchDropdownTimer);
  window.clearTimeout(state.globalSearchRemoteTimer);
  state.explorerSearch = "";
  if (elements.explorerSearchInput) {
    elements.explorerSearchInput.value = "";
    elements.explorerSearchInput.setAttribute("readonly", "true");
  }
  if (elements.globalSearchInput) {
    elements.globalSearchInput.value = "";
    elements.globalSearchInput.setAttribute("readonly", "true");
  }
  closeGlobalSearchDropdown();
}

function navigateTo(url) {
  const currentUrl = window.location.pathname + window.location.hash;
  if (currentUrl !== url) {
    const nextIndex = (history.state?.index || 0) + 1;
    history.pushState({ index: nextIndex }, "", url);
    state.internalHistoryCount = nextIndex;
    const pathnameBefore = currentUrl.split('#')[0];
    const pathnameAfter = url.split('#')[0];
    if (pathnameBefore !== pathnameAfter) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }
  handleRouting(url);
  applyActiveView();
}

function selectView(view) {
  if (state.mustChangePassword && view !== "settings") {
    state.activeView = "settings";
    state.activeSettingsTab = "general";
    applyActiveView();
    return;
  }
  const legacyImporterView = view === "importer";
  const requestedView = legacyImporterView ? "settings" : view;
  const legacySettingsTab = legacyImporterView ? "tools" : null;
  const targetView = PRIMARY_VIEWS.includes(requestedView) ? requestedView : "dashboard";

  let url = "/";
  if (state.mediaDetailInline) {
    const personMatch = window.location.pathname.match(/^\/person\/(\d+)$/);
    if (personMatch) {
      url = window.location.pathname + window.location.hash;
    } else if (state.explorerMode === "shows" && state.activeShowModalKey) {
      url = `/tvshow/${state.activeShowModalKey}`;
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "shows" && state.activeShowTmdbId) {
      url = `/tvshow/tmdb/${state.activeShowTmdbId}`;
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "movies" && state.activeMovieModalId) {
      url = movieHref(movieBySlugOrId(state.activeMovieModalId) || { id: state.activeMovieModalId });
    } else if (state.explorerMode === "movies" && state.activeMovieTmdbId) {
      url = `/movie/tmdb/${state.activeMovieTmdbId}`;
    } else {
      url = state.explorerMode === "shows" ? "/tvshows" : "/movies";
    }
  } else if (targetView === "explorer") {
    url = state.explorerMode === "shows" ? "/tvshows" : "/movies";
  } else if (targetView === "settings") {
    url = `/settings/${legacySettingsTab || state.activeSettingsTab}`;
  } else if (targetView === "help") {
    url = `/help/${state.activeHelpTopic}`;
  } else if (targetView === "search") {
    const q = state.searchQuery || new URLSearchParams(window.location.search).get("q") || "";
    url = `/search${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  } else if (targetView !== "dashboard") {
    url = `/${targetView}`;
  }

  const currentUrl = window.location.pathname + window.location.search + window.location.hash;
  if (currentUrl !== url) {
    if (isConfigSensitiveRoute(currentUrl) && !state.configLoaded) {
      applyActiveView();
    } else {
      navigateTo(url);
    }
  } else {
    applyActiveView();
  }
}

function selectSettingsTab(tab) {
  const targetTab = SETTINGS_TABS.includes(tab) ? tab : "general";
  navigateTo(`/settings/${targetTab}`);
}

function selectBackupsTab(tab) {
  const validTabs = ["settings", "restore"];
  state.activeBackupsTab = validTabs.includes(tab) ? tab : "settings";
  localStorage.setItem("activeBackupsTab", state.activeBackupsTab);
  if (state.activeBackupsTab === "restore") {
    state.remoteBackupFiles = [];
    state.remoteBackupFilesLoading = false;
  }
  applyActiveView();
  if (state.activeBackupsTab === "restore") {
    loadRemoteBackupsForRestoreTab().catch((error) => setMessage(error.message, "error"));
  }
}

function settingsTopbarTitle() {
  const labels = {
    general: "General",
    apps: "Apps",
    "api-keys": "API Keys",
    tools: "Tools",
    backups: state.activeBackupsTab === "restore" ? "Backups - Restore" : "Backups",
    sync: "Sync",
    logs: "Logs",
    appearance: "Appearance",
    changelog: "Changelog",
    cache: "Cache",
  };
  return `Settings - ${labels[state.activeSettingsTab] || "General"}`;
}

function activeHelpTitle() {
  const topic = visibleHelpTopics().find((item) => item.id === state.activeHelpTopic);
  return topic?.title || "Help";
}

function syncPageTopbar() {
  if (!elements.pageTopbar) return;

  const path = window.location.pathname;
  const query = new URLSearchParams(window.location.search);
  const isPersonDetail = path.startsWith("/person/");
  const isInlineDetail = state.mediaDetailInline || isPersonDetail;
  const mobileTopbarControls = window.matchMedia("(max-width: 640px)").matches;
  const controlGroups = [
    elements.explorerTopbarControls,
    elements.historyTopbarControls,
    elements.searchTopbarControls,
    elements.statsTopbarControls,
    elements.settingsSubMenu,
    elements.helpSubMenu,
  ].filter(Boolean);
  let title = "Dashboard";
  let subtitle = "Overview";
  let activeControls = null;

  if (state.activeView === "explorer") {
    const mode = state.explorerMode === "shows" ? "shows" : "movies";
    title = mode === "shows" ? "TV Shows" : "Movies";
    if (isInlineDetail) {
      if (mode === "shows" && state.activeShowModalKey) {
        const activeShow = state.showsRaw?.find(s => slug(s.title) === state.activeShowModalKey);
        if (activeShow?.title) title = `TV Shows — ${activeShow.title}`;
      } else if (mode === "movies" && state.activeMovieModalId) {
        const activeMovie = state.history?.find(h => h.id === state.activeMovieModalId);
        if (activeMovie?.title) title = `Movies — ${activeMovie.title}`;
      }
    }
    subtitle = isInlineDetail ? "" : (state.savedConfig?.plex?.username || "Watched history library");
    activeControls = isInlineDetail ? null : elements.explorerTopbarControls;
  } else if (state.activeView === "history") {
    title = "Watch History";
    subtitle = "";
    activeControls = elements.historyTopbarControls;
  } else if (state.activeView === "stats") {
    title = "Stats";
    subtitle = "";
    activeControls = elements.statsTopbarControls;
  } else if (state.activeView === "settings") {
    title = settingsTopbarTitle();
    subtitle = "";
    activeControls = mobileTopbarControls ? elements.settingsSubMenu : null;
  } else if (state.activeView === "help") {
    title = activeHelpTitle();
    subtitle = "Help";
    activeControls = mobileTopbarControls ? elements.helpSubMenu : null;
  } else if (state.activeView === "search") {
    const searchQuery = state.searchQuery || query.get("q") || "";
    title = searchQuery ? `Search Results for "${searchQuery}"` : "Search Results";
    subtitle = "Local and global database search results";
    activeControls = elements.searchTopbarControls;
  }

  if (isPersonDetail && state.personProfileName) {
    title = state.personProfileName;
    subtitle = "";
  }

  if (elements.explorerTitle) elements.explorerTitle.textContent = title;
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = subtitle;
    elements.explorerSubtitle.classList.toggle("hidden", !subtitle);
  }

  const backButton = document.querySelector("#explorerBackButton");
  backButton?.classList.toggle("hidden", !isInlineDetail);

  for (const group of controlGroups) {
    restoreTopbarControlGroup(group);
    group.classList.add("hidden");
  }

  if (!mobileTopbarControls && state.activeView === "settings" && elements.settingsSubMenu) {
    elements.settingsSubMenu.classList.remove("hidden");
  }
  if (!mobileTopbarControls && state.activeView === "help" && elements.helpSubMenu) {
    elements.helpSubMenu.classList.remove("hidden");
  }

  if (elements.topbarControlsMenu) {
    elements.topbarControlsMenu.classList.toggle("hidden", !mobileTopbarControls || !activeControls);
  }

  const mediaDetailActions = document.getElementById("mediaDetailActions");
  if (elements.pageTopbarActions) {
    if (activeControls && mobileTopbarControls && elements.topbarControlsPanel) {
      elements.topbarControlsPanel.appendChild(activeControls);
      activeControls.classList.remove("hidden");
    } else if (activeControls && !mobileTopbarControls) {
      elements.pageTopbarActions.insertBefore(activeControls, mediaDetailActions || null);
      activeControls.classList.remove("hidden");
    }
    if (mediaDetailActions && mediaDetailActions.parentElement !== elements.pageTopbarActions) {
      elements.pageTopbarActions.appendChild(mediaDetailActions);
    }
  }
  syncTopbarControlsMenuState();
}

function restoreTopbarControlGroup(group) {
  if (!group) return;
  if (group.id === "sidebarSettingsMenu") {
    const settingsButton = document.querySelector('[data-view="settings"]');
    if (settingsButton && group.parentElement !== settingsButton.parentElement) {
      settingsButton.after(group);
    }
  } else if (group.id === "helpMenu") {
    const helpButton = document.querySelector('[data-view="help"]');
    if (helpButton && group.parentElement !== helpButton.parentElement) {
      helpButton.after(group);
    }
  }
}

function applyActiveView() {
  localStorage.setItem(ACTIVE_VIEW_KEY, state.activeView);
  document.querySelector(".page-shell")?.setAttribute("data-active-view", state.activeView);

  for (const button of elements.tabButtons || []) {
    const explorerMode = button.dataset.explorerNav;
    const isExplorerMode = state.activeView === "explorer" && explorerMode === state.explorerMode;
    const isActiveView = button.dataset.view === state.activeView && !explorerMode;
    button.classList.toggle("active", isActiveView || isExplorerMode);
  }

  for (const panel of elements.viewPanels || []) {
    panel.classList.toggle("hidden", panel.dataset.viewPanel !== state.activeView);
  }

  const helpSubMenu = document.querySelector("#helpMenu");
  const settingsSubMenu = document.querySelector("#sidebarSettingsMenu");
  if (helpSubMenu) {
    helpSubMenu.classList.toggle("hidden", state.activeView !== "help");
  }
  if (settingsSubMenu) {
    settingsSubMenu.classList.toggle("hidden", state.activeView !== "settings");
  }

  if (state.activeView === "help") renderHelp();
  if (state.activeView === "dashboard") {
    applyCachedDashboardHistory();
    renderDashboard();
    if (state.token) loadHistory().catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView === "stats") {
    renderStats();
    loadStats().catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
  if (state.activeView === "search") renderSearchPage();
  if (state.activeView === "history") renderHistoryView();
  if (state.activeView !== "explorer") {
    state.explorerLoadObserver?.disconnect();
    state.explorerLoadObserver = undefined;
    updateAlphaFilter();
  }

  if (state.activeView !== "history") {
    state.historyViewLoadObserver?.disconnect();
    state.historyViewLoadObserver = undefined;
  }
  if (state.activeView !== "dashboard") {
    state.partWatchedLoadObserver?.disconnect();
    state.partWatchedLoadObserver = undefined;
  }

  if (state.activeView !== "dashboard") {
    state.dashboardPosterObserver?.disconnect();
    state.dashboardPosterObserver = undefined;
  }

  if (state.activeView === "settings") {
    renderSettingsInlineHelp();
    localStorage.setItem(ACTIVE_SETTINGS_TAB_KEY, state.activeSettingsTab);
    for (const button of elements.settingsTabButtons || []) {
      button.classList.toggle("active", button.dataset.settingsTab === state.activeSettingsTab);
    }
    for (const panel of elements.settingsPanels || []) {
      panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
    }
    if (state.activeSettingsTab === "sync") {
      renderSyncJobs();
      renderSyncHistory();
      loadSyncJobs().catch((error) => setMessage(error.message, "error"));
      loadSyncHistory().catch((error) => setMessage(error.message, "error"));
    }
    if (state.activeSettingsTab === "backups") {
      // Show/hide backup sub-tabs menu
      const backupsSubMenu = document.querySelector("#sidebarBackupsMenu");
      if (backupsSubMenu) backupsSubMenu.classList.remove("hidden");

      // Update backup sub-tab buttons and panels
      for (const button of elements.backupsSubTabButtons || []) {
        button.classList.toggle("active", button.dataset.backupsTab === state.activeBackupsTab);
      }
      for (const panel of elements.backupsPanels || []) {
        const isVisible = panel.dataset.backupsPanel === state.activeBackupsTab;
        panel.classList.toggle("hidden", !isVisible);
      }

      renderWatchBackups();
      loadWatchBackups().catch((error) => setMessage(error.message, "error"));
      if (state.activeBackupsTab === "restore" && !state.remoteBackupFilesLoading && !state.remoteBackupFiles.length) {
        loadRemoteBackupsForRestoreTab().catch((error) => setMessage(error.message, "error"));
      }
    } else {
      // Hide backup sub-tabs menu when not on backups
      const backupsSubMenu = document.querySelector("#sidebarBackupsMenu");
      if (backupsSubMenu) backupsSubMenu.classList.add("hidden");
    }
    if (state.activeSettingsTab === "logs") renderLogs().catch(() => { });
    if (state.activeSettingsTab === "changelog") renderChangelog().catch(() => { });
    if (state.activeSettingsTab === "cache") {
      renderCachePanel();
      if (!state.cacheStats && !state.cacheStatsLoading) loadCacheStats().catch((error) => setMessage(error.message, "error"));
    }
    if (state.configLoaded) {
      renderSettingsStatus("Configuration ready.", "success");
    }
  }
  syncPageTopbar();
  syncLogsRefresh();

  if (state.token) {
    syncNowPlayingPolling();
  }
}

function configFromInputs() {
  return {
    plex: {
      baseUrl: elements.plexServerUrl.value.trim(),
      token: elements.plexToken.value.trim(),
      username: elements.plexUsername.value.trim(),
      disabled: !elements.plexEnabled.checked,
    },
    tmdb: {
      apiKey: elements.tmdbApiKey?.value.trim() || "",
    },
    youtube: {
      apiKey: elements.youtubeApiKey?.value.trim() || "",
    },
    emby: {
      baseUrl: elements.embyServerUrl.value.trim(),
      apiKey: elements.embyApiKey.value.trim(),
      userId: elements.embyUserId.value.trim(),
      disabled: !elements.embyEnabled.checked,
    },
    jellyfin: {
      baseUrl: elements.jellyfinServerUrl.value.trim(),
      apiKey: elements.jellyfinApiKey.value.trim(),
      userId: elements.jellyfinUserId.value.trim(),
      disabled: !elements.jellyfinEnabled.checked,
    },
  };
}

function syncSettingsInputsDisabledState() {
  const plexActive = elements.plexEnabled.checked;
  elements.plexServerUrl.disabled = !plexActive;
  elements.plexToken.disabled = !plexActive;
  elements.plexUsername.disabled = !plexActive;

  const embyActive = elements.embyEnabled.checked;
  elements.embyServerUrl.disabled = !embyActive;
  elements.embyApiKey.disabled = !embyActive;
  elements.embyUserId.disabled = !embyActive;

  const jellyfinActive = elements.jellyfinEnabled?.checked;
  if (elements.jellyfinServerUrl) elements.jellyfinServerUrl.disabled = !jellyfinActive;
  if (elements.jellyfinApiKey) elements.jellyfinApiKey.disabled = !jellyfinActive;
  if (elements.jellyfinUserId) elements.jellyfinUserId.disabled = !jellyfinActive;

  const seerrActive = elements.seerrEnabled?.checked;
  if (elements.seerrServerUrl) elements.seerrServerUrl.disabled = !seerrActive;
  if (elements.seerrApiKey) elements.seerrApiKey.disabled = !seerrActive;
}

function populateConfigForm(config = {}) {
  elements.plexEnabled.checked = !config.plex?.disabled;
  elements.plexServerUrl.value = config.plex?.baseUrl || config.plex?.url || "";
  elements.plexToken.value = config.plex?.token || config.plex?.apiKey || "";
  elements.plexUsername.value = config.plex?.username || "";

  elements.embyEnabled.checked = !config.emby?.disabled;
  elements.embyServerUrl.value = config.emby?.baseUrl || config.emby?.url || "";
  elements.embyApiKey.value = config.emby?.apiKey || config.emby?.api_key || "";
  elements.embyUserId.value = config.emby?.userId || "";

  elements.jellyfinEnabled.checked = !config.jellyfin?.disabled;
  elements.jellyfinServerUrl.value = config.jellyfin?.baseUrl || config.jellyfin?.url || "";
  elements.jellyfinApiKey.value = config.jellyfin?.apiKey || config.jellyfin?.api_key || "";
  elements.jellyfinUserId.value = config.jellyfin?.userId || "";

  if (elements.tmdbApiKey) elements.tmdbApiKey.value = "";
  if (elements.tmdbApiKey) elements.tmdbApiKey.placeholder = config.tmdb?.configured ? "Configured - enter a new key to replace it" : "TMDB API key";
  if (elements.youtubeApiKey) elements.youtubeApiKey.value = config.youtube?.apiKey || "";
  if (elements.fanartApiKey) elements.fanartApiKey.value = "";
  if (elements.fanartApiKey) elements.fanartApiKey.placeholder = config.fanart?.configured ? "Configured - enter a new key to replace it" : "Personal API key (optional)";
  if (elements.omdbApiKey) elements.omdbApiKey.value = "";
  if (elements.omdbApiKey) elements.omdbApiKey.placeholder = config.omdb?.configured ? "Configured - enter a new key to replace it" : "OMDb API key";

  if (elements.seerrEnabled) elements.seerrEnabled.checked = !config.seerr?.disabled;
  if (elements.seerrServerUrl) elements.seerrServerUrl.value = config.seerr?.baseUrl || "";
  if (elements.seerrApiKey) elements.seerrApiKey.value = "";
  if (elements.seerrApiKey) elements.seerrApiKey.placeholder = config.seerr?.configured ? "Configured - enter a new key to replace it" : "Seerr API key";

  // Update the global Seerr configured flag so detail pages show/hide the button.
  state.seerrConfigured = Boolean(config.seerr?.configured);

  syncSettingsInputsDisabledState();
}

function renderSettingsStatus(text, tone = "muted") {
  if (!elements.settingsStatus) return;
  elements.settingsStatus.textContent = text;
  elements.settingsStatus.dataset.tone = tone;
}

function renderAdminCredentialsStatus(text, tone = "muted") {
  if (!elements.adminCredentialsStatus) return;
  elements.adminCredentialsStatus.textContent = text;
  elements.adminCredentialsStatus.dataset.tone = tone;
}

async function saveAdminCredentials() {
  const username = elements.settingsUsername.value.trim();
  const currentPassword = elements.currentAdminPassword.value;
  const newPassword = elements.newAdminPassword.value;
  const confirmPassword = elements.confirmAdminPassword.value;

  if (!username || !currentPassword) {
    renderAdminCredentialsStatus("Enter a username and your current password.", "error");
    return;
  }
  if (newPassword && newPassword.length < 8) {
    renderAdminCredentialsStatus("New password must be at least 8 characters.", "error");
    return;
  }
  if (newPassword !== confirmPassword) {
    renderAdminCredentialsStatus("New password and confirmation do not match.", "error");
    return;
  }

  const button = elements.saveAdminCredentialsButton;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Saving...";
  renderAdminCredentialsStatus("Updating login...", "muted");

  try {
    const result = await updateAdminCredentials({ username, currentPassword, newPassword });
    state.currentUser = result.user;
    state.token = result.token;
    elements.adminEmail.value = username;
    elements.currentAdminPassword.value = "";
    elements.newAdminPassword.value = "";
    elements.confirmAdminPassword.value = "";
    localStorage.setItem("adminUsername", username);
    renderAdminCredentialsStatus("Login updated. Other dashboard sessions have been signed out.", "success");
    setMessage(`Login updated for ${username}.`, "success");
    // Re-check whether the default-password flag has been cleared.
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then(r => r.json()).then(data => {
        if (state.mustChangePassword && !data.mustChangePassword) {
          state.mustChangePassword = false;
          applyMustChangePassword();
        }
      }).catch(() => {});
  } catch (error) {
    renderAdminCredentialsStatus(error.message, "error");
    setMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function loadSavedConfig() {
  const response = await fetch("/api/config", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Config load failed with ${response.status}`);

  state.savedConfig = body.config || {};
  state.lastCron = body.lastCron;
  state.lastWebhook = body.lastWebhook;
  state.syncHistory = Array.isArray(body.history) ? body.history : state.syncHistory;
  state.syncHistoryLoaded = Array.isArray(body.history);
  populateConfigForm(body.config || {});
  state.configLoaded = true;
  state.posterLookupCache.clear();
  state.posterLookupInflight.clear();
  renderSettingsStatus("Configuration loaded.", "success");
  await refreshSeerrCapabilities().catch(() => null);
  await loadAppearanceSettings().catch(() => null);
  renderDashboard();
  renderActiveSessions();
  renderSyncHistory();
  refreshHelpIfVisible();
  return body.config || {};
}

async function refreshSeerrCapabilities() {
  if (!state.seerrConfigured) {
    state.seerrSupports4k = { movie: false, tv: false };
    return state.seerrSupports4k;
  }
  const response = await fetch("/api/seerr/status", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Seerr status failed with ${response.status}`);
  state.seerrSupports4k = {
    movie: Boolean(body.capabilities?.movie4k),
    tv: Boolean(body.capabilities?.tv4k),
  };
  return state.seerrSupports4k;
}

async function saveSavedConfig() {
  const button = elements.saveConfigButton;
  const originalText = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Saving...";
  }

  try {
    const config = configFromInputs();
    const response = await fetch("/api/config", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(config),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Config save failed with ${response.status}`);

    state.savedConfig = body.config || {
      ...config,
      tmdb: { configured: Boolean(config.tmdb?.apiKey || state.savedConfig.tmdb?.configured) },
    };
    if (elements.tmdbApiKey) elements.tmdbApiKey.value = "";
    state.configLoaded = true;
    clearDerivedUiCaches();
    renderSettingsStatus("Configuration saved. Run Full Sync Watchstates if a media server was rebuilt or newly added.", "success");
    renderDashboard();
    renderActiveSessions();
    refreshHelpIfVisible();
    setMessage("Configuration saved. Full sync is recommended for rebuilt or newly added servers.", "success");
    return body;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function saveSectionConfig(section) {
  const buttonId = `save${section.charAt(0).toUpperCase() + section.slice(1)}ConfigButton`;
  const statusId = `${section}ConfigStatus`;

  const button = elements[buttonId];
  const statusEl = elements[statusId];

  const originalText = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Saving...";
  }
  if (statusEl) {
    statusEl.textContent = "Saving...";
    statusEl.className = "message muted";
  }

  try {
    const payload = {};
    if (section === "plex") {
      payload.plex = {
        baseUrl: elements.plexServerUrl.value.trim(),
        token: elements.plexToken.value.trim(),
        username: elements.plexUsername.value.trim(),
        disabled: !elements.plexEnabled.checked,
      };
    } else if (section === "emby") {
      payload.emby = {
        baseUrl: elements.embyServerUrl.value.trim(),
        apiKey: elements.embyApiKey.value.trim(),
        userId: elements.embyUserId.value.trim(),
        disabled: !elements.embyEnabled.checked,
      };
    } else if (section === "jellyfin") {
      payload.jellyfin = {
        baseUrl: elements.jellyfinServerUrl.value.trim(),
        apiKey: elements.jellyfinApiKey.value.trim(),
        userId: elements.jellyfinUserId.value.trim(),
        disabled: !elements.jellyfinEnabled.checked,
      };
    } else if (section === "tmdb") {
      payload.tmdb = {
        apiKey: elements.tmdbApiKey.value.trim(),
      };
    } else if (section === "youtube") {
      payload.youtube = {
        apiKey: elements.youtubeApiKey.value.trim(),
      };
    } else if (section === "fanart") {
      payload.fanart = {
        apiKey: elements.fanartApiKey.value.trim(),
      };
    } else if (section === "omdb") {
      payload.omdb = {
        apiKey: elements.omdbApiKey.value.trim(),
      };
    } else if (section === "seerr") {
      payload.seerr = {
        baseUrl: elements.seerrServerUrl?.value.trim() || "",
        disabled: !(elements.seerrEnabled?.checked ?? true),
      };
      const seerrApiKey = elements.seerrApiKey?.value.trim() || "";
      if (seerrApiKey) payload.seerr.apiKey = seerrApiKey;
    }

    const response = await fetch("/api/config", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Save failed with ${response.status}`);

    const savedSectionConfig = body.config?.[section];
    const previousSectionConfig = state.savedConfig?.[section] || {};

    // Update state.savedConfig with new section values
    state.savedConfig = {
      ...state.savedConfig,
      [section]: payload[section],
    };
    if (section === "tmdb") {
      state.savedConfig.tmdb = {
        configured: Boolean(payload.tmdb.apiKey || state.savedConfig.tmdb?.configured)
      };
      elements.tmdbApiKey.value = "";
      elements.tmdbApiKey.placeholder = state.savedConfig.tmdb.configured ? "Configured - enter a new key to replace it" : "TMDB API key";
    }
    if (section === "fanart") {
      state.savedConfig.fanart = {
        configured: Boolean(payload.fanart.apiKey || state.savedConfig.fanart?.configured)
      };
      if (elements.fanartApiKey) elements.fanartApiKey.value = "";
      if (elements.fanartApiKey) elements.fanartApiKey.placeholder = state.savedConfig.fanart.configured ? "Configured - enter a new key to replace it" : "Personal API key (optional)";
    }
    if (section === "omdb") {
      state.savedConfig.omdb = {
        configured: Boolean(payload.omdb.apiKey || state.savedConfig.omdb?.configured)
      };
      if (elements.omdbApiKey) elements.omdbApiKey.value = "";
      if (elements.omdbApiKey) elements.omdbApiKey.placeholder = state.savedConfig.omdb.configured ? "Configured - enter a new key to replace it" : "OMDb API key";
    }
    if (section === "seerr") {
      if (savedSectionConfig) {
        state.savedConfig.seerr = savedSectionConfig;
        state.seerrConfigured = Boolean(savedSectionConfig.configured);
        if (elements.seerrServerUrl) elements.seerrServerUrl.value = savedSectionConfig.baseUrl || "";
        if (elements.seerrEnabled) elements.seerrEnabled.checked = !savedSectionConfig.disabled;
        if (elements.seerrApiKey) elements.seerrApiKey.value = "";
        if (elements.seerrApiKey) elements.seerrApiKey.placeholder = state.seerrConfigured ? "Configured - enter a new key to replace it" : "Seerr API key";
        syncSettingsInputsDisabledState();
      } else {
        // Recompute configured flag based on what was just saved.
        const apiKeySet = Boolean(payload.seerr?.apiKey || previousSectionConfig?.configured);
        const urlSet = Boolean(payload.seerr?.baseUrl);
        const enabled = !payload.seerr?.disabled;
        state.savedConfig.seerr = {
          configured: apiKeySet && urlSet && enabled,
          baseUrl: payload.seerr?.baseUrl || "",
          disabled: Boolean(payload.seerr?.disabled),
        };
        state.seerrConfigured = state.savedConfig.seerr.configured;
        if (elements.seerrApiKey) elements.seerrApiKey.value = "";
        if (elements.seerrApiKey) elements.seerrApiKey.placeholder = state.seerrConfigured ? "Configured - enter a new key to replace it" : "Seerr API key";
      }
      await refreshSeerrCapabilities().catch(() => {
        state.seerrSupports4k = { movie: false, tv: false };
      });
    }

    state.configLoaded = true;
    clearDerivedUiCaches();

    if (statusEl) {
      statusEl.textContent = "Saved successfully.";
      statusEl.className = "message success";
    }
    renderDashboard();
    renderActiveSessions();
    refreshHelpIfVisible();
    setMessage(`Saved ${section} settings successfully.`, "success");
    return body;
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = error.message;
      statusEl.className = "message error";
    }
    setMessage(error.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function loadHistory({ force = false } = {}) {
  if (state.historyLoadPromise) return state.historyLoadPromise;

  state.historyLoadPromise = (async () => {
    if (!force) applyCachedDashboardHistory();

    const url = new URL("/api/history", window.location.origin);
    url.searchParams.set("limit", String(HISTORY_PREVIEW_LIMIT));
    url.searchParams.set("stats", "0");
    url.searchParams.set("preview", "dashboard");

    const response = await fetch(url, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `History load failed with ${response.status}`);

    const previousHistoryVersion = state.historyVersion;
    state.history = Array.isArray(body.history) ? body.history : [];
    state.historyVersion = String(body.historyVersion ?? historyVersionFromRows(state.history));
    rememberDashboardHistory(state.history, state.historyVersion);
    if (previousHistoryVersion && previousHistoryVersion !== state.historyVersion) {
      state.explorerPageCache.clear();
    }
    if (body.stats) {
      state.stats = body.stats;
      state.statsLoaded = true;
    }
    renderDashboard();
    renderStats();
    if (state.activeView === "stats") loadStats({ force: true }).catch((error) => setMessage(error.message, "error"));
    if (state.activeView === "settings" && state.activeSettingsTab === "sync") {
      loadSyncJobs({ force: true }).catch((error) => setMessage(error.message, "error"));
      loadSyncHistory({ force: true }).catch((error) => setMessage(error.message, "error"));
    }
    renderDbStatus(true);
    return state.history;
  })().finally(() => {
    state.historyLoadPromise = null;
  });

  return state.historyLoadPromise;
}

function clearDerivedUiCaches({ resetExplorer = true } = {}) {
  state.explorerPageCache.clear();
  clearPersistentExplorerPageCache();
  state.posterLookupCache.clear();
  state.posterLookupInflight.clear();
  clearPersistentPosterLookupCache();
  state.statsLoaded = false;
  if (resetExplorer) {
    resetMovieExplorer();
    resetShowExplorer();
  }
}

function renderDbStatus(isOnline) {
  if (!elements.dbStatus) return;
  elements.dbStatus.innerHTML = `
    <span class="target-pill" data-status="${isOnline ? "success" : "error"}">${isOnline ? "Connected" : "Unavailable"}</span>
    <p>Total rows visible to this query: ${formatNumber(state.stats.totalWatches || 0)}</p>
    <p>Backend store: <code>SQLite</code></p>
  `;
}

function helpBadgeValue(token = "") {
  const key = String(token || "").trim().toUpperCase();
  if (key === "ADMIN_AUTH") return { label: "ADMIN", value: state.currentUser?.username || state.currentUser?.email || "" };
  if (key === "PLEX_URL") return { label: "PLEX_URL", value: state.savedConfig.plex?.baseUrl || state.savedConfig.plex?.url || "" };
  if (key === "PLEX_TOKEN") return { label: "PLEX_TOKEN", value: state.savedConfig.plex?.token || state.savedConfig.plex?.apiKey || "" };
  if (key === "EMBY_API_KEY") return { label: "EMBY_API_KEY", value: state.savedConfig.emby?.apiKey || state.savedConfig.emby?.api_key || "" };
  if (key === "EMBY_USER_ID") return { label: "EMBY_USER_ID", value: state.savedConfig.emby?.userId || "" };
  if (key === "JELLYFIN_API_KEY") return { label: "JELLYFIN_API_KEY", value: state.savedConfig.jellyfin?.apiKey || state.savedConfig.jellyfin?.api_key || "" };
  if (key === "JELLYFIN_USER_ID") return { label: "JELLYFIN_USER_ID", value: state.savedConfig.jellyfin?.userId || "" };
  return { label: key || "UNKNOWN", value: "" };
}

function tokenBadges(tokens = []) {
  const badges = tokens
    .map((token) => {
      const entry = helpBadgeValue(token);
      const value = String(entry.value || "");
      if (!value) {
        return `<span class="help-badge help-badge--required"><span>Required: ${escapeHtml(entry.label)}</span></span>`;
      }

      return `
        <span class="help-badge help-badge--ready" tabindex="0">
          <span>Available: ${escapeHtml(entry.label)}</span>
          <button class="help-badge-copy" type="button" data-copy="${escapeAttribute(value)}">Copy</button>
        </span>
      `;
    })
    .join("");

  return `<div class="help-badges">${badges}</div>`;
}

function renderHelp() {
  const topics = visibleHelpTopics();
  const categories = [...new Set(topics.map((topic) => topic.category))];
  elements.helpMenu.innerHTML = categories
    .map(
      (category) => `
        <section class="help-menu-group">
          <p>${escapeHtml(category)}</p>
          ${topics.filter((topic) => topic.category === category)
          .map(
            (topic) => `
                <button class="help-menu-item ${topic.id === state.activeHelpTopic ? "active" : ""}" type="button" data-help-topic="${topic.id}">
                  <span class="help-menu-item-title">${escapeHtml(topic.title)}</span>
                  ${topic.description ? `<span class="help-menu-item-desc">${escapeHtml(topic.description)}</span>` : ""}
                </button>
              `,
          )
          .join("")}
        </section>
      `,
    )
    .join("");

  const topic = topics.find((item) => item.id === state.activeHelpTopic) || topics[0];
  if (!topic) {
    elements.helpCanvas.innerHTML = `<div class="idle-state"><b>No help topics available.</b></div>`;
    return;
  }
  state.activeHelpTopic = topic.id;
  elements.helpCanvas.innerHTML = `
    <div class="help-hero">
      <div class="help-hero-eyebrow">${escapeHtml(topic.category)}</div>
      <h2>${escapeHtml(topic.title)}</h2>
      ${topic.description ? `<p class="help-hero-desc">${escapeHtml(topic.description)}</p>` : ""}
      ${tokenBadges(topic.badges)}
    </div>
    <div class="help-doc-body">${topic.body()}</div>
  `;
}

function openHelpTopic(topicId) {
  if (!visibleHelpTopics().some((topic) => topic.id === topicId)) return;
  navigateTo(`/help/${topicId}`);
  window.setTimeout(() => elements.helpCanvas?.scrollIntoView({ block: "start" }), 0);
}

async function renderLogs() {
  if (!elements.logsTerminal) return;

  const localLogs = logsText();

  try {
    const backendLogs = await fetchDiagnosticLogs(authHeaders());
    if (backendLogs.length > 0) {
      const allLogs = [
        "=== BACKEND DIAGNOSTIC LOGS ===",
        ...backendLogs,
        "",
        "=== FRONTEND DEBUG LOGS ===",
        localLogs || "[no frontend logs]"
      ].join("\n");
      state.renderedLogsText = allLogs;
      elements.logsTerminal.textContent = allLogs;
    } else {
      state.renderedLogsText = localLogs || "[no diagnostic logs captured yet]";
      elements.logsTerminal.textContent = state.renderedLogsText;
    }
  } catch (error) {
    state.renderedLogsText = localLogs || "[no diagnostic logs captured yet]";
    elements.logsTerminal.textContent = state.renderedLogsText;
  }
  const el = elements.logsTerminal;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function syncLogsRefresh() {
  const shouldRefresh = state.activeView === "settings" && state.activeSettingsTab === "logs" && state.token;
  if (shouldRefresh && !state.logsRefreshInterval) {
    renderLogs().catch(() => { });
    state.logsRefreshInterval = window.setInterval(() => {
      if (state.activeView === "settings" && state.activeSettingsTab === "logs") {
        renderLogs().catch(() => { });
      }
    }, 3000);
  } else if (!shouldRefresh && state.logsRefreshInterval) {
    window.clearInterval(state.logsRefreshInterval);
    state.logsRefreshInterval = undefined;
  }
}

function setConnectionStatus(type, text, tone = "muted") {
  const status = elements.testConnectionStatuses.find((item) => item.dataset.testStatus === type);
  if (!status) return;
  status.textContent = text;
  status.dataset.tone = tone;
}

function setConnectionButton(button, text, tone = "muted", disabled = false) {
  button.textContent = text;
  button.dataset.tone = tone;
  button.disabled = disabled;
}

async function testConnection(type, button) {
  // Seerr uses its own status endpoint rather than the generic test-connection proxy.
  if (type === "seerr") {
    const hasNewUrl    = Boolean(elements.seerrServerUrl?.value.trim());
    const hasNewApiKey = Boolean(elements.seerrApiKey?.value.trim());

    // Allow testing if already configured (key was previously saved and field is blank),
    // but require at minimum that a URL is present somewhere.
    if (!hasNewUrl && !state.seerrConfigured) {
      setConnectionStatus(type, "Enter a Seerr Server URL first.", "error");
      return;
    }
    if (!state.seerrConfigured && !hasNewApiKey) {
      setConnectionStatus(type, "Enter a Seerr API key first.", "error");
      return;
    }

    setConnectionButton(button, "Testing...", "loading", true);
    setConnectionStatus(type, "Testing Seerr connection...", "muted");
    let seerrTestRes, seerrTestBody = {};
    try {
      // Only save if the user has entered new values in the fields.
      if (hasNewUrl || hasNewApiKey) {
        await saveSectionConfig("seerr");
      }
      if (!state.seerrConfigured) {
        setConnectionButton(button, "✘ Failed", "error");
        setConnectionStatus(type, "Enter a Seerr API key first.", "error");
        return;
      }
      seerrTestRes = await fetch("/api/seerr/status", { headers: authHeaders() });
      seerrTestBody = await seerrTestRes.json().catch(() => ({}));
    } catch (err) {
      setConnectionButton(button, "✘ Failed", "error");
      setConnectionStatus(type, `Seerr fetch failed: ${err.message}`, "error");
      button.disabled = false;
      return;
    } finally {
      button.disabled = false;
    }
    if (seerrTestRes.ok && seerrTestBody.ok) {
      state.seerrSupports4k = {
        movie: Boolean(seerrTestBody.capabilities?.movie4k),
        tv: Boolean(seerrTestBody.capabilities?.tv4k),
      };
      const title = seerrTestBody.applicationTitle || "Seerr";
      setConnectionButton(button, "✔ Connected", "success");
      setConnectionStatus(type, `✔ Connected to "${title}"`, "success");
      window.setTimeout(() => setConnectionButton(button, "Test Connection", "muted"), 3000);
    } else {
      setConnectionButton(button, "✘ Failed", "error");
      setConnectionStatus(type, `✘ ${seerrTestBody.error || "Connection failed"}`, "error");
    }
    return;
  }

  const payload = connectionPayloadFromElements(type, elements);
  const label = connectionLabel(type);

  if (!payload.url || !payload.token) {
    const message = `${label} test blocked: server URL and token are required.`;
    setConnectionStatus(type, message, "error");
    logDebug(message);
    return;
  }

  setConnectionButton(button, "Testing...", "loading", true);
  setConnectionStatus(type, `Testing ${label} endpoint...`, "muted");
  logDebug(`Initiating request loop to ${label} local host address...`, { url: payload.url, type });

  let response;
  let body = {};
  try {
    response = await fetch("/api/test-connection", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    const message = `${label} fetch failed. Reason: FETCH_FAILED (${error?.message || "request could not be sent"})`;
    setConnectionButton(button, `✘ Failed`, "error");
    setConnectionStatus(type, message, "error");
    logDebug(message);
    return;
  } finally {
    button.disabled = false;
  }

  logDebug(`${label} test-connection endpoint returned HTTP ${response.status}`, body);

  if (response.ok && body.ok) {
    const message = `✔ Connected (HTTP ${body.status || response.status})`;
    setConnectionButton(button, message, "success");
    setConnectionStatus(type, `${body.detail || "Server identity verified"} in ${body.elapsedMs || 0}ms`, "success");
    window.setTimeout(() => setConnectionButton(button, "Test Connection", "muted"), 3000);
    return;
  }

  const statusText = body.status ? `HTTP ${body.status}` : `HTTP ${response.status}`;
  const errorMessage = body.error || `Connection failed with ${statusText}`;
  setConnectionButton(button, `✘ Failed`, "error");
  setConnectionStatus(type, `✘ Failed: ${errorMessage} (${statusText})`, "error");
}

function refreshHelpIfVisible() {
  if (state.activeView === "help") {
    renderHelp();
  }
}

function historyById(id) {
  return state.history.find((entry) => String(entry.id) === String(id));
}

function movieById(id) {
  return state.history.find((entry) => String(entry.id) === String(id)) ||
    state.moviesRaw.find((entry) => String(entry.id) === String(id)) ||
    state.activeSessions.find((entry) => String(entry.id || entry.key) === String(id));
}

function movieBySlugOrId(value) {
  const key = decodeURIComponent(String(value || ""));
  const keySlug = slug(key);
  return movieById(key) ||
    state.moviesRaw.find((entry) => movieSlug(entry) === keySlug) ||
    state.history.find((entry) => entry.media_type === "movie" && movieSlug(entry) === keySlug);
}

async function resolveMovieBySlugOrId(value) {
  const local = movieBySlugOrId(value);
  if (local) return local;

  const key = decodeURIComponent(String(value || ""));
  const keySlug = slug(key);
  const search = key.replace(/-/g, " ").trim();
  if (!search) return null;

  const url = new URL("/api/movies", window.location.origin);
  url.searchParams.set("limit", "50");
  url.searchParams.set("search", search);
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const movies = Array.isArray(body.movies) ? body.movies : [];
  if (movies.length) {
    state.moviesRaw = dedupeMediaRecords([...state.moviesRaw, ...movies], "movies");
  }
  const found = movies.find((entry) => String(entry.id) === key || movieSlug(entry) === keySlug);
  if (found) return found;

  // Titles with special chars (e.g. "Angels & Demons") produce slugs that don't round-trip
  // cleanly through a text search. Fall back to searching by first word and slug-matching results.
  const firstWord = search.split(" ")[0];
  if (!firstWord || firstWord === search) return null;
  const url2 = new URL("/api/movies", window.location.origin);
  url2.searchParams.set("limit", "50");
  url2.searchParams.set("search", firstWord);
  const res2 = await fetch(url2, { headers: authHeaders(), cache: "no-store" });
  const body2 = await res2.json().catch(() => ({}));
  if (!res2.ok) return null;
  const movies2 = Array.isArray(body2.movies) ? body2.movies : [];
  if (movies2.length) {
    state.moviesRaw = dedupeMediaRecords([...state.moviesRaw, ...movies2], "movies");
  }
  return movies2.find((entry) => String(entry.id) === key || movieSlug(entry) === keySlug) || null;
}

function nowPlayingHref(session = {}) {
  const mediaType = String(session.mediaType || session.media_type || "").toLowerCase();
  const ids = session.ids || {};
  const isEpisode = ["episode", "show", "tv", "tvshow"].includes(mediaType) || session.season != null || session.episode != null;

  if (isEpisode) {
    const title = showTitleFrom(session.showTitle || session.show_title || session.title);
    const localShow = state.showsRaw.find((show) => {
      if (ids.tmdb && String(show.tmdb_id || "") === String(ids.tmdb)) return true;
      if (ids.tvdb && String(show.tvdb_id || "") === String(ids.tvdb)) return true;
      return slug(show.title) === slug(title);
    });
    const base = localShow
      ? `/tvshow/${slug(localShow.title)}`
      : ids.tmdb
        ? `/tvshow/tmdb/${ids.tmdb}`
        : `/tvshow/${slug(title)}`;
    const season = session.season != null ? Number(session.season) : null;
    const episode = session.episode != null ? Number(session.episode) : null;
    return season == null ? base : `${base}#season${season}${episode == null ? "" : `ep${episode}`}`;
  }

  const localMovie = state.history.find((entry) => {
    if (entry.media_type !== "movie" || !isWatchedHistoryAction(entry)) return false;
    if (ids.imdb && String(entry.imdb_id || "") === String(ids.imdb)) return true;
    if (ids.tmdb && String(entry.tmdb_id || "") === String(ids.tmdb)) return true;
    return String(entry.title || "").trim().toLowerCase() === String(session.title || "").trim().toLowerCase();
  });
  if (localMovie?.id) return movieHref(localMovie);
  if (ids.tmdb) return `/movie/tmdb/${ids.tmdb}`;
  return `/movie/${slug(session.title || session.id || session.key || "unknown")}`;
}

function mergeShowWithLoadedHistory(show = {}) {
  if (!show?.title) return show;
  const showKey = slug(show.title || "");

  const byEpisode = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    if (episode.season == null || episode.episode == null) continue;
    byEpisode.set(showEpisodeKey(episode.season, episode.episode), episode);
  }

  for (const row of state.history || []) {
    if (!isWatchedHistoryAction(row)) continue;
    if (row.media_type !== "episode") continue;
    if (row.season == null || row.episode == null) continue;
    const rowShowTitle = row.show_title || showTitleFrom(row.title);
    if (slug(rowShowTitle) !== showKey) continue;

    const key = showEpisodeKey(row.season, row.episode);
    const existing = byEpisode.get(key);
    if (!existing || String(row.watched_at || "") >= String(existing.watched_at || "")) {
      byEpisode.set(key, { ...row, show_title: rowShowTitle });
    }
  }

  const episodes = [...byEpisode.values()].sort((a, b) => Number(b.season || 0) - Number(a.season || 0) || Number(b.episode || 0) - Number(a.episode || 0));
  if (!episodes.length) return show;

  const seasonCount = new Set(episodes.map((episode) => episode.season).filter((season) => season != null)).size;
  const watchedDates = episodes.map((episode) => episode.watched_at).filter(Boolean).sort();
  return {
    ...show,
    episode_count: Math.max(Number(show.episode_count || 0), episodes.length),
    season_count: Math.max(Number(show.season_count || 0), seasonCount),
    latest_watched_at: watchedDates.at(-1) || show.latest_watched_at,
    earliest_watched_at: watchedDates[0] || show.earliest_watched_at,
    episodes,
  };
}

function applyWatchedAtToLocalWatchRecord(id, watchedAt) {
  if (!id || !watchedAt) return null;
  let updated = null;

  const updateRow = (row) => {
    if (!row || String(row.id) !== String(id)) return;
    row.watched_at = watchedAt;
    updated = row;
  };

  state.history.forEach(updateRow);
  state.historyViewRaw.forEach(updateRow);

  for (const show of state.showsRaw || []) {
    let showUpdated = false;
    for (const episode of show.episodes || []) {
      if (String(episode.id) !== String(id)) continue;
      episode.watched_at = watchedAt;
      updated = episode;
      showUpdated = true;
    }
    if (show.representative_episode && String(show.representative_episode.id) === String(id)) {
      show.representative_episode.watched_at = watchedAt;
      updated = show.representative_episode;
      showUpdated = true;
    }
    if (showUpdated) {
      const dates = (show.episodes || []).map((episode) => episode.watched_at).filter(Boolean).sort();
      if (dates.length) {
        show.earliest_watched_at = dates[0];
        show.latest_watched_at = dates.at(-1);
      }
    }
  }

  for (const episode of state.showModalEpisodes || []) {
    if (!episode.watched || String(episode.watched.id) !== String(id)) continue;
    episode.watched.watched_at = watchedAt;
    updated = episode.watched;
  }

  return updated;
}

function editDateOptionsFromButton(button, entry = null) {
  const releaseDateFromRow = button?.closest(".immersive-episode-row")?.querySelector(".immersive-episode-dates time[datetime]")?.getAttribute("datetime");
  if (releaseDateFromRow) return { releaseDate: releaseDateFromRow };

  if (entry?.media_type === "movie") {
    const tmdbData = resolvedTmdbCache("movie", entry.tmdb_id, entry.title);
    if (tmdbData?.release_date) return { releaseDate: tmdbData.release_date };
  }

  return {};
}

async function openShowImmersiveModalByTitleLegacy(showTitle) {
  const showKey = slug(showTitle);
  let show = state.showsRaw.find((s) => slug(s.title) === showKey);

  if (!show) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
    elements.modalBody.innerHTML = `
      <div class="immersive-container">
        <button class="immersive-back-button" type="button">← Back</button>
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
          <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading show details...</span>
        </div>
      </div>
    `;

    try {
      const response = await fetch(`/api/show?title=${encodeURIComponent(showTitle)}`, { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.show) {
        const found = body.show;
        if (found) {
          mergeShowDetail(found);
          show = found;
        }
      }
    } catch (error) {
      console.error("Failed to fetch show details by title", error);
    }
  }

  if (show) {
    await renderImmersiveShowModal(slug(show.title));
  } else {
    elements.modalBody.innerHTML = `
      <div class="immersive-container">
        <button class="immersive-back-button" type="button">← Back</button>
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Show not found</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Could not locate this TV series in the archive.</span>
        </div>
      </div>
    `;
  }
}

async function openShowImmersiveModalByTitle(showTitle, seedEpisode = null) {
  const showKey = slug(showTitle);
  state.activeShowModalKey = showKey;
  const requestedSeason = seedEpisode?.season != null ? Number(seedEpisode.season) : null;
  let show = state.showsRaw.find((item) => slug(item.title) === showKey);

  if (!show && seedEpisode) {
    show = {
      title: showTitle,
      episode_count: 1,
      season_count: seedEpisode.season != null ? 1 : 0,
      latest_watched_at: seedEpisode.watched_at,
      earliest_watched_at: seedEpisode.watched_at,
      tmdb_id: seedEpisode.tmdb_id || null,
      episodes: [{ ...seedEpisode, show_title: showTitle }],
    };
    state.showsRaw.push(show);
    if (state.mediaDetailInline) {
      await openShowInlineDetail(slug(show.title), requestedSeason);
    } else {
      await renderImmersiveShowModal(slug(show.title), requestedSeason);
    }
  } else if (!show) {
    if (!state.mediaDetailInline) {
      elements.debugModal.classList.remove("hidden");
      document.body.style.overflow = "hidden";
      const modalPanel = elements.debugModal.querySelector(".modal-panel");
      if (modalPanel) {
        modalPanel.classList.add("modal-panel--immersive");
      }
    }
    const root = mediaDetailRoot();
    root.innerHTML = `
      <div class="immersive-container">
        ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">&larr; Back</button>' : ''}
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
          <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading show details...</span>
        </div>
      </div>
    `;
  }

  try {
    const response = await fetch(`/api/show?title=${encodeURIComponent(showTitle)}`, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.show) {
      const found = body.show;
      if (found) {
        mergeShowDetail(found);
        show = found;
      }
    }
  } catch (error) {
    console.error("Failed to fetch show details by title", error);
  }

  const root = mediaDetailRoot();
  const isModalOpen = state.mediaDetailInline || !elements.debugModal.classList.contains("hidden");

  if (show && state.activeShowModalKey === showKey && isModalOpen) {
    if (state.mediaDetailInline) {
      await openShowInlineDetail(slug(show.title), requestedSeason || state.activeShowModalSeason);
    } else {
      await renderImmersiveShowModal(slug(show.title), requestedSeason || state.activeShowModalSeason);
    }
  } else if (!show && state.activeShowModalKey === showKey && isModalOpen) {
    root.innerHTML = `
      <div class="immersive-container">
        ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">&larr; Back</button>' : ''}
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Show not found</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Could not locate this TV series in the archive.</span>
        </div>
      </div>
    `;
  }
}

async function openImmersiveModal(id) {
  setMediaDetailActions("");
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();
  root.innerHTML = `
    <div class="immersive-container media-detail-page">
      ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">← Back</button>' : ''}
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading details...</span>
      </div>
    </div>
  `;

  let entry = movieById(id);
  if (!entry) {
    try {
      const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.row) {
        entry = body.row;
      }
    } catch (error) {
      console.error("Failed to fetch watch history item", error);
    }
  }

  if (!entry) {
    root.innerHTML = `
      <div class="immersive-container">
        ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">← Back</button>' : ''}
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Content not found</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Could not locate this watch history record.</span>
        </div>
      </div>
    `;
    return;
  }

  if (!isWatchedHistoryAction(entry)) {
    openDebugModal(entry);
    return;
  }

  if (entry.media_type === "episode") {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    await openShowImmersiveModalByTitle(showTitle, entry);
  } else {
    await renderMovieImmersiveModalContent(entry);
  }
}

async function openHistoryDebugModal(id) {
  const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `History detail failed with ${response.status}`);
  openDebugModal(body.row || historyById(id));
}

// Request coalescer: explorer grids ask for TMDB details one card at a time, which
// used to mean ~90 separate /api/tmdb-details calls hammering a single Cloud Function
// instance (3s avg, 14s worst case). We now batch all asks within a short window into
// one POST to /api/tmdb-details-batch, which resolves them in parallel server-side.
let _tmdbBatchQueue = [];
let _tmdbBatchTimer = null;

function flushTmdbBatch() {
  _tmdbBatchTimer = null;
  const batch = _tmdbBatchQueue;
  _tmdbBatchQueue = [];
  if (!batch.length) return;
  const items = batch.map((entry) => entry.item);
  (async () => {
    try {
      // no-store: the real cache is server-side (status-aware TTL).
      const res = await fetch("/api/tmdb-details-batch", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ items }),
      });
      if (res.ok) {
        const data = await res.json();
        const results = Array.isArray(data.results) ? data.results : [];
        batch.forEach((entry, i) => {
          const r = results[i];
          entry.resolve(r && r.details ? r.details : null);
        });
        return;
      }
      batch.forEach((entry) => entry.resolve(null));
    } catch (error) {
      console.error("Failed to fetch TMDB details batch", error);
      batch.forEach((entry) => entry.resolve(null));
    }
  })();
}

function normalizeTmdbLookupIds(ids = {}) {
  return {
    imdbId: String(ids.imdbId || ids.imdb_id || ids.imdb || "").trim(),
    tvdbId: String(ids.tvdbId || ids.tvdb_id || ids.tvdb || "").trim(),
  };
}

async function fetchTmdbDetails(mediaType, tmdbId, title, ids = {}) {
  const lookupIds = normalizeTmdbLookupIds(ids);
  const cacheKey = `${mediaType}|${tmdbId || ""}|${String(title || "").toLowerCase()}|${lookupIds.imdbId.toLowerCase()}|${lookupIds.tvdbId.toLowerCase()}`;
  if (state.tmdbDetailsCache.has(cacheKey)) return state.tmdbDetailsCache.get(cacheKey);

  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  _tmdbBatchQueue.push({
    item: {
      mediaType,
      tmdbId: tmdbId || undefined,
      title: title || undefined,
      imdbId: lookupIds.imdbId || undefined,
      tvdbId: lookupIds.tvdbId || undefined,
    },
    resolve: resolveFn,
  });
  if (_tmdbBatchQueue.length >= 100) {
    clearTimeout(_tmdbBatchTimer);
    flushTmdbBatch();
  } else if (!_tmdbBatchTimer) {
    _tmdbBatchTimer = setTimeout(flushTmdbBatch, 50);
  }

  state.tmdbDetailsCache.set(cacheKey, promise);

  promise.then((val) => {
    if (val === null) {
      state.tmdbDetailsCache.delete(cacheKey);
    } else {
      state.tmdbDetailsCache.set(cacheKey, val);
    }
  });

  return promise;
}

function renderCastSection(tmdbData) {
  const cast = tmdbData?.credits?.cast || [];
  if (!cast.length) return "";
  return `
    <section class="seasons-section cast-section">
      <div class="show-section-title"><h3>Cast</h3></div>
      <div class="cast-compact-row cast-scroll-row">
        ${cast.slice(0, 20).map((actor) => {
    const avatarUrl = tmdbProfile(actor.profile_path) || "/favicon.svg";
    return `
            <div class="cast-member-card" style="cursor: pointer;" data-person-id="${actor.id}" data-person-name="${escapeAttribute(actor.name)}">
              <img class="cast-avatar-img" src="${escapeAttribute(avatarUrl)}" alt="${escapeAttribute(actor.name)}" data-err="fav" />
              <span class="cast-actor-name">${escapeHtml(actor.name)}</span>
              <span class="cast-character-name">${escapeHtml(actor.character)}</span>
            </div>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

function renderTrailersReviewsSection(tmdbData) {
  if (!tmdbData) return "";
  const trailers = (tmdbData.videos?.results || []).filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"));
  const reviews = tmdbData.reviews?.results || [];
  let html = "";

  if (trailers.length > 0) {
    html += `
      <section class="seasons-section trailers-section">
        <div class="show-section-title"><h3>Trailers & Clips</h3><span>${trailers.length} available</span></div>
        <div class="horizontal-scroll-row trailer-scroll-row" style="margin-top: 0.5rem;">
          ${trailers.map((video) => `
            <div class="trailer-card">
              <div class="trailer-thumb-container" data-video-key="${video.key}" data-video-name="${escapeAttribute(video.name)}">
                <img class="trailer-thumb" src="https://img.youtube.com/vi/${video.key}/mqdefault.jpg" alt="${escapeAttribute(video.name)}" data-err="fav" />
                <div class="play-overlay"><svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
              </div>
              <span class="trailer-title" title="${escapeAttribute(video.name)}">${escapeHtml(video.name)}</span>
            </div>
          `).join("")}
        </div>
      </section>
    `;
  }

  if (reviews.length > 0) {
    html += `
      <section class="seasons-section reviews-section">
        <div class="show-section-title"><h3>Reviews</h3><span>${reviews.length} reviews</span></div>
        <div class="review-list" style="margin-top: 0.5rem;">
          ${reviews.slice(0, 3).map((review) => {
      const hasLong = review.content?.length > 300;
      return `
              <div class="review-card">
                <div class="review-header">
                  <span class="review-author">${escapeHtml(review.author)}</span>
                  ${review.author_details?.rating ? `<span class="review-rating">★ ${review.author_details.rating}/10</span>` : ""}
                </div>
                <div class="review-content-wrapper"><p class="review-content">${escapeHtml(review.content)}</p></div>
                ${hasLong ? `<button class="action-pill review-toggle-btn" type="button">Read More</button>` : ""}
              </div>
            `;
    }).join("")}
        </div>
      </section>
    `;
  }

  return html;
}

function renderRelatedShowsSection(tmdbData) {
  const related = tmdbData?.similar?.results || [];
  if (!related.length) return "";
  return `
    <section class="seasons-section related-section">
      <div class="show-section-title"><h3>Related Shows</h3></div>
      <div class="horizontal-scroll-row" style="margin-top: 0.5rem;">
        ${related.slice(0, 20).map((item) => {
    const poster = tmdbPoster(item.poster_path) || "/favicon.svg";
    const year = (item.first_air_date || "").slice(0, 4);
    return `
            <a class="season-poster-card related-show-card" data-immersive-related-tmdb="${item.id}" href="/tvshow/tmdb/${item.id}">
              <img class="season-poster-img" src="${escapeAttribute(poster)}" alt="${escapeAttribute(item.name || "")}" data-err="fav" />
              <span class="season-poster-name">${escapeHtml(item.name || "")}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
            </a>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

function renderRichTmdbDetails(tmdbData) {
  return renderTrailersReviewsSection(tmdbData);
}

function renderMediaImagesSection(tmdbData) {
  if (!tmdbData?.images) return "";
  const seen = new Set();
  const dedupe = (imgs) => imgs.filter((img) => {
    if (!img.file_path || seen.has(img.file_path)) return false;
    seen.add(img.file_path);
    return true;
  });
  // Prefer language-neutral backdrops (no text overlay); fall back to all if too few.
  const raw = tmdbData.images.backdrops || [];
  const clean = dedupe(raw.filter((img) => !img.iso_639_1));
  const backdrops = (clean.length >= 3 ? clean : dedupe(raw))
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
    .slice(0, 20);

  if (!backdrops.length) return "";

  return `
    <section class="seasons-section media-images-section">
      <div class="show-section-title"><h3>Images</h3><span>${backdrops.length} available</span></div>
      <div class="media-images-scroll-row">
        ${backdrops.map((img, i) => {
    const thumb = tmdbImage(img.file_path, "w780");
    const full = tmdbImage(img.file_path, "original");
    return `<button class="media-image-card" type="button" data-lightbox-index="${i}" data-lightbox-src="${escapeAttribute(full)}">
            <img class="media-image-thumb" src="${escapeAttribute(thumb)}" alt="Scene image" loading="lazy" data-err="hide-parent" />
          </button>`;
  }).join("")}
      </div>
    </section>
  `;
}

function renderMediaFacts(tmdbData, mediaType = "movie", placement = "inline") {
  if (!tmdbData) return "";
  const providers = tmdbData["watch/providers"]?.results?.GB?.flatrate || tmdbData["watch/providers"]?.results?.US?.flatrate || [];
  const runtime = mediaType === "movie"
    ? (tmdbData.runtime ? `${tmdbData.runtime} min` : "")
    : (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min episodes` : "");
  const facts = [
    ["Status", tmdbData.status],
    [mediaType === "movie" ? "Release" : "First aired", formatTmdbDate(tmdbData.release_date || tmdbData.first_air_date)],
    ["Runtime", runtime],
    ["Language", String(tmdbData.original_language || "").toUpperCase()],
    ["Genres", (tmdbData.genres || []).map((genre) => genre.name).join(", ")],
    ["Network", (tmdbData.networks || []).map((network) => network.name).join(", ")],
    ["Streaming", providers.map((provider) => provider.provider_name).join(", ")],
  ].filter(([, value]) => value);
  if (!facts.length) return "";
  const wideLabels = new Set(["Streaming", "Network"]);
  return `<aside class="media-facts-rail ${placement === "sidebar" ? "media-facts-rail--sidebar" : ""}" aria-label="Media facts">${facts.map(([label, value]) => `
    <div class="media-fact${wideLabels.has(label) ? " media-fact--wide" : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
  `).join("")}</aside>`;
}

async function fetchTmdbSeasonDetails(tmdbId, seasonNumber) {
  if (!state.savedConfig.tmdb?.configured || !tmdbId || seasonNumber == null) return null;

  const cacheKey = `${tmdbId}|${seasonNumber}`;
  if (state.tmdbSeasonCache.has(cacheKey)) return state.tmdbSeasonCache.get(cacheKey);

  const promise = (async () => {
    try {
      const res = await fetch(`/api/tmdb-season?tmdbId=${encodeURIComponent(tmdbId)}&seasonNumber=${encodeURIComponent(seasonNumber)}`, { headers: authHeaders() });
      if (res.ok) {
        return await res.json();
      }
    } catch (error) {
      console.error("Failed to fetch TMDB season details", error);
    }
    return null;
  })();

  state.tmdbSeasonCache.set(cacheKey, promise);

  promise.then((val) => {
    if (val === null) {
      state.tmdbSeasonCache.delete(cacheKey);
    } else {
      state.tmdbSeasonCache.set(cacheKey, val);
    }
  });

  return promise;
}

async function resolveEpisodeTitleFromTmdb(entry, element) {
  const showTitle = entry.show_title || showTitleFrom(entry.title);
  if (!showTitle) return;

  try {
    const tmdbData = await fetchTmdbDetails("tv", entry.tmdb_id, showTitle);
    if (!tmdbData?.id) return;

    const seasonData = await fetchTmdbSeasonDetails(tmdbData.id, entry.season);
    if (!seasonData || !Array.isArray(seasonData.episodes)) return;

    const tmdbEpisode = seasonData.episodes.find(
      (ep) => Number(ep.episode_number) === Number(entry.episode)
    );

    if (tmdbEpisode?.name) {
      entry.episode_title = tmdbEpisode.name;
      entry.episodeTitle = tmdbEpisode.name;
      if (element) {
        element.textContent = tmdbEpisode.name;
        element.title = tmdbEpisode.name;
      }
    }
    if (tmdbEpisode?.air_date) {
      entry.airDate = tmdbEpisode.air_date;
      entry.air_date = tmdbEpisode.air_date;
    }
  } catch (error) {
    console.error("Failed to resolve episode title from TMDB in background", error);
  }
}

function formatTmdbDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(date.getTime())) return dateStr;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function ordinalDay(day) {
  const value = Number(day) || 0;
  const suffix = (value % 100 >= 11 && value % 100 <= 13)
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[value % 10] || "th");
  return `${value}${suffix}`;
}

function formatLongAiringDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(date.getTime())) return dateStr;
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  return `${ordinalDay(date.getDate())} ${month} ${date.getFullYear()}`;
}

function knownShowAirtime(showTitle = "") {
  return String(showTitle || "").trim().toLowerCase() === "from" ? "9:00 p.m. ET" : "";
}

function formatEpisodeAirtime(episode = {}, showTitle = "") {
  const raw = episode.airTime || episode.air_time || episode.airtime || "";
  if (!raw) return knownShowAirtime(showTitle) || "Airtime TBA";
  const text = String(raw).trim();
  if (/^\d{1,2}:\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return formatShortTime(date);
  return text;
}

function tmdbTitleUrl(mediaType, tmdbId) {
  const id = String(tmdbId || "");
  if (!id) return "";
  return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${encodeURIComponent(id)}`;
}

function ratingPillHtml({ label, value = "View", href = "", title = "" } = {}) {
  if (!label || !href) return "";
  return `
    <a class="rating-pill rating-pill-link" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttribute(title || `${label} rating`)}">
      <span>${escapeHtml(label)}</span>
      <span>${escapeHtml(value)}</span>
    </a>
  `;
}

function tvAvailabilityLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available = Number(status.availableEpisodes || 0);
  if (!total) return status.available ? "Available" : "";
  if (available >= total) return `${available}/${total} Available in 1080p`;
  if (available > 0) return `${available}/${total} Available in 1080p`;
  return "";
}

function tvAvailability4kLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available4k = Number(status.available4kEpisodes || 0);
  if (!total) return status.available4k ? "Available in 4K" : "";
  if (available4k >= total) return `${available4k}/${total} Available in 4K`;
  if (available4k > 0) return `${available4k}/${total} Available in 4K`;
  return "";
}

function tvSeasonAvailability(status = {}, seasonNumber) {
  return (status.seasons || []).find((season) => Number(season.seasonNumber) === Number(seasonNumber)) || null;
}

function tvSeasonAvailabilityHtml(status = {}, seasonNumber) {
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  if (!season || !Number(season.released || season.total || 0)) return "";
  const total = Number(season.released || season.total || 0);
  const available = Number(season.available || 0);
  const available4k = Number(season.available4k || 0);
  const availabilityText = available >= total ? `All ${total} available` : `${available}/${total} available`;
  const fourKText = available4k >= total ? `All ${total} in 4K` : available4k > 0 ? `${available4k}/${total} in 4K` : "";
  return `
    <span class="season-availability-pill ${available >= total ? "is-complete" : available > 0 ? "is-partial" : "is-missing"}">${escapeHtml(availabilityText)}</span>
    ${fourKText ? `<span class="season-availability-pill is-4k ${available4k >= total ? "is-complete" : "is-partial"}">${escapeHtml(fourKText)}</span>` : ""}
  `;
}

function renderSeasonSeerrControls(tmdbId, seasonNumber, status = {}) {
  if (!state.seerrConfigured || !tmdbId) return "";
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  const released = Number(season?.released || season?.total || 0);
  const missingStandard = !season || !released || Number(season.available || 0) < released;
  const missing4k = !season || !released || Number(season.available4k || 0) < released;
  const supports4k = state.seerrSupports4k.tv;
  return `
    <span class="season-request-controls">
      ${missingStandard ? `
        <button class="rating-pill seerr-request-btn season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}">
          <span>Request season</span>
        </button>
      ` : ""}
      ${supports4k && missing4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}"
          data-seerr-request-4k="true">
          <span>Request 4K</span>
        </button>
      ` : ""}
    </span>
  `;
}

function renderSeerrRequestPill(mediaType, tmdbId, localAvailable = false) {
  if (!state.seerrConfigured || !tmdbId) return "";
  const status = state.seerrMediaStatusCache.get(`${mediaType}:${tmdbId}`) || {};
  const isTv = mediaType === "tv";
  const isAvailable = Boolean(status.available);
  const supports4k = mediaType === "movie" ? state.seerrSupports4k.movie : state.seerrSupports4k.tv;
  const seerrBaseUrl = String(state.savedConfig?.seerr?.baseUrl || "").replace(/\/+$/, "");
  const seerrIconHtml = seerrBaseUrl
    ? `<img class="seerr-request-icon" src="${escapeAttribute(`${seerrBaseUrl}/favicon.ico`)}" alt="" loading="lazy" data-err="hide-show-next" />`
    : "";
  const iconAndFallback = `${seerrIconHtml}<span class="seerr-request-fallback" aria-hidden="true">S</span>`;
  const tvAvailableLabel = isTv ? tvAvailabilityLabel(status) : "";
  const tv4kLabel = isTv ? tvAvailability4kLabel(status) : "";
  // For whole-show TV 4K requests, embed the season numbers that are missing 4K so
  // Jellyseerr receives the required `seasons` field in the request payload.
  const tv4kSeasons = isTv && Array.isArray(status.seasons)
    ? status.seasons
        .filter((s) => Number(s.released || s.total || 0) > 0 && !s.available4k)
        .map((s) => s.seasonNumber)
    : [];
  return `
    <span id="seerrRequestContainer" style="display: inline-flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;" data-media-type="${escapeAttribute(mediaType)}" data-tmdb-id="${escapeAttribute(String(tmdbId))}" data-local-available="${localAvailable}">
      ${isAvailable ? `<span class="rating-pill seerr-owned-pill">${escapeHtml(isTv ? tvAvailableLabel || "Available" : "Available in 1080p")}</span>` : tvAvailableLabel ? `<span class="rating-pill seerr-owned-pill seerr-owned-pill-partial">${escapeHtml(tvAvailableLabel)}</span>` : `
        <button class="rating-pill seerr-request-btn" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}">
          ${iconAndFallback}
          <span>${status.pending ? "Requested on Seerr" : "Request on Seerr"}</span>
        </button>
      `}
      ${tv4kLabel ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k ${status.available4k ? "" : "seerr-owned-pill-partial"}">${escapeHtml(tv4kLabel)}</span>
      ` : supports4k && !status.available4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-request-4k="true"${tv4kSeasons.length ? ` data-seerr-seasons="${escapeAttribute(JSON.stringify(tv4kSeasons))}"` : ""}>
          ${iconAndFallback}
          <span>${status.pending4k ? "4K Requested" : "Request 4K"}</span>
        </button>
      ` : status.available4k ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k">${escapeHtml(isTv ? tv4kLabel || "Available in 4K" : "Available in 4K")}</span>
      ` : ""}
    </span>
  `;
}

function fetchSeerrMediaStatus(mediaType, tmdbId) {
  if (!state.seerrConfigured || !tmdbId) return Promise.resolve(null);
  const cacheKey = `${mediaType}:${tmdbId}`;
  if (state.seerrMediaStatusCache.get(cacheKey)?.loading) return Promise.resolve(null);
  state.seerrMediaStatusCache.set(cacheKey, { ...(state.seerrMediaStatusCache.get(cacheKey) || {}), loading: true });
  return fetch(`/api/seerr/media-status?mediaType=${encodeURIComponent(mediaType)}&mediaId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() })
    .then((response) => response.json().then((body) => ({ response, body })).catch(() => ({ response, body: {} })))
    .then(({ response, body }) => {
      if (!response.ok || !body.ok) throw new Error(body.error || `Seerr status failed with ${response.status}`);
      state.seerrMediaStatusCache.set(cacheKey, { ...body, loading: false });
      return body;
    })
    .catch(() => {
      state.seerrMediaStatusCache.set(cacheKey, { loading: false });
      return null;
    });
}

function refreshActiveMediaDetailAfterSeerrStatus(mediaType, tmdbId) {
  const container = document.getElementById("seerrRequestContainer");
  if (container && container.getAttribute("data-media-type") === mediaType && String(container.getAttribute("data-tmdb-id")) === String(tmdbId)) {
    const localAvailable = container.getAttribute("data-local-available") === "true";
    container.outerHTML = renderSeerrRequestPill(mediaType, tmdbId, localAvailable);
  }
}

function renderExternalRatingPills(mediaType, tmdbData, title, rating = "") {
  const tmdbId = tmdbData?.id || tmdbData?.tmdb_id || "";
  const pills = [];
  if (rating) {
    pills.push(ratingPillHtml({
      label: "TMDB",
      value: rating,
      href: tmdbTitleUrl(mediaType, tmdbId),
      title: "Open this title on TMDB",
    }));
  }
  return pills.join("");
}

async function renderImmersiveShowModalLegacy(showKey, activeSeasonNum = null) {
  state.activeShowModalKey = showKey;
  elements.debugModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  const modalPanel = elements.debugModal.querySelector(".modal-panel");
  if (modalPanel) {
    modalPanel.classList.add("modal-panel--immersive");
  }

  let show = state.showsRaw.find((s) => slug(s.title) === showKey);
  if (!show) return;

  if (!Array.isArray(show.episodes) || !show.episodes.length) {
    elements.modalBody.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container">
        <button class="immersive-back-button" type="button">&larr; Back</button>
        <div class="empty-log">
          <b>Loading episodes...</b>
          <span>Loading episode history.</span>
        </div>
      </div>
    `;
    hydratePosters(elements.modalBody);
    show = await loadShowDetail(show).catch((error) => {
      console.error("Failed to load show detail", error);
      setMessage(`Failed to load show details: ${error.message}`, "error");
      return show;
    });
    if (!Array.isArray(show.episodes) || !show.episodes.length) {
      elements.modalBody.innerHTML = `
        <div class="modal-backdrop-image"></div>
        <div class="immersive-container">
          <button class="immersive-back-button" type="button">&larr; Back</button>
          <div class="empty-log">
            <b>No episode rows found</b>
            <span>No local episode history was available.</span>
          </div>
        </div>
      `;
      return;
    }
  }

  const seasonsMap = seasonsFromShowRecord(show);

  if (activeSeasonNum === null) {
    const sortedSeasonNums = [...seasonsMap.keys()].sort((a, b) => b - a);
    activeSeasonNum = sortedSeasonNums[0] || 1;
  }
  state.activeShowModalSeason = activeSeasonNum;

  elements.modalBody.innerHTML = `
    <div class="immersive-container">
      <button class="immersive-back-button" type="button">← Back</button>
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading show details...</span>
      </div>
    </div>
  `;

  const tmdbData = await fetchTmdbDetails("tv", show.tmdb_id, show.title, tmdbLookupIdsFromShow(show, seasonsMap));

  const showTitle = sanitizeTitle(show.title) || "Unknown Show";
  let backdropUrl = "";
  let posterUrl = posterUrlFor(representativeEpisode(seasonsMap));
  let overview = "No synopsis available.";
  let premiered = "Unknown Release Date";
  let rating = "N/A";
  let seasonsList = [];
  let currentSeasonEpisodeCount = 0;

  if (tmdbData) {
    if (tmdbData.backdrop_path) {
      backdropUrl = `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`;
    }
    if (tmdbData.poster_path) {
      posterUrl = tmdbPoster(tmdbData.poster_path, tmdbData.id, "tv");
    }
    overview = tmdbData.overview || overview;
    premiered = tmdbData.first_air_date ? `Premiered ${formatTmdbDate(tmdbData.first_air_date)}` : premiered;
    rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : rating;
    seasonsList = tmdbData.seasons || [];

    const tmdbSeason = seasonsList.find((s) => s.season_number === activeSeasonNum);
    if (tmdbSeason) {
      currentSeasonEpisodeCount = tmdbSeason.episode_count || 0;
    }
  }

  if (seasonsList.length === 0) {
    seasonsList = [...seasonsMap.keys()].sort((a, b) => b - a).map((num) => ({
      season_number: num,
      name: `Season ${num}`,
      episode_count: seasonsMap.get(num)?.length || 0,
      poster_path: null,
    }));
  }

  const watchedEpisodes = seasonsMap.get(activeSeasonNum) || [];
  const watchedCount = watchedEpisodes.length;
  const totalCount = currentSeasonEpisodeCount || watchedCount || 1;
  const progressPercent = Math.max(0, Math.min(100, Math.round((watchedCount / totalCount) * 100)));

  const uniqueSources = [...new Set(watchedEpisodes.map(ep => ep.source || "unknown"))].filter(src => src !== "unknown");
  const sourceBadgesHtml = uniqueSources.map(src => `
    <span class="source-badge ${sourceClass(src)}" style="display: inline-flex;">${escapeHtml(platformBadge(src))}</span>
  `).join("");

  const ratingBadgeHtml = rating !== "N/A" ? `
    ${renderExternalRatingPills("tv", tmdbData, showTitle, rating)}
  ` : "";

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${backdropUrl || posterUrl}');"></div>
    <div class="immersive-container media-detail-page">
      <button class="immersive-back-button" type="button">← Back</button>
      
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(showTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          <span class="format-badge">Season ${activeSeasonNum}</span>
          <h2 class="immersive-title">${escapeHtml(showTitle)}</h2>
          <p class="immersive-subtitle">${premiered}</p>
          
          <div class="ratings-row">
            ${ratingBadgeHtml}
            ${renderSeerrRequestPill("tv", show.tmdb_id, state.activeSessions.some((s) => String(s.ids?.tmdb || "") === String(show.tmdb_id || "")))}
            ${sourceBadgesHtml ? `
              <div style="display: flex; gap: 0.25rem; align-items: center; margin-left: 0.5rem;">
                <span style="font-size: 0.72rem; color: var(--muted); font-weight: 800; text-transform: uppercase;">Platforms:</span>
                ${sourceBadgesHtml}
              </div>
            ` : ""}
          </div>

          <p class="immersive-overview">${escapeHtml(overview)}</p>
        </div>
      </header>

      <section class="progress-section">
        <h3>Progress</h3>
        <div class="progress-label-row">
          <span>${watchedCount} of ${totalCount} episodes watched</span>
          <span>${progressPercent}% complete</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
        </div>
      </section>

      <section class="episodes-section">
        <h3>Episodes</h3>
        <button class="episodes-accordion-btn" type="button" data-immersive-toggle-episodes="true">
          <span>Browse episodes</span>
          <span>${watchedCount} episodes watched</span>
        </button>
        <div id="immersiveEpisodeList" class="episode-list hidden" style="margin-top: 0.75rem;">
          ${[...watchedEpisodes].sort((a, b) => Number(b.episode || 0) - Number(a.episode || 0))
      .map(
        (episode) => `
                <article class="episode-row" style="background: #0d1216;">
                  ${posterMarkup(episode, "explorer-episode-poster")}
                  <span class="episode-code">[ E${String(episode.episode || "?").padStart(2, "0")} ]</span>
                  <b>[ ${escapeHtml(episodeTitle(episode.title, episode.episode))} ]</b>
                  <button class="debug-badge" type="button" data-history-id="${episode.id}">${formatDate(episode.watched_at)}</button>
                </article>
              `,
      )
      .join("")}
        </div>
      </section>

      <section class="seasons-section">
        <h3>Other seasons</h3>
        <div class="horizontal-scroll-row">
          ${[...seasonsList]
      .filter((s) => s.season_number > 0)
      .sort((a, b) => Number(b.season_number) - Number(a.season_number))
      .map((s) => {
        const isActive = s.season_number === activeSeasonNum;
        const seasonPoster = s.poster_path
          ? tmdbPoster(s.poster_path)
          : posterUrl;
        return `
                <div class="season-poster-card ${isActive ? "active" : ""}" data-immersive-season-num="${s.season_number}">
                  <img class="season-poster-img" src="${seasonPoster}" alt="${escapeHtml(s.name)}" data-err="fav" />
                  <span class="season-poster-name">${escapeHtml(s.name || `Season ${s.season_number}`)}</span>
                </div>
              `;
      })
      .join("")}
        </div>
      </section>
    </div>
  `;
  fetchSeerrMediaStatus("tv", show.tmdb_id)
    .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("tv", show.tmdb_id); });
  hydratePosters(root);
}

function showEpisodeKey(seasonNumber, episodeNumber) {
  return `${Number(seasonNumber) || 0}|${Number(episodeNumber) || 0}`;
}

function seasonLabel(seasonNumber) {
  return `Season ${Number(seasonNumber) || 0}`;
}

function episodeCode(seasonNumber, episodeNumber) {
  return `S${String(Number(seasonNumber) || 0).padStart(2, "0")}E${String(Number(episodeNumber) || 0).padStart(2, "0")}`;
}


// Whole years between birthday and (deathday || today). Returns null if unparseable.
function personAge(birthday, deathday) {
  if (!birthday) return null;
  const birth = new Date(birthday);
  if (Number.isNaN(birth.getTime())) return null;
  const end = deathday ? new Date(deathday) : new Date();
  if (Number.isNaN(end.getTime())) return null;
  let age = end.getFullYear() - birth.getFullYear();
  const monthDelta = end.getMonth() - birth.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && end.getDate() < birth.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

// Build social/external links from a TMDB person's external_ids + homepage.
function personSocialLinks(data = {}) {
  const ext = data.external_ids || {};
  const links = [];
  if (ext.instagram_id) links.push({ label: "Instagram", href: `https://instagram.com/${ext.instagram_id}` });
  if (ext.twitter_id) links.push({ label: "X", href: `https://x.com/${ext.twitter_id}` });
  if (ext.tiktok_id) links.push({ label: "TikTok", href: `https://www.tiktok.com/@${ext.tiktok_id}` });
  if (ext.facebook_id) links.push({ label: "Facebook", href: `https://facebook.com/${ext.facebook_id}` });
  if (ext.youtube_id) links.push({ label: "YouTube", href: `https://www.youtube.com/${ext.youtube_id}` });
  if (ext.imdb_id) links.push({ label: "IMDb", href: `https://www.imdb.com/name/${ext.imdb_id}/` });
  if (data.homepage) links.push({ label: "Website", href: data.homepage });
  return links;
}

function watchedEpisodesByKey(show = {}) {
  const map = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    map.set(showEpisodeKey(episode.season, episode.episode), episode);
  }
  return map;
}

function fallbackSeasonList(seasonsMap) {
  return [...seasonsMap.keys()].sort((a, b) => b - a).map((seasonNumber) => ({
    season_number: seasonNumber,
    name: seasonLabel(seasonNumber),
    episode_count: seasonsMap.get(seasonNumber)?.length || 0,
    poster_path: null,
  }));
}

function buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, resolvedTmdbId = "", tmdbData = null) {
  const watchedMap = watchedEpisodesByKey(show);
  const localSeasons = seasonsFromShowRecord(show);
  const rows = [];

  // Build a lookup of episodes known at show level (next_episode_to_air) but possibly
  // absent from season detail responses (TMDB sometimes publishes them late).
  const knownNextEpisodes = new Map();
  for (const ep of [tmdbData?.next_episode_to_air, tmdbData?.last_episode_to_air]) {
    if (ep?.season_number != null && ep?.episode_number != null) {
      knownNextEpisodes.set(showEpisodeKey(Number(ep.season_number), Number(ep.episode_number)), ep);
    }
  }

  for (const season of seasonsList.filter((item) => Number(item.season_number) > 0)) {
    const seasonNumber = Number(season.season_number);
    const tmdbSeason = seasonDetailsByNumber.get(seasonNumber);
    const tmdbEpisodes = Array.isArray(tmdbSeason?.episodes) ? tmdbSeason.episodes : [];
    const fallbackPosterUrl = tmdbPoster(season.poster_path) || posterUrlFor(representativeEpisode(localSeasons));

    if (tmdbEpisodes.length) {
      const knownEpNums = new Set();
      for (const episode of tmdbEpisodes) {
        const episodeNumber = Number(episode.episode_number);
        knownEpNums.add(episodeNumber);
        const watched = watchedMap.get(showEpisodeKey(seasonNumber, episodeNumber));
        rows.push({
          key: showEpisodeKey(seasonNumber, episodeNumber),
          showTitle: show.title,
          showTmdbId: resolvedTmdbId || show.tmdb_id || "",
          seasonNumber,
          episodeNumber,
          title: episode.name || episodeTitle(watched?.title, episodeNumber),
          overview: episode.overview || "No synopsis available.",
          airDate: episode.air_date || "",
          airTime: episode.air_time || episode.airTime || episode.airtime || "",
          stillUrl: tmdbImage(episode.still_path, "w300"),
          posterUrl: tmdbPoster(season.poster_path) || posterUrlFor(watched || representativeEpisode(localSeasons)),
          watched,
        });
      }

      // Synthesize placeholder rows for episodes in season.episode_count that TMDB season
      // detail hasn't published yet (e.g. future episodes announced at show level only).
      const totalEpCount = Number(season.episode_count || 0);
      for (let epNum = 1; epNum <= totalEpCount; epNum++) {
        if (knownEpNums.has(epNum)) continue;
        const key = showEpisodeKey(seasonNumber, epNum);
        const hint = knownNextEpisodes.get(key);
        rows.push({
          key,
          showTitle: show.title,
          showTmdbId: resolvedTmdbId || show.tmdb_id || "",
          seasonNumber,
          episodeNumber: epNum,
          title: hint?.name || episodeTitle(null, epNum),
          overview: hint?.overview || "No synopsis available.",
          airDate: hint?.air_date || "",
          airTime: hint?.air_time || hint?.airTime || hint?.airtime || "",
          stillUrl: hint ? tmdbImage(hint.still_path, "w300") : "",
          posterUrl: fallbackPosterUrl,
          watched: null,
        });
      }

      continue;
    }

    for (const watched of localSeasons.get(seasonNumber) || []) {
      const episodeNumber = Number(watched.episode);
      rows.push({
        key: showEpisodeKey(seasonNumber, episodeNumber),
        showTitle: show.title,
        showTmdbId: resolvedTmdbId || show.tmdb_id || "",
        seasonNumber,
        episodeNumber,
        title: episodeTitle(watched.title, episodeNumber),
        overview: "TMDB metadata is still loading.",
        airDate: "",
        airTime: "",
        stillUrl: posterUrlFor(watched),
        posterUrl: posterUrlFor(watched),
        watched,
      });
    }
  }

  return rows.sort((a, b) => b.seasonNumber - a.seasonNumber || b.episodeNumber - a.episodeNumber);
}

function episodeThumbMarkup(episode) {
  const stillUrl = safeImageUrl(episode.stillUrl);
  // posterUrl may be a relative /api/... path (safe, our own server) — use it directly
  const posterUrl = safeImageUrl(episode.posterUrl) || episode.posterUrl || "";
  const url = stillUrl || posterUrl;
  if (!url) return `<span class="episode-thumb poster-fallback" aria-hidden="true"></span>`;
  const onerrorAttr = stillUrl && posterUrl && stillUrl !== posterUrl
    ? ` onerror="this.onerror=null;this.src=this.dataset.fallback" data-fallback="${escapeAttribute(posterUrl)}"`
    : "";
  return `<img class="episode-thumb" src="${escapeAttribute(url)}" alt="${escapeAttribute(episode.title)} thumbnail" loading="lazy" decoding="async" referrerpolicy="no-referrer"${onerrorAttr} />`;
}

function episodeReleaseLabel(airDate) {
  return airDate ? `Released ${formatTmdbDate(airDate)}` : "Release date unknown";
}

function showModalStatus(loading, hasTmdbKey, hasTmdbData) {
  if (loading) return `<span class="show-load-pill">Loading episode metadata...</span>`;
  if (!hasTmdbKey) return `<span class="show-load-pill muted">Add a TMDB API key to load all seasons and episode synopses.</span>`;
  if (!hasTmdbData) return `<span class="show-load-pill muted">TMDB episode metadata was unavailable.</span>`;
  return "";
}

function renderMovieWatchDatePrompt(action, customValue) {
  const movie = action.movie || {};
  const releaseLabel = movie.releaseDate ? formatTmdbDate(movie.releaseDate) : "Unknown release date";
  const lastPlayedLabel = action.lastPlayedAt ? formatDate(action.lastPlayedAt) : "";
  return `
    <div class="watch-date-overlay" role="dialog" aria-modal="true" aria-label="Choose watched date">
      <div class="watch-date-dialog">
        <div class="watch-date-head">
          <div class="watch-date-head-text">
            <h3>${escapeHtml(action.label)}</h3>
            <p class="watch-date-sub">${escapeHtml(movie.title || "Movie")} &middot; Movie</p>
          </div>
          <button class="watch-date-close" type="button" data-watch-date-cancel="true" aria-label="Cancel">&times;</button>
        </div>

        <p class="watch-date-intro">Logs this movie to your watch history and marks it played on Plex, Emby, and Jellyfin. Pick which date to record.</p>

        <div class="watch-date-section-label">Watched date</div>
        <div class="watch-date-options">
          <button class="watch-date-pick" type="button" data-watch-date-choice="release"${movie.releaseDate ? "" : " disabled"}>
            <span class="watch-date-pick-title">Day of release</span>
            <span class="watch-date-pick-sub">${escapeHtml(releaseLabel)}</span>
          </button>
          <button class="watch-date-pick" type="button" data-watch-date-choice="now">
            <span class="watch-date-pick-title">Now</span>
            <span class="watch-date-pick-sub">Today, ${escapeHtml(formatTmdbDate(customValue))}</span>
          </button>
          ${lastPlayedLabel ? `
          <button class="watch-date-pick" type="button" data-watch-date-choice="last_played">
            <span class="watch-date-pick-title">Last played</span>
            <span class="watch-date-pick-sub">${escapeHtml(lastPlayedLabel)}</span>
          </button>
          ` : ""}
        </div>

        ${watchDateCustomCardHtml()}
      </div>
    </div>
  `;
}

// ── Custom date+time picker (used inside the "Mark watched" prompt) ──────────
const WD_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function initWatchDateCustomState() {
  const now = new Date();
  now.setSeconds(0, 0);
  state.watchDateCustom = { year: now.getFullYear(), month: now.getMonth(), selected: now };
  return state.watchDateCustom;
}

function formatCustomDisplay(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

// Pull the hour/minute <select> values back into the selected Date before
// re-rendering or reading the final value (the calendar re-renders on day
// clicks, so the chosen time must be preserved across renders).
function syncCustomTimeFromSelects() {
  const wd = state.watchDateCustom;
  if (!wd?.selected) return;
  const root = mediaDetailRoot();
  const hourEl = root.querySelector("[data-wd-hour]");
  const minuteEl = root.querySelector("[data-wd-minute]");
  if (hourEl) wd.selected.setHours(Number(hourEl.value));
  if (minuteEl) wd.selected.setMinutes(Number(minuteEl.value));
  wd.selected.setSeconds(0, 0);
}

function getCustomWatchDateValue() {
  if (!state.watchDateCustom?.selected) return toDateTimeInputValue(new Date());
  syncCustomTimeFromSelects();
  return toDateTimeInputValue(state.watchDateCustom.selected);
}

function renderWatchDateCustomPicker() {
  const wd = state.watchDateCustom || initWatchDateCustomState();
  const sel = wd.selected;
  const now = new Date();
  const todayStr = toDateInputValue(now);
  const selStr = toDateInputValue(sel);

  const viewDate = new Date(wd.year, wd.month, 1);
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(viewDate);
  const firstDow = (viewDate.getDay() + 6) % 7; // Monday-indexed
  const daysInMonth = new Date(wd.year, wd.month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(`<span class="wd-cell wd-empty"></span>`);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateStr = `${wd.year}-${String(wd.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const classes = ["wd-cell", "wd-day"];
    if (dateStr === selStr) classes.push("is-selected");
    if (dateStr === todayStr) classes.push("is-today");
    const future = dateStr > todayStr;
    cells.push(`<button type="button" class="${classes.join(" ")}" data-wd-day="${dateStr}"${future ? " disabled" : ""}>${d}</button>`);
  }

  const atCurrentMonth = wd.year > now.getFullYear() || (wd.year === now.getFullYear() && wd.month >= now.getMonth());
  const dowHtml = WD_WEEKDAYS.map((d) => `<span class="wd-dow">${d}</span>`).join("");
  const hoursHtml = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === sel.getHours() ? " selected" : ""}>${String(h).padStart(2, "0")}</option>`).join("");
  const minutesHtml = Array.from({ length: 60 }, (_, m) =>
    `<option value="${m}"${m === sel.getMinutes() ? " selected" : ""}>${String(m).padStart(2, "0")}</option>`).join("");

  return `
    <div class="wd-display">${escapeHtml(formatCustomDisplay(sel))}</div>
    <div class="wd-body">
      <div class="wd-calendar">
        <div class="wd-cal-head">
          <button type="button" class="wd-nav" data-wd-nav="prev" aria-label="Previous month">&#8249;</button>
          <span class="wd-month">${escapeHtml(monthLabel)}</span>
          <button type="button" class="wd-nav" data-wd-nav="next" aria-label="Next month"${atCurrentMonth ? " disabled" : ""}>&#8250;</button>
        </div>
        <div class="wd-grid wd-dow-row">${dowHtml}</div>
        <div class="wd-grid wd-day-grid">${cells.join("")}</div>
      </div>
      <div class="wd-time">
        <span class="wd-time-label">Time</span>
        <div class="wd-time-selects">
          <select class="wd-select" data-wd-hour aria-label="Hour">${hoursHtml}</select>
          <span class="wd-colon">:</span>
          <select class="wd-select" data-wd-minute aria-label="Minute">${minutesHtml}</select>
        </div>
        
      </div>
    </div>
    <button class="button-primary wd-use" type="button" data-watch-date-choice="custom">Use this date &amp; time</button>
  `;
}

function watchDateCustomCardHtml() {
  return `
    <div class="watch-date-custom">
      <div class="watch-date-section-label">Or pick a specific date &amp; time</div>
      <div class="watch-date-picker" data-watch-date-picker>${renderWatchDateCustomPicker()}</div>
    </div>
  `;
}

function rerenderWatchDateCustomPicker() {
  const host = mediaDetailRoot().querySelector("[data-watch-date-picker]");
  if (host) host.innerHTML = renderWatchDateCustomPicker();
}

// Keeps the human-readable display line in sync when the hour/minute selects
// change, without re-rendering (which would drop the open select).
function wireWatchDateCustomPicker(root) {
  const host = root.querySelector("[data-watch-date-picker]");
  if (!host) return;
  host.addEventListener("change", (event) => {
    if (!event.target.matches("[data-wd-hour], [data-wd-minute]")) return;
    syncCustomTimeFromSelects();
    const display = host.querySelector(".wd-display");
    if (display && state.watchDateCustom?.selected) {
      display.textContent = formatCustomDisplay(state.watchDateCustom.selected);
    }
  });
}

function renderWatchDatePrompt(action) {
  if (!action) return "";
  const customValue = new Date().toISOString().slice(0, 10);
  if (action.scope === "movie") return renderMovieWatchDatePrompt(action, customValue);
  const episodeCount = action.episodes.length;
  const them = episodeCount === 1 ? "this episode" : "these episodes";
  const hasAirDate = action.episodes.some((episode) => episode.airDate);
  const lastPlayedLabel = action.lastPlayedAt ? formatDate(action.lastPlayedAt) : "";
  const episodesHtml = action.episodes
    .map((episode) => `
      <li class="watch-date-episode">
        <span class="watch-date-episode-code">${escapeHtml(episodeCode(episode.seasonNumber, episode.episodeNumber))}</span>
        <span class="watch-date-episode-title">${escapeHtml(episode.title || "Untitled episode")}</span>
        <span class="watch-date-episode-air">${episode.airDate ? escapeHtml(formatTmdbDate(episode.airDate)) : "Air date TBA"}</span>
      </li>
    `)
    .join("");

  return `
    <div class="watch-date-overlay" role="dialog" aria-modal="true" aria-label="Choose watched date">
      <div class="watch-date-dialog">
        <div class="watch-date-head">
          <div class="watch-date-head-text">
            <h3>${escapeHtml(action.label)}</h3>
            <p class="watch-date-sub">${escapeHtml(action.showTitle)} &middot; ${escapeHtml(action.countLabel)}</p>
          </div>
          <button class="watch-date-close" type="button" data-watch-date-cancel="true" aria-label="Cancel">&times;</button>
        </div>

        <p class="watch-date-intro">Logs ${escapeHtml(them)} to your watch history and marks ${episodeCount === 1 ? "it" : "them"} played on Plex, Emby, and Jellyfin. Pick which date to record.</p>

        <div class="watch-date-episodes">
          <div class="watch-date-episodes-head">
            <span>${episodeCount === 1 ? "Episode" : "Episodes"}</span>
            <span>${episodeCount}</span>
          </div>
          <ul class="watch-date-episode-list">${episodesHtml}</ul>
        </div>

        <div class="watch-date-section-label">Watched date</div>
        <div class="watch-date-options">
          <button class="watch-date-pick" type="button" data-watch-date-choice="release"${hasAirDate ? "" : " disabled"}>
            <span class="watch-date-pick-title">Day of release</span>
            <span class="watch-date-pick-sub">Use each episode's air date</span>
          </button>
          <button class="watch-date-pick" type="button" data-watch-date-choice="now">
            <span class="watch-date-pick-title">Now</span>
            <span class="watch-date-pick-sub">Today, ${escapeHtml(formatTmdbDate(customValue))}</span>
          </button>
          ${lastPlayedLabel ? `
          <button class="watch-date-pick" type="button" data-watch-date-choice="last_played">
            <span class="watch-date-pick-title">Last played</span>
            <span class="watch-date-pick-sub">${escapeHtml(lastPlayedLabel)}</span>
          </button>
          ` : ""}
        </div>

        ${watchDateCustomCardHtml()}
      </div>
    </div>
  `;
}

function showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle = "", tmdbData = null) {
  const watchedInSeason = seasonEpisodes.filter((episode) => episode.watched).length;
  const seasonTotal = Math.max(seasonEpisodes.length, Number(season.episode_count || 0));
  const today = toDateInputValue(new Date());
  let nextAiring = seasonEpisodes
    .filter((episode) => !episode.watched && episode.airDate && episode.airDate >= today)
    .sort((a, b) => a.airDate.localeCompare(b.airDate) || Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0))[0] || null;
  const tmdbNextEpisode = tmdbData?.next_episode_to_air;
  if (
    !nextAiring &&
    tmdbNextEpisode?.air_date &&
    tmdbNextEpisode.air_date >= today &&
    Number(tmdbNextEpisode.season_number) === Number(seasonNumber)
  ) {
    nextAiring = {
      airDate: tmdbNextEpisode.air_date,
      airTime: tmdbNextEpisode.air_time || tmdbNextEpisode.airTime || tmdbNextEpisode.airtime || "",
      episodeNumber: tmdbNextEpisode.episode_number,
    };
  }
  const nextAiringText = nextAiring
    ? `Next Airing ${formatLongAiringDate(nextAiring.airDate)} (${formatEpisodeAirtime(nextAiring, showTitle)})`
    : "";
  return { watchedInSeason, seasonTotal, nextAiring, nextAiringText };
}

function renderShowModalContent(show, {
  activeSeasonNum,
  tmdbData = null,
  seasonDetailsByNumber = new Map(),
  loading = false,
  tmdbOnly = false,
  imdbPillHtml = "",
} = {}) {
  const root = mediaDetailRoot();
  const isSaving = state.savingWatchAction;
  const isSavingShow = isSaving && isSaving.scope === "show";
  show = mergeShowWithLoadedHistory(show);
  const seasonsMap = seasonsFromShowRecord(show);
  const showTitle = sanitizeTitle(show.title) || "Unknown Show";
  const hasTmdbKey = Boolean(state.savedConfig.tmdb?.configured);
  const seasonsList = [...(tmdbData?.seasons?.length ? tmdbData.seasons : fallbackSeasonList(seasonsMap))]
    .filter((season) => Number(season.season_number) > 0)
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));
  const selectedSeason = activeSeasonNum == null ? null : Number(activeSeasonNum);
  const episodeRows = buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, tmdbData?.id || show.tmdb_id || "", tmdbData);
  const watchedRows = episodeRows.filter((episode) => episode.watched);
  const metadataEpisodeCount = seasonsList.reduce((total, season) => total + Number(season.episode_count || 0), 0);
  const totalCount = Math.max(episodeRows.length, metadataEpisodeCount, watchedRows.length, 1);
  const watchedCount = watchedRows.length || [...watchedEpisodesByKey(show).keys()].length;
  const progressPercent = Math.max(0, Math.min(100, Math.round((watchedCount / totalCount) * 100)));
  const representative = representativeEpisode(seasonsMap);
  const backdropUrl = tmdbData?.cached_backdrop_url || tmdbImage(tmdbData?.backdrop_path, "original");
  // Prefer a locally cached/custom poster so a poster chosen via "Edit Images"
  // wins over the TMDB default and stays consistent with the dashboard.
  const posterUrl = posterUrlFor(representative) || tmdbData?.cached_poster_url || tmdbPoster(tmdbData?.poster_path, tmdbData?.id, "tv");
  const logoUrl = show.logo_url || bestTmdbLogo(tmdbData);
  const overview = tmdbData?.overview || "No synopsis available.";
  const premiered = tmdbData?.first_air_date ? `Premiered ${formatTmdbDate(tmdbData.first_air_date)}` : "Release date unknown";
  const rating = tmdbData?.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "";
  const ratingPillsHtml = renderExternalRatingPills("tv", tmdbData, showTitle, rating);
  const uniqueSources = [...new Set((show.episodes || []).map((episode) => episode.source || "unknown"))].filter((source) => source !== "unknown");
  const tvSeerrTmdbId = tmdbData?.id || show.tmdb_id || "";
  const tvSeerrCacheKey = `tv:${tvSeerrTmdbId}`;
  const hasTvSeerrStatus = Boolean(tvSeerrTmdbId && state.seerrMediaStatusCache.has(tvSeerrCacheKey));
  const tvSeerrStatus = state.seerrMediaStatusCache.get(tvSeerrCacheKey) || {};
  const showIsNowPlaying = state.activeSessions.some((s) => {
    if (tvSeerrTmdbId && String(s.ids?.tmdb || "") === String(tvSeerrTmdbId)) return true;
    const sessionShowTitle = showTitleFrom(s.showTitle || s.show_title || s.title || "");
    return Boolean(sessionShowTitle && slug(sessionShowTitle) === slug(showTitle));
  });

  state.showModalEpisodes = episodeRows;
  state.showModalEpisodeIndex = new Map(episodeRows.map((episode) => [episode.key, episode]));
  state.activeShowRenderContext = { show, activeSeasonNum, tmdbData, seasonDetailsByNumber, loading };

  const selectedSeasonRecord = selectedSeason == null
    ? null
    : seasonsList.find((season) => Number(season.season_number) === selectedSeason) || { season_number: selectedSeason };
  const selectedSeasonNumber = selectedSeasonRecord ? Number(selectedSeasonRecord.season_number) : null;
  const selectedSeasonEpisodes = selectedSeasonNumber == null
    ? []
    : episodeRows.filter((episode) => episode.seasonNumber === selectedSeasonNumber);
  const isUnreleased = (episode) => {
    if (episode.watched) return false;
    if (!episode.airDate) return false;
    const parts = episode.airDate.split("-");
    if (parts.length !== 3) return false;
    const air = new Date(parts[0], parts[1] - 1, parts[2]);
    return !Number.isNaN(air.getTime()) && air > new Date();
  };
  const selectedSeasonUnwatched = selectedSeasonEpisodes.filter((episode) => !episode.watched && !isUnreleased(episode));
  const unwatchedRows = episodeRows.filter((episode) => !episode.watched && !isUnreleased(episode));
  const selectedSeasonSummary = selectedSeasonRecord
    ? showSeasonSummary(selectedSeasonNumber, selectedSeasonEpisodes, selectedSeasonRecord, showTitle, tmdbData)
    : { watchedInSeason: 0, seasonTotal: 0 };
  const selectedSeasonSeerrControls = selectedSeasonRecord ? renderSeasonSeerrControls(tvSeerrTmdbId, selectedSeasonNumber, tvSeerrStatus) : "";
  const selectedSeasonEpisodesHtml = selectedSeasonRecord ? `
    <section class="show-season-block" id="showSeason${selectedSeasonNumber}">
      <div class="show-season-head">
        <span class="show-season-label">${selectedSeasonSummary.watchedInSeason} of ${selectedSeasonSummary.seasonTotal || "?"} episodes watched</span>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          ${selectedSeasonSeerrControls}
          ${selectedSeasonSummary.watchedInSeason ? `<button class="action-pill" type="button" data-edit-season-date="${selectedSeasonNumber}" ${isSaving ? "disabled" : ""}>Edit season date</button>` : ""}
          <button class="action-pill" type="button" data-watch-scope="season" data-season-number="${selectedSeasonNumber}" ${(selectedSeasonUnwatched.length && !isSaving) ? "" : "disabled"}>
            ${isSaving && isSaving.scope === "season" && Number(isSaving.episodes[0]?.seasonNumber) === Number(selectedSeasonNumber) ? "Saving…" : "Mark season watched"}
          </button>
        </div>
      </div>
      <div class="show-episode-list">
        ${selectedSeasonEpisodes.length ? selectedSeasonEpisodes.map((episode) => {
    const isHighlighted = (Number(episode.seasonNumber) === Number(selectedSeasonNumber)) && (Number(episode.episodeNumber) === Number(state.activeShowModalEpisode));
    const syncStatusDotHtml = episode.watched ? renderSyncStatusDot(episode.watched) : "";
    const episodeIsUnreleased = isUnreleased(episode);
    return `
            <article class="immersive-episode-row ${episode.watched ? "is-watched" : ""} ${episodeIsUnreleased ? "is-unreleased" : ""} ${isHighlighted ? "is-highlighted" : ""}" ${isHighlighted ? 'id="highlightedEpisode"' : ""} data-immersive-episode-num="${episode.episodeNumber}" data-immersive-season-num="${episode.seasonNumber}">
              ${episodeThumbMarkup(episode)}
              <div class="immersive-episode-copy">
                <div class="immersive-episode-title-row">
                  <b style="display: inline-flex; align-items: center; gap: 0.35rem;">
                    ${escapeHtml(episodeCode(episode.seasonNumber, episode.episodeNumber))} ${escapeHtml(episode.title)}
                    ${syncStatusDotHtml}
                  </b>
                </div>
                <div class="immersive-episode-copy-wrap"><p>${escapeHtml(episode.overview)}</p></div>
                <div class="immersive-episode-meta-row">
                  <span class="immersive-episode-dates">
                    <time datetime="${escapeAttribute(episode.airDate || "")}">${escapeHtml(episodeReleaseLabel(episode.airDate))}</time>
                    ${episode.watched ? `<time>Watched ${formatDate(episode.watched.watched_at)} <button class="edit-date-icon-btn episode-edit-date-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(episode.watched.id)}" data-watched-at="${escapeAttribute(episode.watched.watched_at || "")}">✎</button></time>` : ""}
                  </span>
                  <span class="immersive-episode-actions">
                    ${episodeIsUnreleased
        ? `<span class="unreleased-pill">Not yet released</span>`
        : !episode.watched
          ? `<button class="action-pill" type="button" data-watch-scope="episode" data-episode-key="${escapeAttribute(episode.key)}" ${isSaving ? "disabled" : ""}>
                            ${isSaving && isSaving.scope === "episode" && isSaving.episodes[0]?.key === episode.key ? "Saving…" : "Mark watched"}
                           </button>`
          : `<button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(episode.watched.id)}" data-unwatch-kind="episode" data-unwatch-label="${escapeAttribute(`${episodeCode(episode.seasonNumber, episode.episodeNumber)} ${episode.title}`)}" data-show-title="${escapeAttribute(episode.showTitle || showTitle)}">Mark unwatched</button>`}
                  </span>
                </div>
              </div>
            </article>
          `;
  }).join("") : `<div class="empty-log"><b>No episode rows yet</b><span>${loading ? "Episode metadata is loading." : "No local or TMDB episodes were found for this season."}</span></div>`}
      </div>
    </section>
  ` : "";

  const seasonsAccordionHtml = seasonsList.map((season) => {
    const seasonNumber = Number(season.season_number);
    const seasonEpisodes = episodeRows.filter((episode) => episode.seasonNumber === seasonNumber);
    const { watchedInSeason, seasonTotal, nextAiringText } = showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle, tmdbData);
    const isActive = seasonNumber === selectedSeasonNumber;
    const panelId = `seasonAccordionPanel${seasonNumber}`;
    const seasonMetaText = `${seasonTotal || "?"} episode${seasonTotal === 1 ? "" : "s"}${watchedInSeason ? ` - ${watchedInSeason} watched` : ""}${nextAiringText ? ` - ${nextAiringText}` : ""}`;
    const seasonAvailabilityHtml = tvSeasonAvailabilityHtml(tvSeerrStatus, seasonNumber);
    return `
      <article class="season-accordion ${isActive ? "is-open" : ""}">
        <button class="season-accordion-trigger" type="button" data-season-accordion="${seasonNumber}" aria-expanded="${isActive}" aria-controls="${panelId}">
          <span class="season-accordion-title">
            <strong>${escapeHtml(season.name || seasonLabel(seasonNumber))}</strong>
            <span class="season-episode-count">${escapeHtml(seasonMetaText)}</span>
          </span>
          <span class="season-accordion-meta">
            ${seasonAvailabilityHtml}
            <svg class="season-accordion-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
        ${isActive ? `<div class="season-accordion-panel" id="${panelId}">${selectedSeasonEpisodesHtml}</div>` : ""}
      </article>
    `;
  }).join("");

  const seasonsSectionHtml = seasonsList.length ? `
    <section class="seasons-section season-accordions">
      <div class="show-section-title">
        <h3>Seasons</h3>
        <span>${seasonsList.length} season${seasonsList.length === 1 ? "" : "s"}</span>
      </div>
      <div class="season-accordion-list">${seasonsAccordionHtml}</div>
    </section>
  ` : "";

  const showImdbId = show.imdb_id || representativeEpisode(seasonsMap)?.imdb_id || tmdbData?.external_ids?.imdb_id || "";
  const showImdbBasePill = showImdbId && !imdbPillHtml ? ratingPillHtml({ label: "IMDb", value: "View", href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`, title: "Open on IMDb" }) : "";

  setMediaDetailActions(`
    <details class="media-actions-menu">
      <summary class="action-pill media-actions-menu-trigger">Show actions</summary>
      <div class="media-actions-menu-panel">
        <button class="action-pill" type="button" data-watch-scope="show" ${(unwatchedRows.length && !isSaving) ? "" : "disabled"}>
          ${isSavingShow ? "Saving watched state…" : "Mark whole show watched"}
        </button>
        ${watchedRows.length ? `<button class="action-pill media-edit-show-date-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">Edit Show Watch Date</button>` : ""}
        ${tmdbOnly ? "" : `
          <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-poster-url="${escapeAttribute(show.poster_url || "")}" data-logo-url="${escapeAttribute(show.logo_url || "")}">Edit Images</button>
          <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-title="${escapeAttribute(showTitle)}" data-media-type="tv">Fix Match</button>
          <button class="action-pill media-merge-show-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">Merge</button>
        `}
      </div>
    </details>
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || "")}');"></div>
    <div class="immersive-container media-detail-page">

      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || "/favicon.svg")}" alt="${escapeAttribute(showTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(showTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(showTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(showTitle)}</h2>`}
          <div class="media-detail-bottom-stack">
            <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              ${ratingPillsHtml}
              ${imdbPillHtml || showImdbBasePill}
              ${showModalStatus(loading, hasTmdbKey, Boolean(tmdbData))}
              ${renderSeerrRequestPill("tv", tvSeerrTmdbId, showIsNowPlaying)}
            </div>

            <p class="immersive-overview">${escapeHtml(overview)}</p>

            <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
              <h3>Progress</h3>
              <div class="progress-label-row">
                <span>${watchedCount} of ${totalCount} episodes watched</span>
                <span>${progressPercent}% complete</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
              </div>
            </section>
          </div>

         </div>
        ${renderMediaFacts(tmdbData, "tv", "sidebar")}
      </header>

      ${seasonsSectionHtml}

      ${renderCastSection(tmdbData)}

      ${renderTrailersReviewsSection(tmdbData)}
      ${renderMediaImagesSection(tmdbData)}
      ${renderRelatedShowsSection(tmdbData)}
    </div>
    ${renderWatchDatePrompt(state.pendingWatchAction)}
  `;
  if (tvSeerrTmdbId && !hasTvSeerrStatus) {
    fetchSeerrMediaStatus("tv", tvSeerrTmdbId)
      .then((status) => {
        if (!status || state.activeShowModalKey !== slug(show.title)) return;
        const current = state.activeShowRenderContext;
        if (current?.tmdbData && !current.loading) {
          renderShowModalContent(current.show, {
            activeSeasonNum: current.activeSeasonNum,
            tmdbData: current.tmdbData,
            seasonDetailsByNumber: current.seasonDetailsByNumber,
            loading: current.loading,
          });
          return;
        }
        refreshActiveMediaDetailAfterSeerrStatus("tv", tvSeerrTmdbId);
      });
  }
  hydratePosters(root);
  // Highlight only — no scrolling when navigating from dashboard
}

async function hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken) {
  const show = mergeShowWithLoadedHistory(state.showsRaw.find((s) => slug(s.title) === showKey));
  if (!show) return;

  const tmdbData = await fetchTmdbDetails("tv", show.tmdb_id, show.title, tmdbLookupIdsFromShow(show));
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;

  if (tmdbData && tmdbData.id) {
    state.activeShowTmdbId = String(tmdbData.id);
  }

  const seasonsList = (tmdbData?.seasons?.length ? tmdbData.seasons : fallbackSeasonList(seasonsFromShowRecord(show))).filter((season) => Number(season.season_number) > 0);

  const showImdbId = show.imdb_id || tmdbData?.external_ids?.imdb_id || "";
  let imdbPillHtml = "";
  if (showImdbId && state.savedConfig?.omdb?.configured) {
    const omdbRes = await fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(showImdbId)}`, { headers: authHeaders() }).catch(() => null);
    if (omdbRes?.ok) {
      const omdbData = await omdbRes.json().catch(() => null);
      if (omdbData?.imdbRating) {
        imdbPillHtml = ratingPillHtml({
          label: "IMDb",
          value: `${Math.round(parseFloat(omdbData.imdbRating) * 10)}%`,
          href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`,
          title: `IMDb rating: ${omdbData.imdbRating}/10`,
        });
      }
    }
    if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
  }

  renderShowModalContent(show, { activeSeasonNum, tmdbData, seasonDetailsByNumber: new Map(), loading: true, imdbPillHtml });

  const seasonDetailsByNumber = new Map();
  if (tmdbData?.id && activeSeasonNum != null) {
    const seasonDetails = await fetchTmdbSeasonDetails(tmdbData.id, activeSeasonNum);
    if (seasonDetails) seasonDetailsByNumber.set(Number(activeSeasonNum), seasonDetails);
  }
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;

  renderShowModalContent(show, {
    activeSeasonNum,
    tmdbData,
    seasonDetailsByNumber,
    loading: false,
    imdbPillHtml,
  });
}

async function renderImmersiveShowModal(showKey, activeSeasonNum = null, activeEpisodeNum = null) {
  _mediaRenderToken += 1; // invalidate any in-flight movie render
  syncInlineMediaDetailHeading("shows");
  state.activeShowModalKey = showKey;
  state.pendingWatchAction = null;
  state.activeShowModalEpisode = activeEpisodeNum;
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();

  let show = state.showsRaw.find((s) => slug(s.title) === showKey);
  if (!show) {
    root.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container media-detail-page">
        <div class="empty-log">
          <b>Loading show details...</b>
          <span>Loading TV series history.</span>
        </div>
      </div>
    `;
    try {
      const response = await fetch(`/api/show?id=${encodeURIComponent(showKey)}`, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.show) {
        show = body.show;
        state.showsRaw.push(show);
      }
    } catch (error) {
      console.error("Failed to load show detail on direct link", error);
    }
  }

  if (!show) {
    // Not in local library. If the now-playing session has a TMDB ID, delegate to
    // the TMDB-based loader (which has its own title fallback). Otherwise try a
    // TMDB title search using the slug as a title hint.
    const matchingSession = state.activeSessions.find((s) => {
      const t = showTitleFrom(s.showTitle || s.show_title || s.title || "");
      return slug(t) === showKey;
    });
    if (matchingSession?.ids?.tmdb) {
      await openShowImmersiveModalByTmdbId(matchingSession.ids.tmdb);
      return;
    }
    const sessionTitle = matchingSession
      ? showTitleFrom(matchingSession.showTitle || matchingSession.show_title || matchingSession.title || "")
      : "";
    const titleGuess = sessionTitle || showKey.replace(/-/g, " ");
    if (titleGuess) {
      state.activeShowTmdbId = null;
      const tmdbData = await fetchTmdbDetails("tv", null, titleGuess);
      if (tmdbData) {
        await openShowImmersiveModalByTmdbId(tmdbData.id);
        return;
      }
    }
    root.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container media-detail-page">
        <div class="empty-log">
          <b style="color: var(--danger);">TV Show Not Found</b>
          <span>Could not locate the series "${escapeHtml(showKey)}" in your archive.</span>
        </div>
      </div>
    `;
    return;
  }

  if (!Array.isArray(show.episodes) || !show.episodes.length) {
    root.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container media-detail-page">
        <div class="empty-log">
          <b>Loading episodes...</b>
          <span>Loading episode history.</span>
        </div>
      </div>
    `;
    hydratePosters(root);
    const detailedShow = await loadShowDetail(show).catch((error) => {
      console.error("Failed to load show detail", error);
      setMessage(`Failed to load show details: ${error.message}`, "error");
      return null;
    });
    if (detailedShow) show = detailedShow;
    if (!Array.isArray(show.episodes) || !show.episodes.length) {
      root.innerHTML = `
        <div class="modal-backdrop-image"></div>
        <div class="immersive-container media-detail-page">
          <div class="empty-log">
            <b>No episode rows found</b>
            <span>No local episode history was available.</span>
          </div>
        </div>
      `;
      return;
    }
  }

  state.activeShowModalSeason = activeSeasonNum;
  const requestToken = ++state.showModalRequestToken;

  renderShowModalContent(show, {
    activeSeasonNum,
    tmdbData: null,
    seasonDetailsByNumber: new Map(),
    loading: Boolean(state.savedConfig.tmdb?.configured),
  });
  hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken).catch((error) => {
    console.error("Failed to hydrate show modal", error);
    if (requestToken === state.showModalRequestToken && state.activeShowModalKey === showKey) {
      renderShowModalContent(show, { activeSeasonNum, tmdbData: null, seasonDetailsByNumber: new Map(), loading: false });
    }
  });
  hydratePosters(root);
}

function watchActionFromButton(button) {
  const scope = button?.dataset.watchScope;
  if (!scope) return null;

  let episodes = [];
  if (scope === "episode") {
    const episode = state.showModalEpisodeIndex.get(button.dataset.episodeKey);
    if (episode && !episode.watched) episodes = [episode];
  } else if (scope === "season") {
    const seasonNumber = Number(button.dataset.seasonNumber);
    episodes = state.showModalEpisodes.filter((episode) => episode.seasonNumber === seasonNumber && !episode.watched);
  } else if (scope === "show") {
    episodes = state.showModalEpisodes.filter((episode) => !episode.watched);
  }

  if (!episodes.length) return null;

  const showTitle = episodes[0]?.showTitle || "Show";
  const label = scope === "episode"
    ? `Mark ${episodeCode(episodes[0].seasonNumber, episodes[0].episodeNumber)} watched`
    : scope === "season"
      ? `Mark ${showTitle} ${seasonLabel(episodes[0].seasonNumber)} watched`
      : `Mark ${showTitle} watched`;

  return {
    scope,
    showTitle,
    showTmdbId: episodes[0]?.showTmdbId || "",
    episodes,
    label,
    countLabel: `${episodes.length} episode${episodes.length === 1 ? "" : "s"}`,
  };
}

function openWatchDatePrompt(action) {
  if (!action) {
    setMessage("There are no unwatched episodes in that selection.");
    return;
  }
  state.pendingWatchAction = action;
  initWatchDateCustomState();
  const root = mediaDetailRoot();
  root.querySelector(".watch-date-overlay")?.remove();
  root.insertAdjacentHTML("beforeend", renderWatchDatePrompt(action));
  wireWatchDateCustomPicker(root);
}

function closeWatchDatePrompt() {
  state.pendingWatchAction = null;
  mediaDetailRoot().querySelector(".watch-date-overlay")?.remove();
}

function dateAtMiddayIso(dateString) {
  if (!dateString) return new Date().toISOString();
  const date = new Date(`${dateString}T12:00:00`);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

// Converts the custom picker value to an ISO timestamp. Accepts a
// "YYYY-MM-DDTHH:MM" datetime-local value (interpreted as local time) or a
// bare "YYYY-MM-DD" date (defaulted to midday for backwards compatibility).
function customWatchedAtIso(value) {
  if (!value) return new Date().toISOString();
  if (value.includes("T")) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  return dateAtMiddayIso(value);
}

function watchedAtForChoice(choice, episode, customDate) {
  if (choice === "release") return dateAtMiddayIso(episode.airDate);
  if (choice === "last_played") {
    const value = Number(episode.lastPlayedAt || 0);
    if (Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  }
  if (choice === "custom") return customWatchedAtIso(customDate);
  return new Date().toISOString();
}

function watchRecordFromEpisode(episode, watchedAt) {
  return {
    media_type: "episode",
    title: `${episode.showTitle} - ${episodeCode(episode.seasonNumber, episode.episodeNumber)} - ${episode.title}`,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: episode.showTmdbId || null,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
    poster_url: episode.posterUrl || episode.stillUrl || null,
  };
}

function watchRecordFromMovie(movie, watchedAt) {
  return {
    media_type: "movie",
    title: movie.title,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: movie.tmdbId || null,
    poster_url: movie.posterUrl || null,
  };
}

async function submitSeerrRequest(mediaType, mediaId, button) {
  if (!mediaId || !mediaType) {
    setMessage("Cannot send Seerr request — missing media info.", "error");
    return;
  }
  const is4k = button?.getAttribute("data-seerr-request-4k") === "true";
  const seasonNumber = Number(button?.getAttribute("data-seerr-season") || 0);
  // data-seerr-seasons (plural) carries a JSON array of season numbers for whole-show
  // requests from the top-level pill, where no single season is targeted.
  const seasonsJson = button?.getAttribute("data-seerr-seasons");
  const seasonsArray = seasonsJson ? JSON.parse(seasonsJson).filter((s) => Number.isInteger(s) && s > 0) : [];
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Requesting…";
  }
  try {
    const tvSeasons = mediaType === "tv"
      ? seasonNumber > 0
        ? [seasonNumber]
        : seasonsArray.length > 0 ? seasonsArray : undefined
      : undefined;
    const res = await fetch("/api/seerr/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        mediaType,
        mediaId,
        is4k,
        ...(tvSeasons ? { seasons: tvSeasons } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      setMessage(`✔ ${is4k ? "4K request" : "Request"} submitted to Seerr!`, "success");
      if (button) button.textContent = "✔ Requested";
      state.seerrMediaStatusCache.delete(`${mediaType}:${mediaId}`);
      fetchSeerrMediaStatus(mediaType, mediaId)
        .then((status) => {
          if (!status) return;
          if (mediaType === "tv" && state.activeShowModalKey) {
            renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode);
            return;
          }
          refreshActiveMediaDetailAfterSeerrStatus(mediaType, mediaId);
        });
    } else {
      const errMsg = data.error || `Seerr returned ${res.status}`;
      setMessage(`Seerr error: ${errMsg}`, "error");
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  } catch (err) {
    setMessage(`Seerr request failed: ${err.message}`, "error");
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function markMovieWatched(movie) {
  if (!movie?.title) {
    setMessage("Cannot mark this movie watched — missing details.", "error");
    return;
  }
  openWatchDatePrompt({
    scope: "movie",
    movie,
    label: `Mark ${movie.title} watched`,
    showTitle: movie.title,
    countLabel: "1 movie",
  });
}

async function applyMovieWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  const movie = action?.movie;
  if (!movie) return;

  const root = mediaDetailRoot();
  const customDate = getCustomWatchDateValue();
  const watchedAt = watchedAtForChoice(choice, { airDate: movie.releaseDate }, customDate);
  const record = watchRecordFromMovie(movie, watchedAt);

  root.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]").forEach((button) => {
    button.disabled = true;
  });

  state.savingWatchAction = action;
  closeWatchDatePrompt();

  // Optimistically disable the mark-watched button in place (no full re-render needed).
  // A full re-render happens after the POST completes below.
  const markWatchedBtn = root.querySelector("[data-movie-mark-watched]");
  if (markWatchedBtn) {
    markWatchedBtn.disabled = true;
    markWatchedBtn.textContent = "Saving watched state…";
  }

  setMessage(`Saving "${movie.title}" to your watch history…`, "muted");

  try {
    const result = await postManualWatchRecords([record]);
    state.savingWatchAction = null;
    clearDerivedUiCaches({ resetExplorer: false });
    const syncText = result.syncQueued
      ? `sync queued for ${result.syncQueued} item${result.syncQueued === 1 ? "" : "s"}`
      : `pushed ${result.propagated} to media apps`;
    setMessage(
      `Marked "${movie.title}" watched${result.skipped ? " (already logged)" : ""}; ${syncText}.`,
      result.rejected ? "error" : "success",
    );
    await loadHistory({ force: true }).catch(() => null);
    if (movie.tmdbId) await openMovieImmersiveModalByTmdbId(movie.tmdbId);
  } catch (error) {
    state.savingWatchAction = null;
    if (movie.tmdbId) await openMovieImmersiveModalByTmdbId(movie.tmdbId).catch(() => null);
    setMessage(`Manual watch update failed: ${error.message}`, "error");
    throw error;
  }
}

function localWatchRowFromEpisode(episode, watchedAt) {
  return {
    id: `local-${episode.key}-${Date.now()}`,
    media_type: "episode",
    title: `${episode.showTitle} - ${episodeCode(episode.seasonNumber, episode.episodeNumber)} - ${episode.title}`,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: episode.showTmdbId || null,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
    poster_url: episode.posterUrl || episode.stillUrl || null,
    show_title: episode.showTitle,
  };
}

function cloneShowRecord(show) {
  return show ? JSON.parse(JSON.stringify(show)) : null;
}

function applyOptimisticWatchedEpisodes(action, watchedRows) {
  const showKey = slug(action.showTitle);
  let index = state.showsRaw.findIndex((show) => slug(show.title) === showKey);
  const created = index < 0;
  if (created) {
    state.showsRaw.push({
      title: action.showTitle,
      tmdb_id: action.showTmdbId || null,
      episodes: [],
      episode_count: 0,
      season_count: 0,
    });
    index = state.showsRaw.length - 1;
  }

  const previousShow = cloneShowRecord(state.showsRaw[index]);
  const show = cloneShowRecord(state.showsRaw[index]);
  const watchedByKey = new Map(watchedRows.map((row) => [showEpisodeKey(row.season, row.episode), row]));
  const existing = (show.episodes || []).filter((row) => !watchedByKey.has(showEpisodeKey(row.season, row.episode)));
  show.episodes = [...existing, ...watchedRows].sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0));
  show.episode_count = show.episodes.length;
  show.season_count = new Set(show.episodes.map((episode) => Number(episode.season || 0)).filter(Boolean)).size;
  show.latest_watched_at = show.episodes.reduce((latest, episode) => episode.watched_at > latest ? episode.watched_at : latest, show.latest_watched_at || "");
  show.earliest_watched_at = show.episodes.reduce((earliest, episode) => !earliest || episode.watched_at < earliest ? episode.watched_at : earliest, show.earliest_watched_at || "");
  state.showsRaw[index] = show;

  for (const modalEpisode of state.showModalEpisodes) {
    const watched = watchedByKey.get(showEpisodeKey(modalEpisode.seasonNumber, modalEpisode.episodeNumber));
    if (watched) modalEpisode.watched = watched;
  }
  state.showModalEpisodeIndex = new Map(state.showModalEpisodes.map((episode) => [episode.key, episode]));
  return { showKey, previousShow, created };
}

function rollbackOptimisticWatchedEpisodes(rollback) {
  if (!rollback?.showKey) return;
  const index = state.showsRaw.findIndex((show) => slug(show.title) === rollback.showKey);
  if (rollback?.created) {
    if (index >= 0) state.showsRaw.splice(index, 1);
    return;
  }
  if (index >= 0 && rollback?.previousShow) state.showsRaw[index] = rollback.previousShow;
}

async function postManualWatchRecords(records, onProgress) {
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  let propagated = 0;
  let syncQueued = 0;

  for (let index = 0; index < records.length; index += MANUAL_WATCH_BATCH_SIZE) {
    const batch = records.slice(index, index + MANUAL_WATCH_BATCH_SIZE);
    const response = await fetch("/api/manual-watch", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Manual watch update failed with ${response.status}`);
    inserted += Number(body.inserted || 0);
    skipped += Number(body.skipped || 0);
    rejected += Array.isArray(body.rejected) ? body.rejected.length : Number(body.rejected || 0);
    propagated += Number(body.propagated || 0);
    syncQueued += Number(body.syncQueued || 0);
    onProgress?.(Math.min(index + batch.length, records.length), records.length);
  }

  return { inserted, skipped, rejected, propagated, syncQueued };
}

async function refreshShowAfterManualWatch(showTitle) {
  const url = new URL("/api/show", window.location.origin);
  url.searchParams.set("title", showTitle);
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.show) return;
  mergeShowDetail(body.show);
}

async function applyPartWatchedWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  if (!action) return;

  const root = mediaDetailRoot();
  const customDate = getCustomWatchDateValue();

  const episode = action.episodes?.[0] || {};
  const airDate = action.scope === "movie" ? action.movie?.releaseDate : episode.airDate;
  const watchedAt = watchedAtForChoice(choice, { airDate, lastPlayedAt: action.lastPlayedAt }, customDate);
  const ids = action.scope === "movie"
    ? {
        tmdb_id: action.movie?.tmdbId || null,
        imdb_id: action.movie?.imdbId || null,
        tvdb_id: action.movie?.tvdbId || null,
      }
    : {
        tmdb_id: episode.showTmdbId || null,
        imdb_id: episode.imdbId || null,
        tvdb_id: episode.tvdbId || null,
      };

  root.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]").forEach((button) => {
    button.disabled = true;
  });

  closeWatchDatePrompt();
  setMessage(`Marking "${action.title}" as watched…`, "muted");

  try {
    const res = await fetch("/api/playback-progress/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ media_key: action.mediaKey, watched_at: watchedAt, ...ids }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setMessage(`"${action.title}" marked as watched`, "success");
    resetPartWatchedView("default");
    renderPartWatched();
  } catch (error) {
    showErrorExplainModal(`Failed to mark "${action.title}" as watched`, error.message);
  }
}

async function applyWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  if (action?.origin === "part-watched") return applyPartWatchedWatchDateChoice(choice);
  if (action?.scope === "movie") return applyMovieWatchDateChoice(choice);
  if (!action?.episodes?.length) return;

  const root = mediaDetailRoot();
  const customDate = getCustomWatchDateValue();
  const watchedRows = action.episodes.map((episode) => localWatchRowFromEpisode(episode, watchedAtForChoice(choice, episode, customDate)));
  const records = action.episodes.map((episode, index) => watchRecordFromEpisode(episode, watchedRows[index].watched_at));
  const buttons = [...root.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]")];
  buttons.forEach((button) => {
    button.disabled = true;
  });

  state.savingWatchAction = action;
  closeWatchDatePrompt();
  const rollback = applyOptimisticWatchedEpisodes(action, watchedRows);
  if (state.activeShowModalKey) {
    renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
  } else if (state.activeShowTmdbId) {
    await openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
  }

  const total = records.length;
  setMessage(total > 1 ? `Saving ${total} episodes to your watch history… 0/${total}` : "Saving to your watch history…", "muted");

  try {
    const result = await postManualWatchRecords(records, (done, all) => {
      if (all > 1) setMessage(`Saving ${all} episodes to your watch history… ${done}/${all}`, "muted");
    });
    state.savingWatchAction = null;
    clearDerivedUiCaches({ resetExplorer: false });
    const totalMarked = result.inserted + result.skipped;
    const syncText = result.syncQueued
      ? `sync queued for ${result.syncQueued} item${result.syncQueued === 1 ? "" : "s"}`
      : `pushed ${result.propagated} to media apps`;
    setMessage(
      `Marked ${totalMarked} episode${totalMarked === 1 ? "" : "s"} watched; ${syncText}${result.skipped ? `, ${result.skipped} already logged` : ""}.`,
      result.rejected ? "error" : "success",
    );
    await refreshShowAfterManualWatch(action.showTitle).catch((error) => setMessage(error.message, "error"));
    if (state.activeShowModalKey) {
      renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    }
  } catch (error) {
    state.savingWatchAction = null;
    rollbackOptimisticWatchedEpisodes(rollback);
    if (state.activeShowModalKey) {
      renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    }
    setMessage(`Manual watch update failed: ${error.message}`, "error");
    throw error;
  }
}

async function confirmAndMarkUnwatched(button) {
  const id = button.dataset.unwatchId;
  if (!id) return;
  const kind = button.dataset.unwatchKind || "item";
  const label = button.dataset.unwatchLabel || "this item";
  const showTitle = button.dataset.showTitle || "";

  const confirmed = await openConfirmDialog({
    title: "Mark unwatched",
    body: `Remove "${label}" from your watch history and mark it unplayed on Plex, Emby, and Jellyfin?`,
    confirmLabel: "Mark unwatched",
    danger: true,
  });
  if (!confirmed) return;

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Removing…";

  try {
    const response = await fetch("/api/manual-unwatch", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Mark unwatched failed (${response.status})`);

    clearDerivedUiCaches({ resetExplorer: kind === "movie" });
    setMessage(`Marked "${label}" unwatched; pushed unplayed to media apps.`, "success");

    if (kind === "episode" && (state.activeShowModalKey || state.activeShowTmdbId)) {
      if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
      await loadHistory().catch(() => null);
      if (state.activeShowModalKey) {
        renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else {
        await openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      }
    } else {
      // Movie (or no show context): the watched record is gone, so refresh history
      // and drop back out of the now-empty detail view.
      await loadHistory().catch(() => null);
      closeMediaDetail();
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    setMessage(`Mark unwatched failed: ${error.message}`, "error");
  }
}

// Permanently delete a library item. Because this wipes the watch record and all
// of its play history with no way to recover it, we require three explicit
// confirmations, each more emphatic than the last, before calling the API.
async function confirmAndDeleteMedia(button) {
  const id = button.dataset.deleteMediaId;
  if (!id) return;
  const label = button.dataset.deleteMediaTitle || "this item";

  const first = await openConfirmDialog({
    title: "Delete from library?",
    body: `This permanently deletes "${label}" and its entire watch history from Plembfin. This does NOT affect Plex, Emby or Jellyfin — it only removes the local record.`,
    confirmLabel: "Continue",
    cancelLabel: "Keep it",
    danger: true,
  });
  if (!first) return;

  const second = await openConfirmDialog({
    title: "This cannot be undone",
    body: `There is no recoverable history. Every play date, sync record and progress entry for "${label}" will be erased and cannot be restored. Are you absolutely sure?`,
    confirmLabel: "Yes, I understand",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (!second) return;

  const third = await openConfirmDialog({
    title: "Final confirmation",
    body: `Last chance — permanently delete "${label}" now?`,
    confirmLabel: "Delete permanently",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (!third) return;

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Deleting…";

  try {
    const response = await fetch("/api/delete-media", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id, confirm: "DELETE" }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Delete failed (${response.status})`);

    clearDerivedUiCaches({ resetExplorer: true });
    setMessage(`Deleted "${label}" and its history (${result.deleted || 0} record${result.deleted === 1 ? "" : "s"}).`, "success");
    await loadHistory().catch(() => null);
    closeMediaDetail();
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    setMessage(`Delete failed: ${error.message}`, "error");
  }
}

async function triggerRetrySync(id, button) {
  if (!id || !button) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Syncing...";

  const titleEl = document.getElementById("terminalModalTitle");
  if (titleEl) {
    titleEl.textContent = "Retry Sync Terminal";
  }

  elements.terminalModal?.classList.remove("hidden");
  if (elements.retryTerminalOutput) {
    elements.retryTerminalOutput.innerHTML = "";
  }

  function termLog(text, tone = "info") {
    if (!elements.retryTerminalOutput) return;
    const span = document.createElement("span");
    if (tone === "error") {
      span.style.color = "#fb7185";
      span.style.fontWeight = "bold";
    } else if (tone === "success") {
      span.style.color = "#34d399";
      span.style.fontWeight = "bold";
    } else if (tone === "warn") {
      span.style.color = "#f59e0b";
    } else if (tone === "header") {
      span.style.color = "#38bdf8";
      span.style.fontWeight = "bold";
    } else {
      span.style.color = "#e8edf2";
    }
    span.textContent = text + "\n";
    elements.retryTerminalOutput.appendChild(span);
    elements.retryTerminalOutput.scrollTop = elements.retryTerminalOutput.scrollHeight;
  }

  termLog("plembfin@server:~$ ./retry-sync --id=" + id, "header");
  termLog("Initializing sync connection...", "info");
  termLog("POST /api/retry-sync HTTP/1.1", "info");

  try {
    const response = await fetch("/api/retry-sync", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      termLog("[ERROR] Sync request failed with status: " + response.status, "error");
      if (body.error) {
        termLog("Reason: " + body.error, "error");
      }
      throw new Error(body.error || `Retry failed with status ${response.status}`);
    }

    termLog("Response received: HTTP 200 OK", "success");
    termLog("Fetching updated watch record from database...", "info");

    const refreshRes = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
    const refreshBody = await refreshRes.json().catch(() => ({}));
    if (refreshRes.ok && refreshBody.row) {
      const updatedRow = refreshBody.row;
      if (Array.isArray(state.history)) {
        const idx = state.history.findIndex((x) => x.id === id);
        if (idx !== -1) state.history[idx] = updatedRow;
      }
      if (Array.isArray(state.moviesRaw)) {
        const idx = state.moviesRaw.findIndex((x) => x.id === id);
        if (idx !== -1) state.moviesRaw[idx] = updatedRow;
      }
      if (Array.isArray(state.showsRaw)) {
        for (const show of state.showsRaw) {
          if (Array.isArray(show.episodes)) {
            const idx = show.episodes.findIndex((x) => x.id === id);
            if (idx !== -1) show.episodes[idx] = updatedRow;
          }
        }
      }

      termLog("\n--- Sync Telemetry Dispatch Output ---", "header");
      const telemetry = String(updatedRow.sync_dispatch_telemetry || updatedRow.syncDispatchTelemetry || "");
      if (telemetry) {
        for (const line of telemetry.split(/\r?\n/)) {
          if (line.toLowerCase().includes("status: success") || line.toLowerCase().includes("resolved status to success")) {
            termLog(line, "success");
          } else if (line.toLowerCase().includes("status: error") || line.toLowerCase().includes("status: failed") || line.toLowerCase().includes("error") || line.toLowerCase().includes("fail")) {
            termLog(line, "error");
          } else if (line.toLowerCase().includes("status: pending") || line.toLowerCase().includes("pending")) {
            termLog(line, "warn");
          } else {
            termLog(line, "info");
          }
        }
      } else {
        termLog("No dispatch telemetry recorded.", "warn");
      }

      const targetStatuses = getMediaTargetSyncStatus(updatedRow);
      const errors = targetStatuses.filter(t => t.status === "error" || t.status === "failed");
      const pendings = targetStatuses.filter(t => t.status === "pending");

      if (errors.length > 0) {
        termLog("\n⚠️ Sync failure detected for one or more targets!", "error");
        for (const err of errors) {
          termLog(`\n[DIAGNOSTICS & FIX FOR ${err.target.toUpperCase()}]:`, "warn");
          const telLine = telemetry.split("\n").find(l => l.toLowerCase().includes(err.target) && l.toLowerCase().includes("error"));
          termLog(`Details: ${telLine || "Connection failed"}`, "info");

          const errLower = (telLine || "").toLowerCase();
          if (errLower.includes("unauthorized") || errLower.includes("401") || errLower.includes("token") || errLower.includes("auth")) {
            termLog("👉 FIX: Go to the settings tab for this app (Settings -> Apps) and verify that the API Key or Token is correct, valid, and not expired.", "success");
          } else if (errLower.includes("refused") || errLower.includes("timeout") || errLower.includes("conn") || errLower.includes("reach") || errLower.includes("address")) {
            termLog("👉 FIX: Verify that the Server URL is correct, the target server is currently online, and there are no network rules or firewalls blocking the connection from the machine running Plembfin.", "success");
          } else if (errLower.includes("not found") || errLower.includes("404") || errLower.includes("match")) {
            termLog("👉 FIX: The media item was not found on the target platform. Ensure the TMDB/IMDB/TVDB IDs are correct and that the media is properly scanned/matched in your Plex/Emby/Jellyfin library.", "success");
          } else {
            termLog("👉 FIX: Check the Settings -> Apps configuration for this platform. Try testing the connection to verify credentials and endpoint URLs.", "success");
          }
        }
      } else if (pendings.length > 0) {
        termLog("\n⚠️ One or more sync dispatches are still pending or queued.", "warn");
        termLog("👉 SUGGESTION: The target sync is in progress or propagation is queued. Wait a few moments and retry.", "info");
      } else {
        termLog("\n✨ Sync completed successfully! All configured targets are fully up to date.", "success");
      }

      clearDerivedUiCaches({ resetExplorer: false });
      renderDashboard();
      renderStats();
      await Promise.all([
        loadSyncJobs({ force: true }),
        loadSyncHistory({ force: true }),
      ]).catch(() => null);

      if (state.activeView === "explorer") {
        renderExplorer();
      }

      if (state.activeShowModalKey) {
        renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode);
      }

      setMessage("Retry sync completed.", "success");
    } else {
      throw new Error("Could not fetch the updated sync state from server.");
    }
  } catch (error) {
    termLog(`\n[FATAL ERROR] Retry sync process aborted: ${error.message}`, "error");
    button.disabled = false;
    button.textContent = originalText;
    setMessage(`Retry sync failed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function openMovieImmersiveModal(id) {
  await openImmersiveModal(id);
}

async function openMovieInlineDetail(id) {
  prepareInlineMediaDetail("movies");
  const movie = await resolveMovieBySlugOrId(id);
  if (movie) {
    await renderMovieImmersiveModalContent(movie);
    return;
  }
  await openImmersiveModal(id);
}

async function openRecommendedMovieInlineDetail(tmdbId) {
  prepareInlineMediaDetail("movies");
  await openMovieImmersiveModalByTmdbId(tmdbId);
}

async function openShowInlineDetail(showKey, activeSeasonNum = null, activeEpisodeNum = null) {
  prepareInlineMediaDetail("shows");
  await renderImmersiveShowModal(showKey, activeSeasonNum, activeEpisodeNum);
}

// Monotonic token guarding async media-detail renders. Each render captures the
// current value; if navigation (a new render, or clearMediaDetailState) bumps it
// while a slow TMDB fetch is in flight, the stale render aborts before writing the
// DOM. Without this, an abandoned detail page would "appear" after you'd already
// navigated back and opened something else.
let _mediaRenderToken = 0;

async function renderMovieImmersiveModalContent(movie) {
  const renderToken = ++_mediaRenderToken;
  state.showModalRequestToken += 1; // invalidate any in-flight show hydrate
  state.activeMovieModalId = movie.id;
  state.activeMovieTmdbId = movie.tmdb_id ? String(movie.tmdb_id) : null;
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();

  const isSaving = state.savingWatchAction;

  const localPoster = posterUrlFor(movie) || "/favicon.svg";
  setMediaDetailActions(`
    <details class="media-actions-menu">
      <summary class="action-pill media-actions-menu-trigger">Movie actions</summary>
      <div class="media-actions-menu-panel">
        <button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">Mark unwatched</button>
        <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}">Edit Images</button>
        <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">Fix Match</button>
      </div>
    </details>
  `);
  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(localPoster)}');"></div>
    <div class="immersive-container media-detail-page is-loading-metadata">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(localPoster)}" alt="${escapeAttribute(movie.title || "Movie")} poster" data-err="fav" />
        <div class="immersive-meta">
          <span class="media-kicker">Movie · Loading metadata</span>
          <h2 class="immersive-title">${escapeHtml(movie.title || "Unknown movie")}</h2>
          <p class="immersive-overview">Your library record is ready. Synopsis, cast, providers and related media are loading.</p>
        </div>
      </header>
    </div>
  `;

  const tmdbData = await fetchTmdbDetails("movie", movie.tmdb_id, movie.title);
  if (_mediaRenderToken !== renderToken) return; // navigated away while loading

  if (tmdbData && tmdbData.id) {
    state.activeMovieTmdbId = String(tmdbData.id);
  }

  // For YouTube-only content, fetch metadata from our backend
  let youtubeMeta = null;
  if (!tmdbData && movie.youtube_url) {
    try {
      const ytRes = await fetch(`/api/youtube-meta?url=${encodeURIComponent(movie.youtube_url)}`, { headers: authHeaders() });
      const ytData = await ytRes.json();
      if (!ytData.error) youtubeMeta = ytData;
    } catch { /* non-fatal */ }
    if (_mediaRenderToken !== renderToken) return; // navigated away while loading
  }

  const movieTitle = movie.title;
  let backdropUrl = "";
  let posterUrl = posterUrlFor(movie);
  let overview = "No synopsis available.";
  let released = "Unknown Release Date";
  let rating = "N/A";
  let recommendations = [];

  if (tmdbData) {
    if (tmdbData.backdrop_path) {
      backdropUrl = tmdbData.cached_backdrop_url || `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`;
    }
    // Keep a locally cached/custom poster (from "Edit Images") over the TMDB
    // default so the detail page matches what the dashboard shows.
    if (tmdbData.poster_path && !posterUrl) {
      posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie");
    }
    overview = tmdbData.overview || overview;
    released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : released;
    rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : rating;

    recommendations = tmdbData.recommendations?.results || [];
  } else if (youtubeMeta) {
    if (youtubeMeta.thumbnails?.[0]) posterUrl = youtubeMeta.thumbnails[0];
    overview = youtubeMeta.description || overview;
    if (youtubeMeta.publishedAt) released = `Published ${formatTmdbDate(youtubeMeta.publishedAt.slice(0, 10))}`;
  }

  const logoUrl = movie.logo_url || bestTmdbLogo(tmdbData);

  const ratingBadgeHtml = rating !== "N/A" ? `
    ${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}
  ` : "";

  const imdbId = movie.imdb_id || tmdbData?.imdb_id || "";
  let imdbRating = null;
  if (imdbId && state.savedConfig?.omdb?.configured) {
    const omdbRes = await fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(imdbId)}`, { headers: authHeaders() }).catch(() => null);
    if (omdbRes?.ok) {
      const omdbData = await omdbRes.json().catch(() => null);
      if (omdbData?.imdbRating) imdbRating = omdbData.imdbRating;
    }
    if (_mediaRenderToken !== renderToken) return;
  }
  const imdbPillHtml = imdbId ? ratingPillHtml({
    label: "IMDb",
    value: imdbRating ? `${Math.round(parseFloat(imdbRating) * 10)}%` : "View",
    href: `https://www.imdb.com/title/${escapeAttribute(imdbId)}`,
    title: imdbRating ? `IMDb rating: ${imdbRating}/10` : "Open on IMDb",
  }) : "";

  const sourceBadgeHtml = movie.source ? `
    <span class="source-badge ${sourceClass(movie.source)}" style="display: inline-flex;">${escapeHtml(platformBadge(movie.source))}</span>
  ` : "";

  const syncStatusDotHtml = renderSyncStatusDot(movie);
  const visibleSyncStatuses = getMediaTargetSyncStatus(movie).filter((s) => !s.hidden);
  const allSynced = !visibleSyncStatuses.length || visibleSyncStatuses.every((s) => s.status === "success" || s.status === "skipped");
  const syncStatusBlockHtml = syncStatusDotHtml ? `
            <div style="display: flex; gap: 0.5rem; align-items: center; margin-left: auto;">
              <span style="font-size: 0.72rem; color: var(--muted); font-weight: 800; text-transform: uppercase;">Sync Status:</span>
              ${syncStatusDotHtml}
              ${!allSynced ? `<button class="retry-sync-btn action-pill" type="button" ${isSaving ? "disabled" : ""} data-retry-sync-id="${escapeAttribute(movie.id)}" style="font-size: 0.7rem; padding: 0.15rem 0.45rem;">Retry Sync</button>` : ""}
            </div>
  ` : "";

  const ytWatchBtn = movie.youtube_url
    ? `<a class="action-pill" href="${escapeAttribute(movie.youtube_url)}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>`
    : "";
  setMediaDetailActions(`
    <details class="media-actions-menu">
      <summary class="action-pill media-actions-menu-trigger">Movie actions</summary>
      <div class="media-actions-menu-panel">
        <button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">Mark unwatched</button>
        <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}">Edit Images</button>
        <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">Fix Match</button>
        <button class="action-pill action-pill-danger" type="button" ${isSaving ? "disabled" : ""} data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">Delete</button>
      </div>
    </details>
    ${ytWatchBtn}
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${backdropUrl || posterUrl}');"></div>
    <div class="immersive-container media-detail-page">

      <header class="immersive-header">
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>`}
          <p class="immersive-subtitle">${released}${youtubeMeta?.channelName ? ` &middot; ${escapeHtml(youtubeMeta.channelName)}` : ""}</p>

          <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}
            ${imdbPillHtml}
            ${renderSeerrRequestPill("movie", tmdbData?.id || movie.tmdb_id, true)}
            ${syncStatusBlockHtml}
          </div>
          <p class="immersive-overview">${escapeHtml(overview)}</p>

          <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
            <h3>Watch Status</h3>
            <div class="progress-label-row">
              <span>Watched on ${formatDate(movie.watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-watched-at="${escapeAttribute(movie.watched_at || "")}">✎</button></span>
              <span>100% complete</span>
            </div>
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width: 100%;"></div>
            </div>
          </section>

        </div>
        ${renderMediaFacts(tmdbData, "movie", "sidebar")}
      </header>

      ${renderCastSection(tmdbData)}

      ${renderRichTmdbDetails(tmdbData)}

      ${renderMediaImagesSection(tmdbData)}

      ${recommendations.length > 0 ? `
        <section class="seasons-section">
          <h3>Recommended movies</h3>
          <div class="horizontal-scroll-row">
            ${recommendations
        .slice(0, 15)
        .map((rec) => {
          const recPoster = rec.poster_path
            ? tmdbPoster(rec.poster_path)
            : "/favicon.svg";
          return `
                  <a class="season-poster-card" data-immersive-movie-id="${rec.id}" href="/movie/tmdb/${rec.id}">
                    <img class="season-poster-img" src="${recPoster}" alt="${escapeHtml(rec.title)}" data-err="fav" />
                    <span class="season-poster-name">${escapeHtml(rec.title)}</span>
                  </a>
                `;
        })
        .join("")}
          </div>
        </section>
      ` : ""}
    </div>
  `;
  const movieSeerrTmdbId = tmdbData?.id || movie.tmdb_id;
  if (movieSeerrTmdbId) {
    fetchSeerrMediaStatus("movie", movieSeerrTmdbId)
      .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", movieSeerrTmdbId); });
  }
  hydratePosters(root);
}

// Authoritatively check whether a movie is already in watch history. state.history
// is only the dashboard preview, so fall back to the server (which holds the full
// history) to avoid showing a saved movie as unwatched after a refresh.
async function fetchWatchedMovieByTmdb(tmdbId, title) {
  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("search", title || "");
    url.searchParams.set("limit", "30");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    const movies = Array.isArray(body.movies) ? body.movies : [];
    return movies.find((movie) => String(movie.tmdb_id || "") === String(tmdbId)) || null;
  } catch {
    return null;
  }
}

async function openMovieImmersiveModalByTmdbId(tmdbId) {
  state.activeMovieTmdbId = String(tmdbId);
  // Fast path: if it's in the loaded preview, show its watched detail immediately.
  const existingWatched = state.history.find(
    (entry) => entry.media_type === "movie" && isWatchedHistoryAction(entry) && String(entry.tmdb_id || "") === String(tmdbId),
  );
  if (existingWatched) return renderMovieImmersiveModalContent(existingWatched);

  setMediaDetailActions("");

  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();
  root.innerHTML = `
    <div class="immersive-container">
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading movie details...</span>
      </div>
    </div>
  `;

  const tmdbData = await fetchTmdbDetails("movie", tmdbId, null);
  if (!tmdbData) {
    root.innerHTML = `
      <div class="immersive-container">
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Could not load movie details</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Please check your TMDB API Key in Settings.</span>
        </div>
      </div>
    `;
    return;
  }

  const movieTitle = tmdbData.title;
  // state.history is only the dashboard preview; confirm against the server so a
  // movie marked watched (especially with an old release date) still shows watched.
  const persistedWatched = await fetchWatchedMovieByTmdb(tmdbId, movieTitle);
  if (persistedWatched) return renderMovieImmersiveModalContent(persistedWatched);

  const isSaving = state.savingWatchAction;
  const isSavingThisMovie = isSaving && isSaving.scope === "movie" && String(isSaving.movie?.tmdbId || "") === String(tmdbId);

  let backdropUrl = tmdbData.cached_backdrop_url || (tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}` : "");
  let posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie") || "/favicon.svg";
  let overview = tmdbData.overview || "No synopsis available.";
  let released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : "Unknown Release Date";
  let rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "N/A";
  let recommendations = [];

  recommendations = tmdbData.recommendations?.results || [];

  const logoUrl = bestTmdbLogo(tmdbData);

  const ratingBadgeHtml = rating !== "N/A" ? `
    ${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}
  ` : "";

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${backdropUrl || posterUrl}');"></div>
    <div class="immersive-container media-detail-page">

      <header class="immersive-header">
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>`}
          <p class="immersive-subtitle">${released}</p>
          
          <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}
            ${renderSeerrRequestPill("movie", tmdbId, false)}
          </div>

          <p class="immersive-overview">${escapeHtml(overview)}</p>

          <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
            <h3>Watch Status</h3>
            <div class="progress-label-row">
              <span>Unwatched (local archive)</span>
              <span>0% complete</span>
            </div>
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width: 0%;"></div>
            </div>
            <div class="immersive-actions" style="margin-top: 0.75rem;">
              <button class="action-pill" type="button" ${isSaving ? "disabled" : ""}
                data-movie-mark-watched="${escapeAttribute(String(tmdbId))}"
                data-movie-title="${escapeAttribute(movieTitle)}"
                data-movie-poster="${escapeAttribute(posterUrl)}"
                data-movie-release="${escapeAttribute(tmdbData.release_date || "")}">${isSavingThisMovie ? "Saving watched state…" : "Mark watched"}</button>
            </div>
          </section>
        </div>
      </header>

      ${renderMediaFacts(tmdbData, "movie")}

      ${renderCastSection(tmdbData)}

      ${renderRichTmdbDetails(tmdbData)}

      ${recommendations.length > 0 ? `
        <section class="seasons-section">
          <h3>Recommended movies</h3>
          <div class="horizontal-scroll-row">
            ${recommendations
        .slice(0, 15)
        .map((rec) => {
          const recPoster = rec.poster_path
            ? tmdbPoster(rec.poster_path)
            : "/favicon.svg";
          return `
                  <a class="season-poster-card" data-immersive-movie-id="${rec.id}" href="/movie/tmdb/${rec.id}">
                    <img class="season-poster-img" src="${recPoster}" alt="${escapeHtml(rec.title)}" data-err="fav" />
                    <span class="season-poster-name">${escapeHtml(rec.title)}</span>
                  </a>
                `;
        })
        .join("")}
          </div>
        </section>
      ` : ""}
    </div>
  `;
  fetchSeerrMediaStatus("movie", tmdbId)
    .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", tmdbId); });
  hydratePosters(root);
}

function openDebugModal(entry) {
  if (!entry) return;
  const status = syncStatus(entry);
  elements.debugModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  document.querySelector("#debugModalTitle").textContent = entry.title || "History row";
  elements.modalBody.innerHTML = `
    <section class="diagnostic-grid">
      <div><span>Title</span><b>${escapeHtml(entry.title || "Unknown")}</b></div>
      <div><span>Media type</span><b>${escapeHtml(entry.media_type || "unknown")}</b></div>
      <div><span>IMDb</span><b>${escapeHtml(entry.imdb_id || "None")}</b></div>
      <div><span>TMDB</span><b>${escapeHtml(entry.tmdb_id || "None")}</b></div>
      <div><span>TVDB</span><b>${escapeHtml(entry.tvdb_id || "None")}</b></div>
      <div><span>Source</span><b>${escapeHtml(platformName(entry.source))}</b></div>
      <div><span>Action</span><b>${escapeHtml(historyAction(entry))}</b></div>
      <div><span>Sync state</span><b>${escapeHtml(status.label)}</b></div>
      <div><span>Season</span><b>${escapeHtml(entry.season ?? "None")}</b></div>
      <div><span>Episode</span><b>${escapeHtml(entry.episode ?? "None")}</b></div>
      <div><span>Watched at (oldest)</span><b>${escapeHtml(formatDate(entry.watched_at))}</b></div>
      ${entry.playHistory && entry.playHistory.length > 1 ? `<div><span>Play history</span><b>${entry.playHistory.map(d => escapeHtml(formatDate(d))).join("<br>")}</b></div>` : ""}
    </section>
    <section class="telemetry-block">
      <p>Sync dispatch telemetry</p>
      <pre>${escapeHtml(entry.sync_dispatch_telemetry || "No sync telemetry recorded for this row.")}</pre>
    </section>
  `;
}

function closeDebugModal() {
  elements.debugModal.classList.add("hidden");
  document.body.style.overflow = "";
  const modalPanel = elements.debugModal.querySelector(".modal-panel");
  if (modalPanel) {
    modalPanel.classList.remove("modal-panel--immersive");
  }
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  const eyebrowEl = elements.debugModal.querySelector(".eyebrow");
  if (eyebrowEl) {
    eyebrowEl.textContent = "Sync diagnostic audit";
  }
}

function mediaDetailRoot() {
  if (state.mediaDetailInline) return elements.explorerPanel;
  // The watch-date prompt is opened from the dashboard Part Watched row while the
  // diagnostic modal is closed (and #modalBody therefore display:none, which would
  // suppress the fixed overlay). Anchor to <body> so the overlay always renders.
  if (state.activeView === "dashboard") return document.body;
  return elements.modalBody;
}

function prepareInlineMediaDetail(mode = state.explorerMode || "movies") {
  setMediaDetailActions("");
  if (!state.mediaDetailInline) {
    state.mediaDetailReturnView = state.activeView || "explorer";
    state.mediaDetailReturnExplorerMode = state.explorerMode || "movies";
  }
  state.mediaDetailInline = true;
  state.explorerMode = mode;
  selectView("explorer");
  syncInlineMediaDetailHeading(mode);
  elements.explorerPanel.innerHTML = "";
  elements.explorerPanel.scrollIntoView({ block: "start" });
  document.querySelector("#explorerBackButton")?.classList.remove("hidden");
  elements.explorerTopbarControls?.classList.add("hidden");
  syncPageTopbar();
}

function setMediaDetailActions(html) {
  const el = document.getElementById("mediaDetailActions");
  if (el) el.innerHTML = html || "";
  normalizeMediaDetailActions(el);
  syncMediaActionsMenuState();
  syncPageTopbar();
}

function normalizeMediaDetailActions(el) {
  if (!el || !el.childNodes.length) return;

  let menu = el.querySelector(":scope > .media-actions-menu");
  if (!menu) {
    const actionHtml = el.innerHTML;
    el.innerHTML = `
      <details class="media-actions-menu">
        <summary class="action-pill media-actions-menu-trigger">Actions</summary>
        <div class="media-actions-menu-panel">${actionHtml}</div>
      </details>
    `;
    return;
  }

  const panel = menu.querySelector(".media-actions-menu-panel");
  if (!panel) return;

  for (const node of [...el.childNodes]) {
    if (node === menu) continue;
    if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
      node.remove();
      continue;
    }
    panel.appendChild(node);
  }
}

function syncMediaActionsMenuState() {
  const isMobileActions = window.matchMedia("(max-width: 640px)").matches;
  for (const menu of document.querySelectorAll("#mediaDetailActions .media-actions-menu")) {
    if (isMobileActions) {
      menu.removeAttribute("open");
    } else {
      menu.setAttribute("open", "");
    }
  }
}

function syncTopbarControlsMenuState() {
  const menu = elements.topbarControlsMenu;
  if (!menu || menu.classList.contains("hidden")) {
    menu?.removeAttribute("open");
    return;
  }
  const isMobileControls = window.matchMedia("(max-width: 640px)").matches;
  if (isMobileControls) {
    menu.removeAttribute("open");
  } else {
    menu.removeAttribute("open");
  }
}

function clearMediaDetailState() {
  _mediaRenderToken += 1; // invalidate any in-flight detail render (movie/show)
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  state.activeMovieTmdbId = null;
  setMediaDetailActions("");
}

function closeMediaDetail() {
  if (window.location.pathname.startsWith("/person/")) {
    const returnUrl = state.personReturnUrl;
    state.personReturnUrl = null;
    navigateTo(returnUrl || "/");
    return;
  }
  if (!state.mediaDetailInline) {
    closeDebugModal();
    return;
  }
  state.mediaDetailInline = false;
  clearMediaDetailState();
  document.querySelector("#explorerBackButton")?.classList.add("hidden");
  elements.explorerTopbarControls?.classList.remove("hidden");
  syncPageTopbar();
  state.explorerMode = state.mediaDetailReturnExplorerMode || state.explorerMode || "movies";
  if (state.mediaDetailReturnView && state.mediaDetailReturnView !== "explorer") {
    selectView(state.mediaDetailReturnView);
    return;
  }
  renderExplorer();
}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

async function unlockWithToken(password, email = elements.adminEmail?.value) {
  const cleanEmail = String(email || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanEmail || !cleanPassword) {
    setMessage("Enter your admin username and password.", "error");
    return;
  }

  const result = await signInAdmin(cleanEmail, cleanPassword);
  state.currentUser = result.user;
  state.token = result.token;
  if (elements.settingsUsername) elements.settingsUsername.value = cleanEmail;
  localStorage.setItem("adminUsername", cleanEmail);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_UPPER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  setUnlocked(true);
  selectView(state.activeView);
  await loadHistory().catch((error) => {
    renderDbStatus(false);
    setMessage(`${error.message} Signed in, but dashboard APIs are not responding yet.`, "error");
  });
  await loadSavedConfig().catch((error) => {
    renderSettingsStatus(error.message, "error");
    setMessage(error.message, "error");
  });
  const fullPath = window.location.pathname + window.location.search + window.location.hash;
  if (isConfigSensitiveRoute(fullPath)) {
    handleRouting(fullPath);
    applyActiveView();
  }
  startHistoryPolling();
  setMessage("Dashboard unlocked.", "success");
}

async function lockDashboard() {
  stopHistoryPolling();
  state.token = "";
  state.currentUser = undefined;
  state.history = [];
  state.historyVersion = "";
  state.activeSessions = [];
  state.syncJobs = [];
  state.syncJobsLoaded = false;
  state.syncHistory = [];
  state.syncHistoryLoaded = false;
  state.importRecords = [];
  state.importFileNames = [];
  state.importLogs = ["[idle] Waiting for files."];
  state.importProgressValue = 0;
  state.nowPlayingRefreshToken = "";
  state.nowPlayingSessionKey = "";
  state.nowPlayingLastFetchAt = 0;
  state.configLoaded = false;
  state.savedConfig = {};
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_UPPER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  await signOutAdmin().catch(() => { });
  elements.adminToken.value = "";
  if (elements.settingsUsername) elements.settingsUsername.value = "";
  populateConfigForm({});
  renderDashboard();
  renderActiveSessions();
  renderSyncHistory();
  renderStats();
  renderImportPreview();
  renderDbStatus(false);
  renderSettingsStatus("Configuration cleared from the unlocked session.");
  refreshHelpIfVisible();
  setUnlocked(false);
  setMessage("Dashboard locked.");
}


async function runSystemIntegrityCheck() {
  const button = elements.runCompleteCheckButton;
  const container = elements.completeCheckResults;

  if (!button || !container) return;

  button.disabled = true;
  button.textContent = "Running diagnostics...";
  container.classList.remove("hidden");
  container.innerHTML = `<div class="idle-state"><b>Running integrity checks...</b></div>`;

  const results = [];

  // 1. Check history API (SQLite)
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

  // 2. Check server configuration
  try {
    await loadSavedConfig();
    results.push({ name: "Server Configuration", status: "success", detail: "Read server-side media configuration successfully." });
  } catch (error) {
    results.push({ name: "Server Configuration", status: "error", detail: `Failed to read config: ${error.message}` });
  }

  // 3. Webhook Listener Availability & Events
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

  // 4. Check Cron Job Execution
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

  // 5. Check Outbound Sync Status (Telemetry Scan)
  let historyToCheck = state.history || [];
  if (!historyToCheck.length) {
    try {
      const response = await fetch("/api/history?limit=5", { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(body.history)) {
        historyToCheck = body.history;
      }
    } catch (e) {
      // Ignore
    }
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
        if (tel.includes("status: error") || tel.includes("failed") || tel.includes("propagation failed")) {
          errorCount++;
        }
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

  // Fetch values from inputs
  const plexUrl = elements.plexServerUrl.value.trim();
  const plexToken = elements.plexToken.value.trim();
  const embyUrl = elements.embyServerUrl.value.trim();
  const embyApiKey = elements.embyApiKey.value.trim();
  const jellyfinUrl = elements.jellyfinServerUrl.value.trim();
  const jellyfinApiKey = elements.jellyfinApiKey.value.trim();

  // 6. Check Plex
  if (plexUrl && plexToken) {
    try {
      const startTime = Date.now();
      const payload = { type: "plex", url: plexUrl, token: plexToken };
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name: "Plex Media Server", status: "success", detail: `${body.detail || "Server identity verified"} in ${body.elapsedMs || elapsed}ms.` });
      } else {
        results.push({ name: "Plex Media Server", status: "error", detail: body.error || `Connection failed (HTTP ${response.status}).` });
      }
    } catch (error) {
      results.push({ name: "Plex Media Server", status: "error", detail: `Check failed: ${error.message}` });
    }
  } else {
    results.push({ name: "Plex Media Server", status: "skipped", detail: "Skipped - URL or token not provided." });
  }

  // 6b. Plex Realtime Notifications (event-driven unwatch detection)
  if (plexUrl && plexToken) {
    try {
      const startTime = Date.now();
      const response = await fetch("/api/test-plex-notifications", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ url: plexUrl, token: plexToken }),
      });
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

  // 7. Check Emby
  if (embyUrl && embyApiKey) {
    try {
      const startTime = Date.now();
      const payload = { type: "emby", url: embyUrl, token: embyApiKey };
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name: "Emby Media Server", status: "success", detail: `${body.detail || "Server identity verified"} in ${body.elapsedMs || elapsed}ms.` });
      } else {
        results.push({ name: "Emby Media Server", status: "error", detail: body.error || `Connection failed (HTTP ${response.status}).` });
      }
    } catch (error) {
      results.push({ name: "Emby Media Server", status: "error", detail: `Check failed: ${error.message}` });
    }
  } else {
    results.push({ name: "Emby Media Server", status: "skipped", detail: "Skipped - URL or API key not provided." });
  }

  // 8. Check Jellyfin
  if (jellyfinUrl && jellyfinApiKey) {
    try {
      const startTime = Date.now();
      const payload = { type: "jellyfin", url: jellyfinUrl, token: jellyfinApiKey };
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name: "Jellyfin Media Server", status: "success", detail: `${body.detail || "Server identity verified"} in ${body.elapsedMs || elapsed}ms.` });
      } else {
        results.push({ name: "Jellyfin Media Server", status: "error", detail: body.error || `Connection failed (HTTP ${response.status}).` });
      }
    } catch (error) {
      results.push({ name: "Jellyfin Media Server", status: "error", detail: `Check failed: ${error.message}` });
    }
  } else {
    results.push({ name: "Jellyfin Media Server", status: "skipped", detail: "Skipped - URL or API key not provided." });
  }

  // Render results
  container.innerHTML = results.map(res => {
    let statusLabel = "Skipped";
    let pillStyle = "border-color: var(--line); background: var(--panel-3); color: var(--muted);";
    let fixInstruction = "";
    let settingsLink = "";

    if (res.status === "success") {
      statusLabel = "Online";
      pillStyle = "border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.12); color: var(--green);";
    } else if (res.status === "error") {
      statusLabel = "Failed";
      pillStyle = "border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); color: var(--red);";
    } else if (res.status === "skipped") {
      statusLabel = "Not Configured";
      pillStyle = "border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.12); color: var(--yellow);";
    } else if (res.status === "warning") {
      statusLabel = "Warnings Detected";
      pillStyle = "border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12); color: var(--yellow);";
    }

    if (res.status !== "success") {
      if (res.name === "Scheduled Cron Job") {
        fixInstruction = "Fix: The background sync worker runs in-process every minute. If it hasn't fired, confirm the server is running and check the server logs for errors. You can also trigger it manually via /api/cron-sync.";
        settingsLink = "sync";
      } else if (res.name === "Watch History API") {
        fixInstruction = "Fix: The SQLite database may be locked or the data directory may not be writable. Check the server logs and confirm DATA_DIR is set correctly.";
      } else if (res.name === "Server Configuration") {
        fixInstruction = "Fix: Try saving your configuration again in Settings → Apps. If the error persists, check that data/config.json is writable.";
      } else if (res.name === "Webhook Listener Endpoint") {
        fixInstruction = "Fix: Confirm the server is running and accessible at the expected host and port. Check for firewall or reverse-proxy rules blocking /api/webhook.";
      } else if (res.name === "Outbound Playstate Sync") {
        fixInstruction = "Fix: Open the latest history row debug details, review sync_dispatch_telemetry, then correct the failed platform credentials or provider-ID match.";
      } else if (res.name === "Plex Media Server") {
        fixInstruction = "Fix: Enter the Plex Server URL and Plex Token in Settings → Apps, then confirm the server is reachable from the machine running Plembfin.";
      } else if (res.name === "Plex Realtime Notifications") {
        fixInstruction = "Fix: Ensure any reverse proxy / Cloudflare in front of Plex forwards WebSocket upgrades on /:/websockets/notifications, or set the Plex Server URL to the direct LAN address (e.g. http://192.168.x.x:32400). Unwatch sync still works via the fallback poll until this is fixed.";
        settingsLink = "apps";
      } else if (res.name === "Emby Media Server") {
        fixInstruction = "Fix: Enter the Emby Server URL, API Key, and User ID in Settings → Apps, then confirm the server is reachable from the machine running Plembfin.";
      } else if (res.name === "Jellyfin Media Server") {
        fixInstruction = "Fix: Enter the Jellyfin Server URL, API Key, and User ID in Settings → Apps, then confirm the server is reachable from the machine running Plembfin.";
      }
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


async function triggerClearMissingTelemetry(button) {
  const btn = button || elements.clearMissingTelemetryButton || document.querySelector('[data-action="clearMissingTelemetry"]');
  if (!btn) return;

  showConfirmModal(
    "Clear missing dispatch telemetry records?\n\nThis will mark records with missing telemetry as resolved, removing them from the outstanding jobs list. This is safe — it only affects logging, not actual sync functionality.",
    async () => {
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Clearing...";

      const titleEl = document.getElementById("terminalModalTitle");
      if (titleEl) {
        titleEl.textContent = "Clear Telemetry Terminal";
      }

      elements.terminalModal?.classList.remove("hidden");
      if (elements.retryTerminalOutput) {
        elements.retryTerminalOutput.innerHTML = "";
      }

      function termLog(text, tone = "info") {
        if (!elements.retryTerminalOutput) return;
        const span = document.createElement("span");
        if (tone === "error") {
          span.style.color = "#fb7185";
          span.style.fontWeight = "bold";
        } else if (tone === "success") {
          span.style.color = "#34d399";
          span.style.fontWeight = "bold";
        } else if (tone === "warn") {
          span.style.color = "#f59e0b";
        } else if (tone === "header") {
          span.style.color = "#38bdf8";
          span.style.fontWeight = "bold";
        } else {
          span.style.color = "#e8edf2";
        }
        span.textContent = text + "\n";
        elements.retryTerminalOutput.appendChild(span);
        elements.retryTerminalOutput.scrollTop = elements.retryTerminalOutput.scrollHeight;
      }

      termLog("plembfin@server:~$ ./clear-missing-telemetry", "header");
      termLog("Initiating request to clear missing dispatch telemetry...", "info");
      termLog("POST /api/clear-missing-telemetry HTTP/1.1", "info");

      try {
        const response = await fetch("/api/clear-missing-telemetry", {
          method: "POST",
          headers: authHeaders()
        });

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          termLog("[ERROR] Clear request failed with status: " + response.status, "error");
          if (body.error) {
            termLog("Reason: " + body.error, "error");
          }
          throw new Error(body.error || `Failed with HTTP ${response.status}`);
        }

        termLog("Response received: HTTP 200 OK", "success");
        termLog(`Successfully cleared ${body.cleared || 0} watch history record(s) with missing telemetry.`, "success");
        termLog("\n✨ Done!", "success");

        setMessage(`Cleared ${body.cleared || 0} records`, "success");
        await loadSyncJobs({ force: true });
      } catch (error) {
        termLog(`\n[FATAL ERROR] Clear process aborted: ${error.message}`, "error");
        setMessage(`Error: ${error.message}`, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  );
}

async function triggerRetryAllCategory(categoryName, button) {
  if (!categoryName || !state.syncJobs) return;

  const categories = categorizeIssues(state.syncJobs);
  const jobsInCategory = categories[categoryName] || [];

  if (!jobsInCategory.length) {
    setMessage("No issues to retry in this category", "info");
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = `Retrying ${jobsInCategory.length}...`;

  const categoryLabels = {
    plexMismatch: 'Plex Match',
    targetMismatch: 'Emby/Jellyfin Match',
    otherIssues: 'Unresolved',
    missingTelemetry: 'Missing Telemetry',
  };
  const categoryLabel = categoryLabels[categoryName] || categoryName;

  showConfirmModal(
    `Retry all ${jobsInCategory.length} ${categoryLabel} issues?\n\nThis will sequentially retry each item. The process may take a minute or two.`,
    async () => {
      try {
        setMessage(`Retrying ${jobsInCategory.length} items...`, "info");

        // Retry all items sequentially
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
              if (data.status === "success" || String(data.status || "").includes("success")) {
                successCount++;
              } else {
                failCount++;
              }
            } else {
              failCount++;
            }
          } catch (err) {
            console.error(`Failed to retry ${job.id}:`, err);
            failCount++;
          }

          // Small delay between retries and progress updates
          if (i % 5 === 0 || i === jobsInCategory.length - 1) {
            setMessage(`Retrying... ${i + 1}/${jobsInCategory.length} (${successCount} passed)`, "info");
          }
          await new Promise(r => setTimeout(r, 200));
        }

        // Refresh to see updated results
        await loadSyncJobs({ force: true });
        await loadSyncHistory({ force: true });

        const resultMsg = `Completed ${jobsInCategory.length} retries. ${successCount} passed, ${failCount} had issues.`;
        setMessage(resultMsg, successCount > failCount ? "success" : "warning");
      } catch (error) {
        setMessage(`Error during retry: ${error.message}`, "error");
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  );
}

async function triggerCronSync() {
  const button = elements.runCronSyncButton;
  const terminal = elements.forceSyncTerminal;
  if (!button) return;

  if (terminal) {
    terminal.classList.remove("hidden");
    terminal.textContent = "Cron Sync started...\n";
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Syncing...";

  try {
    const response = await fetch("/api/cron-sync", {
      method: "POST",
      headers: authHeaders()
    });

    if (!response.ok) {
      throw new Error(`Cron sync failed with HTTP ${response.status}`);
    }

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
          try {
            finalResult = JSON.parse(trimmed.substring(8));
          } catch (e) {
            console.error("Failed to parse final result JSON", e);
          }
        } else {
          if (terminal) {
            terminal.textContent += `${trimmed}\n`;
            terminal.scrollTop = terminal.scrollHeight;
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("RESULT: ")) {
        try {
          finalResult = JSON.parse(trimmed.substring(8));
        } catch (e) {
          console.error("Failed to parse final result JSON", e);
        }
      } else {
        if (terminal) {
          terminal.textContent += `${trimmed}\n`;
          terminal.scrollTop = terminal.scrollHeight;
        }
      }
    }

    if (finalResult) {
      const detail = `Cron run complete! Sessions: ${finalResult.sessions ?? 0}, completions: ${finalResult.completions ?? 0}, cached: ${finalResult.cached ?? 0}`;
      showToast(detail);
      if (terminal) {
        terminal.textContent += `\nSUCCESS: ${detail}\n`;
        terminal.scrollTop = terminal.scrollHeight;
      }
    } else {
      throw new Error("No final result returned from server");
    }

    await Promise.all([
      loadSyncJobs({ force: true }),
      loadSyncHistory({ force: true })
    ]);
  } catch (error) {
    showToast(`Error: ${error.message}`);
    if (terminal) {
      terminal.textContent += `\nERROR: ${error.message}\n`;
      terminal.scrollTop = terminal.scrollHeight;
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function showConfirmModal(message, onApprove) {
  if (!elements.confirmModal || !elements.confirmModalMessage) return;

  const titleEl = document.getElementById("confirmModalTitle") || elements.confirmModal.querySelector("h2");
  if (titleEl) {
    titleEl.textContent = "Confirm Sync";
  }
  const cancelBtn = elements.cancelConfirmButton;
  if (cancelBtn) cancelBtn.style.display = "";

  elements.approveConfirmButton.textContent = "Approve";

  elements.confirmModalMessage.textContent = message;
  elements.confirmModal.classList.remove("hidden");

  // Remove existing listeners to avoid multiple triggers
  const newApproveButton = elements.approveConfirmButton.cloneNode(true);
  elements.approveConfirmButton.parentNode.replaceChild(newApproveButton, elements.approveConfirmButton);
  elements.approveConfirmButton = newApproveButton;

  elements.approveConfirmButton.addEventListener("click", () => {
    elements.confirmModal.classList.add("hidden");
    onApprove();
  });
}

function showErrorExplainModal(title, errorMsg) {
  if (!elements.confirmModal || !elements.confirmModalMessage) return;

  const titleEl = document.getElementById("confirmModalTitle") || elements.confirmModal.querySelector("h2");
  if (titleEl) {
    titleEl.textContent = title;
  }

  let resolutionInstructions = "";
  const errLower = String(errorMsg || "").toLowerCase();

  if (errLower.includes("not found") || errLower.includes("404")) {
    resolutionInstructions = "\n\n👉 How to Resolve:\nThis item could not be found on the target media server. Ensure that the media server (Plex, Emby, Jellyfin) is running, that this item exists in its library, and that its metadata (IMDB/TMDB/TVDB IDs) is fully matched and synchronized.";
  } else if (errLower.includes("unauthorized") || errLower.includes("401") || errLower.includes("forbidden") || errLower.includes("key") || errLower.includes("token")) {
    resolutionInstructions = "\n\n👉 How to Resolve:\nAuthentication failed. Please check the Settings tab for the app used and verify that the Server URL, API Key, User ID, or Access Token are correct and valid.";
  } else if (errLower.includes("timeout") || errLower.includes("refused") || errLower.includes("network") || errLower.includes("fetch") || errLower.includes("connect")) {
    resolutionInstructions = "\n\n👉 How to Resolve:\nNetwork connection failed. Verify that your media server is online and reachable from the Plembfin server, and check that no firewall or proxy is blocking outbound API requests.";
  } else {
    resolutionInstructions = "\n\n👉 How to Resolve:\nPlease check the Server Logs under Settings -> Logs for a detailed traceback, and test your media server connection credentials in Settings -> Apps.";
  }

  elements.confirmModalMessage.innerHTML = `<span style="white-space: pre-wrap; display: block; line-height: 1.5; color: var(--text);">${escapeHtml(errorMsg)}${escapeHtml(resolutionInstructions)}</span>`;

  const cancelBtn = elements.cancelConfirmButton;
  if (cancelBtn) cancelBtn.style.display = "none";

  const approveBtn = elements.approveConfirmButton;
  if (approveBtn) {
    approveBtn.textContent = "OK";
    const newApproveBtn = approveBtn.cloneNode(true);
    approveBtn.parentNode.replaceChild(newApproveBtn, approveBtn);
    elements.approveConfirmButton = newApproveBtn;
    newApproveBtn.addEventListener("click", () => {
      elements.confirmModal.classList.add("hidden");
      if (cancelBtn) cancelBtn.style.display = "";
      newApproveBtn.textContent = "Approve";
      if (titleEl) titleEl.textContent = "Confirm Sync";
    });
  }

  elements.confirmModal.classList.remove("hidden");
}

async function triggerStopSync() {
  const button = elements.stopSyncButton;
  if (!button) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Stopping...";

  try {
    const response = await fetch("/api/stop-force-sync", {
      method: "POST",
      headers: authHeaders()
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Stop sync failed with HTTP ${response.status}`);
    }
    showToast("Stop sync request sent.");
  } catch (error) {
    showToast(`Error stopping sync: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function triggerForceSync() {
  const button = elements.forceSyncButton;
  const stopButton = elements.stopSyncButton;
  const terminal = elements.forceSyncTerminal;
  if (!button) return;

  showConfirmModal(
    "Are you sure you want to run Force Sync?\n\nThis will check all configured media servers (Plex, Emby, Jellyfin) and resolve their watched/unwatched states based on the newest timestamp. It may take some time.",
    async () => {
      if (terminal) {
        terminal.classList.remove("hidden");
        terminal.textContent = "Force Sync starting...\n";
      }

      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Syncing...";
      button.classList.add("hidden");
      if (stopButton) stopButton.classList.remove("hidden");

      try {
        // POST to kick off — returns 202 immediately (fire-and-forget)
        const startResponse = await fetch("/api/force-sync", {
          method: "POST",
          headers: authHeaders(),
        });

        if (!startResponse.ok) {
          const body = await startResponse.json().catch(() => ({}));
          throw new Error(body.error || `Force sync failed with HTTP ${startResponse.status}`);
        }

        // Poll GET /api/force-sync every 2s to read buffered log lines
        let seenLines = 0;
        let finalResult = null;
        let pollActive = true;

        while (pollActive) {
          await new Promise((r) => setTimeout(r, 2000));

          let statusBody;
          try {
            const statusRes = await fetch("/api/force-sync", { headers: authHeaders(), cache: "no-store" });
            statusBody = await statusRes.json();
          } catch (err) {
            // transient network error — keep polling
            continue;
          }

          const log = Array.isArray(statusBody.log) ? statusBody.log : [];

          // Append any new lines to the terminal
          for (let i = seenLines; i < log.length; i++) {
            const line = log[i];
            if (line && line.startsWith("RESULT: ")) {
              try { finalResult = JSON.parse(line.substring(8)); } catch (_) { }
            } else if (terminal && line) {
              terminal.textContent += `${line}\n`;
              terminal.scrollTop = terminal.scrollHeight;
            }
          }
          seenLines = log.length;

          // Stop polling when the job is done
          if (!statusBody.active) {
            finalResult = finalResult || statusBody.result;
            pollActive = false;
          }
        }

        if (finalResult && finalResult.success) {
          const stats = finalResult.stats || {};
          const detail = finalResult.aborted
            ? `Force Sync stopped! Found: ${stats.totalWatchedFoundAcrossServers ?? 0}, added: ${stats.addedToHistory ?? 0}, deleted: ${stats.deletedFromHistory ?? 0}, propagated: ${stats.propagatedUpdates ?? 0}`
            : `Force Sync complete! Targets: ${(finalResult.activeTargets || []).join(", ") || "none"}. Found: ${stats.totalWatchedFoundAcrossServers ?? 0}, added: ${stats.addedToHistory ?? 0}, deleted: ${stats.deletedFromHistory ?? 0}, propagated: ${stats.propagatedUpdates ?? 0}`;
          showToast(detail);
          if (terminal) {
            terminal.textContent += `\n${finalResult.aborted ? "ABORTED" : "SUCCESS"}: ${detail}\n`;
            terminal.scrollTop = terminal.scrollHeight;
          }
        } else if (finalResult) {
          throw new Error(finalResult.error || "Force Sync ended with an unknown error.");
        }

        await Promise.all([loadSyncJobs({ force: true }), loadSyncHistory({ force: true })]);
      } catch (error) {
        showToast(`Error: ${error.message}`);
        if (terminal) {
          terminal.textContent += `\nERROR: ${error.message}\n`;
          terminal.scrollTop = terminal.scrollHeight;
        }
      } finally {
        button.disabled = false;
        button.textContent = originalText;
        button.classList.remove("hidden");
        if (stopButton) stopButton.classList.add("hidden");
      }
    }
  );
}


function attachEvents() {
  document.addEventListener("click", (e) => {
    const castCard = e.target.closest("[data-person-id]");
    if (castCard) {
      window.showCastMemberDetails(castCard.dataset.personId, castCard.dataset.personName);
      return;
    }
    const trailer = e.target.closest(".trailer-thumb-container[data-video-key]");
    if (trailer) {
      window.playTrailer(trailer, trailer.dataset.videoKey, trailer.dataset.videoName);
      return;
    }
    const reviewBtn = e.target.closest(".review-toggle-btn");
    if (reviewBtn) {
      const p = reviewBtn.previousElementSibling.querySelector(".review-content");
      p.classList.toggle("expanded");
      reviewBtn.textContent = p.classList.contains("expanded") ? "Show Less" : "Read More";
      return;
    }
    const photoThumb = e.target.closest("[data-photo-index]");
    if (photoThumb) {
      window.openPhotoLightbox(window._personPhotos, parseInt(photoThumb.dataset.photoIndex, 10));
      return;
    }
  });

  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG") return;
    const mode = img.dataset.err;
    if (!mode) return;
    img.dataset.err = "";
    if (mode === "fav") { img.src = "/favicon.svg"; }
    else if (mode === "hide") { img.style.display = "none"; }
    else if (mode === "hide-parent") { img.parentElement.style.display = "none"; }
    else if (mode === "hide-closest-btn") { img.closest("button").style.display = "none"; }
    else if (mode === "hide-show-next") { img.style.display = "none"; img.nextElementSibling.style.display = "inline-grid"; }
  }, true);

  elements.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await unlockWithToken(elements.adminToken.value);
    } catch (error) {
      setUnlocked(false);
      renderDbStatus(false);
      setMessage(error.message, "error");
    }
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.explorerNav) {
        if (state.activeView === "explorer" && !state.mediaDetailInline && state.explorerMode !== button.dataset.explorerNav) {
          clearSearchInputs();
        }
        state.explorerMode = button.dataset.explorerNav;
      }
      if (state.mediaDetailInline) {
        state.mediaDetailInline = false;
        state.activeShowModalKey = null;
        state.activeShowModalSeason = null;
        state.activeShowModalEpisode = null;
        state.showModalRequestToken += 1;
        state.showModalEpisodes = [];
        state.showModalEpisodeIndex = new Map();
        state.pendingWatchAction = null;
        state.activeMovieModalId = null;
        document.querySelector("#explorerBackButton")?.classList.add("hidden");
        elements.explorerTopbarControls?.classList.remove("hidden");
      }
      closeMobileMenu();
      selectView(button.dataset.view);
    });
  });

  const hamburgerButton = document.getElementById("hamburgerButton");
  const topnav = document.querySelector(".topnav");
  if (hamburgerButton && topnav) {
    let lastIsMobile = window.innerWidth <= 760;
    function initMobileMenu(force = false) {
      const isMobile = window.innerWidth <= 760;
      if (force || isMobile !== lastIsMobile) {
        if (isMobile) {
          topnav.classList.add("nav-closed");
          topnav.classList.remove("nav-open");
          hamburgerButton.classList.remove("active");
        } else {
          hamburgerButton.classList.remove("active");
          topnav.classList.remove("nav-closed");
          topnav.classList.remove("nav-open");
        }
        lastIsMobile = isMobile;
      }
    }
    initMobileMenu(true);
    window.addEventListener("resize", () => initMobileMenu(false));

    hamburgerButton.addEventListener("click", () => {
      hamburgerButton.classList.toggle("active");
      topnav.classList.toggle("nav-closed");
      topnav.classList.toggle("nav-open");
      hamburgerButton.setAttribute("aria-expanded", hamburgerButton.classList.contains("active"));
    });
  }

  function closeMobileMenu() {
    if (hamburgerButton && hamburgerButton.classList.contains("active")) {
      hamburgerButton.classList.remove("active");
      topnav.classList.add("nav-closed");
      topnav.classList.remove("nav-open");
      hamburgerButton.setAttribute("aria-expanded", "false");
    }
  }

  // No scroll events or arrow click handlers needed for fixed-fit rows

  elements.testConnectionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      testConnection(button.dataset.testConnection, button).catch((error) => {
        const type = button.dataset.testConnection;
        const message = `${connectionLabel(type)} connection test exception: ${error?.message || "unknown error"}`;
        setConnectionButton(button, "✘ Failed", "error");
        setConnectionStatus(type, message, "error");
        logDebug(message);
      });
    });
  });

  elements.clearLogsButton.addEventListener("click", () => {
    state.debugLogs = clearDebugLogs();
    clearBackendDiagnosticLogs(authHeaders())
      .catch((error) => setMessage(error.message, "error"))
      .finally(() => renderLogs().catch(() => { }));
  });

  elements.copyLogsButton.addEventListener("click", () => {
    copyToClipboard(state.renderedLogsText || logsText() || "[no diagnostic logs captured yet]");
  });

  elements.settingsTabButtons.forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
  });

  elements.backupsSubTabButtons.forEach((button) => {
    button.addEventListener("click", () => selectBackupsTab(button.dataset.backupsTab));
  });

  for (const id of ["appearShowLogoArt", "appearShowCast", "appearShowTrailers", "appearShowReviews", "appearShowImages", "appearShowRelated"]) {
    elements[id]?.addEventListener("change", () => saveAppearanceSettings().catch(() => null));
  }

  elements.saveWatchBackupConfigButton?.addEventListener("click", () => {
    saveWatchBackupSettings().catch((error) => setMessage(error.message, "error"));
  });
  elements.createWatchBackupButton?.addEventListener("click", () => {
    createWatchBackupNow().catch((error) => setMessage(error.message, "error"));
  });
  elements.chooseWatchBackupFileButton?.addEventListener("click", () => {
    elements.watchBackupUploadFile?.click();
  });
  elements.watchBackupUploadFile?.addEventListener("change", () => {
    const file = elements.watchBackupUploadFile.files?.[0];
    uploadWatchBackupFile(file)
      .catch((error) => {
        if (elements.watchBackupUploadStatus) elements.watchBackupUploadStatus.textContent = "Upload failed";
        setMessage(error.message, "error");
      })
      .finally(() => {
        if (elements.watchBackupUploadFile) elements.watchBackupUploadFile.value = "";
      });
  });
  elements.refreshWatchBackupsButton?.addEventListener("click", () => {
    state.watchBackups = null;
    loadWatchBackups({ force: true }).catch((error) => setMessage(error.message, "error"));
  });
  elements.watchBackupList?.addEventListener("click", (event) => {
    const download = event.target.closest("[data-watch-backup-download]");
    if (download) {
      downloadWatchBackup(download.dataset.watchBackupDownload).catch((error) => setMessage(error.message, "error"));
      return;
    }
    const dryRun = event.target.closest("[data-watch-backup-dry-run]");
    if (dryRun) {
      restoreWatchBackup(dryRun.dataset.watchBackupDryRun, "reconcile", true).catch((error) => setMessage(error.message, "error"));
      return;
    }
    const restore = event.target.closest("[data-watch-backup-restore]");
    if (restore) {
      const clearMode = state.restoreClearMode || "reconcile";
      const destId = restore.dataset.restoreDestId;
      if (destId) {
        restoreRemoteBackupFromCard({ dataset: { destId } }, restore.dataset.watchBackupRestore, clearMode).catch((error) => setMessage(error.message, "error"));
      } else {
        restoreWatchBackup(restore.dataset.watchBackupRestore, clearMode).catch((error) => setMessage(error.message, "error"));
      }
    }
  });

  elements.watchBackupList?.addEventListener("change", (event) => {
    const clearModeInput = event.target.closest("[data-restore-clear-mode]");
    if (clearModeInput) {
      state.restoreClearMode = clearModeInput.value === "wipe" ? "wipe" : "reconcile";
    }
  });

  elements.watchBackupRuntime?.addEventListener("click", (event) => {
    const clearBtn = event.target.closest("[data-clear-restore-status]");
    if (clearBtn) {
      postWatchBackupAction({ action: "clear-restore-status" })
        .then(() => loadWatchBackups({ force: true }))
        .catch((error) => setMessage(error.message, "error"));
    }
  });

  elements.addWatchBackupDestinationButton?.addEventListener("click", () => {
    addBackupDestination().catch((error) => setMessage(error.message, "error"));
  });
  elements.watchBackupDestinations?.addEventListener("click", (event) => {
    const restoreFile = event.target.closest("[data-dest-restore-file]");
    if (restoreFile) {
      const card = restoreFile.closest("[data-dest-id]");
      if (card) restoreRemoteBackupFromCard(card, restoreFile.dataset.destRestoreFile, state.restoreClearMode || "reconcile").catch((error) => setMessage(error.message, "error"));
      return;
    }
    const button = event.target.closest("[data-dest-action]");
    if (!button) return;
    const card = button.closest("[data-dest-id]");
    if (!card) return;
    const actions = {
      save: saveBackupDestinationCard,
      test: testBackupDestinationCard,
      remove: removeBackupDestinationCard,
      connect: connectBackupDestinationCard,
      "restore-list": listRemoteBackupsForCard,
    };
    const run = actions[button.dataset.destAction];
    if (run) run(card).catch((error) => setMessage(error.message, "error"));
  });


  elements.explorerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.explorerMode = button.dataset.explorerMode;
      renderExplorer();
      selectView("explorer");
    });
  });

  elements.explorerSort?.addEventListener("change", () => {
    setCurrentExplorerSort(elements.explorerSort.value || "title_asc");
    renderExplorer();
  });
  elements.explorerHideWatched?.addEventListener("change", () => {
    state.hideWatchedShows = elements.explorerHideWatched.checked;
    localStorage.setItem(HIDE_WATCHED_KEY_SHOWS, String(state.hideWatchedShows));
    renderExplorer();
  });
  elements.explorerHideEnded?.addEventListener("change", () => {
    state.hideEndedShows = elements.explorerHideEnded.checked;
    localStorage.setItem(HIDE_ENDED_KEY_SHOWS, String(state.hideEndedShows));
    renderExplorer();
  });
  elements.statsMediaFilter?.addEventListener("change", () => {
    state.statsMediaFilter = elements.statsMediaFilter.value || "all";
    renderStats();
  });
  elements.statsPeriodType?.addEventListener("change", () => {
    state.statsPeriodType = elements.statsPeriodType.value || "all";
    state.statsPeriodValue = state.statsPeriodType === "all" ? "all" : "";
    renderStats();
  });
  elements.statsPeriodValue?.addEventListener("change", () => {
    state.statsPeriodValue = elements.statsPeriodValue.value || "all";
    renderStats();
  });
  document.querySelector("#stats-view")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-stats-media-href]");
    if (!card) return;
    navigateTo(card.dataset.statsMediaHref);
  });
  document.querySelector("#stats-view")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-stats-media-href]");
    if (!card) return;
    event.preventDefault();
    navigateTo(card.dataset.statsMediaHref);
  });

  elements.explorerPanel?.addEventListener("click", (e) => {
    const header = e.target.closest("[data-sort-key]");
    if (!header) return;
    applyListHeaderSort(header.dataset.sortKey);
  });

  elements.alphaFilterNav?.addEventListener("click", handleAlphaFilterClick);

  elements.helpMenu.addEventListener("click", (event) => {
    const topicButton = event.target.closest("[data-help-topic]");
    if (!topicButton) return;
    navigateTo(`/help/${topicButton.dataset.helpTopic}`);
  });

  const brandLink = document.querySelector("#brandLink");
  if (brandLink) {
    brandLink.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo("/");
    });
  }

  elements.appVersion?.addEventListener("click", () => {
    navigateTo("/settings/changelog");
  });

  elements.changelogRefreshButton?.addEventListener("click", () => {
    renderChangelog(true).catch(() => { });
  });

  elements.lockButton.addEventListener("click", lockDashboard);
  if (elements.themeToggleButton) {
    elements.themeToggleButton.addEventListener("click", toggleTheme);
  }
  elements.closeModalButton.addEventListener("click", closeDebugModal);
  elements.debugModal.addEventListener("click", (event) => {
    if (event.target === elements.debugModal) closeDebugModal();
  });

  if (elements.closePersonModalButton) {
    elements.closePersonModalButton.addEventListener("click", () => {
      closePersonProfile();
    });
  }
  if (elements.personModal) {
    elements.personModal.addEventListener("click", (event) => {
      if (event.target === elements.personModal) {
        closePersonProfile();
      }
    });
  }

  const closeConfirmModal = () => {
    if (elements.confirmModal) elements.confirmModal.classList.add("hidden");
  };
  if (elements.closeConfirmModalButton) {
    elements.closeConfirmModalButton.addEventListener("click", closeConfirmModal);
  }
  if (elements.cancelConfirmButton) {
    elements.cancelConfirmButton.addEventListener("click", closeConfirmModal);
  }
  if (elements.confirmModal) {
    elements.confirmModal.addEventListener("click", (event) => {
      if (event.target === elements.confirmModal) closeConfirmModal();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (elements.personModal && !elements.personModal.classList.contains("hidden")) {
        closePersonProfile();
      } else {
        closeMediaDetail();
      }
      closeConfirmModal();
      elements.terminalModal?.classList.add("hidden");
    }
  });

  const wheelScrollTargets = new WeakMap();
  document.addEventListener("wheel", (e) => {
    const row = e.target.closest(".horizontal-scroll-row, .trailer-scroll-row, .cast-scroll-row, .media-images-scroll-row");
    if (!row) return;
    if (row.scrollWidth <= row.clientWidth) return;
    // Let native horizontal gestures (trackpad swipe) pass through untouched.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

    // Normalise delta to pixels regardless of the device's wheel mode.
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= row.clientWidth;

    const maxScroll = row.scrollWidth - row.clientWidth;
    const atLeft = row.scrollLeft <= 0;
    const atRight = Math.ceil(row.scrollLeft + row.clientWidth) >= row.scrollWidth;
    // At an edge in the scroll direction, release the wheel back to the page.
    if ((delta > 0 && atRight) || (delta < 0 && atLeft)) {
      wheelScrollTargets.delete(row);
      return;
    }
    e.preventDefault();

    const current = wheelScrollTargets.has(row) ? wheelScrollTargets.get(row) : row.scrollLeft;
    const target = Math.max(0, Math.min(maxScroll, current + delta));
    wheelScrollTargets.set(row, target);

    if (!row._wheelRAF) {
      const step = () => {
        const goal = wheelScrollTargets.get(row);
        if (goal == null) {
          row._wheelRAF = null;
          return;
        }
        const diff = goal - row.scrollLeft;
        if (Math.abs(diff) < 0.5) {
          row.scrollLeft = goal;
          wheelScrollTargets.delete(row);
          row._wheelRAF = null;
          return;
        }
        row.scrollLeft += diff * 0.2;
        row._wheelRAF = requestAnimationFrame(step);
      };
      row._wheelRAF = requestAnimationFrame(step);
    }
  }, { passive: false });

  document.addEventListener("click", (event) => {
    const mediaImageCard = event.target.closest(".media-image-card[data-lightbox-src]");
    if (mediaImageCard) {
      const row = mediaImageCard.closest(".media-images-scroll-row");
      const cards = row ? [...row.querySelectorAll(".media-image-card[data-lightbox-src]")] : [mediaImageCard];
      const srcs = cards.map((c) => c.dataset.lightboxSrc);
      const index = parseInt(mediaImageCard.dataset.lightboxIndex, 10) || 0;
      window.openPhotoLightbox(srcs, index);
      return;
    }

    const nowPlayingCard = event.target.closest("[data-now-playing-href]");
    if (nowPlayingCard) {
      navigateTo(nowPlayingCard.dataset.nowPlayingHref);
      return;
    }

    const retryBtn = event.target.closest("[data-retry-sync-id]");
    if (retryBtn) {
      triggerRetrySync(retryBtn.dataset.retrySyncId, retryBtn).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const editDateBtn = event.target.closest(".media-edit-date-btn");
    if (editDateBtn) {
      const container = editDateBtn.closest(".immersive-container, .modal-body") || document.body;
      const currentEntry = state.history.find((h) => h.id === editDateBtn.dataset.editId);
      openEditDateDialog(container, editDateBtn.dataset.editId, editDateBtn.dataset.watchedAt, ({ watched_at }) => {
        editDateBtn.dataset.watchedAt = watched_at;
        const span = container.querySelector(".progress-label-row span");
        if (span) span.textContent = `Watched on ${formatDate(watched_at)}`;
        const entry = applyWatchedAtToLocalWatchRecord(editDateBtn.dataset.editId, watched_at)
          || state.history.find((h) => h.id === editDateBtn.dataset.editId);
        if (entry) {
          if (entry.media_type === "episode") {
            const showTitle = entry.show_title || showTitleFrom(entry.title);
            if (showTitle) {
              refreshShowAfterManualWatch(showTitle).then(() => {
                if (state.activeShowModalKey) {
                  renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
                }
              });
            }
          } else if (entry.media_type === "movie" && state.activeMovieModalId && String(entry.id) === String(state.activeMovieModalId)) {
            fetch(`/api/history?id=${encodeURIComponent(entry.id)}`, { headers: authHeaders() })
              .then(res => res.json())
              .then(body => {
                if (body.row) {
                  renderMovieImmersiveModalContent(body.row).catch(() => {});
                }
              });
          }
        }
        if (state.activeView === "history") {
          renderHistoryView();
        }
      }, editDateOptionsFromButton(editDateBtn, currentEntry));
      return;
    }

    const editImageBtn = event.target.closest(".media-edit-image-btn");
    if (editImageBtn) {
      const container = editImageBtn.closest(".immersive-container, .modal-body") || document.body;
      const id = editImageBtn.dataset.editId;
      // Resolve tmdbData — check both movie and TV caches
      let tmdbData = null;
      const entry = state.history.find((h) => h.id === id);
      if (entry) {
        const movieKey = `movie|${entry.tmdb_id || ""}|${String(entry.title || "").toLowerCase()}`;
        const cached = state.tmdbDetailsCache.get(movieKey);
        if (cached && !(cached instanceof Promise)) tmdbData = cached;
      }
      if (!tmdbData && state.activeShowModalKey) {
        const show = state.showsRaw.find((s) => slug(s.title) === state.activeShowModalKey);
        if (show) {
          const tvKey = `tv|${show.tmdb_id || ""}|${String(show.title || "").toLowerCase()}`;
          const cached = state.tmdbDetailsCache.get(tvKey);
          if (cached && !(cached instanceof Promise)) tmdbData = cached;
          if (!tmdbData && show.tmdb_id) tmdbData = { id: show.tmdb_id, name: show.title };
        }
      }
      if (!tmdbData && entry?.tmdb_id && entry.media_type === "movie") {
        tmdbData = { id: entry.tmdb_id, title: entry.title };
      }
      openEditImageDialog(container, id, editImageBtn.dataset.posterUrl, tmdbData, ({ poster_url, logo_url, storage_url, updated_ids }) => {
        if (poster_url) {
          editImageBtn.dataset.posterUrl = poster_url;
          const posterImg = container.querySelector(".immersive-poster-img");
          if (posterImg) posterImg.src = poster_url;
          const backdrop = container.querySelector(".modal-backdrop-image");
          if (backdrop) backdrop.style.backgroundImage = `url('${poster_url}')`;
          // The backend cached the chosen poster and propagated it to every
          // related record. Point the client poster cache at that stored image
          // so the dashboard and explorer cards (which resolve posters by record
          // id) pick it up instead of the previously cached artwork.
          if (storage_url && isCachedStorageImageUrl(storage_url)) {
            for (const updatedId of (Array.isArray(updated_ids) ? updated_ids : [id])) {
              rememberPosterLookup(String(updatedId), storage_url);
            }
          }
        }
        if (logo_url !== undefined) {
          editImageBtn.dataset.logoUrl = logo_url;
          const meta = container.querySelector(".immersive-meta");
          if (meta) {
            let logoEl = meta.querySelector(".immersive-logo");
            const titleEl = meta.querySelector(".immersive-title");
            if (logo_url) {
              if (logoEl) {
                logoEl.src = logo_url;
              } else {
                logoEl = document.createElement("img");
                logoEl.className = "immersive-logo";
                logoEl.alt = titleEl?.textContent || "";
                logoEl.src = logo_url;
                meta.insertBefore(logoEl, titleEl);
              }
              titleEl?.classList.add("sr-only");
            } else {
              logoEl?.remove();
              titleEl?.classList.remove("sr-only");
            }
          }
        }
      });
      return;
    }

    const editShowDateBtn = event.target.closest(".media-edit-show-date-btn");
    if (editShowDateBtn) {
      const fallbackRows = state.showModalEpisodes.map((episode) => episode.watched).filter(Boolean);
      openEditShowDateDialog(editShowDateBtn.dataset.showTitle || "", fallbackRows);
      return;
    }

    const fixMatchBtn = event.target.closest(".media-fix-match-btn");
    if (fixMatchBtn) {
      const container = fixMatchBtn.closest(".immersive-container, .modal-body") || document.body;
      const mediaType = fixMatchBtn.dataset.mediaType;
      openFixMatchDialog(container, fixMatchBtn.dataset.editId, fixMatchBtn.dataset.title, mediaType, ({ tmdb_id }) => {
        state.tmdbDetailsCache.clear();
        const syncJobCard = fixMatchBtn.closest(".sync-job-card");
        const inSyncIssues = fixMatchBtn.closest("#syncIssuesContainer");
        if (syncJobCard || inSyncIssues) {
          setMessage("Match updated. Retrying sync...", "info");
          triggerRetrySync(fixMatchBtn.dataset.editId, fixMatchBtn).catch(() => {
            loadSyncJobs({ force: true }).catch(() => null);
            loadSyncHistory({ force: true }).catch(() => null);
          });
        } else if (mediaType === "movie") {
          const movie = state.history.find((h) => h.id === fixMatchBtn.dataset.editId);
          if (movie) { movie.tmdb_id = tmdb_id; renderMovieImmersiveModalContent(movie).catch(() => { }); }
        } else if (state.activeShowModalKey) {
          const show = state.showsRaw.find((s) => slug(s.title) === state.activeShowModalKey);
          if (show) { show.tmdb_id = tmdb_id; openShowInlineDetail(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode).catch(() => { }); }
        }
      });
      return;
    }

    const mergeShowBtn = event.target.closest(".media-merge-show-btn");
    if (mergeShowBtn) {
      openMergeShowDialog(mergeShowBtn.dataset.showTitle);
      return;
    }

    const editDateIconBtn = event.target.closest(".edit-date-icon-btn");
    if (editDateIconBtn) {
      const id = editDateIconBtn.dataset.editId;
      const currentEntry = state.history.find((h) => h.id === id);
      openEditDateDialog(null, id, editDateIconBtn.dataset.watchedAt, ({ watched_at }) => {
        editDateIconBtn.dataset.watchedAt = watched_at;
        // Update the time element this icon is inside
        const timeEl = editDateIconBtn.closest("time");
        if (timeEl) timeEl.innerHTML = `Watched ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        // Also update movie watch status row if present
        const span = editDateIconBtn.closest(".progress-label-row")?.querySelector("span");
        if (span) span.innerHTML = `Watched on ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        const entry = applyWatchedAtToLocalWatchRecord(id, watched_at)
          || state.history.find((h) => h.id === id);
        if (entry) {
          if (entry.media_type === "episode") {
            const showTitle = entry.show_title || showTitleFrom(entry.title);
            if (showTitle) {
              refreshShowAfterManualWatch(showTitle).then(() => {
                if (state.activeShowModalKey) {
                  renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
                }
              });
            }
          } else if (entry.media_type === "movie" && state.activeMovieModalId && String(entry.id) === String(state.activeMovieModalId)) {
            fetch(`/api/history?id=${encodeURIComponent(entry.id)}`, { headers: authHeaders() })
              .then(res => res.json())
              .then(body => {
                if (body.row) {
                  renderMovieImmersiveModalContent(body.row).catch(() => {});
                }
              });
          }
        }
        if (state.activeView === "history") {
          renderHistoryView();
        }
      }, editDateOptionsFromButton(editDateIconBtn, currentEntry));
      return;
    }

    const availIssueEl = event.target.closest("[data-avail-issue]");
    if (availIssueEl) {
      showAvailIssuePopup(availIssueEl);
      return;
    }

    const helpLink = event.target.closest("[data-help-topic-link]");
    if (helpLink) {
      event.preventDefault();
      openHelpTopic(helpLink.dataset.helpTopicLink);
      return;
    }

    const settingsLink = event.target.closest("[data-settings-link]");
    if (settingsLink) {
      event.preventDefault();
      selectSettingsTab(settingsLink.dataset.settingsLink);
      return;
    }

    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      copyToClipboard(copyButton.dataset.copy);
      return;
    }

    const watchDateCancel = event.target.closest("[data-watch-date-cancel]");
    if (watchDateCancel) {
      event.preventDefault();
      closeWatchDatePrompt();
      return;
    }

    const watchDateChoice = event.target.closest("[data-watch-date-choice]");
    if (watchDateChoice) {
      event.preventDefault();
      applyWatchDateChoice(watchDateChoice.dataset.watchDateChoice).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const wdNav = event.target.closest("[data-wd-nav]");
    if (wdNav && state.watchDateCustom) {
      syncCustomTimeFromSelects();
      const dir = wdNav.dataset.wdNav === "next" ? 1 : -1;
      let month = state.watchDateCustom.month + dir;
      let year = state.watchDateCustom.year;
      if (month < 0) { month = 11; year -= 1; }
      if (month > 11) { month = 0; year += 1; }
      state.watchDateCustom.year = year;
      state.watchDateCustom.month = month;
      rerenderWatchDateCustomPicker();
      return;
    }

    const wdDay = event.target.closest("[data-wd-day]");
    if (wdDay && state.watchDateCustom) {
      syncCustomTimeFromSelects();
      const [year, month, day] = wdDay.dataset.wdDay.split("-").map(Number);
      state.watchDateCustom.selected.setFullYear(year, month - 1, day);
      state.watchDateCustom.year = year;
      state.watchDateCustom.month = month - 1;
      rerenderWatchDateCustomPicker();
      return;
    }

    const wdNow = event.target.closest("[data-wd-now]");
    if (wdNow) {
      initWatchDateCustomState();
      rerenderWatchDateCustomPicker();
      return;
    }

    const watchButton = event.target.closest("[data-watch-scope]");
    if (watchButton) {
      event.preventDefault();
      openWatchDatePrompt(watchActionFromButton(watchButton));
      return;
    }

    const editSeasonDateBtn = event.target.closest("[data-edit-season-date]");
    if (editSeasonDateBtn) {
      const seasonNum = Number(editSeasonDateBtn.dataset.editSeasonDate);
      const seasonEpisodes = state.showModalEpisodes.filter((ep) => ep.seasonNumber === seasonNum);
      const watchedEpisodes = seasonEpisodes.map((ep) => ep.watched).filter(Boolean);
      if (!watchedEpisodes.length) {
        setMessage("No watched episodes in this season to update.", "error");
        return;
      }
      const showTitle = seasonEpisodes[0]?.showTitle || "";
      openEditSeasonDateDialog(showTitle, seasonNum, watchedEpisodes);
      return;
    }

    const movieWatchButton = event.target.closest("[data-movie-mark-watched]");
    if (movieWatchButton) {
      markMovieWatched({
        tmdbId: movieWatchButton.dataset.movieMarkWatched,
        title: movieWatchButton.dataset.movieTitle,
        posterUrl: movieWatchButton.dataset.moviePoster,
        releaseDate: movieWatchButton.dataset.movieRelease,
      });
      return;
    }

    const seerrBtn = event.target.closest("[data-seerr-media-type]");
    if (seerrBtn) {
      const mediaType = seerrBtn.dataset.seerrMediaType;
      const mediaId = Number(seerrBtn.dataset.seerrMediaId);
      submitSeerrRequest(mediaType, mediaId, seerrBtn);
      return;
    }

    const unwatchButton = event.target.closest("[data-unwatch-id]");
    if (unwatchButton) {
      confirmAndMarkUnwatched(unwatchButton).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const deleteMediaButton = event.target.closest("[data-delete-media-id]");
    if (deleteMediaButton) {
      confirmAndDeleteMedia(deleteMediaButton).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const backBtn = event.target.closest(".immersive-back-button");
    if (backBtn) {
      if (state.internalHistoryCount > 0) {
        window.history.back();
      } else {
        closeMediaDetail();
      }
      return;
    }

    const toggleEpisodes = event.target.closest("[data-immersive-toggle-episodes]");
    if (toggleEpisodes) {
      const list = document.querySelector("#immersiveEpisodeList");
      if (list) list.classList.toggle("hidden");
      return;
    }

    const seasonAccordion = event.target.closest("[data-season-accordion]");
    if (seasonAccordion) {
      const seasonNum = Number(seasonAccordion.dataset.seasonAccordion);
      const shouldClose = Number(state.activeShowModalSeason) === seasonNum;
      if (state.activeShowModalKey) {
        navigateTo(shouldClose ? `/tvshow/${state.activeShowModalKey}` : `/tvshow/${state.activeShowModalKey}#season${seasonNum}`);
      } else if (state.activeShowTmdbId) {
        navigateTo(shouldClose ? `/tvshow/tmdb/${state.activeShowTmdbId}` : `/tvshow/tmdb/${state.activeShowTmdbId}#season${seasonNum}`);
      }
      return;
    }

    const episodeRow = event.target.closest("[data-immersive-episode-num]");
    if (episodeRow) {
      if (event.target.closest("button") || event.target.closest("a") || event.target.closest(".avail-pill")) {
        return;
      }
      const episodeNum = Number(episodeRow.dataset.immersiveEpisodeNum);
      const seasonNum = Number(episodeRow.dataset.immersiveSeasonNum);
      if (state.activeShowModalKey) {
        navigateTo(`/tvshow/${state.activeShowModalKey}#season${seasonNum}ep${episodeNum}`);
      }
      return;
    }

    const recMovieCard = event.target.closest("[data-immersive-movie-id]");
    if (recMovieCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigateTo(`/movie/tmdb/${recMovieCard.dataset.immersiveMovieId}`);
      return;
    }

    const relatedShowCard = event.target.closest("[data-immersive-related-tmdb]");
    if (relatedShowCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigateTo(`/tvshow/tmdb/${relatedShowCard.dataset.immersiveRelatedTmdb}`);
      return;
    }

    const libraryItemCard = event.target.closest("a[data-library-item-type]");
    if (libraryItemCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.openLibraryItem(libraryItemCard.dataset.libraryItemType, libraryItemCard.dataset.libraryItemId, libraryItemCard.dataset.libraryItemTitle, true, null);
      return;
    }

    const tmdbItemCard = event.target.closest("a[data-tmdb-id]");
    if (tmdbItemCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.openLibraryItem(tmdbItemCard.dataset.tmdbMediaType, null, tmdbItemCard.dataset.tmdbTitle, false, tmdbItemCard.dataset.tmdbId);
      return;
    }

    const historyRow = event.target.closest("[data-history-id]");
    if (historyRow) {
      if (event.target.closest("[data-sync-status-dot]")) {
        openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
        return;
      }
      if (event.target.closest("#historyPanel") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        const href = historyRow.getAttribute("href");
        if (href) {
          event.preventDefault();
          navigateTo(href);
          return;
        }
      }
      const isTvRow = event.target.closest("#tvHistoryRow");
      if (isTvRow && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const entry = state.history.find(e => e.id === historyRow.dataset.historyId);
        if (entry) {
          const canonicalShowName = entry.show_title || showName(entry.title);
          const showKeySlug = slug(canonicalShowName);
          let showObj = state.showsRaw.find(s => slug(s.title) === showKeySlug);
          if (!showObj) {
            showObj = { title: canonicalShowName, id: entry.tvdb_id || entry.tmdb_id || canonicalShowName };
            state.showsRaw.push(showObj);
          }

          navigateTo(`/tvshow/${showKeySlug}`);
        }
      } else if (event.target.closest(".movie-card") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        navigateTo(movieHref(movieBySlugOrId(historyRow.dataset.historyId) || { id: historyRow.dataset.historyId }));
      } else if (!event.target.closest(".movie-card")) {
        openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
      }
      return;
    }

    const showTrigger = event.target.closest("[data-show-key]");
    if (showTrigger) {
      navigateTo(`/tvshow/${showTrigger.dataset.showKey}`);
      return;
    }

    const seasonTrigger = event.target.closest("[data-season-key]");
    if (seasonTrigger) {
      toggleSet(state.expandedSeasons, seasonTrigger.dataset.seasonKey);
      if (state.activeShowModalKey) {
        if (state.mediaDetailInline) {
          let url = `/tvshow/${state.activeShowModalKey}`;
          if (state.activeShowModalSeason !== null) {
            url += `#season${state.activeShowModalSeason}`;
          }
          navigateTo(url);
        } else {
          renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
        }
      } else {
        renderExplorer();
      }
      return;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const statusDot = event.target.closest?.("[data-sync-status-dot]");
    if (!statusDot) return;
    const historyRow = statusDot.closest("[data-history-id]");
    if (!historyRow) return;
    event.preventDefault();
    openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
  });

  elements.adminCredentialsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveAdminCredentials().catch((error) => {
      renderAdminCredentialsStatus(error.message, "error");
      setMessage(error.message, "error");
    });
  });

  elements.checkSessionButton.addEventListener("click", async () => {
    const user = currentUser();
    const text = user ? `Signed in as ${user.username || user.email || "admin"}.` : "Sign in again from the lock screen.";
    const tone = user ? "success" : "error";
    renderAdminCredentialsStatus(text, tone);
    setMessage(text, tone);
  });

  elements.rotateWebhookButton?.addEventListener("click", async () => {
    try {
      await rotateWebhookSecret();
      elements.webhookUrl.textContent = buildWebhookUrl();
      renderSettingsInlineHelp();
      setMessage("Webhook secret rotated. Update the webhook URL in all media servers.", "success");
    } catch (error) {
      setMessage(`Failed to rotate webhook secret: ${error.message}`, "error");
    }
  });

  elements.saveConfigButton?.addEventListener("click", () => {
    saveSavedConfig().catch((error) => {
      renderSettingsStatus(error.message, "error");
      setMessage(error.message, "error");
    });
  });

  elements.savePlexConfigButton?.addEventListener("click", () => {
    saveSectionConfig("plex");
  });
  elements.saveEmbyConfigButton?.addEventListener("click", () => {
    saveSectionConfig("emby");
  });
  elements.saveJellyfinConfigButton?.addEventListener("click", () => {
    saveSectionConfig("jellyfin");
  });
  elements.saveTmdbConfigButton?.addEventListener("click", () => {
    saveSectionConfig("tmdb");
  });
  elements.saveYoutubeConfigButton?.addEventListener("click", () => {
    saveSectionConfig("youtube");
  });
  elements.saveFanartConfigButton?.addEventListener("click", () => {
    saveSectionConfig("fanart");
  });
  elements.saveOmdbConfigButton?.addEventListener("click", () => {
    saveSectionConfig("omdb");
  });
  elements.saveSeerrConfigButton?.addEventListener("click", () => {
    saveSectionConfig("seerr");
  });

  elements.plexEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.embyEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.jellyfinEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.seerrEnabled?.addEventListener("change", syncSettingsInputsDisabledState);

  elements.explorerSearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.explorerSearchTimer);
    state.explorerSearchTimer = window.setTimeout(() => {
      state.explorerSearch = elements.explorerSearchInput.value.trim();
      if (elements.globalSearchInput && elements.globalSearchInput.value !== state.explorerSearch) {
        elements.globalSearchInput.value = state.explorerSearch;
      }
      renderExplorer();
    }, 220);
  });

  elements.globalSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeGlobalSearchDropdown();
      elements.globalSearchInput.blur();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const first = document.querySelector(".global-search-result");
      first?.focus();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const firstResult = document.querySelector(".global-search-result");
    if (firstResult) {
      firstResult.click();
      return;
    }
    closeGlobalSearchDropdown();
    const query = elements.globalSearchInput.value.trim();
    if (query) {
      navigateTo(`/search?q=${encodeURIComponent(query)}`);
    }
  });

  elements.globalSearchInput?.addEventListener("input", () => {
    const query = elements.globalSearchInput.value.trim();
    window.clearTimeout(state.globalSearchDropdownTimer);
    window.clearTimeout(state.globalSearchRemoteTimer);
    if (!query) { closeGlobalSearchDropdown(); }
    else {
      renderGlobalSearchDropdown(query);
      state.globalSearchRemoteTimer = window.setTimeout(() => loadGlobalDiscovery(query), 260);
    }
    if (state.activeView === "explorer") {
      window.clearTimeout(state.explorerSearchTimer);
      state.explorerSearchTimer = window.setTimeout(() => {
        state.explorerSearch = query;
        if (elements.explorerSearchInput && elements.explorerSearchInput.value !== query) {
          elements.explorerSearchInput.value = query;
        }
        renderExplorer();
      }, 220);
    }
  });

  // Browsers ignore autocomplete="off" and will dump the saved login username into
  // the first text field on load. The search box ships read-only so the password
  // manager can't autofill it; unlock it the moment the user actually interacts.
  const unlockGlobalSearch = () => elements.globalSearchInput?.removeAttribute("readonly");
  elements.globalSearchInput?.addEventListener("pointerdown", unlockGlobalSearch);
  elements.globalSearchInput?.addEventListener("focus", unlockGlobalSearch);

  const unlockExplorerSearch = () => elements.explorerSearchInput?.removeAttribute("readonly");
  elements.explorerSearchInput?.addEventListener("pointerdown", unlockExplorerSearch);
  elements.explorerSearchInput?.addEventListener("focus", unlockExplorerSearch);

  elements.globalSearchInput?.addEventListener("focus", () => {
    const query = elements.globalSearchInput.value.trim();
    if (query) renderGlobalSearchDropdown(query);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".global-search")) closeGlobalSearchDropdown();
  });

  document.querySelectorAll(".search-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".search-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.searchFilter = btn.dataset.filter;
      renderSearchPage();
    });
  });

  document.getElementById("searchViewResults")?.addEventListener("click", (e) => {
    const card = e.target.closest(".explorer-overview-card");
    if (card && card.dataset.href) {
      navigateTo(card.dataset.href);
    }
  });

  elements.importFile.addEventListener("change", async () => {
    const files = elements.importFile.files;
    if (!files?.length) return;
    try {
      await parseSelectedFiles(files);
      setMessage(`Parsed ${state.importRecords.length} records from ${files.length} file${files.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      state.importRecords = [];
      state.importFileNames = [];
      appendImportLog(`Parse failed: ${error.message}`);
      renderImportPreview();
      setMessage(`Import parse failed: ${error.message}`, "error");
    }
  });

  elements.startImportButton.addEventListener("click", () => {
    startImport().catch((error) => setMessage(error.message, "error"));
  });

  elements.clearImportButton.addEventListener("click", () => {
    state.importRecords = [];
    state.importFileNames = [];
    state.importLogs = ["[idle] Waiting for files."];
    state.importProgressValue = 0;
    elements.importFile.value = "";
    renderImportPreview();
    setMessage("Import selection cleared.");
  });

  elements.backupExportButton?.addEventListener("click", () => {
    exportPlembfinBackup().catch((error) => setMessage(error.message, "error"));
  });

  elements.backupImportFile?.addEventListener("change", async () => {
    state.backupImport = null;
    elements.backupImportButton.disabled = true;
    const file = elements.backupImportFile.files?.[0];
    if (!file) {
      setBackupTransferState("Idle", "muted", "[idle] Select Export or choose a backup file.");
      return;
    }
    try {
      state.backupImport = await readPlembfinBackup(file);
      const documentCount = state.backupImport.included.reduce((sum, name) => sum + state.backupImport.backup.collections[name].length, 0);
      elements.backupImportButton.disabled = false;
      setBackupTransferState("Ready", "ready", `${file.name}\n${formatNumber(documentCount)} documents across ${formatNumber(state.backupImport.included.length)} supported collections.`);
    } catch (error) {
      setBackupTransferState("Invalid", "error", `Backup file rejected: ${error.message}`);
      setMessage(error.message, "error");
    }
  });

  elements.backupImportButton?.addEventListener("click", () => {
    importPlembfinBackup().catch((error) => setMessage(error.message, "error"));
  });

  if (elements.runCompleteCheckButton) {
    elements.runCompleteCheckButton.addEventListener("click", () => {
      runSystemIntegrityCheck().catch((error) => {
        setMessage(`Integrity check exception: ${error.message}`, "error");
      });
    });
  }

  if (elements.refreshCacheStatsButton) {
    elements.refreshCacheStatsButton.addEventListener("click", () => {
      loadCacheStats({ force: true }).catch((error) => setMessage(error.message, "error"));
    });
  }

  if (elements.runRepairButton) {
    elements.runRepairButton.addEventListener("click", () => {
      runRepairWorkflow().catch((error) => {
        renderSettingsStatus(error.message, "error");
        setMessage(error.message, "error");
      });
    });
  }

  if (elements.traktBackfillButton) {
    elements.traktBackfillButton.addEventListener("click", () => {
      runTraktBackfill().catch((error) => {
        elements.traktBackfillStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.dedupHistoryButton) {
    elements.dedupHistoryButton.addEventListener("click", () => {
      runDedupHistory().catch((error) => {
        if (elements.dedupHistoryStatus) elements.dedupHistoryStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.refreshMetadataButton) {
    elements.refreshMetadataButton.addEventListener("click", () => {
      runRefreshMetadataWorkflow().catch((error) => {
        if (elements.refreshMetadataStatus) elements.refreshMetadataStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.fullSyncButton) {
    elements.fullSyncButton.addEventListener("click", () => {
      runFullSyncWatchstates().catch(() => { });
    });
  }

  if (elements.runCronSyncButton) {
    elements.runCronSyncButton.addEventListener("click", () => {
      triggerCronSync().catch(() => { });
    });
  }

  if (elements.refreshSyncButton) {
    elements.refreshSyncButton.addEventListener("click", () => {
      loadSyncJobs({ force: true }).catch((error) => setMessage(error.message, "error"));
      loadSyncHistory({ force: true }).catch((error) => setMessage(error.message, "error"));
    });
  }

  if (elements.forceSyncButton) {
    elements.forceSyncButton.addEventListener("click", () => {
      triggerForceSync().catch(() => { });
    });
  }

  if (elements.stopSyncButton) {
    elements.stopSyncButton.addEventListener("click", () => {
      triggerStopSync().catch(() => { });
    });
  }

  // Sync issues toggle
  if (elements.syncIssuesToggle) {
    elements.syncIssuesToggle.addEventListener("click", () => {
      const isHidden = elements.syncIssuesContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncIssuesContent.classList.remove("hidden");
        elements.syncIssuesToggleIcon.textContent = "▼";
      } else {
        elements.syncIssuesContent.classList.add("hidden");
        elements.syncIssuesToggleIcon.textContent = "▶";
      }
    });
  }

  // Sync history toggle
  if (elements.syncHistoryToggle) {
    elements.syncHistoryToggle.addEventListener("click", () => {
      const isHidden = elements.syncHistoryContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncHistoryContent.classList.remove("hidden");
        elements.syncHistoryToggleIcon.textContent = "▼";
      } else {
        elements.syncHistoryContent.classList.add("hidden");
        elements.syncHistoryToggleIcon.textContent = "▶";
      }
    });
  }

  // Sync tools toggle
  if (elements.syncToolsToggle) {
    elements.syncToolsToggle.addEventListener("click", () => {
      const isHidden = elements.syncToolsContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncToolsContent.classList.remove("hidden");
        elements.syncToolsToggleIcon.textContent = "▼";
      } else {
        elements.syncToolsContent.classList.add("hidden");
        elements.syncToolsToggleIcon.textContent = "▶";
      }
    });
  }

  // Event delegation for action buttons in sync issues
  document.addEventListener("click", (e) => {
    if (e.target.dataset.action === "clearMissingTelemetry") {
      triggerClearMissingTelemetry(e.target).catch(() => { });
    }
    if (e.target.dataset.action === "retryAllCategory") {
      triggerRetryAllCategory(e.target.dataset.category, e.target).catch(() => { });
    }
    if (e.target.classList.contains("dismiss-issue-btn")) {
      const issueCard = e.target.closest(".sync-issue-card");
      if (issueCard) {
        issueCard.style.animation = "fadeOut 0.3s ease forwards";
        setTimeout(() => {
          issueCard.remove();
          const container = document.getElementById("syncIssuesContainer");
          if (container && container.querySelectorAll(".sync-issue-card").length === 0) {
            loadSyncJobs({ force: true }).catch(() => { });
          }
        }, 300);
      }
    }
  });

  window.addEventListener("error", (event) => {
    logDebug("Global browser error captured.", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logDebug("Global unhandled promise rejection captured.", {
      reason: event.reason?.message || String(event.reason || "unknown"),
    });
  });

  window.addEventListener("resize", () => {
    applyExplorerPosterWidth();
    applyHistoryPosterWidth();
    syncPageTopbar();
    syncMediaActionsMenuState();
    window.clearTimeout(state.dashboardHistoryResizeTimer);
    state.dashboardHistoryResizeTimer = window.setTimeout(() => {
      if (state.activeView === "dashboard") renderDashboard();
    }, 120);
  });

  window.addEventListener("scroll", () => {
    if (state.activeView !== "explorer" && state.activeView !== "history") return;
    if (state.activeView === "explorer") {
      state.explorerScrollArmed = true;
    } else if (state.activeView === "history") {
      state.historyViewScrollArmed = true;
    }
    if (state.posterHydrateScrollScheduled) return;
    state.posterHydrateScrollScheduled = true;
    window.requestAnimationFrame(() => {
      state.posterHydrateScrollScheduled = false;
      const container = state.activeView === "explorer"
        ? elements.explorerPanel
        : elements.historyPanel;
      hydratePosters(container);
    });
  }, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (!state.token || state.activeView !== "dashboard") return;
    if (document.hidden) {
      stopHistoryPolling();
      return;
    }
    startHistoryPolling();
  });

  window.addEventListener("popstate", () => {
    state.internalHistoryCount = history.state?.index || 0;
    handleRouting(window.location.pathname + window.location.search + window.location.hash);
    applyActiveView();
  });

  elements.explorerPosterSize?.addEventListener("input", (e) => {
    const val = e.target.value;
    document.documentElement.style.setProperty("--poster-width", `${val}px`);
    localStorage.setItem(currentPosterWidthKey(), `${val}px`);
  });

  elements.historyPosterSize?.addEventListener("input", (e) => {
    const val = e.target.value;
    document.documentElement.style.setProperty("--history-poster-width", `${val}px`);
    localStorage.setItem("plembfin:history:posterWidth", `${val}px`);
  });

  elements.partWatchedPanel?.addEventListener("click", async (event) => {
    const posterLink = event.target.closest("[data-part-watched-href]");
    if (posterLink) {
      event.preventDefault();
      navigateTo(posterLink.dataset.partWatchedHref);
      return;
    }
    const watchBtn = event.target.closest("[data-action-watch]");
    const unwatchBtn = event.target.closest("[data-action-unwatch]");
    if (!watchBtn && !unwatchBtn) return;

    const btn = watchBtn || unwatchBtn;
    const mediaKey = watchBtn ? watchBtn.dataset.actionWatch : unwatchBtn.dataset.actionUnwatch;
    const title = watchBtn ? watchBtn.dataset.title : unwatchBtn.dataset.title;

    if (watchBtn) {
      const entry = state.partWatchedRaw.find(e => e.media_key === mediaKey);
      if (entry) {
        if (entry.media_type === "movie") {
          state.pendingWatchAction = {
            origin: "part-watched",
            scope: "movie",
            mediaKey: entry.media_key,
            title: entry.title,
            movie: {
              title: entry.title,
              tmdbId: entry.tmdb_id,
              imdbId: entry.imdb_id,
              tvdbId: entry.tvdb_id,
              posterUrl: entry.poster_url || entry.imageUrl || entry.thumb || null,
            },
            label: `Mark ${entry.title} watched`,
            lastPlayedAt: entry.updated_at,
          };
        } else {
          const showTitle = entry.show_title || showTitleFrom(entry.title);
          state.pendingWatchAction = {
            origin: "part-watched",
            scope: "episode",
            mediaKey: entry.media_key,
            title: entry.title,
            showTitle: showTitle,
            episodes: [{
              seasonNumber: entry.season,
              episodeNumber: entry.episode,
              title: entry.episode_title || entry.title,
              showTmdbId: entry.tmdb_id,
              imdbId: entry.imdb_id,
              tvdbId: entry.tvdb_id,
              posterUrl: entry.poster_url || entry.imageUrl || entry.thumb || null,
              key: entry.media_key,
              airDate: entry.airDate || entry.air_date || null,
            }],
            label: `Mark ${showTitle} watched`,
            countLabel: `Season ${entry.season} · Episode ${entry.episode}`,
            lastPlayedAt: entry.updated_at,
          };
        }
        openWatchDatePrompt(state.pendingWatchAction);
      }
    } else if (unwatchBtn) {
      showConfirmModal(`Clear playback progress for "${title}"? This will mark it unwatched and reset progress.`, async () => {
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Clearing...";
        try {
          const res = await fetch("/api/playback-progress/unwatch", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ media_key: mediaKey }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setMessage(`Progress cleared for "${title}"`, "success");
          resetPartWatchedView("default");
          renderPartWatched();
        } catch (error) {
          showErrorExplainModal(`Failed to clear progress for "${title}"`, error.message);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    }
  });

  elements.historySearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.historyViewSearchTimer);
    state.historyViewSearchTimer = window.setTimeout(() => {
      state.historyViewSearch = elements.historySearchInput.value.trim();
      renderHistoryView();
    }, 220);
  });

  const unlockHistorySearch = () => elements.historySearchInput?.removeAttribute("readonly");
  elements.historySearchInput?.addEventListener("pointerdown", unlockHistorySearch);
  elements.historySearchInput?.addEventListener("focus", unlockHistorySearch);

  for (const btn of elements.historyFilterButtons || []) {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.historyFilter || "all";
      if (!HISTORY_FILTERS.includes(filter)) return;
      if (filter === state.historyViewFilter) return;
      state.historyViewFilter = filter;
      localStorage.setItem(HISTORY_FILTER_KEY, filter);
      resetHistoryView([state.historyViewSearch, state.historyViewFilter].join("|"));
      renderHistoryView();
    });
  }

  for (const btn of elements.historyViewButtons || []) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.historyView || "grid";
      if (!HISTORY_VIEW_MODES.includes(view)) return;
      if (view === state.historyViewMode) return;
      state.historyViewMode = view;
      localStorage.setItem(HISTORY_VIEW_KEY, view);
      renderHistoryView();
    });
  }

  for (const btn of elements.explorerViewButtons || []) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.explorerView;
      if (!view || view === currentExplorerView()) return;
      if (state.explorerMode === "shows") {
        state.explorerViewShows = view;
        localStorage.setItem(EXPLORER_VIEW_KEY_SHOWS, view);
        state.showsRaw = [];
        state.showsOffset = 0;
        state.showsHasMore = true;
        state.showsLoading = false;
      } else {
        state.explorerViewMovies = view;
        localStorage.setItem(EXPLORER_VIEW_KEY_MOVIES, view);
        state.moviesRaw = [];
        state.moviesOffset = 0;
        state.moviesHasMore = true;
        state.moviesLoading = false;
      }
      renderExplorer();
    });
  }

  elements.closeTerminalModalButton?.addEventListener("click", () => {
    elements.terminalModal?.classList.add("hidden");
  });

  elements.terminalModal?.addEventListener("click", (event) => {
    if (event.target === elements.terminalModal) {
      elements.terminalModal.classList.add("hidden");
    }
  });
}

function primeSensitiveRouteState(path = "") {
  const pathname = path.split("?")[0].split("#")[0];
  if (pathname.startsWith("/movie/")) {
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    return true;
  }
  if (pathname.startsWith("/tvshow/")) {
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    return true;
  }
  if (pathname.startsWith("/person/")) {
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    return true;
  }
  if (pathname.startsWith("/search")) {
    state.activeView = "search";
    return true;
  }
  return false;
}

function initialize() {
  bindElements();
  initTools({
    setMessage,
    openConfirmDialog,
    showConfirmModal,
    loadSavedConfig,
    loadHistory,
    loadActiveSessions,
    loadStats,
    clearDerivedUiCaches,
  });
  initSync({
    logDebug,
    loadHistory,
    setMessage,
    updateDashboardSplitState,
    nowPlayingHref,
  });
  initDashboard({
    setMessage,
    fetchTmdbDetails,
    resolveEpisodeTitleFromTmdb,
    observeExplorerTmdbPrefetch,
  });
  initExplorer({
    setMessage,
    syncPageTopbar,
    cachedExplorerPage,
    rememberExplorerPage,
    fetchTmdbDetails,
    resolveEpisodeTitleFromTmdb,
  });
  initStats({
    slug,
  });
  loadAppVersion();
  bootstrapTokenFromUrl();
  const initialPath = window.location.pathname + window.location.search + window.location.hash;
  if (isConfigSensitiveRoute(initialPath)) {
    primeSensitiveRouteState(initialPath);
  } else {
    handleRouting(initialPath);
  }
  attachEvents();
  applyAppearanceToBody(APPEARANCE_DEFAULTS);
  applyExplorerPosterWidth();
  elements.adminEmail.value = localStorage.getItem("adminUsername") || "";
  elements.adminToken.value = "";
  elements.settingsUsername.value = elements.adminEmail.value;
  elements.webhookUrl.textContent = buildWebhookUrl();
  if (elements.cronSyncUrl) {
    elements.cronSyncUrl.textContent = `${window.location.origin}/api/cron-sync`;
  }
  applyActiveView();
  populateConfigForm({});
  renderDashboard();
  renderActiveSessions();
  renderStats();
  if (!state.mediaDetailInline) renderExplorer();
  renderHelp();
  renderLogs().catch(() => { });
  renderImportPreview();
  renderWatchBackups();
  renderDbStatus(false);
  renderSettingsStatus("Configuration not loaded yet.");

  onAuthChange((user, token, mustChangePassword) => {
    state.authReady = true;
    state.mustChangePassword = mustChangePassword === true;
    state.currentUser = user || undefined;
    state.token = token || "";
    if (user && token) {
      for (const [key, value] of state.posterLookupCache.entries()) {
        if (!value) state.posterLookupCache.delete(key);
      }
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("plembfin:posterLookupCache:v2")) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                const cleaned = parsed.filter(item => item.url);
                localStorage.setItem(key, JSON.stringify(cleaned));
              }
            }
          }
        }
      } catch (e) { }

    }
    if (user && token && !state.configLoaded) {
      const fullPath = window.location.pathname + window.location.search + window.location.hash;
      elements.settingsUsername.value = user.username || user.email || "";
      localStorage.setItem("adminUsername", user.email || "");
      setUnlocked(true);
      applyMustChangePassword();
      if (isConfigSensitiveRoute(fullPath) && !state.mustChangePassword) {
        primeSensitiveRouteState(fullPath);
        applyActiveView();
        // Paint the media detail immediately using local data (e.g. /api/show)
        // instead of waiting for loadSavedConfig() — which is three sequential
        // round-trips (/api/config → /api/seerr/status → /api/appearance). The
        // local show record (title, poster, episodes, progress) needs no config,
        // so rendering now removes the blank flash on a direct load/refresh. The
        // post-config handleRouting below re-renders to layer in TMDB/IMDb data.
        handleRouting(fullPath);
      } else {
        selectView(state.activeView);
      }
      loadSavedConfig()
        .then(() => {
          if (isConfigSensitiveRoute(fullPath)) {
            handleRouting(fullPath);
            applyActiveView();
          }
          if (state.activeView === "dashboard") return loadHistory();
          if (state.activeView === "stats") return loadStats();
          return null;
        })
        .then(() => startHistoryPolling())
        .catch((error) => {
          renderDbStatus(false);
          setMessage(`${error.message} Signed in, but dashboard APIs are not responding yet.`, "error");
        });
    } else if (user && token) {
      const fullPath = window.location.pathname + window.location.search + window.location.hash;
      if (isConfigSensitiveRoute(fullPath)) {
        handleRouting(fullPath);
        applyActiveView();
      }
    } else if (!user) {
      setUnlocked(false);
    }
  });
}

window.addEventListener("DOMContentLoaded", initialize);

async function copyToClipboard(value) {
  try {
    await navigator.clipboard.writeText(value);
    showCopyToast();
  } catch (error) {
    const textArea = document.createElement("textarea");
    textArea.value = value;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    textArea.remove();
    showCopyToast();
  }
}

function showToast(text) {
  if (!elements.copyToast) return;
  elements.copyToast.textContent = text;
  elements.copyToast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.copyToast.classList.add("hidden");
    elements.copyToast.textContent = "Copied!";
  }, 3500);
}

function showCopyToast() {
  elements.copyToast.classList.remove("hidden");
  window.clearTimeout(showCopyToast.timer);
  showCopyToast.timer = window.setTimeout(() => {
    elements.copyToast.classList.add("hidden");
  }, 1300);
}

window.playTrailer = function (el, videoKey, videoName) {
  const container = el.closest('.trailer-scroll-row');
  if (container) {
    container.querySelectorAll('.trailer-thumb-container').forEach(thumbCont => {
      if (thumbCont !== el && thumbCont.querySelector('iframe')) {
        const key = thumbCont.dataset.videoKey;
        const name = thumbCont.dataset.videoName;
        thumbCont.innerHTML = `
          <img class="trailer-thumb" src="https://img.youtube.com/vi/${key}/mqdefault.jpg" alt="${escapeAttribute(name)}" data-err="fav" />
          <div class="play-overlay">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
        `;
      }
    });
  }
  el.style.overflow = "visible";
  el.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoKey}?autoplay=1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;"></iframe>`;
};

// Photo lightbox
(function () {
  let photos = [];
  let current = 0;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let lb = null;
  // drag state
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panAtDragX = 0;
  let panAtDragY = 0;

  function applyTransform() {
    const img = lb.querySelector('.photo-lightbox-img');
    const wrap = lb.querySelector('.photo-lightbox-img-wrap');
    if (scale === 1) {
      img.style.transform = '';
      wrap.classList.remove('grabbing');
      wrap.style.cursor = '';
    } else {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      wrap.style.cursor = dragging ? 'grabbing' : 'grab';
    }
  }

  function render() {
    const img = lb.querySelector('.photo-lightbox-img');
    img.src = photos[current];
    scale = 1; panX = 0; panY = 0;
    applyTransform();
    lb.querySelector('.photo-lightbox-counter').textContent = `${current + 1} / ${photos.length}`;
    lb.querySelector('.photo-lightbox-nav--prev').style.display = photos.length > 1 ? '' : 'none';
    lb.querySelector('.photo-lightbox-nav--next').style.display = photos.length > 1 ? '' : 'none';
  }

  function open(srcs, index) {
    photos = srcs;
    current = index;
    if (!lb) {
      lb = document.createElement('div');
      lb.className = 'photo-lightbox';
      lb.innerHTML = `
        <div class="photo-lightbox-img-wrap">
          <button class="photo-lightbox-nav photo-lightbox-nav--prev">&#8249;</button>
          <img class="photo-lightbox-img" alt="" draggable="false" />
          <button class="photo-lightbox-nav photo-lightbox-nav--next">&#8250;</button>
        </div>
        <div class="photo-lightbox-controls">
          <button class="photo-lightbox-btn" data-lb-zoom="-1">－</button>
          <button class="photo-lightbox-btn" data-lb-zoom="0">1:1</button>
          <button class="photo-lightbox-btn" data-lb-zoom="1">＋</button>
          <span class="photo-lightbox-counter"></span>
          <button class="photo-lightbox-btn" data-lb-close>✕</button>
        </div>
      `;

      // Zoom buttons + close
      lb.addEventListener('click', (e) => {
        if (dragging) return;
        if (e.target.dataset.lbClose !== undefined || e.target === lb) { close(); return; }
        const z = e.target.dataset.lbZoom;
        if (z === undefined) return;
        if (z === '0') { scale = 1; panX = 0; panY = 0; }
        else if (z === '1') scale = Math.min(scale + 0.5, 5);
        else { scale = Math.max(scale - 0.5, 0.5); if (scale === 1) { panX = 0; panY = 0; } }
        applyTransform();
      });

      // Wheel zoom
      const wrap = lb.querySelector('.photo-lightbox-img-wrap');
      wrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.min(5, Math.max(0.5, scale - e.deltaY * 0.001));
        if (scale === 1) { panX = 0; panY = 0; }
        applyTransform();
      }, { passive: false });

      // Drag to pan
      wrap.addEventListener('mousedown', (e) => {
        if (scale <= 1) return;
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panAtDragX = panX;
        panAtDragY = panY;
        wrap.classList.add('grabbing');
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panX = panAtDragX + (e.clientX - dragStartX);
        panY = panAtDragY + (e.clientY - dragStartY);
        applyTransform();
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove('grabbing');
        applyTransform();
      });

      // Nav arrows
      lb.querySelector('.photo-lightbox-nav--prev').addEventListener('click', (e) => { e.stopPropagation(); current = (current - 1 + photos.length) % photos.length; render(); });
      lb.querySelector('.photo-lightbox-nav--next').addEventListener('click', (e) => { e.stopPropagation(); current = (current + 1) % photos.length; render(); });

      document.body.appendChild(lb);
    }
    lb.style.display = 'flex';
    render();
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (lb) lb.style.display = 'none';
    dragging = false;
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', (e) => {
    if (!lb || lb.style.display === 'none') return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') { current = (current - 1 + photos.length) % photos.length; render(); }
    if (e.key === 'ArrowRight') { current = (current + 1) % photos.length; render(); }
  });

  window.openPhotoLightbox = function (srcs, index) { open(srcs, index); };
})();

async function runRefreshMetadataWorkflow() {
  const button = elements.refreshMetadataButton;
  const status = elements.refreshMetadataStatus;
  const logEl = elements.refreshMetadataLog;
  if (!button) return;

  button.disabled = true;
  button.textContent = "Refreshing Metadata...";
  if (status) status.textContent = "Starting...";
  if (logEl) logEl.textContent = "Refreshing TMDB metadata, cast, artwork and posters for your whole library...\n";

  try {
    let offset = 0;
    let total = 0;
    let success = 0;
    let failed = 0;
    let posters = 0;
    let hasMore = true;

    // The backend processes the library in time-boxed pages (metadata + artwork
    // cached, and the canonical poster stamped back onto every record). We just
    // drive the pages, retrying transient 503/504s (cold start / scaling).
    const fetchPage = async () => {
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch("/api/refresh-tmdb-metadata", {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ offset, limit: 8 }),
          });
          if (res.ok) return await res.json();
          if (res.status === 503 || res.status === 504 || res.status === 429) {
            lastErr = new Error(`HTTP ${res.status}`);
            if (logEl) { logEl.textContent += `(server busy, retrying...)\n`; logEl.scrollTop = logEl.scrollHeight; }
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      throw lastErr || new Error("Refresh page failed");
    };

    while (hasMore) {
      const data = await fetchPage();
      total = data.total || total;
      success += data.success || 0;
      failed += data.failed || 0;
      posters += data.postersWritten || 0;
      offset = data.nextOffset != null ? data.nextOffset : offset + 12;
      hasMore = !!data.hasMore;

      const percent = total ? Math.round((Math.min(offset, total) / total) * 100) : 100;
      if (status) status.textContent = `Progress: ${Math.min(offset, total)} of ${total} (${percent}%)`;
      if (logEl && Array.isArray(data.log)) {
        for (const line of data.log) logEl.textContent += line + "\n";
        logEl.scrollTop = logEl.scrollHeight;
      }
    }

    const summaryMsg = `Done! Refreshed ${success} items (failed: ${failed}), ${posters} posters stored.`;
    clearDerivedUiCaches();
    state.historyVersion = "";
    await loadHistory({ force: true });
    if (status) status.textContent = summaryMsg;
    if (logEl) {
      logEl.textContent += summaryMsg + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (err) {
    const msg = `Error: ${err.message}`;
    if (status) status.textContent = msg;
    if (logEl) {
      logEl.textContent += msg + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    }
  } finally {
    button.disabled = false;
    button.textContent = "Refresh Metadata Now";
  }
}

window.showCastMemberDetails = function (personId, personName) {
  state.personReturnUrl = window.location.pathname + window.location.hash;
  navigateTo(`/person/${personId}`);
};

function closePersonProfile() {
  if (elements.personModal) {
    elements.personModal.classList.add("hidden");
  }
  document.body.style.overflow = "";
  if (window.location.pathname.startsWith("/person/")) {
    const returnUrl = state.personReturnUrl;
    state.personReturnUrl = null;
    navigateTo(returnUrl || "/");
  }
}

async function loadCastMemberDetails(personId, personName = null) {
  state.personProfileName = personName || "";
  if (elements.personModal) {
    elements.personModal.classList.add("hidden");
  }
  document.body.style.overflow = "";

  state.activeView = "explorer";
  state.mediaDetailInline = true;
  clearMediaDetailState();

  // Don't use prepareInlineMediaDetail() here: it calls selectView("explorer"),
  // which rebuilds the URL from activeMovieModalId/activeShowModalKey (still set
  // from the underlying movie/show) and overwrites the /person/<id> URL we're on.
  // That breaks closeMediaDetail()'s "return to the media item" branch below.
  applyActiveView();
  elements.explorerPanel.innerHTML = "";
  elements.explorerPanel.scrollIntoView({ block: "start" });
  document.querySelector("#explorerBackButton")?.classList.remove("hidden");
  elements.explorerTopbarControls?.classList.add("hidden");

  const root = mediaDetailRoot();

  if (elements.explorerTitle) {
    elements.explorerTitle.textContent = personName || "Cast Member Profile";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = "";
  }
  syncPageTopbar();

  root.innerHTML = `
    <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
      <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading profile...</span>
    </div>
  `;

  try {
    // Fetch person data and all watched movies/shows in parallel so filmography
    // watched-status is accurate regardless of which explorer tabs have been visited.
    const [res, moviesRes, showsRes] = await Promise.all([
      fetch(`/api/tmdb-person?id=${personId}`, { headers: authHeaders() }),
      fetch(`/api/movies?limit=5000&sort=title_asc`, { headers: authHeaders(), cache: "no-store" }),
      fetch(`/api/shows?limit=5000&sort=title_asc`, { headers: authHeaders(), cache: "no-store" }),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const moviesBody = await moviesRes.json().catch(() => ({}));
    const showsBody = await showsRes.json().catch(() => ({}));

    // Build filmography-local lookups by tmdb_id and slug so findLibraryItem can
    // match even when the explorer hasn't been opened yet.
    const allWatchedMovies = Array.isArray(moviesBody.movies) ? moviesBody.movies : [];
    const allWatchedShows = Array.isArray(showsBody.shows) ? showsBody.shows : [];
    const filmographyLookup = { allWatchedMovies, allWatchedShows };

    if (elements.explorerTitle) {
      elements.explorerTitle.textContent = data.name || "Cast Member Profile";
    }
    state.personProfileName = data.name || "Cast Member Profile";
    syncPageTopbar();

    const castCredits = (data.combined_credits?.cast || []);
    const profileUrl = tmdbProfile(data.profile_path) || '/favicon.svg';

    // Initialize temporary filter/sort preferences on state if not set
    state.personCreditsFilter = state.personCreditsFilter || "all";
    state.personCreditsSort = state.personCreditsSort || "popularity";
    state.personCreditsVisible = FILMOGRAPHY_PAGE_SIZE;

    root.innerHTML = `
      <div class="person-profile-container" style="padding-top: var(--space-4);">
        <div class="person-profile-sidebar">
          <img class="person-profile-img" src="${escapeAttribute(profileUrl)}" alt="${escapeAttribute(data.name)}" data-err="fav" />
          <div class="person-profile-meta">
            <h3>Personal Info</h3>
            <div class="meta-item">
              <span class="meta-label">Known For</span>
              <span class="meta-value">${escapeHtml(data.known_for_department || "Acting")}</span>
            </div>
            ${data.birthday ? `
            <div class="meta-item">
              <span class="meta-label">Born</span>
              <span class="meta-value">${escapeHtml(data.birthday)}${!data.deathday && personAge(data.birthday) !== null ? ` (age ${personAge(data.birthday)})` : ''}${data.place_of_birth ? ` in ${escapeHtml(data.place_of_birth)}` : ''}</span>
            </div>
            ` : ''}
            ${data.deathday ? `
            <div class="meta-item">
              <span class="meta-label">Died</span>
              <span class="meta-value">${escapeHtml(data.deathday)}${personAge(data.birthday, data.deathday) !== null ? ` (aged ${personAge(data.birthday, data.deathday)})` : ''}</span>
            </div>
            ` : ''}
            ${(() => {
        const socials = personSocialLinks(data);
        if (!socials.length) return '';
        return `
              <div class="meta-item person-socials">
                <span class="meta-label">Socials</span>
                <span class="person-socials-links">
                  ${socials.map((s) => `<a class="person-social-link" href="${escapeAttribute(s.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a>`).join('')}
                </span>
              </div>`;
      })()}
          </div>
        </div>
        <div class="person-profile-content">
          ${data.biography ? `
          <div class="person-biography-section">
            <h3>Biography</h3>
            <p class="person-biography-text" style="white-space: pre-wrap;">${escapeHtml(data.biography)}</p>
          </div>
          ` : '<p class="muted-copy">No biography available for this cast member.</p>'}
          
          ${(() => {
        const seen = new Set();
        const addUnique = (list) => list.filter((img) => {
          if (!img.file_path || seen.has(img.file_path)) return false;
          seen.add(img.file_path);
          return true;
        });
        const profiles = addUnique(data.images?.profiles || []);
        // tagged_images are photos TMDB has tagged as featuring this person
        // (drop title posters so the gallery stays photos OF the person).
        const tagged = addUnique(
          (data.tagged_images?.results || []).filter((img) => img.image_type !== "poster")
        );
        const gallery = [...profiles, ...tagged].slice(0, 250);
        if (!gallery.length) return '';
        window._personPhotos = gallery.map((img) => tmdbProfile(img.file_path));
        return `
            <div class="person-photos-section" style="margin-top: 2rem;">
              <h3>Photos <span class="person-photos-count">${gallery.length}</span></h3>
              <div class="person-photos-grid">
                ${gallery.map((img, i) => `
                  <img class="person-photo-thumb" src="${escapeAttribute(tmdbProfile(img.file_path))}" loading="lazy" alt="${escapeAttribute(data.name)}" data-photo-index="${i}" data-err="hide" />
                `).join('')}
              </div>
            </div>`;
      })()}

          <div class="person-credits-section" style="margin-top: 2rem;">
            <div class="person-credits-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-4); border-bottom: 1px solid var(--line-strong); padding-bottom: var(--space-3);">
              <h3 style="margin: 0;">Filmography (<span id="personCreditsCount">${castCredits.length}</span>)</h3>
              <div class="person-credits-controls" style="display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap;">
                <div class="pill-toggle-group" id="personCreditsFilterBtns">
                  <button class="pill-toggle${state.personCreditsFilter === "movie" ? " active" : ""}" type="button" data-filter="movie">Movies</button>
                  <button class="pill-toggle${state.personCreditsFilter === "tv" ? " active" : ""}" type="button" data-filter="tv">TV Shows</button>
                </div>
                <div class="pill-toggle-group" id="personCreditsSortBtns">
                  <button class="pill-toggle${state.personCreditsSort === "popularity" ? " active" : ""}" type="button" data-sort="popularity">Popularity</button>
                  <button class="pill-toggle${state.personCreditsSort === "date_desc" ? " active" : ""}" type="button" data-sort="date_desc">Newest</button>
                  <button class="pill-toggle${state.personCreditsSort === "date_asc" ? " active" : ""}" type="button" data-sort="date_asc">Oldest</button>
                </div>
              </div>
            </div>
            <div class="person-credits-grid" id="personCreditsGrid">
              <div style="display: flex; justify-content: center; align-items: center; min-height: 100px; grid-column: 1 / -1;">
                <span style="color: var(--muted); font-size: 0.9rem;">Sorting filmography...</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const filterBtns = root.querySelector("#personCreditsFilterBtns");
    const sortBtns = root.querySelector("#personCreditsSortBtns");
    const gridEl = root.querySelector("#personCreditsGrid");
    const countEl = root.querySelector("#personCreditsCount");

    const renderCreditCards = (credits) => {
      const libraryTvCredits = [];
      const html = credits.map(credit => {
        const isTv = credit.media_type === "tv";
        const title = credit.title || credit.name || "Untitled";
        const character = credit.character || "Unknown Character";
        const posterUrl = tmdbPoster(credit.poster_path) || '/favicon.svg';
        const dateStr = credit.release_date || credit.first_air_date || "";
        const year = dateStr ? `(${dateStr.split("-")[0]})` : "";

        let libItem = findLibraryItem(credit.media_type, credit.id, title, filmographyLookup);
        if (!libItem && credit.in_library) {
          if (isTv) {
            libItem = {
              type: "show",
              key: credit.library_key,
              item: {
                title: credit.show_title || title,
                episode_count: credit.watched_count,
              }
            };
          } else {
            libItem = {
              type: "movie",
              id: credit.library_id
            };
          }
        }

        const isInLibrary = !!credit.in_library;
        const isWatched = !!(credit.in_watch_history || credit.in_library ||
          (!isTv && filmographyLookup.allWatchedMovies.some(m => String(m.tmdb_id || "") === String(credit.id))) ||
          (isTv && filmographyLookup.allWatchedShows.some(s => String(s.tmdb_id || "") === String(credit.id))));

        if (libItem && isInLibrary) {
          const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
          const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
          if (isTv) libraryTvCredits.push({ credit, libItem, title });
          const href = libItem.type === "tvshow" ? `/tvshow/${libItem.key}` : movieHref(movieBySlugOrId(libItem.id) || { id: libItem.id, title });
          return `
            <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
              <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
              <div class="person-credit-info">
                <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
                <span class="person-credit-badges">
                  <span class="library-badge">In Library</span>
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </div>
            </a>
          `;
        } else if (libItem && isWatched) {
          const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
          const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
          if (isTv) libraryTvCredits.push({ credit, libItem, title });
          const href = libItem.type === "tvshow" ? `/tvshow/${libItem.key}` : movieHref(movieBySlugOrId(libItem.id) || { id: libItem.id, title });
          return `
            <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
              <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
              <div class="person-credit-info">
                <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
                <span class="person-credit-badges">
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </div>
            </a>
          `;
        } else {
          const href = isTv ? `/tvshow/tmdb/${credit.id}` : `/movie/tmdb/${credit.id}`;
          return `
            <a class="person-credit-card" href="${escapeAttribute(href)}" data-tmdb-id="${credit.id}" data-tmdb-media-type="${credit.media_type}" data-tmdb-title="${escapeAttribute(title)}">
              <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
              <div class="person-credit-info">
                <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
              </div>
            </a>
          `;
        }
      }).join("");
      return { html, libraryTvCredits };
    };

    const updateGrid = (resetVisible = true) => {
      if (resetVisible) {
        state.personCreditsVisible = FILMOGRAPHY_PAGE_SIZE;
      }

      let filtered = [...castCredits];
      if (state.personCreditsFilter === "movie") {
        filtered = filtered.filter(c => c.media_type === "movie");
      } else if (state.personCreditsFilter === "tv") {
        filtered = filtered.filter(c => c.media_type === "tv");
      }

      if (state.personCreditsSort === "popularity") {
        filtered.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      } else if (state.personCreditsSort === "date_desc") {
        filtered.sort((a, b) => {
          const dateA = a.release_date || a.first_air_date || "";
          const dateB = b.release_date || b.first_air_date || "";
          if (!dateA) return 1;
          if (!dateB) return -1;
          return dateB.localeCompare(dateA);
        });
      } else if (state.personCreditsSort === "date_asc") {
        filtered.sort((a, b) => {
          const dateA = a.release_date || a.first_air_date || "";
          const dateB = b.release_date || b.first_air_date || "";
          if (!dateA) return 1;
          if (!dateB) return -1;
          return dateA.localeCompare(dateB);
        });
      }

      countEl.textContent = filtered.length;

      if (getFilmographyObserver()) { getFilmographyObserver().disconnect(); setFilmographyObserver(null); }

      if (filtered.length === 0) {
        gridEl.innerHTML = `<p class="muted-copy" style="grid-column: 1 / -1; text-align: center; padding: 2rem 0;">No matching filmography items found.</p>`;
        return;
      }

      const visibleCount = Math.min(state.personCreditsVisible, filtered.length);
      const page = filtered.slice(0, visibleCount);
      const hasMore = filtered.length > visibleCount;

      const { html, libraryTvCredits } = renderCreditCards(page);
      gridEl.innerHTML = html + (hasMore ? `<div class="filmography-load-sentinel" aria-hidden="true"></div>` : "");

      if (libraryTvCredits.length > 0) {
        hydratePersonFilmographyWatchStatuses(personId, libraryTvCredits);
      }

      if (hasMore) {
        const sentinel = gridEl.querySelector(".filmography-load-sentinel");
        if (sentinel) {
          setFilmographyObserver(new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting) return;
            state.personCreditsVisible += FILMOGRAPHY_PAGE_SIZE;
            updateGrid(false);
          }, { rootMargin: "600px" }));
          getFilmographyObserver().observe(sentinel);
        }
      }
    };

    filterBtns?.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill-toggle[data-filter]");
      if (!btn) return;
      const val = btn.dataset.filter;
      state.personCreditsFilter = state.personCreditsFilter === val ? "all" : val;
      filterBtns.querySelectorAll(".pill-toggle").forEach(b => b.classList.toggle("active", b.dataset.filter === state.personCreditsFilter));
      updateGrid();
    });

    sortBtns?.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill-toggle[data-sort]");
      if (!btn) return;
      state.personCreditsSort = btn.dataset.sort;
      sortBtns.querySelectorAll(".pill-toggle").forEach(b => b.classList.toggle("active", b.dataset.sort === state.personCreditsSort));
      updateGrid();
    });

    // Initial render of the grid
    updateGrid();

  } catch (err) {
    root.innerHTML = `
      <div style="display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 200px; gap: 1rem;">
        <span class="status-pill status-error" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Failed to load profile</span>
        <span style="color: var(--muted);">${escapeHtml(err.message)}</span>
      </div>
    `;
  }
}

window.openLibraryItem = function (mediaType, idOrKey, title, isLibraryItem = true, tmdbId = null) {
  const modal = elements.personModal;
  if (modal) modal.classList.add("hidden");

  if (isLibraryItem) {
    if (mediaType === "show" || mediaType === "tv") {
      navigateTo(`/tvshow/${idOrKey}`);
    } else if (mediaType === "movie") {
      navigateTo(movieHref(movieBySlugOrId(idOrKey) || { id: idOrKey, title }));
    }
  } else {
    if (mediaType === "show" || mediaType === "tv") {
      navigateTo(`/tvshow/tmdb/${tmdbId}`);
    } else if (mediaType === "movie") {
      navigateTo(`/movie/tmdb/${tmdbId}`);
    }
  }

  if (elements.debugModal && elements.debugModal.classList.contains("hidden")) {
    document.body.style.overflow = "";
  }
};

async function openShowImmersiveModalByTmdbId(tmdbId) {
  setMediaDetailActions("");
  state.activeShowTmdbId = String(tmdbId);
  syncInlineMediaDetailHeading("shows");
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();
  root.innerHTML = `
    <div class="immersive-container">
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading TV show details...</span>
      </div>
    </div>
  `;

  let tmdbData = await fetchTmdbDetails("tv", tmdbId, null);
  if (!tmdbData) {
    // The stored TMDB ID may not map to a valid show (e.g. episode-level ID from
    // Plex, or a show not yet indexed). Fall back to a title search using the
    // matching now-playing session title so first-watch shows still load.
    const matchingSession = state.activeSessions.find(
      (s) => String(s.ids?.tmdb || "") === String(tmdbId)
    );
    if (matchingSession) {
      const fallbackTitle = showTitleFrom(
        matchingSession.showTitle || matchingSession.show_title || matchingSession.title || ""
      );
      if (fallbackTitle) tmdbData = await fetchTmdbDetails("tv", null, fallbackTitle);
    }
  }
  if (!tmdbData) {
    root.innerHTML = `
      <div class="immersive-container">
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Could not load TV show details</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Please check your TMDB API Key in Settings.</span>
        </div>
      </div>
    `;
    return;
  }

  const showTitle = tmdbData.name || "Untitled TV Show";
  const seasons = [...(tmdbData.seasons || [])]
    .filter((season) => Number(season.season_number) > 0)
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));

  const seasonDetailsByNumber = new Map();
  await Promise.all([
    // Pull persisted watched state from the server so a fresh page load — where
    // state.showsRaw/state.history aren't populated yet — still reflects what is
    // already marked watched (otherwise the show looks unwatched after a refresh).
    loadShowDetail({ title: showTitle }).catch(() => null),
    ...seasons.map(async (season) => {
      const seasonNumber = Number(season.season_number);
      const details = await fetchTmdbSeasonDetails(tmdbData.id, seasonNumber);
      if (details) seasonDetailsByNumber.set(seasonNumber, details);
    }),
  ]);

  const existingShow = state.showsRaw.find((show) => (
    String(show.tmdb_id || "") === String(tmdbData.id) || slug(show.title) === slug(showTitle)
  ));
  const show = mergeShowWithLoadedHistory(existingShow || {
    title: showTitle,
    tmdb_id: String(tmdbData.id),
    episodes: [],
    episode_count: 0,
    season_count: seasons.length,
  });

  renderShowModalContent(show, {
    activeSeasonNum: state.activeShowModalSeason,
    tmdbData,
    seasonDetailsByNumber,
    loading: false,
    tmdbOnly: !existingShow,
  });
}

function findLibraryItem(mediaType, tmdbId, title, filmographyLookup = null) {
  const cleanTitle = slug(title);
  if (mediaType === "tv" || mediaType === "show") {
    // Check the full server-fetched list first (filmography page), then fall back
    // to the in-memory explorer state which may be only partially loaded.
    let found = (filmographyLookup?.allWatchedShows || []).find(
      s => String(s.tmdb_id || "") === String(tmdbId) || slug(s.title) === cleanTitle
    );
    if (!found) {
      found = state.showsRaw.find(s => String(s.tmdb_id || "") === String(tmdbId) || slug(s.title) === cleanTitle);
    }
    if (!found) {
      const historyRows = state.history.filter(h => h.media_type === "episode" && isWatchedHistoryAction(h) && (
        String(h.tmdb_id || "") === String(tmdbId) || slug(h.show_title || showTitleFrom(h.title)) === cleanTitle
      ));
      if (historyRows.length) {
        const histRow = historyRows[0];
        found = {
          title: histRow.show_title || showTitleFrom(histRow.title),
          id: histRow.tvdb_id || histRow.tmdb_id || histRow.show_title,
          tmdb_id: histRow.tmdb_id || tmdbId,
          episodes: historyRows,
          episode_count: new Set(historyRows.map((row) => showEpisodeKey(row.season, row.episode))).size,
        };
      }
    }
    return found ? { type: "show", key: slug(found.title), item: found } : null;
  } else {
    // Check the full server-fetched movies list first, then the partially-loaded explorer.
    let found = (filmographyLookup?.allWatchedMovies || []).find(
      m => String(m.tmdb_id || "") === String(tmdbId) || slug(m.title) === cleanTitle
    );
    if (!found) {
      found = state.moviesRaw.find(m => String(m.tmdb_id) === String(tmdbId) || slug(m.title) === cleanTitle);
    }
    if (!found) {
      found = state.history.find(h => h.media_type === "movie" && (String(h.tmdb_id) === String(tmdbId) || slug(h.title) === cleanTitle));
    }
    return found ? { type: "movie", id: found.id } : null;
  }
}

function libraryTvWatchProgress(libItem, tmdbData = null) {
  const show = libItem?.item || {};
  const watchedKeys = new Set();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    if (Number(episode.season || 0) <= 0) continue;
    watchedKeys.add(showEpisodeKey(episode.season, episode.episode));
  }
  const watched = watchedKeys.size || Number(show.episode_count || 0);
  const total = show.total_episodes || Number(tmdbData?.number_of_episodes || 0);
  return {
    watched,
    total,
    complete: total > 0 && watched >= total,
  };
}

function personWatchBadgeMarkup(progress, tmdbId) {
  if (!progress?.watched) return "";
  const label = progress.complete ? "Watched" : "Part watched";
  const count = progress.total > 0 ? `${progress.watched}/${progress.total}` : `${progress.watched} ep`;
  return `<span class="watch-state-badge ${progress.complete ? "is-complete" : "is-partial"}" data-person-watch-status="${escapeAttribute(tmdbId)}">${label} <small>${count}</small></span>`;
}

async function hydratePersonFilmographyWatchStatuses(personId, credits = []) {
  await Promise.all(credits.map(async ({ credit, libItem, title }) => {
    const tmdbData = await fetchTmdbDetails("tv", credit.id, title);
    if (window.location.pathname !== `/person/${personId}`) return;
    const progress = libraryTvWatchProgress(libItem, tmdbData);
    document.querySelectorAll(`[data-person-watch-status="${CSS.escape(String(credit.id))}"]`).forEach((badge) => {
      badge.className = `watch-state-badge ${progress.complete ? "is-complete" : "is-partial"}`;
      badge.innerHTML = `${progress.complete ? "Watched" : "Part watched"} <small>${progress.total > 0 ? `${progress.watched}/${progress.total}` : `${progress.watched} ep`}</small>`;
    });
  }));
}
