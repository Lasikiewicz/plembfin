import { buildAuthHeaders, buildNowPlayingUrl, currentUser, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./modules/auth.js";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./modules/logs.js";
import { applySettingsRoute, focusSettingsRoute, parseSettingsRoute, prepareSettingsShell, settingsPathForLegacy } from "./modules/settings-shell.js";
import { initSettingsServices, applyConfigToSettingsUi, refreshSeerrCapabilities, renderMediaServerCards, renderMetadataCards } from "./modules/settings-services.js";
import { state, elements, ACTIVE_VIEW_KEY, ACTIVE_SETTINGS_TAB_KEY, EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS, EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS, HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS, HISTORY_VIEW_KEY, HISTORY_FILTER_KEY, HISTORY_VIEW_MODES, HISTORY_FILTERS, PRIMARY_VIEWS } from "./modules/state.js";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, slug, movieSlug, movieHref, showName, showTitleFrom, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDate, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader, formatTmdbDate, ordinalDay, formatLongAiringDate, knownShowAirtime, formatEpisodeAirtime, showEpisodeKey, episodeCode, seasonLabel } from "./modules/utils.js";
import { buildWebhookUrl, renderSettingsInlineHelp } from "./modules/help-content.js";
import { isCachedStorageImageUrl, compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, rememberPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, tmdbProfile } from "./modules/images.js";
import { initTools, APPEARANCE_DEFAULTS, setBackupTransferState, exportPlembfinBackup, readPlembfinBackup, importPlembfinBackup, renderWatchBackups, loadRemoteBackupsForRestoreTab, loadCacheStats, renderCachePanel, loadWatchBackups, postWatchBackupAction, applyAppearanceToBody, loadAppearanceSettings, saveAppearanceSettings, saveWatchBackupSettings, createWatchBackupNow, downloadWatchBackup, uploadWatchBackupFile, restoreWatchBackup, parseSelectedFiles, renderImportPreview, renderImportActivity, startImport, runRepairWorkflow, runDedupHistory, runTraktBackfill, runFullSyncWatchstates, runSystemIntegrityCheck, triggerClearMissingTelemetry, triggerRetryAllCategory, loadPlembfinBackups, renderPlembfinBackups } from "./modules/tools.js";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, showAvailIssuePopup, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling, triggerRetrySync, triggerCronSync, triggerStopSync, triggerForceSync } from "./modules/sync.js";
import { initDashboard, getRowFitLimit, mediaRecordIdentity, dedupeMediaRecords, progressRecordIdentity, dedupePlaybackProgress, renderHistoryCard, observeDashboardPosters, renderDashboard, updateDashboardSplitState, resetPartWatchedView, renderPartWatchedCard, renderPartWatched, loadPartWatched } from "./modules/dashboard.js";
import { initStats, formatListDate, futureListDate, showStatusLabel, nextAiringDateValue, nextAiringCell, statsReports, statsPeriodLabel, syncStatsPeriodOptions, selectedStatsReport, statsFilteredRows, statsPeriodNoun, statsTrackingSpanText, statsPlatformLabel, statsSelectedMediaLabel, statsIntroCards, renderStatsKpis, renderStatsLeaderboard, renderStatsMoviesTvSplit, renderStatsPlatformRows, renderStatsBookends, renderMonthChart, renderStats, loadStats, renderRankingTable } from "./modules/stats.js";
import { initUpcoming, renderUpcoming, loadUpcoming } from "./modules/upcoming.js";
import { initExplorer, syncExplorerControlsState, syncInlineMediaDetailHeading, triggerSearchPage, renderSearchPage, renderExplorer, explorerQueryKey, updateAlphaFilter, handleAlphaFilterClick, resetMovieExplorer, resetShowExplorer, renderExplorerSentinel, observeExplorerSentinel, observeExplorerTmdbPrefetch, scheduleNextAirResort, currentExplorerView, currentExplorerSort, currentPosterWidthKey, setCurrentExplorerSort, applyExplorerPosterWidth, applyListHeaderSort, renderMovieCard, renderMovieExplorer, loadExplorerMovies, applyHistoryPosterWidth, resetHistoryView, renderHistoryItems, renderHistoryView, loadHistoryView, observeHistorySentinel, renderShowExplorer, loadExplorerShows, mergeShowDetail, loadShowDetail, matchesExplorerSearch, sortExplorerItems, renderShowRecord, renderShowFolder, renderSeasonFolder, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, emptyExplorer, FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver } from "./modules/explorer.js";
import { initEditDialogs, openEditDateDialog, openEditShowDateDialog, openEditSeasonDateDialog, openEditImageDialog, openFixMatchDialog, openMergeShowDialog, applyWatchedAtToLocalWatchRecord, editDateOptionsFromButton } from "./modules/edit-dialogs.js";
import { initWatchAction, rerenderWatchDateCustomPicker, openWatchDatePrompt, closeWatchDatePrompt, submitSeerrRequest, markMovieWatched, refreshShowAfterManualWatch, applyWatchDateChoice, confirmAndMarkUnwatched, confirmAndDeleteMedia } from "./modules/watch-action.js";
import { fetchTmdbDetails, fetchTmdbSeasonDetails, resolveEpisodeTitleFromTmdb } from "./modules/tmdb.js?v=20260710";
import { initMediaDetail, movieBySlugOrId, nowPlayingHref, openMovieInlineDetail, openShowInlineDetail, clearMediaDetailState, syncMediaActionsMenuState, syncTopbarControlsMenuState, closeDebugModal, closeMediaDetail, renderImmersiveShowModal, renderMovieImmersiveModalContent, openMovieImmersiveModalByTmdbId, openShowImmersiveModalByTmdbId, openHistoryDebugModal, fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus, patchMovieWatchedState } from "./modules/media-detail.js?v=20260701";
import { initMediaPerson, closePersonProfile, loadCastMemberDetails } from "./modules/media-person.js";
import { initMediaLightbox } from "./modules/media-lightbox.js";
import { initAppEvents } from "./modules/app-events.js";

