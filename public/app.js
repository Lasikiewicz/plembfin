import { buildAuthHeaders, buildNowPlayingUrl, currentUser, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./modules/auth.js";
import { initOnboarding, loadSetupStatus, renderSetupPage, setClaimRequired } from "./modules/onboarding.js";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs, formatLogLineToHtml } from "./modules/logs.js";
import { applySettingsRoute, focusSettingsRoute, parseSettingsRoute, prepareSettingsShell, scrollToSettingsSection, settingsPathForLegacy } from "./modules/settings-shell.js";
import { initSettingsServices, applyConfigToSettingsUi, refreshSeerrCapabilities, renderMediaServerCards, renderMetadataCards } from "./modules/settings-services.js";
import { state, elements, ACTIVE_VIEW_KEY, ACTIVE_SETTINGS_TAB_KEY, EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS, EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS, HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS, HISTORY_VIEW_KEY, HISTORY_FILTER_KEY, HISTORY_VIEW_MODES, HISTORY_FILTERS, PRIMARY_VIEWS } from "./modules/state.js";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, slug, movieSlug, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, showName, showTitleFrom, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDate, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader, formatTmdbDate, ordinalDay, formatLongAiringDate, knownShowAirtime, formatEpisodeAirtime, showEpisodeKey, episodeCode, seasonLabel } from "./modules/utils.js?v=20260824h";
import { buildWebhookUrl, renderSettingsInlineHelp } from "./modules/help-content.js";
import { isCachedStorageImageUrl, compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, rememberPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, tmdbProfile, proxiedArtworkUrl } from "./modules/images.js?v=20260826b";
import { initTools, APPEARANCE_DEFAULTS, setBackupTransferState, exportPlembfinBackup, readPlembfinBackup, importPlembfinBackup, renderWatchBackups, loadRemoteBackupsForRestoreTab, loadCacheStats, renderCachePanel, loadWatchBackups, postWatchBackupAction, applyAppearanceToBody, loadAppearanceSettings, saveAppearanceSettings, saveWatchBackupSettings, createWatchBackupNow, downloadWatchBackup, uploadWatchBackupFile, restoreWatchBackup, parseSelectedFiles, renderImportPreview, renderImportActivity, startImport, runRepairWorkflow, runPhantomWatchAudit, runPhantomWatchRepair, runTraktBackfill, runSystemIntegrityCheck, triggerClearMissingTelemetry, triggerRetryAllCategory, loadPlembfinBackups, renderPlembfinBackups, runDuplicateWatchCleanup } from "./modules/tools.js?v=20260810";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, showAvailIssuePopup, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling, triggerRetrySync, triggerCronSync, triggerStopSync, triggerForceSync, isSyncProgressActive } from "./modules/sync.js";
import { renderSyncActivity, renderSyncActivityStatus, setSyncActivityProgress, setSyncActivitySearch, loadSyncActivity, downloadSyncActivityLog, retrySyncActivity, toggleSyncActivityRowLog, toggleSyncActivityFailedOnly, startSyncActivityRefresh, stopSyncActivityRefresh } from "./modules/sync-activity.js";
import { initSyncPreview } from "./modules/sync-preview.js";
import { initDashboard, getRowFitLimit, mediaRecordIdentity, dedupeMediaRecords, progressRecordIdentity, dedupePlaybackProgress, renderHistoryCard, observeDashboardPosters, renderDashboard, updateDashboardSplitState, resetPartWatchedView, renderPartWatchedCard, renderPartWatched, loadPartWatched } from "./modules/dashboard.js?v=20260826b";
import { initStats, formatListDate, futureListDate, showStatusLabel, nextAiringDateValue, nextAiringCell, statsReports, statsPeriodLabel, syncStatsPeriodOptions, selectedStatsReport, statsFilteredRows, statsPeriodNoun, statsTrackingSpanText, statsPlatformLabel, statsSelectedMediaLabel, statsIntroCards, renderStatsKpis, renderStatsLeaderboard, renderStatsMoviesTvSplit, renderStatsPlatformRows, renderStatsBookends, renderMonthChart, renderStats, loadStats, renderRankingTable } from "./modules/stats.js";
import { initUpcoming, openUpcomingToToday } from "./modules/upcoming.js";
import { initExplorer, syncExplorerControlsState, syncInlineMediaDetailHeading, triggerSearchPage, renderSearchPage, renderExplorer, explorerQueryKey, updateAlphaFilter, handleAlphaFilterClick, resetMovieExplorer, resetShowExplorer, renderExplorerSentinel, observeExplorerSentinel, observeExplorerTmdbPrefetch, scheduleNextAirResort, currentExplorerView, currentExplorerSort, currentPosterWidthKey, setCurrentExplorerSort, applyExplorerPosterWidth, applyListHeaderSort, renderMovieCard, renderMovieExplorer, loadExplorerMovies, applyHistoryPosterWidth, renderHistoryItems, renderHistoryView, loadHistoryView, observeHistorySentinel, refreshMovieExplorerInPlace, refreshHistoryViewInPlace, renderShowExplorer, loadExplorerShows, mergeShowDetail, loadShowDetail, matchesExplorerSearch, sortExplorerItems, renderShowRecord, renderShowFolder, renderSeasonFolder, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, emptyExplorer, FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver } from "./modules/explorer.js?v=20260826d";
import { initEditDialogs, openEditDateDialog, openEditShowDateDialog, openEditSeasonDateDialog, openEditImageDialog, openFixMatchDialog, openMergeShowDialog, applyWatchedAtToLocalWatchRecord, editDateOptionsFromButton } from "./modules/edit-dialogs.js?v=20260826b";
import { initWatchAction, openWatchDatePrompt, closeWatchDatePrompt, submitSeerrRequest, markMovieWatched, refreshShowAfterManualWatch, applyWatchDateChoice, confirmAndMarkUnwatched, confirmAndDeleteMedia } from "./modules/watch-action.js?v=20260826c";
import { fetchTmdbDetails, fetchTmdbSeasonDetails, resolveEpisodeTitleFromTmdb } from "./modules/tmdb.js?v=20260823";
import { initMediaDetail, movieBySlugOrId, nowPlayingHref, openMovieInlineDetail, openShowInlineDetail, clearMediaDetailState, syncMediaActionsMenuState, syncTopbarControlsMenuState, closeDebugModal, closeMediaDetail, renderImmersiveShowModal, renderShowModalContent, renderMovieImmersiveModalContent, openMovieImmersiveModalByTmdbId, openShowImmersiveModalByTmdbId, openShowImmersiveModalByTvdbId, openHistoryDebugModal, fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus, patchMovieWatchedState } from "./modules/media-detail.js?v=20260810";
import { initMediaPerson, closePersonProfile, loadCastMemberDetails } from "./modules/media-person.js?v=20260810";
import { initMediaLightbox } from "./modules/media-lightbox.js";
import { initAppEvents, closeMobileMenu } from "./modules/app-events.js?v=20260826c";
import { initTrackerSettings, refreshTrackerSettings } from "./modules/tracker-settings.js?v=20260817";
import { startLiveUpdates, stopLiveUpdates } from "./modules/live-updates.js?v=20260816";

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
  const src = isLightMode ? "/plembfin_header_logo_light.png" : "/plembfin_header_logo_dark.png";
  // Two logos can exist at once - the (hidden) sidebar's and the setup
  // wizard's own copy above its steps - both need to track the theme.
  for (const logo of document.querySelectorAll(".brand-logo")) {
    logo.src = src;
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

let themeTransitionTimeout = null;

function toggleTheme() {
  const root = document.documentElement;
  root.classList.add("theme-transition");
  clearTimeout(themeTransitionTimeout);
  themeTransitionTimeout = setTimeout(() => root.classList.remove("theme-transition"), 180);

  const isLightMode = root.classList.contains("light-mode");
  if (isLightMode) {
    root.classList.remove("light-mode");
    localStorage.setItem(THEME_KEY, "dark");
  } else {
    root.classList.add("light-mode");
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
    sidebarOnboardingCta: document.querySelector("#sidebarOnboardingCta"),
    sidebarOnboardingButton: document.querySelector("#sidebarOnboardingButton"),
    sidebarOnboardingDismiss: document.querySelector("#sidebarOnboardingDismiss"),
    syncProgressIndicator: document.querySelector("#syncProgressIndicator"),
    syncProgressText: document.querySelector("#syncProgressText"),
    syncActivityStatus: document.querySelector("#syncActivityStatus"),
    syncActivityStatusText: document.querySelector("#syncActivityStatusText"),
    syncActivitySummary: document.querySelector("#syncActivitySummary"),
    syncActivityRefresh: document.querySelector("#syncActivityRefresh"),
    syncActivitySearch: document.querySelector("#syncActivitySearch"),
    syncActivityRows: document.querySelector("#syncActivityRows"),
    syncActivityTraktProgress: document.querySelector("#syncActivityTraktProgress"),
    syncActivityPagination: document.querySelector("#syncActivityPagination"),
    syncActivityPrevious: document.querySelector("#syncActivityPrevious"),
    syncActivityNext: document.querySelector("#syncActivityNext"),
    syncActivityPageLabel: document.querySelector("#syncActivityPageLabel"),
    syncActivityPageNumbers: document.querySelector("#syncActivityPageNumbers"),
    syncActivityPageRange: document.querySelector("#syncActivityPageRange"),
    changelogPanel: document.querySelector("#changelogPanel"),
    changelogRefreshButton: document.querySelector("#changelogRefreshButton"),
    authForm: document.querySelector("#authForm"),
    authPanel: document.querySelector("#authPanel"),
    authPanelSignIn: document.querySelector("#authPanelSignIn"),
    claimPanel: document.querySelector("#claimPanel"),
    claimForm: document.querySelector("#claimForm"),
    claimUsername: document.querySelector("#claimUsername"),
    claimPassword: document.querySelector("#claimPassword"),
    claimPasswordConfirm: document.querySelector("#claimPasswordConfirm"),
    claimMessage: document.querySelector("#claimMessage"),
    setupPageRoot: document.querySelector("#setupPageRoot"),
    setupFooterBarMeta: document.querySelector("#setupFooterBarMeta"),
    setupRestoreBackupButton: document.querySelector("#setupRestoreBackupButton"),
    dashboardChecklist: document.querySelector("#dashboardChecklist"),
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
    clearLogsButton: document.querySelector("#clearLogsButton"),
    downloadLogsButton: document.querySelector("#downloadLogsButton"),
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
    createPlembfinBackupRemoteButton: document.querySelector("#createPlembfinBackupRemoteButton"),
    plembfinBackupRemoteRuntime: document.querySelector("#plembfinBackupRemoteRuntime"),
    createRemoteWatchBackupButton: document.querySelector("#createRemoteWatchBackupButton"),
    watchBackupRemoteRuntime: document.querySelector("#watchBackupRemoteRuntime"),
    watchBackupProgress: document.querySelector("#watchBackupProgress"),
    plembfinBackupProgress: document.querySelector("#plembfinBackupProgress"),
    remoteWatchBackupProgress: document.querySelector("#remoteWatchBackupProgress"),
    plembfinBackupRemoteProgress: document.querySelector("#plembfinBackupRemoteProgress"),
    remoteWatchBackupEnabled: document.querySelector("#remoteWatchBackupEnabled"),
    remoteWatchBackupTime: document.querySelector("#remoteWatchBackupTime"),
    remoteWatchBackupRetention: document.querySelector("#remoteWatchBackupRetention"),
    saveRemoteWatchBackupConfigButton: document.querySelector("#saveRemoteWatchBackupConfigButton"),
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
    runRepairButton: document.querySelector("#runRepairButton"),
    repairStatus: document.querySelector("#repairStatus"),
    repairLog: document.querySelector("#repairLog"),
    traktBackfillButton: document.querySelector("#traktBackfillButton"),
    traktBackfillLimit: document.querySelector("#traktBackfillLimit"),
    traktBackfillRate: document.querySelector("#traktBackfillRate"),
    traktBackfillStatus: document.querySelector("#traktBackfillStatus"),
    traktBackfillLog: document.querySelector("#traktBackfillLog"),
    phantomAuditButton: document.querySelector("#phantomAuditButton"),
    phantomAuditStatus: document.querySelector("#phantomAuditStatus"),
    phantomAuditLog: document.querySelector("#phantomAuditLog"),
    phantomRepairButton: document.querySelector("#phantomRepairButton"),
    phantomRepairStatus: document.querySelector("#phantomRepairStatus"),
    phantomRepairLog: document.querySelector("#phantomRepairLog"),
    duplicateWatchTvButton: document.querySelector("#duplicateWatchTvButton"),
    duplicateWatchMovieButton: document.querySelector("#duplicateWatchMovieButton"),
    duplicateWatchStatus: document.querySelector("#duplicateWatchStatus"),
    duplicateWatchLog: document.querySelector("#duplicateWatchLog"),
    refreshMetadataButton: document.querySelector("#refreshMetadataButton"),
    refreshMetadataStatus: document.querySelector("#refreshMetadataStatus"),
    refreshMetadataLog: document.querySelector("#refreshMetadataLog"),
    refreshTvdbButton: document.querySelector("#refreshTvdbButton"),
    refreshTvdbStatus: document.querySelector("#refreshTvdbStatus"),
    refreshTvdbLog: document.querySelector("#refreshTvdbLog"),
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
    rotateWebhookButton: document.querySelector("#rotateWebhookButton"),
    runCompleteCheckButton: document.querySelector("#runCompleteCheckButton"),
    previewForceSyncButton: document.querySelector("#previewForceSyncButton"),
    forceSyncPreviewPanel: document.querySelector("#forceSyncPreviewPanel"),
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

// Purely cosmetic: appends the build channel (and rolling build counter)
// to a displayed version string without touching the raw semver. Develop's
// build counter is deliberately standalone (not derived from alpha/main's
// version), so it's shown as "Build N" rather than a borrowed version string -
// see describePendingDevelopBuild in server/src/routes/maintenance.js.
function versionDisplayLabel(version, channel, alphaBuild, developBuild) {
  if (channel === "develop") {
    return developBuild?.build != null ? `Develop Build ${developBuild.build}` : "Develop";
  }
  if (channel === "alpha") {
    const full = alphaBuild?.shortVersion || (alphaBuild?.baseVersion && alphaBuild?.build != null ? `${alphaBuild.baseVersion}.${alphaBuild.build}` : (version ? `${version}.${alphaBuild?.build || 1}` : "alpha"));
    return `${full} (Alpha)`;
  }
  return version || "";
}

function updateVersionBadge(data) {
  if (!elements.appVersion || !data?.current) return;
  const label = versionDisplayLabel(data.current, data.channel, data.alphaBuild, data.developBuild);
  const newerDevelopBuild = data.channel === "develop" && Boolean(data.developBuild?.newerBuildAvailable);
  const newerAlphaBuild = data.channel === "alpha" && Boolean(data.alphaBuild?.newerBuildAvailable);
  const showUpdate = data.channel === "develop"
    ? newerDevelopBuild
    : data.channel === "alpha"
      ? newerAlphaBuild
      : Boolean(data.updateAvailable);

  const labelPrefix = data.channel === "develop" ? "" : "v";
  elements.appVersion.textContent = showUpdate
    ? `${labelPrefix}${label} - Update available`
    : `${labelPrefix}${label}`;
  elements.appVersion.classList.toggle("app-version-update", showUpdate);
  elements.appVersion.title = newerDevelopBuild
    ? `Newer develop build available - build ${data.developBuild.latestBuild}. Open changelog`
    : newerAlphaBuild
      ? `Newer alpha build available - build ${data.alphaBuild.latestBuild}. Open changelog`
      : showUpdate
        ? `Update available - v${data.latest || data.current}. Open changelog`
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
  if (!force && state.changelog) return state.changelog;
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

let changelogExpanded = false;
async function renderChangelog(force = false) {
  if (!elements.changelogPanel) return;
  elements.changelogPanel.innerHTML = `<div class="idle-state"><b>Loading changelog...</b></div>`;
  try {
    const data = await loadChangelogData(force);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const current = data.current || null;
    const currentLabel = versionDisplayLabel(current, data.channel, data.alphaBuild, data.developBuild) || "?";
    const latest = data.latest || current;
    const newerCount = Array.isArray(data.newer) ? data.newer.length : 0;

    const developBuildEntries = data.channel === "develop" && Array.isArray(data.developBuild?.entries)
      ? data.developBuild.entries
      : [];
    const pendingDevelopEntries = data.channel === "develop" && Array.isArray(data.developBuild?.pendingEntries)
      ? data.developBuild.pendingEntries
      : [];
    const newerDevelopBuild = data.channel === "develop" && Boolean(data.developBuild?.newerBuildAvailable);

    const alphaBuildEntries = (data.channel === "alpha" || data.channel === "develop") && Array.isArray(data.alphaBuild?.entries)
      ? data.alphaBuild.entries
      : [];
    const pendingAlphaEntries = data.channel === "alpha" && Array.isArray(data.alphaBuild?.pendingEntries)
      ? data.alphaBuild.pendingEntries
      : [];
    const newerAlphaBuild = data.channel === "alpha" && Boolean(data.alphaBuild?.newerBuildAvailable);

    let banner;
    if (!data.remoteAvailable) {
      banner = `
        <div class="changelog-status changelog-status-muted">
          <b>Current version ${data.channel === "develop" ? "" : "v"}${escapeHtml(currentLabel)}</b>
          <span>Couldn't reach GitHub to check for newer releases${data.remoteError ? ` (${escapeHtml(data.remoteError)})` : ""}.</span>
        </div>`;
    } else if (data.channel === "develop" && newerDevelopBuild) {
      banner = `
        <div class="changelog-status changelog-status-update">
          <b>Newer develop build available - build ${escapeHtml(String(data.developBuild.latestBuild))}</b>
          <span>You're running build ${escapeHtml(String(data.developBuild.build))}. See what's new below, then pull the latest ghcr.io/lasikiewicz/plembfin:develop image to update.</span>
        </div>`;
    } else if (data.channel === "develop") {
      banner = `
        <div class="changelog-status changelog-status-muted">
          <b>Develop channel - ${escapeHtml(currentLabel)}</b>
          <span>Develop is an active rolling development build containing the newest unreleased commits.</span>
        </div>`;
    } else if (data.channel === "alpha" && newerAlphaBuild) {
      banner = `
        <div class="changelog-status changelog-status-update">
          <b>Newer alpha build available - build ${escapeHtml(String(data.alphaBuild.latestBuild))}</b>
          <span>You're running build ${escapeHtml(String(data.alphaBuild.build))}. See what's new below, then pull the latest ghcr.io/lasikiewicz/plembfin:alpha image to update.</span>
        </div>`;
    } else if (data.channel === "alpha") {
      banner = `
        <div class="changelog-status changelog-status-muted">
          <b>Alpha channel - v${escapeHtml(currentLabel)}</b>
          <span>Alpha is a rolling pre-release build; its version number only advances once it's merged into a release${newerCount ? `. ${newerCount} release${newerCount === 1 ? "" : "s"} listed below landed on main since this build` : ""}.</span>
        </div>`;
    } else if (data.updateAvailable) {
      banner = `
        <div class="changelog-status changelog-status-update">
          <b>Update available - v${escapeHtml(latest)}</b>
          <span>You're running v${escapeHtml(currentLabel)}. ${newerCount} newer release${newerCount === 1 ? "" : "s"} listed below.</span>
        </div>`;
    } else {
      banner = `
        <div class="changelog-status changelog-status-ok">
          <b>You're up to date - v${escapeHtml(currentLabel)}</b>
          <span>Running the latest published release.</span>
        </div>`;
    }

    if (!entries.length && !developBuildEntries.length && !alphaBuildEntries.length && !pendingDevelopEntries.length && !pendingAlphaEntries.length) {
      elements.changelogPanel.innerHTML = `${banner}<div class="idle-state"><b>No changelog entries found.</b></div>`;
      return;
    }

    const renderChangelogDetails = (entry) => {
      const sections = entry.sections && typeof entry.sections === "object" ? [
        ["New Features", entry.sections.newFeatures],
        ["Major Bug Fixes", entry.sections.majorBugFixes],
        ["Tweaks", entry.sections.tweaks],
      ] : [];
      const populated = sections.filter(([, details]) => Array.isArray(details) && details.filter(Boolean).length);
      if (populated.length) {
        return `<div class="changelog-detail-groups">${populated.map(([heading, details]) => `
          <section class="changelog-detail-group">
            <h5>${heading}</h5>
            <ul>${details.filter(Boolean).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>
          </section>`).join("")}</div>`;
      }
      const details = Array.isArray(entry.details) ? entry.details.filter(Boolean) : [];
      return details.length ? `<ul>${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : "";
    };

    const renderEntry = (entry) => {
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
          ${renderChangelogDetails(entry)}
        </article>
      `;
    };

    const renderDevelopBuildEntry = (entry, { pending = false } = {}) => {
      const isCurrent = !pending && Number(entry.build) === Number(data.developBuild?.build);
      const tag = pending
        ? `<span class="changelog-tag changelog-tag-new">Not pulled yet</span>`
        : isCurrent ? `<span class="changelog-tag changelog-tag-current">Current</span>` : "";
      const versionTitle = entry.version
        ? `v${escapeHtml(entry.version)} (Develop)`
        : `Develop Build ${escapeHtml(String(entry.build ?? ""))}`;
      return `
        <article class="changelog-entry${isCurrent ? " changelog-entry-current" : ""}${pending ? " changelog-entry-new" : ""}">
          <div class="changelog-entry-head">
            <b>${versionTitle}${tag}</b>
            <time>${escapeHtml(formatListDate(entry.date) || entry.date || "")}</time>
          </div>
          <p>${escapeHtml(entry.message || "Develop build update")}</p>
          ${renderChangelogDetails(entry)}
        </article>
      `;
    };

    const renderAlphaBuildEntry = (entry, { pending = false } = {}) => {
      const isCurrent = !pending && Number(entry.build) === Number(data.alphaBuild?.build) && data.channel === "alpha";
      const tag = pending
        ? `<span class="changelog-tag changelog-tag-new">Not pulled yet</span>`
        : isCurrent ? `<span class="changelog-tag changelog-tag-current">Current</span>` : "";
      const versionTitle = entry.version
        ? `v${escapeHtml(entry.version)} (Alpha)`
        : `Alpha Build ${escapeHtml(String(entry.build ?? ""))}`;
      return `
        <article class="changelog-entry${isCurrent ? " changelog-entry-current" : ""}${pending ? " changelog-entry-new" : ""}">
          <div class="changelog-entry-head">
            <b>${versionTitle}${tag}</b>
            <time>${escapeHtml(formatListDate(entry.date) || entry.date || "")}</time>
          </div>
          <p>${escapeHtml(entry.message || "Alpha build update")}</p>
          ${renderChangelogDetails(entry)}
        </article>
      `;
    };

    const pendingDevelopSection = pendingDevelopEntries.length
      ? `<h4 class="changelog-section-heading">New since your develop build - not pulled yet</h4>${pendingDevelopEntries.map((entry) => renderDevelopBuildEntry(entry, { pending: true })).join("")}`
      : "";
    const developSection = developBuildEntries.length
      ? `<h4 class="changelog-section-heading">Develop builds since last alpha</h4>${developBuildEntries.map((entry) => renderDevelopBuildEntry(entry)).join("")}`
      : "";

    const pendingAlphaSection = pendingAlphaEntries.length
      ? `<h4 class="changelog-section-heading">New since your alpha build - not pulled yet</h4>${pendingAlphaEntries.map((entry) => renderAlphaBuildEntry(entry, { pending: true })).join("")}`
      : "";
    const alphaSection = alphaBuildEntries.length
      ? `<h4 class="changelog-section-heading">${data.channel === "develop" ? "Alpha releases" : "Alpha builds since last merge"}</h4>${alphaBuildEntries.map((entry) => renderAlphaBuildEntry(entry)).join("")}`
      : "";

    const visibleEntries = changelogExpanded ? entries : entries.slice(0, 20);
    const olderCount = entries.length - visibleEntries.length;
    const releaseHeading = (developSection || alphaSection) && entries.length
      ? `<h4 class="changelog-section-heading">Published releases</h4>`
      : "";

    elements.changelogPanel.innerHTML = banner +
      pendingDevelopSection +
      developSection +
      pendingAlphaSection +
      alphaSection +
      releaseHeading +
      visibleEntries.map(renderEntry).join("") + (
        olderCount > 0
          ? `<button id="changelogShowAll" class="button-ghost" type="button">Show ${olderCount} older releases</button>`
          : ""
      );
    elements.changelogPanel.querySelector("#changelogShowAll")?.addEventListener("click", () => {
      changelogExpanded = true;
      renderChangelog(false).catch(() => { });
    });
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

  // Candidates are collected from every source without a per-source cap, then
  // ranked by how well each title matches the query and trimmed to the top few.
  // Capping during collection ranked by source instead: five TMDB shows would
  // crowd out a closer match that happened to come from TVDB.
  const COLLECT_LIMIT = 50;

  // 1. Local TV shows. Provider identity is the primary key: two series can
  // legitimately share a title, and a title-only key sends both to the same
  // legacy /tvshow/<slug> route.
  for (const s of (state.showsRaw || [])) {
    if (shows.length >= COLLECT_LIMIT) break;
    if (!(s.title || "").toLowerCase().includes(q)) continue;
    const identity = showSearchIdentity(s);
    if (seenShows.has(identity)) continue;
    seenShows.add(identity);
    shows.push({
      _type: "show",
      title: s.title,
      poster: s.poster_url || s.posterUrl || "",
      href: s.tmdb_id ? tvShowTmdbHref(s.tmdb_id, s.title) : s.tvdb_id ? tvShowTvdbHref(s.tvdb_id, s.title) : `/tvshow/${slug(s.title)}`,
      sub: "TV Show",
      overview: "",
      isLocal: true
    });
  }

  // 2. Local Movies
  for (const m of (state.history || [])) {
    if (movies.length >= COLLECT_LIMIT) break;
    if (m.media_type !== "movie") continue;
    if (!(m.title || "").toLowerCase().includes(q)) continue;
    if (seenMovies.has(comparableTitle(m.title))) continue;
    seenMovies.add(comparableTitle(m.title));
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

  // 3. TMDB Discovery
  const discoveryState = state.globalDiscoveryResults.get(q.trim());
  for (const item of (discoveryState?.results || [])) {
    const mediaType = item.media_type || (item.title ? "movie" : "tv");
    if (!["movie", "tv", "person"].includes(mediaType)) continue;

    const title = item.title || item.name || "Unknown title";
    const overview = item.overview || (item.known_for ? `Known for: ${item.known_for.map(x => x.title || x.name).filter(Boolean).join(", ")}` : "");
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);

    if (mediaType === "movie") {
      if (movies.length >= COLLECT_LIMIT) continue;
      if (seenMovies.has(comparableTitle(title))) {
        const existing = movies.find(m => comparableTitle(m.title) === comparableTitle(title));
        if (existing && !existing.overview && overview) existing.overview = overview;
        continue;
      }
      seenMovies.add(comparableTitle(title));
      movies.push({
        _type: "movie",
        title,
        poster: tmdbPoster(item.poster_path, item.id, "movie"),
        href: movieTmdbHref(item.id, title),
        sub: `Movie${year ? ` · ${year}` : ""} · TMDB`,
        overview,
        isLocal: false
      });
    } else if (mediaType === "tv") {
      if (shows.length >= COLLECT_LIMIT) continue;
      const identity = showSearchIdentity({ tmdb_id: item.id, title });
      if (seenShows.has(identity)) {
        const existing = shows.find(s => showSearchIdentity(s) === identity);
        if (existing && !existing.overview && overview) existing.overview = overview;
        continue;
      }
      seenShows.add(identity);
      shows.push({
        _type: "show",
        title,
        poster: tmdbPoster(item.poster_path, item.id, "tv"),
        href: tvShowTmdbHref(item.id, title),
        sub: `TV Show${year ? ` · ${year}` : ""} · TMDB`,
        overview,
        isLocal: false
      });
    } else if (mediaType === "person") {
      if (seenPeople.has(comparableTitle(title))) continue;
      seenPeople.add(comparableTitle(title));
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

  // 4. TVDB series, searched alongside TMDB and de-duplicated against the local
  // and TMDB shows already collected above
  for (const item of (discoveryState?.tvdbShows || [])) {
    if (shows.length >= COLLECT_LIMIT) break;
    const title = item.name || "";
    const identity = showSearchIdentity({ tvdb_id: item.tvdb_id, title });
    if (!title || seenShows.has(identity)) continue;
    seenShows.add(identity);
    shows.push({
      _type: "show",
      title,
      poster: proxiedArtworkUrl(item.image_url, "poster"),
      href: tvShowTvdbHref(item.tvdb_id, title),
      sub: `TV Show${item.year ? ` · ${item.year}` : ""} · TVDB`,
      overview: "",
      isLocal: false
    });
  }

  const needle = comparableTitle(query);
  const finalMovies = rankSearchResults(movies, needle).slice(0, 5);
  const finalShows = rankSearchResults(shows, needle).slice(0, 5);
  const finalPeople = rankSearchResults(people, needle).slice(0, 5);

  if (!finalMovies.length && !finalShows.length && !finalPeople.length && !discoveryState?.loading && !discoveryState?.error) return;

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
          ${finalMovies.length ? finalMovies.map(renderItem).join("") : '<div class="gsd-column-empty">No matching movies</div>'}
        </div>
      </div>
      <div class="gsd-column">
        <div class="gsd-column-header">TV Shows</div>
        <div class="gsd-column-list">
          ${finalShows.length ? finalShows.map(renderItem).join("") : '<div class="gsd-column-empty">No matching TV shows</div>'}
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

function comparableTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function showSearchIdentity(show = {}) {
  if (show.tmdb_id) return `tmdb:${String(show.tmdb_id)}`;
  if (show.tvdb_id) return `tvdb:${String(show.tvdb_id)}`;
  if (show.imdb_id) return `imdb:${String(show.imdb_id).toLowerCase()}`;
  return `title:${comparableTitle(show.title)}`;
}

// How closely a title answers the query. An exact title beats a prefix, which
// beats a match anywhere in the title.
function searchRelevance(title, needle) {
  const value = comparableTitle(title);
  if (!value || !needle) return 0;
  if (value === needle) return 8;
  if (value.startsWith(`${needle} `)) return 6;
  if (value.includes(` ${needle} `) || value.endsWith(` ${needle}`)) return 4;
  if (value.includes(needle)) return 2;
  if (needle.includes(value)) return 1;
  return 0;
}

// Whatever is on a connected media server is grouped ahead of TMDB/TVDB-only
// matches, then ranked by relevance within each group. Stable sort: equally
// relevant results keep the order the sources were collected in, so the
// ranking never reshuffles on a re-render.
function rankSearchResults(results, needle) {
  return results
    .map((result, index) => ({ result, index, score: searchRelevance(result.title, needle) }))
    .sort((a, b) => (Number(b.result.isLocal) - Number(a.result.isLocal)) || (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.result);
}

// TVDB series search, kept to results that plausibly match the query. TVDB uses
// the built-in project key, so this works whether or not a TMDB key is set.
async function tvdbShowSearch(query) {
  const needle = comparableTitle(query);
  if (!needle) return [];
  try {
    const response = await fetch(`/api/tvdb-search?query=${encodeURIComponent(query)}`, { headers: authHeaders() });
    if (!response.ok) return [];
    const body = await response.json().catch(() => ({}));
    return (body.results || []).filter((item) => {
      const title = comparableTitle(item.name);
      return title && (title.includes(needle) || needle.includes(title));
    });
  } catch {
    return [];
  }
}

async function fetchTmdbDiscovery(query) {
  try {
    const response = await fetch(`/api/tmdb-search?query=${encodeURIComponent(query)}&mediaType=multi`, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Search failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { results: body.results || [] };
  } catch (error) {
    console.warn("TMDB discovery search unavailable", error);
    return {
      results: [],
      error: error.status === 504 || /timed out/i.test(error.message || "")
        ? "TMDB is taking too long to respond. Local and TVDB results are still available; try again shortly."
        : "TMDB results are unavailable right now. Local and TVDB results are still available; try again.",
    };
  }
}

async function loadGlobalDiscovery(query) {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return;
  const token = ++state.globalSearchRequestToken;
  state.globalDiscoveryResults.set(normalized, { loading: true, results: [] });
  renderGlobalSearchDropdown(query);
  // Both catalogues are queried at once so TVDB series appear as quickly as TMDB
  // ones, and so an unavailable TMDB does not hold back or hide TVDB results.
  const [tmdb, tvdbShows] = await Promise.all([
    state.savedConfig.tmdb?.configured ? fetchTmdbDiscovery(query) : Promise.resolve({ results: [] }),
    tvdbShowSearch(query),
  ]);
  state.globalDiscoveryResults.set(normalized, {
    loading: false,
    results: tmdb.results,
    tvdbShows,
    error: tmdb.error && !tvdbShows.length ? tmdb.error : "",
  });
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
  // #message lives inside the auth panel, which is hidden once signed in - surface
  // feedback as a toast whenever the app shell is the visible surface.
  if (text && elements.appShell && !elements.appShell.classList.contains("hidden")) {
    showToast(text, tone);
  }
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
    || path.startsWith("/logs")
    || path.startsWith("/setup");
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
  // The trailing `-<slug>` (e.g. tmdb/202555-daredevil-born-again) is purely
  // decorative - the numeric id is what actually resolves the item. It's
  // never treated as identity on its own, unlike the local-key route below,
  // so two different real titles that happen to collide can't be confused.
  const movieTmdbMatch = pathname.match(/^\/movie\/tmdb\/(\d+)(?:-[^/]*)?$/);
  const tvshowTmdbMatch = pathname.match(/^\/tvshow\/tmdb\/(\d+)(?:-[^/]*)?(?:\/season\/(\d+))?(?:\/episode\/(\d+))?$/);
  const tvshowTvdbMatch = pathname.match(/^\/tvshow\/tvdb\/(\d+)(?:-[^/]*)?(?:\/season\/(\d+))?(?:\/episode\/(\d+))?$/);
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
      // The route type decides which library Back returns to. Reading
      // state.explorerMode here would capture whatever it happened to be, and on
      // a direct load of a detail URL that is still its "movies" default, which
      // sent Back to the wrong library.
      state.mediaDetailReturnExplorerMode = "movies";
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
      state.mediaDetailReturnExplorerMode = "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = null;
    state.activeShowTmdbId = String(tmdbId);
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    state.pendingSeasonScrollTarget = seasonNum;
    openShowImmersiveModalByTmdbId(tmdbId).catch((error) => setMessage(error.message, "error"));
  } else if (tvshowTvdbMatch) {
    const tvdbId = tvshowTvdbMatch[1];
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
      seasonNum = tvshowTvdbMatch[2] ? Number(tvshowTvdbMatch[2]) : null;
      episodeNum = tvshowTvdbMatch[3] ? Number(tvshowTvdbMatch[3]) : null;
    }
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = null;
    state.activeShowTmdbId = null;
    state.activeShowTvdbId = String(tvdbId);
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    state.pendingSeasonScrollTarget = seasonNum;
    openShowImmersiveModalByTvdbId(tvdbId).catch((error) => setMessage(error.message, "error"));
  } else if (movieMatch) {
    const movieKey = decodeURIComponent(movieMatch[1]);
    const movie = movieBySlugOrId(movieKey);
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = "movies";
    }
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.activeMovieModalId = movie?.id || movieKey;
    openMovieInlineDetail(movie?.id || movieKey).catch((error) => setMessage(error.message, "error"));
  } else if (tvshowMatch) {
    const showKey = tvshowMatch[1];
    const routeQuery = pathPart.includes("?") ? pathPart.slice(pathPart.indexOf("?") + 1) : "";
    const queryHistoryId = new URLSearchParams(routeQuery).get("historyId")
      || new URLSearchParams(window.location.search).get("historyId")
      || "";
    // A pending/previous historyId is only relevant when re-rendering the show
    // already open (e.g. a season/episode hash change). Navigating to a
    // different show via a link that doesn't carry its own historyId - a
    // global search result, for instance - must not inherit the last show's
    // record, or the mismatch can make the wrong show's data render under
    // this show's URL.
    const sameShow = state.activeShowModalKey === showKey;
    const historyId = queryHistoryId || (sameShow ? (state.pendingShowHistoryId || state.activeShowHistoryId) : "") || "";
    state.activeShowHistoryId = historyId;
    state.pendingShowHistoryId = "";
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
      state.mediaDetailReturnExplorerMode = "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = showKey;
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    state.pendingSeasonScrollTarget = seasonNum;
    openShowInlineDetail(showKey, seasonNum, episodeNum, historyId).catch((error) => {
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
  } else if (pathname === "/sync-activity") {
    state.activeView = "syncActivity";
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
  } else if (pathname === "/setup") {
    state.activeView = "setup";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    loadSetupStatus().catch((error) => setMessage(error.message, "error"));
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
  closeMobileMenu();
  const currentUrl = window.location.pathname + window.location.search + window.location.hash;
  if (currentUrl !== url) {
    const nextIndex = (history.state?.index || 0) + 1;
    history.pushState({ index: nextIndex }, "", url);
    state.internalHistoryCount = nextIndex;
    const pathnameBefore = currentUrl.split('#')[0];
    const pathnameAfter = url.split('#')[0];
    // The app's real scroll viewport is .page-shell (overflow-y: auto), not
    // the window/body, so resetting scroll on navigation has to target it.
    if (pathnameBefore !== pathnameAfter && !url.includes("#")) {
      document.querySelector(".page-shell")?.scrollTo({ top: 0, behavior: "instant" });
    }
  }
  handleRouting(url);
  applyActiveView();
  if (url.startsWith("/settings")) {
    const targetSection = url.split("#")[1];
    if (targetSection) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToSettingsSection(targetSection));
      });
    } else {
      focusSettingsRoute(state.activeSettingsRoute);
    }
  }
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
      const historyId = state.activeShowHistoryId
        || state.pendingShowHistoryId
        || new URLSearchParams(window.location.search).get("historyId")
        || "";
      if (historyId) {
        url += `?historyId=${encodeURIComponent(historyId)}`;
      }
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "shows" && state.activeShowTmdbId) {
      url = tvShowTmdbHref(state.activeShowTmdbId, state.activeShowModalTitle);
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "shows" && state.activeShowTvdbId) {
      // Series TMDB has no record of are addressed by their TVDB id instead.
      url = tvShowTvdbHref(state.activeShowTvdbId, state.activeShowModalTitle);
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "movies" && state.activeMovieModalId) {
      url = movieHref(movieBySlugOrId(state.activeMovieModalId) || { id: state.activeMovieModalId });
    } else if (state.explorerMode === "movies" && state.activeMovieTmdbId) {
      url = movieTmdbHref(state.activeMovieTmdbId, document.querySelector(".immersive-title")?.textContent);
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
        if (activeShow?.title) title = `TV Shows - ${activeShow.title}`;
      } else if (mode === "shows" && state.activeShowModalTitle) {
        title = `TV Shows - ${state.activeShowModalTitle}`;
      } else if (mode === "movies" && state.activeMovieModalId) {
        const activeMovie =
          state.history?.find(h => h.id === state.activeMovieModalId) ||
          state.moviesRaw?.find(movie => String(movie.id) === String(state.activeMovieModalId));
        if (activeMovie?.title) title = `Movies - ${activeMovie.title}`;
      }
    }
    subtitle = isInlineDetail ? "" : (state.savedConfig?.plex?.username || "Watched history library");
    activeControls = isInlineDetail ? null : elements.explorerTopbarControls;
  } else if (state.activeView === "history") {
    title = "Watch History";
    subtitle = "";
    activeControls = elements.historyTopbarControls;
  } else if (state.activeView === "syncActivity") {
    title = "Sync Activity";
    subtitle = "";
    activeControls = null;
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
  } else if (state.activeView === "setup") {
    title = "Initial Setup";
    subtitle = "";
    activeControls = null;
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
  // The setup wizard is a full-page flow - the sidebar and page topbar are
  // not meant to be reachable mid-onboarding, so hide both entirely rather
  // than let someone click away before finishing (the wizard has its own
  // "Exit to Settings" action for that, plus its own step heading in place of
  // the topbar's title). The theme toggle and version move into a small
  // bottom-center bar so they stay reachable without the rest of the sidebar.
  const isSetupView = state.activeView === "setup";
  document.querySelector(".topnav")?.classList.toggle("hidden", isSetupView);
  document.querySelector("#pageTopbar")?.classList.toggle("hidden", isSetupView);
  const setupFooterBar = document.querySelector("#setupFooterBar");
  setupFooterBar?.classList.toggle("hidden", !isSetupView);
  if (elements.appVersion && elements.themeToggleButton) {
    if (isSetupView && setupFooterBar) {
      const meta = elements.setupFooterBarMeta || setupFooterBar;
      meta.appendChild(elements.appVersion);
      meta.appendChild(elements.themeToggleButton);
      // The changelog it links to isn't relevant mid-onboarding; keep the
      // version number visible but not clickable there.
      elements.appVersion.disabled = true;
    } else if (!isSetupView) {
      const sidebarFooter = document.querySelector(".sidebar-footer");
      const appearanceWrap = document.querySelector("#sidebarAppearanceWrap");
      if (sidebarFooter) {
        sidebarFooter.insertBefore(elements.appVersion, appearanceWrap || null);
        sidebarFooter.appendChild(elements.themeToggleButton);
      }
      elements.appVersion.disabled = false;
    }
  }

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
    openUpcomingToToday();
  }
  if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
  if (state.activeView === "search") renderSearchPage();
  if (state.activeView === "setup") renderSetupPage();
  if (state.activeView === "history") renderHistoryView();
  if (state.activeView === "syncActivity") {
    renderSyncActivity();
    startSyncActivityRefresh();
    if (state.token) loadSyncActivity({ force: true }).catch((error) => setMessage(error.message, "error"));
  } else {
    stopSyncActivityRefresh();
  }
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

  // The topbar (title, back button, and which control group is mounted) is
  // derived state, so it has to be recomputed for every view change. popstate
  // reaches this function without going through selectView, so without this the
  // browser's own back button left the previous view's control bar in place.
  syncPageTopbar();

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
    const rawPath = typeof url === "string" ? url : (window.location.pathname + window.location.hash);
    const route = parseSettingsRoute(rawPath, { mustChangePassword: state.mustChangePassword });
    state.activeSettingsRoute = route;
    state.activeSettingsTab = route.group;
    localStorage.setItem(ACTIVE_SETTINGS_TAB_KEY, route.group);
    applySettingsRoute(route);
    // A route can aggregate several panels at once (a parent group's page),
    // so gate each panel's loader on whether it appears anywhere in the
    // route's views, not just the primary/first one.
    const routePanels = new Set((route.views?.length ? route.views : [{ panel: route.panel }]).map((view) => view.panel));
    if (routePanels.has("apps")) renderMediaServerCards();
    if (routePanels.has("api-keys")) renderMetadataCards();
    if (routePanels.has("sync")) {
      renderSyncJobs();
      renderSyncHistory();
      loadSyncJobs().catch((error) => setMessage(error.message, "error"));
      loadSyncHistory().catch((error) => setMessage(error.message, "error"));
    }
    if (routePanels.has("backups")) {
      state.activeBackupsTab = route.backupTab || "settings";
      renderWatchBackups();
      renderPlembfinBackups();
      // The remote listing feeds both the Remote Watch History card's storage count
      // and the Remote Restore list, and it needs the backup status (destinations)
      // first - chain it behind loadWatchBackups so a cold direct link to any
      // backups route (including the aggregated group page) still populates it.
      loadWatchBackups()
        .then(() => {
          if (!state.remoteBackupFilesLoading && !state.remoteBackupFiles.length) {
            return loadRemoteBackupsForRestoreTab();
          }
          return null;
        })
        .catch((error) => setMessage(error.message, "error"));
      loadPlembfinBackups().catch((error) => setMessage(error.message, "error"));
    }
    if (routePanels.has("logs")) renderLogs().catch(() => { });
    if (routePanels.has("changelog")) renderChangelog().catch(() => { });
    if (routePanels.has("cache")) {
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
    // that cache on read, or it can silently hand back a pre-mutation
    // response for up to 30s - the "watched" item would then be missing from
    // the dashboard's watch-history row until the cache naturally expired.
    // Using "reload" rather than "no-store" also re-populates the cache with
    // this fresh response: every dashboard-view entry runs an unforced
    // loadHistory() right after (see the "dashboard" branch above), and with
    // "no-store" that follow-up default-mode fetch could still hit the
    // stale pre-mutation entry left over from the page's original load and
    // silently undo the forced refresh.
    const response = await fetch(url, { headers: authHeaders(), cache: force ? "reload" : "default" });
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

let isBackgroundSyncing = false;
let syncActivityRefreshTimer = null;
let syncIdleGraceTimer = null;
const SYNC_IDLE_GRACE_MS = 3000;

function isAnySyncRunning() {
  return isBackgroundSyncing || Boolean(state.fullSyncActive) || isSyncProgressActive();
}

function renderSyncProgress({ total = 0, completed = 0 } = {}) {
  const syncing = total > 0 && completed < total;

  // A long sync runs as a sequence of small batches with brief idle gaps
  // between them (one batch finishes, completed>=total, before the next
  // batch's progress event arrives). Flipping isBackgroundSyncing false
  // during those gaps let queueLiveHistoryRefresh's guard miss them, so a
  // continuous multi-batch sync could still rebuild the explorer grid (full
  // reset + refetch, not an in-place patch) close to once a second for its
  // whole duration - visible as ongoing flicker even after the 1s debounce.
  // Keep isBackgroundSyncing true through a short grace window after the
  // last "still going" event so a same-sync follow-up batch doesn't reopen
  // the gap; only treat it as genuinely finished once nothing has reported
  // progress for the whole window.
  if (syncing) {
    isBackgroundSyncing = true;
    if (syncIdleGraceTimer) { window.clearTimeout(syncIdleGraceTimer); syncIdleGraceTimer = null; }
  } else if (isBackgroundSyncing && !syncIdleGraceTimer) {
    syncIdleGraceTimer = window.setTimeout(() => {
      syncIdleGraceTimer = null;
      isBackgroundSyncing = false;
      queueLiveHistoryRefresh({ immediate: true });
    }, SYNC_IDLE_GRACE_MS);
  }

  // The sidebar indicator is permanent: it reads "Sync - Idle" when nothing is
  // running and "Sync - <completed> of <total>" while a sync is in flight.
  setSyncActivityProgress({ total, completed });

  // A live-update sync-progress event can arrive several times a second while
  // a batch is in flight. Reloading the whole Sync Activity list on every tick
  // re-rendered the page that often, which is what caused the visible
  // flickering during an active sync - throttle it to at most once a second.
  if (state.activeView === "syncActivity" && !syncActivityRefreshTimer) {
    syncActivityRefreshTimer = window.setTimeout(() => {
      syncActivityRefreshTimer = null;
      if (state.activeView === "syncActivity") loadSyncActivity({ force: true }).catch(() => null);
    }, 1000);
  }
}

let liveHistoryRefreshTimer = null;
let liveHistoryRefreshActive = false;
let liveHistoryRefreshQueued = false;

function queueLiveHistoryRefresh({ immediate = false } = {}) {
  liveHistoryRefreshQueued = true;

  // While a sync job is actively writing rows in the background (force sync, cron repair, full sync,
  // or background dispatch), do NOT reload or refresh the dashboard until the sync finishes.
  if (!immediate && isAnySyncRunning()) {
    return;
  }

  if (immediate) {
    if (liveHistoryRefreshTimer) {
      window.clearTimeout(liveHistoryRefreshTimer);
      liveHistoryRefreshTimer = null;
    }
  } else if (liveHistoryRefreshTimer) {
    return;
  }

  // A background sync dispatches items in small bursts with brief gaps
  // between them, during which isAnySyncRunning() momentarily reads false -
  // the early-return guard above only catches calls that land while it's
  // true, so calls landing in those gaps still fall through to here and each
  // sets its own timer. At the old 350ms that let the explorer grid (full
  // reset + refetch) rebuild several times a second during a sync, which is
  // the flicker - 1000ms settles it to about once a second, matching the
  // Sync Activity page's fix for the same class of issue above.
  const delayMs = immediate ? 50 : 1000;

  liveHistoryRefreshTimer = window.setTimeout(() => {
    liveHistoryRefreshTimer = null;
    if (!immediate && isAnySyncRunning()) {
      liveHistoryRefreshQueued = true;
      return;
    }
    if (liveHistoryRefreshActive) {
      queueLiveHistoryRefresh({ immediate });
      return;
    }
    refreshLiveHistoryView().catch((error) => logDebug(`Live history refresh failed: ${error.message}`));
  }, delayMs);
}

async function refreshLiveHistoryView() {
  if (liveHistoryRefreshActive) return;
  liveHistoryRefreshActive = true;
  liveHistoryRefreshQueued = false;
  try {
    clearDerivedUiCaches({ resetExplorer: false });
    await loadHistory({ force: true });
    resetPartWatchedView("default");
    renderPartWatched();

    if (state.mediaDetailInline && state.activeShowRenderContext?.show) {
      const context = state.activeShowRenderContext;
      const currentShow = context.show;
      const url = new URL("/api/show", window.location.origin);
      if (currentShow.id) url.searchParams.set("id", currentShow.id);
      if (currentShow.title) url.searchParams.set("title", currentShow.title);
      const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      const freshShow = response.ok && body.show
        ? mergeShowDetail(body.show)
        : mergeShowDetail({ ...currentShow, episodes: [], episode_count: 0, latest_watched_at: "", earliest_watched_at: "" });
      if (freshShow && state.mediaDetailInline && state.activeShowRenderContext?.show === currentShow) {
        renderShowModalContent(freshShow, {
          ...context,
          activeSeasonNum: state.activeShowModalSeason,
        });
      }
      return;
    }

    if (state.mediaDetailInline && state.activeMovieTmdbId) {
      await openMovieImmersiveModalByTmdbId(state.activeMovieTmdbId);
      return;
    }

    // A poster-grid card unwatch already patched state.moviesRaw/
    // historyViewRaw and animated its own card out in place
    // (removeGridCards in watch-action.js) - the live-update poll's own
    // history-version bump for that same mutation lands ~1s later via this
    // debounce and would otherwise immediately undo that with a redundant
    // refresh, since the data here is already current.
    const suppressGridReset = Boolean(state.suppressExplorerLiveResetUntil) && Date.now() < state.suppressExplorerLiveResetUntil;
    state.suppressExplorerLiveResetUntil = 0;
    if (state.activeView === "explorer" && !suppressGridReset) {
      // Shows are grouped/nested (season, episode) in a way that isn't safe
      // to refresh in place yet, so that mode keeps the old reset-and-refetch
      // behavior for now. Movies use refreshMovieExplorerInPlace() instead of
      // resetMovieExplorer() + renderExplorer(): a remote change (a watch or
      // unwatch on Trakt or another device) has no local card to animate out,
      // but the refresh still shouldn't be more disruptive than it has to be
      // - resetting first empties the grid, which briefly shows the "Loading
      // movies…" placeholder and clamps scroll back to the top before the
      // refetch repopulates it, with no way back to where the user was.
      if (state.explorerMode === "shows") {
        resetShowExplorer();
        renderExplorer();
      } else {
        await refreshMovieExplorerInPlace();
      }
    } else if (state.activeView === "history" && !suppressGridReset) {
      await refreshHistoryViewInPlace();
    }
  } finally {
    liveHistoryRefreshActive = false;
    if (liveHistoryRefreshQueued && !isAnySyncRunning()) {
      queueLiveHistoryRefresh();
    }
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



async function renderLogs(forceScrollToBottom = false) {
  if (!elements.logsTerminal) return;

  const isInitialLoad = !state.hasLoadedLogsOnce;
  state.hasLoadedLogsOnce = true;

  const localLogs = logsText();
  const category = state.activeLogCategory || "all";

  // The frontend debug log is a flat browser-activity trail with no server-side
  // category of its own, so it only genuinely belongs under "All" and "System" -
  // showing it under Plex WebSockets/Outbound Sync/Scheduled Polls made every tab
  // look identical, since tab switches force-scroll to the bottom of this section.
  const includeFrontendSection = category === "all" || category === "system";

  try {
    const backendLogs = await fetchDiagnosticLogs(authHeaders(), category);
    if (backendLogs.length > 0 || includeFrontendSection) {
      const visibleBackendLogs = backendLogs.slice(-250);
      const visibleFrontendLogs = includeFrontendSection && localLogs ? localLogs.split("\n").slice(-50) : [];
      const allLogs = [
        `=== BACKEND DIAGNOSTIC LOGS (${category.toUpperCase()}) ===`,
        ...backendLogs,
        ...(includeFrontendSection ? ["", "=== FRONTEND DEBUG LOGS ===", localLogs || "[no frontend logs]"] : [])
      ].join("\n");
      state.renderedLogsText = allLogs;

      const htmlLines = [
        `<div class="log-section-header">=== BACKEND DIAGNOSTIC LOGS (${escapeHtml(category.toUpperCase())}) - showing latest ${visibleBackendLogs.length} of ${backendLogs.length} ===</div>`,
        ...(visibleBackendLogs.length ? visibleBackendLogs.map(formatLogLineToHtml) : ['<div class="log-row"><span class="log-msg" style="opacity: 0.6;">[no backend logs for this category]</span></div>']),
        ...(includeFrontendSection ? [
          `<div class="log-section-header" style="margin-top: 1rem;">=== FRONTEND DEBUG LOGS ===</div>`,
          ...(visibleFrontendLogs.length ? visibleFrontendLogs.map(formatLogLineToHtml) : ['<div class="log-row"><span class="log-msg" style="opacity: 0.6;">[no frontend logs]</span></div>'])
        ] : [])
      ].join("");

      elements.logsTerminal.innerHTML = htmlLines;
    } else {
      state.renderedLogsText = localLogs || `[no diagnostic logs captured yet for category: ${category}]`;
      elements.logsTerminal.innerHTML = `<div class="log-row"><span class="log-msg" style="opacity: 0.6;">${escapeHtml(state.renderedLogsText)}</span></div>`;
    }
  } catch (error) {
    state.renderedLogsText = localLogs || "[no diagnostic logs captured yet]";
    elements.logsTerminal.innerHTML = `<div class="log-row"><span class="log-msg" style="opacity: 0.6;">${escapeHtml(state.renderedLogsText)}</span></div>`;
  }

  const el = elements.logsTerminal;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (forceScrollToBottom || isInitialLoad || atBottom) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

function syncLogsRefresh() {
  const shouldRefresh = state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs" && state.token;
  if (shouldRefresh && !state.logsRefreshInterval) {
    state.hasLoadedLogsOnce = false;
    renderLogs(true).catch(() => { });
    state.logsRefreshInterval = window.setInterval(() => {
      if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs") {
        renderLogs().catch(() => { });
      }
    }, 3000);
  } else if (!shouldRefresh) {
    if (state.logsRefreshInterval) {
      window.clearInterval(state.logsRefreshInterval);
      state.logsRefreshInterval = undefined;
    }
    state.hasLoadedLogsOnce = false;
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
  state.syncActivity = [];
  state.syncActivityLoaded = false;
  state.syncActivityLoading = false;
  state.syncActivitySearch = "";
  if (elements.syncActivitySearch) elements.syncActivitySearch.value = "";
  state.syncActivityPagination = { page: 1, limit: 25, total: 0, totalPages: 1, from: 0, to: 0, hasPrevious: false, hasNext: false };
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
  renderSyncActivity();
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

  elements.approveConfirmButton.textContent = options.approveLabel || "Approve";

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
  if (pathname === "/setup") {
    state.activeView = "setup";
    return true;
  }
  // These branches mark the detail as already open, which means the matching
  // handleRouting branch skips its own "where did I come from" capture. Record
  // the return context here too, or Back falls through to the defaults in
  // state.js and sends a directly loaded show page to the movies library.
  if (pathname.startsWith("/movie/")) {
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.mediaDetailReturnView = "explorer";
    state.mediaDetailReturnExplorerMode = "movies";
    return true;
  }
  if (pathname.startsWith("/tvshow/")) {
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.mediaDetailReturnView = "explorer";
    state.mediaDetailReturnExplorerMode = "shows";
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
  initTrackerSettings({ authHeaders });
  initOnboarding({ authHeaders, navigateTo, setMessage, setUnlocked, loadHistory, loadSavedConfig, startHistoryPolling, openConfirmDialog });
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
    queueLiveHistoryRefresh,
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
    loadHistory,
    renderExplorer,
    renderImmersiveShowModal,
    openShowImmersiveModalByTmdbId,
    openShowImmersiveModalByTvdbId,
    navigateTo,
    openConfirmDialog,
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
    renderShowModalContent,
    openShowImmersiveModalByTmdbId,
    openShowImmersiveModalByTvdbId,
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
    renderHistoryView,
    renderImmersiveShowModal,
    showToast,
    showConfirmModal,
    queueLiveHistoryRefresh,
  });
  initSyncPreview({
    button: elements.previewForceSyncButton,
    panel: elements.forceSyncPreviewPanel,
    token: () => state.token,
    onToast: showToast,
    onExecute: (planId) => triggerForceSync({ planId, confirmed: true }),
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
    openConfirmDialog,
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
    clearDerivedUiCaches,
    loadStats,
    loadSavedConfig,
    renderDbStatus,
    showErrorExplainModal,
    runRefreshMetadataWorkflow,
    runRefreshTvdbMetadataWorkflow,
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
    runPhantomWatchAudit,
    runPhantomWatchRepair,
    runDuplicateWatchCleanup,
    loadSyncActivity,
    setSyncActivitySearch,
    downloadSyncActivityLog,
    retrySyncActivity,
    toggleSyncActivityRowLog,
    toggleSyncActivityFailedOnly,
  });
  applyAppearanceToBody(APPEARANCE_DEFAULTS);
  renderSyncActivityStatus();
  applyExplorerPosterWidth();
  elements.adminEmail.value = localStorage.getItem("adminUsername") || "";
  elements.adminToken.value = "";
  elements.settingsUsername.value = elements.adminEmail.value;
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

  onAuthChange((user, token, mustChangePassword, claimRequired) => {
    state.authReady = true;
    state.mustChangePassword = mustChangePassword === true;
    state.currentUser = user || undefined;
    state.token = token || "";
    if (user && token) {
      startLiveUpdates({
        authHeaders,
        onHistoryVersion: queueLiveHistoryRefresh,
        onSyncProgress: renderSyncProgress,
        onError: (error) => logDebug(`Live update connection interrupted: ${error.message}`),
      });
      refreshTrackerSettings().catch(() => { });
      resumeActiveRefreshJobs();
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
      if (!state.mustChangePassword && fullPath !== "/setup") {
        // Onboarding no longer force-navigates here on every load/refresh - it
        // only redirected once and left no way back except finishing the whole
        // wizard. loadSetupStatus() renders the persistent, dismissible
        // "Complete onboarding" sidebar entry point instead (see
        // renderSidebarOnboardingCta() in onboarding.js).
        loadSetupStatus().catch(() => {});
      }
      if (isConfigSensitiveRoute(fullPath) && !state.mustChangePassword) {
        primeSensitiveRouteState(fullPath);
        applyActiveView();
        // Paint the media detail immediately using local data (e.g. /api/show)
        // instead of waiting for loadSavedConfig() - which is three sequential
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
      stopLiveUpdates();
      renderSyncProgress({ total: 0, completed: 0 });
      setClaimRequired(claimRequired === true);
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

function showToast(text, tone = "success") {
  if (!elements.copyToast) return;
  elements.copyToast.textContent = text;
  elements.copyToast.dataset.tone = tone;
  elements.copyToast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.copyToast.classList.add("hidden");
    elements.copyToast.textContent = "Copied!";
    delete elements.copyToast.dataset.tone;
  }, tone === "error" ? 6000 : 3500);
}

function showCopyToast() {
  showToast("Copied!");
}

// Both refresh workflows run as server-side background jobs (see
// workerCoordinator.js's runTmdbMetadataRefreshJob/runTvdbMetadataRefreshJob)
// instead of a client-driven paging loop, so progress survives navigating away
// from this settings panel, closing the tab, or reloading the page - the
// button click just enqueues the job, and pollRefreshJob() polls its status
// until it finishes. resumeActiveRefreshJobs() (called once after login)
// re-attaches polling to a job that was already running before this page load.
const REFRESH_JOB_POLL_MS = 2000;
const refreshJobPolling = { tmdb: false, tvdb: false };

const REFRESH_JOB_UI = {
  tmdb: {
    url: "/api/refresh-tmdb-metadata",
    button: () => elements.refreshMetadataButton,
    status: () => elements.refreshMetadataStatus,
    log: () => elements.refreshMetadataLog,
    idleLabel: "Refresh Metadata Now",
    activeLabel: "Refreshing Metadata...",
    noun: "items",
  },
  tvdb: {
    url: "/api/refresh-tvdb-metadata",
    button: () => elements.refreshTvdbButton,
    status: () => elements.refreshTvdbStatus,
    log: () => elements.refreshTvdbLog,
    idleLabel: "Refresh TVDB Metadata Now",
    activeLabel: "Refreshing TVDB Metadata...",
    noun: "shows",
  },
};

function lastRefreshProgress(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\((\d+)\/(\d+)\)\s*$/);
    if (match) return { done: Number(match[1]), total: Number(match[2]) };
  }
  return null;
}

function summarizeRefreshResult(kind, result) {
  const { noun } = REFRESH_JOB_UI[kind];
  if (!result) return "";
  if (result.cancelled) return `Cancelled after ${result.refreshed || 0} of ${result.total || 0} ${noun}.`;
  if (result.success === false) return `Error: ${result.error || "refresh failed"}`;
  const postersLine = kind === "tmdb" && result.postersWritten ? `, ${result.postersWritten} posters stored` : "";
  return `Done! Refreshed ${result.refreshed || 0} ${noun} (failed: ${result.failed || 0})${postersLine}.`;
}

async function pollRefreshJob(kind) {
  if (refreshJobPolling[kind]) return;
  refreshJobPolling[kind] = true;
  const ui = REFRESH_JOB_UI[kind];
  const button = ui.button();
  const status = ui.status();
  const logEl = ui.log();

  try {
    for (;;) {
      const res = await fetch(ui.url, { headers: authHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const lines = Array.isArray(data.log) ? data.log : [];
      if (logEl && lines.length) {
        logEl.classList.remove("hidden");
        logEl.textContent = lines.join("\n") + "\n";
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (data.active) {
        if (button) { button.disabled = true; button.textContent = ui.activeLabel; }
        if (status) {
          const progress = lastRefreshProgress(lines);
          status.textContent = progress
            ? `Progress: ${progress.done} of ${progress.total} (${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%)`
            : "Starting...";
          status.className = "status-pill status-warning";
        }
        await new Promise((resolve) => setTimeout(resolve, REFRESH_JOB_POLL_MS));
        continue;
      }

      if (button) { button.disabled = false; button.textContent = ui.idleLabel; }
      if (data.result) {
        const summary = summarizeRefreshResult(kind, data.result);
        const isError = data.result.success === false && !data.result.cancelled;
        if (status) {
          status.textContent = summary || "Idle";
          status.className = isError ? "status-pill status-error" : "status-pill status-ready";
        }
        if (logEl && summary) {
          logEl.textContent += summary + "\n";
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (!isError) {
          clearDerivedUiCaches();
          state.historyVersion = "";
          await loadHistory({ force: true }).catch(() => {});
        }
      }
      break;
    }
  } catch (err) {
    if (status) { status.textContent = `Error: ${err.message}`; status.className = "status-pill status-error"; }
    if (button) { button.disabled = false; button.textContent = ui.idleLabel; }
  } finally {
    refreshJobPolling[kind] = false;
  }
}

async function startRefreshJob(kind) {
  const ui = REFRESH_JOB_UI[kind];
  const button = ui.button();
  const status = ui.status();
  if (!button) return;
  try {
    const res = await fetch(ui.url, { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" } });
    // A 409 means a matching job is already running (e.g. resumed from another
    // tab) - fall through to polling instead of treating it as a failure.
    if (!res.ok && res.status !== 409) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    if (status) { status.textContent = `Error: ${err.message}`; status.className = "status-pill status-error"; }
    return;
  }
  pollRefreshJob(kind);
}

function runRefreshMetadataWorkflow() {
  return startRefreshJob("tmdb");
}

function runRefreshTvdbMetadataWorkflow() {
  return startRefreshJob("tvdb");
}

// Re-attaches status polling to a TMDB/TVDB refresh job that was already
// running before this page loaded, so a reload or a return visit shows live
// progress instead of the static "Idle" markup.
function resumeActiveRefreshJobs() {
  for (const kind of Object.keys(REFRESH_JOB_UI)) {
    fetch(REFRESH_JOB_UI[kind].url, { headers: authHeaders(), cache: "no-store" })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => { if (data?.active) pollRefreshJob(kind); })
      .catch(() => {});
  }
}

window.showCastMemberDetails = function (personId, personName) {
  state.personReturnUrl = window.location.pathname + window.location.hash;
  navigateTo(`/person/${personId}`);
};