// Ping the backend the moment the app loads (no auth needed), so the server's
// caches and upstream connections are warm by the time the user clicks into
// anything. A light keep-alive repeats the ping while the tab is visible.
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
    confirmModalMedia: document.querySelector("#confirmModalMedia"),
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
    sidebarAppearanceWrap: document.querySelector("#sidebarAppearanceWrap"),
    sidebarAppearanceButton: document.querySelector("#sidebarAppearanceButton"),
    sidebarAppearancePanel: document.querySelector("#sidebarAppearancePanel"),
    sidebarAppearanceDashboardGroup: document.querySelector("#sidebarAppearanceDashboardGroup"),
    sidebarAppearanceMediaGroup: document.querySelector("#sidebarAppearanceMediaGroup"),
    historyPanel: document.querySelector("#historyPanel"),
    alphaFilterNav: document.querySelector("#alphaFilterNav"),
    explorerSearchInput: document.querySelector("#explorerSearchInput"),
    historySearchInput: document.querySelector("#historySearchInput"),
    historyFilterButtons: [...document.querySelectorAll("[data-history-filter]")],
    historyViewButtons: [...document.querySelectorAll("[data-history-view]")],
    dashboardHistoryViewButtons: [...document.querySelectorAll("[data-dashboard-history-view]")],
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
    backupExportButton: document.querySelector("#createPlembfinBackupButton"),
    backupExportPassphrase: document.querySelector("#backupExportPassphrase"),
    backupExportRememberPassphrase: document.querySelector("#backupExportRememberPassphrase"),
    backupExportLog: document.querySelector("#backupExportLog"),
    backupExportStatus: document.querySelector("#plembfinBackupSummary"),
    backupImportButton: document.querySelector("#backupImportButton"),
    backupImportFile: document.querySelector("#backupImportFile"),
    backupRestorePassphrase: document.querySelector("#backupRestorePassphrase"),
    backupRestoreLog: document.querySelector("#backupRestoreLog"),
    backupRestoreStatus: document.querySelector("#backupRestoreStatus"),
    plembfinBackupSummary: document.querySelector("#plembfinBackupSummary"),
    plembfinBackupEnabled: document.querySelector("#plembfinBackupEnabled"),
    plembfinBackupTime: document.querySelector("#plembfinBackupTime"),
    plembfinBackupRetention: document.querySelector("#plembfinBackupRetention"),
    savePlembfinBackupConfigButton: document.querySelector("#savePlembfinBackupConfigButton"),
    createPlembfinBackupButton: document.querySelector("#createPlembfinBackupButton"),
    plembfinBackupRuntime: document.querySelector("#plembfinBackupRuntime"),
    plembfinBackupList: document.querySelector("#plembfinBackupList"),
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
    remoteWatchBackupList: document.querySelector("#remoteWatchBackupList"),
    backupDestinationCards: document.querySelector("#backupDestinationCards"),
    plembfinBackupRemoteEnabled: document.querySelector("#plembfinBackupRemoteEnabled"),
    plembfinBackupRemotePassphrase: document.querySelector("#plembfinBackupRemotePassphrase"),
    plembfinBackupRemoteRememberPassphrase: document.querySelector("#plembfinBackupRemoteRememberPassphrase"),
    savePlembfinBackupRemoteButton: document.querySelector("#savePlembfinBackupRemoteButton"),
    plembfinBackupRemoteRuntime: document.querySelector("#plembfinBackupRemoteRuntime"),
    appearShowLogoArt: document.querySelector("#appearShowLogoArt"),
    appearShowCast: document.querySelector("#appearShowCast"),
    appearShowTrailers: document.querySelector("#appearShowTrailers"),
    appearShowReviews: document.querySelector("#appearShowReviews"),
    appearShowImages: document.querySelector("#appearShowImages"),
    appearShowRelated: document.querySelector("#appearShowRelated"),
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
    syncProgress: document.querySelector("#syncProgress"),
    syncProgressLabel: document.querySelector("#syncProgressLabel"),
    syncProgressMeta: document.querySelector("#syncProgressMeta"),
    syncProgressTrack: document.querySelector("#syncProgressTrack"),
    syncProgressFill: document.querySelector("#syncProgressFill"),
    syncIssuesToggle: document.querySelector("#syncIssuesToggle"),
    syncIssuesContent: document.querySelector("#syncIssuesContent"),
    syncIssuesToggleIcon: document.querySelector("#syncIssuesToggleIcon"),
    syncHistoryToggle: document.querySelector("#syncHistoryToggle"),
    syncHistoryContent: document.querySelector("#syncHistoryContent"),
    syncHistoryToggleIcon: document.querySelector("#syncHistoryToggleIcon"),
    syncToolsToggle: document.querySelector("#syncToolsToggle"),
    syncToolsContent: document.querySelector("#syncToolsContent"),
    syncToolsToggleIcon: document.querySelector("#syncToolsToggleIcon"),
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
    rematchTvButton: document.querySelector("#rematchTvButton"),
    rematchTvStatus: document.querySelector("#rematchTvStatus"),
    rematchTvLog: document.querySelector("#rematchTvLog"),
    settingsUsername: document.querySelector("#settingsUsername"),
    settingsForm: document.querySelector("#settingsForm"),
    settingsStatus: document.querySelector("#settingsStatus"),
    settingsPanels: [...document.querySelectorAll("[data-settings-panel]")],
    sourceRanking: document.querySelector("#sourceRanking"),
    statsMediaFilter: document.querySelector("#statsMediaFilter"),
    statsPeriodType: document.querySelector("#statsPeriodType"),
    statsPeriodValue: document.querySelector("#statsPeriodValue"),
    upcomingCalendar: document.querySelector("#upcomingCalendar"),
    upcomingTopbarControls: document.querySelector("#upcomingTopbarControls"),
    upcomingMonthTitle: document.querySelector("#upcomingMonthTitle"),
    upcomingPrevButton: document.querySelector("#upcomingPrevButton"),
    upcomingNextButton: document.querySelector("#upcomingNextButton"),
    upcomingTodayButton: document.querySelector("#upcomingTodayButton"),
    upcomingSearchInput: document.querySelector("#upcomingSearchInput"),
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
    saveAdminCredentialsButton: document.querySelector("#saveAdminCredentialsButton"),
    webhookUrl: document.querySelector("#webhookUrl"),
    rotateWebhookButton: document.querySelector("#rotateWebhookButton"),
    runCompleteCheckButton: document.querySelector("#runCompleteCheckButton"),
    refreshCacheStatsButton: document.querySelector("#refreshCacheStatsButton"),
    completeCheckResults: document.querySelector("#completeCheckResults"),
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
      if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "changelog") renderChangelog().catch(() => { });
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

  if (!movies.length && !shows.length && !finalPeople.length && !discoveryState?.loading && !discoveryState?.error) return;

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
    ${discoveryState?.error ? `<div class="gsd-error" role="status">${escapeHtml(discoveryState.error)}</div>` : ""}
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
    if (!response.ok) {
      const error = new Error(body.error || `Search failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    state.globalDiscoveryResults.set(normalized, { loading: false, results: body.results || [] });
  } catch (error) {
    const message = error.status === 504 || /timed out/i.test(error.message || "")
      ? "TMDB is taking too long to respond. Local results are still available; try again shortly."
      : "TMDB results are unavailable right now. Local results are still available; try again.";
    state.globalDiscoveryResults.set(normalized, { loading: false, results: [], error: message });
    console.warn("TMDB discovery search unavailable", error);
  }
  if (token === state.globalSearchRequestToken && elements.globalSearchInput?.value.trim().toLowerCase() === normalized) {
    renderGlobalSearchDropdown(query);
  }
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
  setLoginAutocompleteEnabled(!isUnlocked);
  if (elements.statusPill) {
    elements.statusPill.className = `session-dot ${isUnlocked ? "unlocked" : "locked"}`;
    elements.statusPill.setAttribute("aria-label", isUnlocked ? "Unlocked session" : "Locked session");
    elements.statusPill.title = isUnlocked ? "Unlocked" : "Locked";
  }
}

function setLoginAutocompleteEnabled(enabled) {
  const fields = [
    { element: elements.adminEmail, autocomplete: "username" },
    { element: elements.adminToken, autocomplete: "current-password" },
  ];
  elements.authForm?.setAttribute("autocomplete", enabled ? "on" : "off");
  for (const attr of ["data-lpignore", "data-1p-ignore"]) {
    if (enabled) elements.authForm?.removeAttribute(attr);
    else elements.authForm?.setAttribute(attr, "true");
  }
  for (const { element, autocomplete } of fields) {
    if (!element) continue;
    element.setAttribute("autocomplete", enabled ? autocomplete : "off");
    for (const attr of ["data-lpignore", "data-1p-ignore"]) {
      if (enabled) element.removeAttribute(attr);
      else element.setAttribute(attr, "true");
    }
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
    state.activeSettingsRoute = parseSettingsRoute("/settings/account/login", { mustChangePassword: true });
    document.body.classList.add("pw-change-required");
  } else {
    existing?.remove();
    document.body.classList.remove("pw-change-required");
  }
}

function isConfigSensitiveRoute(path = "") {
  return path.startsWith("/movie/")
    || path.startsWith("/tvshow/")
    || path.startsWith("/person/")
    || path.startsWith("/search")
    || path.startsWith("/settings")
    || path.startsWith("/sync")
    || path.startsWith("/logs");
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
  } else if (pathname === "/upcoming") {
    state.activeView = "upcoming";
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
  } else if (pathname === "/sync" || pathname === "/logs" || pathname.startsWith("/settings")) {
    state.activeView = "settings";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    state.activeSettingsRoute = parseSettingsRoute(pathname, { mustChangePassword: state.mustChangePassword });
    state.activeSettingsTab = state.activeSettingsRoute.group;
    if (state.activeSettingsRoute.path !== pathname) {
      history.replaceState(history.state, "", state.activeSettingsRoute.path);
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
  const settingsRouteChanged = url.startsWith("/settings") && currentUrl.split("#")[0] !== url.split("#")[0];
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
  if (settingsRouteChanged) requestAnimationFrame(() => focusSettingsRoute(state.activeSettingsRoute));
}

function selectView(view) {
  if (state.mustChangePassword && view !== "settings") {
    navigateTo("/settings/account/login");
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
    url = legacySettingsTab ? settingsPathForLegacy(legacySettingsTab) : "/settings";

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
  return state.activeSettingsRoute?.title === "Settings overview"
    ? "Settings"
    : `Settings - ${state.activeSettingsRoute?.title || "Overview"}`;
}



function syncPageTopbar() {
  if (!elements.pageTopbar) return;

  const path = window.location.pathname;
  const query = new URLSearchParams(window.location.search);
  const isPersonDetail = path.startsWith("/person/");
  const isInlineDetail = state.mediaDetailInline || isPersonDetail;
  const isMobile = window.matchMedia("(max-width: 640px)").matches;
  const controlGroups = [
    elements.explorerTopbarControls,
    elements.historyTopbarControls,
    elements.searchTopbarControls,
    elements.statsTopbarControls,
    elements.upcomingTopbarControls,
    elements.settingsSubMenu,
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
        const activeMovie =
          state.history?.find(h => h.id === state.activeMovieModalId) ||
          state.moviesRaw?.find(movie => String(movie.id) === String(state.activeMovieModalId));
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
  } else if (state.activeView === "upcoming") {
    title = "Upcoming";
    subtitle = "";
    activeControls = elements.upcomingTopbarControls;
  } else if (state.activeView === "settings") {
    title = settingsTopbarTitle();
    subtitle = "";
    activeControls = null;

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

  if (!isMobile && state.activeView === "settings" && elements.settingsSubMenu) {
    elements.settingsSubMenu.classList.remove("hidden");
  }


  if (elements.topbarControlsMenu) {
    elements.topbarControlsMenu.classList.add("hidden");
  }

  const mediaDetailActions = document.getElementById("mediaDetailActions");
  if (elements.pageTopbarActions) {
    if (activeControls) {
      const targetNextSibling = mediaDetailActions || null;
      if (activeControls.parentElement !== elements.pageTopbarActions || activeControls.nextSibling !== targetNextSibling) {
        elements.pageTopbarActions.insertBefore(activeControls, targetNextSibling);
      }
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

  const settingsSubMenu = document.querySelector("#sidebarSettingsMenu");
  if (settingsSubMenu) {
    settingsSubMenu.classList.toggle("hidden", state.activeView !== "settings");
  }
  if (state.activeView === "dashboard") {
    applyCachedDashboardHistory();
    renderDashboard();
    if (state.token) loadHistory().catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView === "stats") {
    renderStats();
    loadStats().catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView === "upcoming") {
    renderUpcoming();
    loadUpcoming({ force: true }).catch((error) => setMessage(error.message, "error"));
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

  const showDashboardAppearance = state.activeView === "dashboard";
  const showMediaAppearance = Boolean(state.mediaDetailInline) && !window.location.pathname.startsWith("/person/");
  const showSidebarAppearance = showDashboardAppearance || showMediaAppearance;
  if (elements.sidebarAppearanceWrap) {
    elements.sidebarAppearanceWrap.classList.toggle("hidden", !showSidebarAppearance);
    if (!showSidebarAppearance) {
      elements.sidebarAppearancePanel?.classList.add("hidden");
      elements.sidebarAppearanceButton?.setAttribute("aria-expanded", "false");
    }
  }
  elements.sidebarAppearanceDashboardGroup?.classList.toggle("hidden", !showDashboardAppearance);
  elements.sidebarAppearanceMediaGroup?.classList.toggle("hidden", !showMediaAppearance);
  for (const button of elements.dashboardHistoryViewButtons || []) {
    button.classList.toggle("active", button.dataset.dashboardHistoryView === state.dashboardHistoryViewMode);
  }

  if (state.activeView === "settings") {
    renderSettingsInlineHelp();
    const route = state.activeSettingsRoute || parseSettingsRoute(window.location.pathname, { mustChangePassword: state.mustChangePassword });
    state.activeSettingsRoute = route;
    state.activeSettingsTab = route.group;
    localStorage.setItem(ACTIVE_SETTINGS_TAB_KEY, route.group);
    applySettingsRoute(route);
    if (route.panel === "apps") renderMediaServerCards();
    if (route.panel === "api-keys") renderMetadataCards();
    if (route.panel === "sync") {
      renderSyncJobs();
      renderSyncHistory();
      loadSyncJobs().catch((error) => setMessage(error.message, "error"));
      loadSyncHistory().catch((error) => setMessage(error.message, "error"));
    }
    if (route.panel === "backups") {
      state.activeBackupsTab = route.backupTab || "settings";
      renderWatchBackups();
      loadWatchBackups().catch((error) => setMessage(error.message, "error"));
      renderPlembfinBackups();
      loadPlembfinBackups().catch((error) => setMessage(error.message, "error"));
      if (state.activeBackupsTab === "restore" && !state.remoteBackupFilesLoading && !state.remoteBackupFiles.length) {
        loadRemoteBackupsForRestoreTab().catch((error) => setMessage(error.message, "error"));
      }
    }
    if (route.panel === "logs") renderLogs().catch(() => { });
    if (route.panel === "changelog") renderChangelog().catch(() => { });
    if (route.panel === "cache") {
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
  applyConfigToSettingsUi(body.config || {});
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

async function loadHistory({ force = false } = {}) {
  if (state.historyLoadPromise) return state.historyLoadPromise;

  state.historyLoadPromise = (async () => {
    if (!force) applyCachedDashboardHistory();

    const url = new URL("/api/history", window.location.origin);
    url.searchParams.set("limit", String(HISTORY_PREVIEW_LIMIT));
    url.searchParams.set("stats", "0");
    url.searchParams.set("preview", "dashboard");

    // The dashboard preview response is served with Cache-Control: max-age=30
    // so routine loads/polls can reuse the browser's HTTP cache. A forced
    // refresh (e.g. right after marking something watched) needs to bypass
    // that cache, or it can silently hand back a pre-mutation response for
    // up to 30s — the "watched" item would then be missing from the
    // dashboard's watch-history row until the cache naturally expired.
    const response = await fetch(url, { headers: authHeaders(), cache: force ? "no-store" : "default" });
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
    if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "sync") {
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
  const shouldRefresh = state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs" && state.token;
  if (shouldRefresh && !state.logsRefreshInterval) {
    renderLogs().catch(() => { });
    state.logsRefreshInterval = window.setInterval(() => {
      if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs") {
        renderLogs().catch(() => { });
      }
    }, 3000);
  } else if (!shouldRefresh && state.logsRefreshInterval) {
    window.clearInterval(state.logsRefreshInterval);
    state.logsRefreshInterval = undefined;
  }
}

function refreshHelpIfVisible() {}

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
  applyConfigToSettingsUi({});
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


function showConfirmModal(message, onApprove, options = {}) {
  if (!elements.confirmModal || !elements.confirmModalMessage) return;

  const titleEl = document.getElementById("confirmModalTitle") || elements.confirmModal.querySelector("h2");
  if (titleEl) {
    titleEl.textContent = options.title || "Confirm Sync";
  }
  const cancelBtn = elements.cancelConfirmButton;
  if (cancelBtn) cancelBtn.style.display = "";

  elements.approveConfirmButton.textContent = "Approve";

  if (elements.confirmModalMedia) {
    if (options.mediaHtml) {
      elements.confirmModalMedia.innerHTML = options.mediaHtml;
      elements.confirmModalMedia.classList.remove("hidden");
    } else {
      elements.confirmModalMedia.innerHTML = "";
      elements.confirmModalMedia.classList.add("hidden");
    }
  }

  elements.confirmModalMessage.style.whiteSpace = "pre-wrap";
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

  if (elements.confirmModalMedia) {
    elements.confirmModalMedia.innerHTML = "";
    elements.confirmModalMedia.classList.add("hidden");
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
    resolutionInstructions = "\n\n👉 How to Resolve:\nCheck Settings → Logs for a detailed traceback, then test the media server credentials under Settings → Media Servers.";
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

function primeSensitiveRouteState(path = "") {
  const pathname = path.split("?")[0].split("#")[0];
  if (pathname === "/sync" || pathname === "/logs" || pathname.startsWith("/settings")) {
    state.activeView = "settings";
    state.activeSettingsRoute = parseSettingsRoute(pathname, { mustChangePassword: state.mustChangePassword });
    state.activeSettingsTab = state.activeSettingsRoute.group;
    return true;
  }
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
  prepareSettingsShell();
  initSettingsServices({
    setMessage,
    clearDerivedUiCaches,
    renderDashboard,
    renderActiveSessions,
  });
  initTools({
    setMessage,
    openConfirmDialog,
    showConfirmModal,
    loadSavedConfig,
    loadHistory,
    loadActiveSessions,
    loadStats,
    clearDerivedUiCaches,
    loadSyncJobs,
    loadSyncHistory,
  });
  initMediaDetail({
    setMessage,
    navigateTo,
    selectView,
    syncPageTopbar,
    renderExplorer,
    renderSearchPage,
    loadExplorerMovies,
    loadExplorerShows,
    closePersonProfile,
  });
  initMediaPerson({
    setMessage,
    navigateTo,
    authHeaders,
    applyActiveView,
    syncPageTopbar,
  });
  initEditDialogs({
    setMessage,
    clearDerivedUiCaches,
    renderImmersiveShowModal,
    openShowImmersiveModalByTmdbId,
    navigateTo,
  });
  const renderActiveView = () => {
    if (state.activeView === "dashboard") renderDashboard();
    if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
    if (state.activeView === "history") renderHistoryView();
  };
  initWatchAction({
    setMessage,
    openConfirmDialog,
    clearDerivedUiCaches,
    loadHistory,
    closeMediaDetail,
    renderActiveView,
    showErrorExplainModal,
    fetchSeerrMediaStatus,
    refreshActiveMediaDetailAfterSeerrStatus,
    renderImmersiveShowModal,
    openShowImmersiveModalByTmdbId,
    openMovieImmersiveModalByTmdbId,
    patchMovieWatchedState,
  });
  initMediaLightbox();
  initSync({
    logDebug,
    loadHistory,
    resetPartWatchedView,
    renderPartWatched,
    setMessage,
    updateDashboardSplitState,
    nowPlayingHref,
    clearDerivedUiCaches,
    renderDashboard,
    renderStats,
    loadSyncJobs,
    loadSyncHistory,
    renderExplorer,
    renderImmersiveShowModal,
    showToast,
    showConfirmModal,
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
  initUpcoming({
    navigateTo,
    setMessage,
  });
  loadAppVersion();
  bootstrapTokenFromUrl();
  const initialPath = window.location.pathname + window.location.search + window.location.hash;
  if (isConfigSensitiveRoute(initialPath)) {
    primeSensitiveRouteState(initialPath);
  } else {
    handleRouting(initialPath);
  }
  initAppEvents({
    authHeaders,
    setMessage,
    unlockWithToken,
    clearSearchInputs,
    selectView,
    renderLogs,
    logsText,
    copyToClipboard,
    selectBackupsTab,
    navigateTo,
    renderChangelog,
    lockDashboard,
    toggleTheme,
    closeDebugModal,
    closePersonProfile,
    showConfirmModal,
    closeMediaDetail,
    closeGlobalSearchDropdown,
    openHistoryDebugModal,
    saveAdminCredentials,
    applyActiveView,
    handleRouting,
    loadHistory,
    loadStats,
    loadSavedConfig,
    renderDbStatus,
    showErrorExplainModal,
    runRefreshMetadataWorkflow,
    showToast,
    logDebug,
    syncPageTopbar,
    loadStats,
    setUnlocked,
    renderSettingsStatus,
    renderAdminCredentialsStatus,
    toggleSet,
    renderGlobalSearchDropdown,
    loadGlobalDiscovery,
  });
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
  applyConfigToSettingsUi({});
  renderDashboard();
  renderActiveSessions();
  renderStats();
  if (!state.mediaDetailInline) renderExplorer();
  renderLogs().catch(() => { });
  renderImportPreview();
  renderWatchBackups();
  renderPlembfinBackups();
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

async function runRefreshMetadataWorkflow() {
  const button = elements.refreshMetadataButton;
  const status = elements.refreshMetadataStatus;
  const logEl = elements.refreshMetadataLog;
  if (!button) return;

  button.disabled = true;
  button.textContent = "Refreshing Metadata...";
  if (status) status.textContent = "Starting...";
  if (status) status.className = "status-pill status-warning";
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
      if (status) status.className = "status-pill status-warning";
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
    if (status) status.className = "status-pill status-ready";
    if (logEl) {
      logEl.textContent += summaryMsg + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (err) {
    const msg = `Error: ${err.message}`;
    if (status) status.textContent = msg;
    if (status) status.className = "status-pill status-error";
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
