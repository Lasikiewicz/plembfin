import { buildAuthHeaders, buildNowPlayingUrl, currentFirebaseUser, onFirebaseAuthChange, readStoredAdminToken, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./modules/auth.js";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./modules/logs.js";
import { connectionLabel, connectionPayloadFromElements } from "./modules/settings.js";
import { fetchLocalActiveSessions } from "./modules/timeline.js";

// Warm the backend the moment the app loads (no auth needed), so the Cloud
// Function is hot by the time the user clicks into anything. A light keep-alive
// holds it warm while the tab is open. This gives warm-instance latency without
// the 24/7 cost of minInstances — we only ping while someone is actually here.
const BACKEND_KEEPALIVE_MS = 4 * 60 * 1000;
function warmUpBackend() {
  try {
    fetch("/api/ping", { cache: "no-store", keepalive: true }).catch(() => {});
  } catch { /* non-fatal */ }
}
warmUpBackend();
setInterval(() => {
  if (document.visibilityState === "visible") warmUpBackend();
}, BACKEND_KEEPALIVE_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") warmUpBackend();
});

const TOKEN_KEY = "adminToken";
const LEGACY_UPPER_TOKEN_KEY = "ADMIN_TOKEN";
const LEGACY_TOKEN_KEY = "sync_admin_token";
const ACTIVE_VIEW_KEY = "history_active_view";
const ACTIVE_SETTINGS_TAB_KEY = "history_active_settings_tab";
const IMPORT_BATCH_SIZE = 100;
const IMPORT_MAX_ATTEMPTS = 4;
const IMPORT_RETRY_BASE_MS = 1500;
const BACKUP_BATCH_SIZE = 250;
const BACKUP_MAX_REQUEST_BYTES = 512 * 1024;
const BACKUP_FORMAT = "plembfin-backup";
const BACKUP_VERSION = 1;
const BACKUP_COLLECTIONS = ["watchHistory", "playstate", "playbackProgress", "activeSessions", "liveTrackingCache", "syncHistory", "settings", "runtimeState", "loopKeys", "posterCache", "tmdbMetadataCache", "tmdbSearchCache", "tmdbSeasonCache", "tmdbPersonCache"];
const NOW_PLAYING_POLL_MS = 10000;
const NOW_PLAYING_EMPTY_POLL_MS = 2 * 60 * 1000;
const NOW_PLAYING_REENTRY_CACHE_MS = 20 * 1000;
const POSTER_LOOKUP_CONCURRENCY = 2;
const POSTER_LOOKUP_PERSISTED_CACHE_KEY = "plembfin:posterLookupCache:v3";
const POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const POSTER_LOOKUP_PERSISTED_CACHE_LIMIT = 800;
const TMDB_POSTER_SIZE = "w342";
const DASHBOARD_HISTORY_CACHE_KEY = "plembfin:dashboardHistory:v1";
const DASHBOARD_HISTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_PREVIEW_LIMIT = 120;
const DASHBOARD_HISTORY_ROWS = 2;
const EXPLORER_PAGE_SIZE = 240;
const EXPLORER_CACHE_TTL_MS = 30 * 60 * 1000;
const EXPLORER_PERSISTED_CACHE_KEY = "plembfin:explorerPageCache:v3";
const EXPLORER_VIEW_KEY_MOVIES = "plembfin:explorerView:movies";
const EXPLORER_VIEW_KEY_SHOWS = "plembfin:explorerView:shows";
const EXPLORER_SORT_KEY_MOVIES = "plembfin:explorerSort:movies";
const EXPLORER_SORT_KEY_SHOWS = "plembfin:explorerSort:shows";
const EXPLORER_PERSISTED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const EXPLORER_PERSISTED_CACHE_LIMIT = 24;
const PRIMARY_VIEWS = ["dashboard", "stats", "explorer", "settings", "help"];
const SETTINGS_TABS = ["general", "apps", "api-keys", "tools", "backups", "sync", "logs"];

const state = {
  token: readStoredAdminToken([TOKEN_KEY, LEGACY_UPPER_TOKEN_KEY, LEGACY_TOKEN_KEY]),
  authReady: false,
  firebaseUser: undefined,
  activeView: localStorage.getItem(ACTIVE_VIEW_KEY) || "dashboard",
  activeSettingsTab: localStorage.getItem(ACTIVE_SETTINGS_TAB_KEY) || "general",
  activeBackupsTab: localStorage.getItem("activeBackupsTab") || "settings",
  remoteBackupFiles: [],
  remoteBackupFilesLoading: false,
  historyWeekStart: startOfWeek(new Date()),
  history: [],
  historyVersion: "",
  historyLoadPromise: null,
  dashboardHistoryFilter: "all",
  dashboardHistoryResizeTimer: undefined,
  activeSessions: [],
  syncJobs: [],
  syncJobsLoaded: false,
  syncJobsLoading: false,
  syncHistory: [],
  syncHistoryLoaded: false,
  syncHistoryLoading: false,
  savedConfig: {},
  stats: {
    totalWatches: 0,
    uniqueMoviesLogged: 0,
    totalTvEpisodesTracked: 0,
    sourceBreakdown: [],
    topShows: [],
    monthlyActivity: [],
  },
  statsLoaded: false,
  statsLoading: false,
  explorerMode: "movies",
  explorerSearch: "",
  explorerSearchTimer: undefined,
  moviesRaw: [],
  moviesOffset: 0,
  moviesHasMore: true,
  moviesLoading: false,
  moviesQueryKey: "",
  showsRaw: [],
  showsOffset: 0,
  showsHasMore: true,
  showsLoading: false,
  showsQueryKey: "",
  explorerSortMovies: localStorage.getItem(EXPLORER_SORT_KEY_MOVIES) || "title_asc",
  explorerSortShows: localStorage.getItem(EXPLORER_SORT_KEY_SHOWS) || "title_asc",
  explorerViewMovies: localStorage.getItem(EXPLORER_VIEW_KEY_MOVIES) || "posters",
  explorerViewShows: localStorage.getItem(EXPLORER_VIEW_KEY_SHOWS) || "posters",
  posterLookupCache: new Map(),
  posterLookupInflight: new Map(),
  tmdbDetailsCache: new Map(),
  tmdbSeasonCache: new Map(),
  globalDiscoveryResults: new Map(),
  globalSearchRequestToken: 0,
  globalSearchRemoteTimer: undefined,
  explorerPageCache: new Map(),
  explorerLoadObserver: undefined,
  dashboardPosterObserver: undefined,
  explorerScrollArmed: false,
  posterHydrateScrollScheduled: false,
  expandedShows: new Set(),
  expandedSeasons: new Set(),
  activeShowModalKey: null,
  activeShowTmdbId: null,
  activeShowModalSeason: null,
  activeShowModalEpisode: null,
  showModalRequestToken: 0,
  showModalEpisodes: [],
  showModalEpisodeIndex: new Map(),
  showDetailInflight: new Map(),
  mediaDetailInline: false,
  mediaDetailReturnView: "explorer",
  mediaDetailReturnExplorerMode: "movies",
  personReturnUrl: null,
  pendingWatchAction: null,
  savingWatchAction: null,
  activeMovieModalId: null,
  activeMovieTmdbId: null,
  activeHelpTopic: "getting-started",
  importRecords: [],
  importFileNames: [],
  importLogs: ["[idle] Waiting for files."],
  importProgressValue: 0,
  importActive: false,
  debugLogs: readStoredDebugLogs(),
  renderedLogsText: "",
  logsRefreshInterval: undefined,
  nowPlayingInterval: undefined,
  nowPlayingRequestActive: false,
  nowPlayingRefreshToken: "",
  nowPlayingSessionKey: "",
  nowPlayingLastFetchAt: 0,
  configLoaded: false,
  fullSyncActive: false,
  backupImport: null,
  watchBackups: null,
  watchBackupsLoading: false,
  internalHistoryCount: history.state?.index || 0,
};

const elements = {};

function bindElements() {
  Object.assign(elements, {
    appShell: document.querySelector("#appShell"),
    appVersion: document.querySelector("#appVersion"),
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
    alphaFilterNav: document.querySelector("#alphaFilterNav"),
    explorerSearchInput: document.querySelector("#explorerSearchInput"),
    explorerPosterSize: document.querySelector("#explorerPosterSize"),
    explorerPosterSizeLabel: document.querySelector(".explorer-size-slider"),
    explorerSort: document.querySelector("#explorerSort"),
    explorerViewButtons: [...document.querySelectorAll("[data-explorer-view]")],
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
    message: document.querySelector("#message"),
    modalBody: document.querySelector("#modalBody"),
    monthChart: document.querySelector("#monthChart"),
    nowPlayingGrid: document.querySelector("#nowPlayingGrid"),
    nowPlayingStatus: document.querySelector("#nowPlayingStatus"),
    refreshSyncButton: document.querySelector("#refreshSyncButton"),
    runCronSyncButton: document.querySelector("#runCronSyncButton"),
    forceSyncButton: document.querySelector("#forceSyncButton"),
    stopSyncButton: document.querySelector("#stopSyncButton"),
    forceSyncTerminal: document.querySelector("#forceSyncTerminal"),
    plexEnabled: document.querySelector("#plexEnabled"),
    plexServerUrl: document.querySelector("#plexServerUrl"),
    plexToken: document.querySelector("#plexToken"),
    plexUsername: document.querySelector("#plexUsername"),
    tmdbApiKey: document.querySelector("#tmdbApiKey"),
    youtubeApiKey: document.querySelector("#youtubeApiKey"),
    embyEnabled: document.querySelector("#embyEnabled"),
    embyServerUrl: document.querySelector("#embyServerUrl"),
    embyApiKey: document.querySelector("#embyApiKey"),
    embyUserId: document.querySelector("#embyUserId"),
    jellyfinEnabled: document.querySelector("#jellyfinEnabled"),
    jellyfinServerUrl: document.querySelector("#jellyfinServerUrl"),
    jellyfinApiKey: document.querySelector("#jellyfinApiKey"),
    jellyfinUserId: document.querySelector("#jellyfinUserId"),
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
    startImportButton: document.querySelector("#startImportButton"),
    statusPill: document.querySelector("#statusPill"),
    totalMovies: document.querySelector("#totalMovies"),
    totalEpisodes: document.querySelector("#totalEpisodes"),
    totalWatches: document.querySelector("#totalWatches"),
    topPlatform: document.querySelector("#topPlatform"),
    dbSize: document.querySelector("#dbSize"),
    trackingSpan: document.querySelector("#trackingSpan"),
    topShows: document.querySelector("#topShows"),
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
    saveAdminCredentialsButton: document.querySelector("#saveAdminCredentialsButton"),
    checkSessionButton: document.querySelector("#checkSessionButton"),
    webhookUrl: document.querySelector("#webhookUrl"),
    runCompleteCheckButton: document.querySelector("#runCompleteCheckButton"),
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

async function loadAppVersion() {
  if (!elements.appVersion) return;
  try {
    const response = await fetch("/changelog.json", { cache: "no-store" });
    const changelog = await response.json();
    if (response.ok && changelog.version) elements.appVersion.textContent = `v${changelog.version}`;
  } catch {
    // Keep the HTML fallback version when release metadata is unavailable.
  }
}

function setBackupTransferState(label, tone = "muted", log = "") {
  if (elements.backupTransferStatus) {
    elements.backupTransferStatus.textContent = label;
    elements.backupTransferStatus.className = `status-pill status-${tone}`;
  }
  if (log && elements.backupTransferLog) {
    elements.backupTransferLog.textContent = log;
    elements.backupTransferLog.scrollTop = elements.backupTransferLog.scrollHeight;
  }
}

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

async function exportPlembfinBackup() {
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
    setMessage("Plembfin backup downloaded.", "success");
  } catch (error) {
    setBackupTransferState("Failed", "error", `Backup failed: ${error.message}`);
    setMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Export Backup";
  }
}

async function readPlembfinBackup(file) {
  const parsed = JSON.parse(await file.text());
  return validatePlembfinBackup(parsed);
}

async function importPlembfinBackup() {
  if (!state.backupImport) return;
  const approved = await openConfirmDialog({
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

    clearDerivedUiCaches();
    state.configLoaded = false;
    state.syncJobsLoaded = false;
    state.syncHistoryLoaded = false;
    await Promise.all([
      loadSavedConfig(),
      loadHistory({ force: true }),
      loadActiveSessions(),
      loadStats({ force: true }),
    ]);
    setBackupTransferState("Complete", "ready", `Import complete: ${formatNumber(totalDocuments)} documents across ${formatNumber(included.length)} collections.`);
    setMessage("Plembfin backup imported.", "success");
  } catch (error) {
    setBackupTransferState("Failed", "error", `Import failed: ${error.message}`);
    setMessage(error.message, "error");
  } finally {
    input.disabled = false;
    button.disabled = !state.backupImport;
    button.textContent = "Import Backup";
  }
}

function watchBackupDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function renderWatchBackups() {
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
    // Settings tab: render schedule/runtime info and destinations
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
    // Settings tab: local file list (download/validate only)
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

  // Restore tab: show unified list of all backups (local + remote), sorted newest first
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

async function loadRemoteBackupsForRestoreTab() {
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
    help: `<details class="destination-help"><summary>How to set up Backblaze B2 (free 10&nbsp;GB, ~5 min)</summary>
      <ol>
        <li>Create a free account at <a href="https://www.backblaze.com/sign-up/cloud-storage" target="_blank" rel="noopener">backblaze.com</a> and enable <b>B2 Cloud Storage</b>.</li>
        <li><b>Buckets → Create a Bucket</b>: pick a globally-unique name, set files <b>Private</b>. After it's made, note the <b>Endpoint</b> shown (e.g. <code>s3.us-west-004.backblazeb2.com</code>) — the middle part is your <b>Region</b> (<code>us-west-004</code>).</li>
        <li><b>Application Keys → Add a New Application Key</b>: restrict it to <i>that one bucket</i>, then create. Copy the <b>keyID</b> and <b>applicationKey</b> now — the applicationKey is shown only once.</li>
        <li>Fill the fields above (Region, Bucket, keyID, applicationKey), <b>Save</b>, then <b>Test</b> (expect “Bucket … reachable”). Tick <b>Enabled</b> and click <b>Back Up Now</b>.</li>
      </ol>
      <p>The endpoint is derived from the region automatically. Backups are pruned to your retention count here too.</p>
    </details>`,
  },
  folder: {
    label: "Local / synced folder",
    settings: [
      { key: "path", label: "Folder path", placeholder: "C:\\Users\\you\\OneDrive\\Plembfin Backups", full: true },
    ],
    secrets: [],
    oauth: null,
    help: `<details class="destination-help"><summary>No login needed — how does this work?</summary>
      <p>Point this at a folder your cloud's <b>desktop app already syncs</b> (e.g. a folder inside your OneDrive or Dropbox folder, or a mounted NAS share). Plembfin writes the backup there and your sync client uploads it. No Azure app, no OAuth.</p>
      <p>The path is read on the server running Plembfin, so use a path that exists on that machine.</p>
    </details>`,
  },
  webdav: {
    label: "WebDAV",
    settings: [
      { key: "url", label: "Collection URL", placeholder: "https://cloud.example.com/remote.php/dav/files/me/plembfin/" },
      { key: "username", label: "Username", placeholder: "username" },
    ],
    secrets: [{ key: "password", label: "Password" }],
    oauth: null,
  },
  s3: {
    label: "S3-compatible",
    settings: [
      { key: "endpoint", label: "Endpoint (blank for AWS)", placeholder: "http://localhost:9000" },
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "bucket", label: "Bucket", placeholder: "my-backups" },
      { key: "prefix", label: "Key prefix (optional)", placeholder: "plembfin/" },
      { key: "accessKeyId", label: "Access key ID", placeholder: "AKIA…" },
      { key: "forcePathStyle", label: "Use path-style URLs (MinIO, B2, most non-AWS)", type: "checkbox", default: true },
    ],
    secrets: [{ key: "secretAccessKey", label: "Secret access key" }],
    oauth: null,
  },
  onedrive: {
    label: "OneDrive",
    settings: [
      { key: "clientId", label: "Azure app client ID", placeholder: "00000000-0000-0000-0000-000000000000", full: true },
    ],
    secrets: [],
    oauth: "device",
    help: `<details class="destination-help"><summary>Where do I get a client ID? (one-time, free)</summary>
      <p><b>Easiest option:</b> skip the API entirely and use a <b>Local / synced folder</b> destination pointed at your OneDrive sync folder — your OneDrive desktop app does the upload, no registration needed.</p>
      <p>If you do want the API, Microsoft requires a free app registration (one time):</p>
      <ol>
        <li>Open <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Entra app registrations</a> → <b>New registration</b>.</li>
        <li>Name it anything. Under supported account types pick <b>“Accounts in any organizational directory and personal Microsoft accounts”</b>. Leave redirect URI blank → <b>Register</b>.</li>
        <li>Open <b>Authentication</b> → enable <b>Allow public client flows</b> → <b>Save</b>.</li>
        <li>Copy the <b>Application (client) ID</b> into the field above, Save, then click <b>Connect</b>.</li>
      </ol>
      <p><b>Personal @outlook/@hotmail account?</b> If step 1 says <i>“creating applications outside of a directory has been deprecated”</i>, your account has no Azure directory yet. Click <b>“sign up for Azure”</b> on that page (free — creates a directory) and then register the app there. The app still works with your personal OneDrive thanks to the account type in step 2. Or just use the folder option above and avoid all of this.</p>
    </details>`,
  },
  dropbox: {
    label: "Dropbox",
    settings: [
      { key: "appKey", label: "App key", placeholder: "abcd1234efgh5678" },
      { key: "folder", label: "Folder", placeholder: "/Plembfin Backups" },
    ],
    secrets: [{ key: "appSecret", label: "App secret" }],
    oauth: "code",
    help: `<details class="destination-help"><summary>Where do I get an app key & secret? (one-time, free)</summary>
      <ol>
        <li>Open <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">Dropbox App Console</a> → <b>Create app</b> → <b>Scoped access</b> → <b>App folder</b>, name it.</li>
        <li>On the <b>Permissions</b> tab enable <b>files.content.write</b>, <b>files.content.read</b>, and <b>files.metadata.read</b> → Submit.</li>
        <li>On the <b>Settings</b> tab copy the <b>App key</b> and <b>App secret</b> above, Save, then click <b>Connect</b>.</li>
      </ol>
      <p>Prefer no setup? Use a <b>Local / synced folder</b> destination pointed at your Dropbox sync folder instead.</p>
    </details>`,
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

async function addBackupDestination() {
  const type = elements.watchBackupDestinationType?.value || "webdav";
  const label = DESTINATION_FORMS[type]?.label || type;
  await postWatchBackupAction({ action: "save-destination", destination: { type, label, enabled: false, settings: {}, secrets: {} } });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  setMessage(`Added ${label} destination — fill in the details and Save.`, "success");
}

async function saveBackupDestinationCard(card) {
  await postWatchBackupAction({ action: "save-destination", destination: collectDestination(card) });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  setMessage("Destination saved.", "success");
}

async function testBackupDestinationCard(card) {
  const destination = collectDestination(card);
  // Persist first so the server tests exactly what is shown.
  await postWatchBackupAction({ action: "save-destination", destination });
  const result = await postWatchBackupAction({ action: "test-destination", destinationId: destination.id });
  setMessage(`Connection OK — ${result.result?.detail || "reachable"}.`, "success");
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
}

async function removeBackupDestinationCard(card) {
  const approved = await openConfirmDialog({
    title: "Remove destination?",
    body: "Stop mirroring backups here? Files already uploaded to the remote are left untouched.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!approved) return;
  await postWatchBackupAction({ action: "remove-destination", destinationId: card.dataset.destId });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  setMessage("Destination removed.", "success");
}

async function listRemoteBackupsForCard(card) {
  const panel = card.querySelector("[data-dest-restore]");
  if (!panel) return;
  if (!panel.hidden) { // toggle closed
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  // Persist what's shown first so the listing uses the current credentials.
  await postWatchBackupAction({ action: "save-destination", destination: collectDestination(card) });
  panel.hidden = false;
  panel.innerHTML = `<div class="empty-log"><b>Loading backups…</b></div>`;
  const result = await postWatchBackupAction({ action: "list-remote-backups", destinationId: card.dataset.destId });
  const files = Array.isArray(result.files) ? result.files : [];
  if (!files.length) {
    panel.innerHTML = `<div class="empty-log"><b>No backups found on this destination</b><span>Run “Back Up Now” first, or recheck the credentials.</span></div>`;
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

async function restoreRemoteBackupFromCard(card, filename, clearMode = "reconcile") {
  const wipe = clearMode === "wipe";
  const approved = await openConfirmDialog({
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

async function connectBackupDestinationCard(card) {
  const destination = collectDestination(card);
  // Persist client/app credentials before kicking off the OAuth handshake.
  await postWatchBackupAction({ action: "save-destination", destination });
  if (destination.type === "onedrive") return connectOneDriveDestination(destination.id, card);
  if (destination.type === "dropbox") return connectDropboxDestination(destination.id, card);
}

async function connectOneDriveDestination(id, card) {
  const feedback = card.querySelector("[data-dest-feedback]");
  const start = await postWatchBackupAction({ action: "device-start", destinationId: id });
  if (feedback) {
    feedback.innerHTML = `Open <a href="${escapeAttribute(start.verificationUri)}" target="_blank" rel="noopener">${escapeHtml(start.verificationUri)}</a> and enter code <b>${escapeHtml(start.userCode)}</b>. Waiting for approval…`;
  }
  const deadline = Date.now() + (Number(start.expiresIn) || 900) * 1000;
  const interval = Math.max(2, Number(start.interval) || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const poll = await postWatchBackupAction({ action: "device-poll", pendingId: start.pendingId });
    if (poll.status === "authorized") {
      setMessage("OneDrive connected.", "success");
      state.watchBackups = null;
      await loadWatchBackups({ force: true });
      return;
    }
    if (poll.status === "error") {
      if (feedback) feedback.textContent = poll.error || "Authorization failed.";
      setMessage(poll.error || "OneDrive authorization failed.", "error");
      return;
    }
  }
  if (feedback) feedback.textContent = "Login timed out — start again.";
}

async function connectDropboxDestination(id, card) {
  const feedback = card.querySelector("[data-dest-feedback]");
  const { url } = await postWatchBackupAction({ action: "oauth-url", destinationId: id });
  window.open(url, "_blank", "noopener");
  if (feedback) feedback.innerHTML = `A Dropbox tab opened. Approve access, then paste the code below.`;
  const code = window.prompt("Dropbox: after approving access, paste the authorization code here:");
  if (!code) return;
  await postWatchBackupAction({ action: "oauth-exchange", destinationId: id, code });
  setMessage("Dropbox connected.", "success");
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
}

async function loadWatchBackups({ force = false } = {}) {
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

async function postWatchBackupAction(payload) {
  const response = await fetch("/api/watch-backups", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Backup action failed with ${response.status}`);
  return body;
}

async function saveWatchBackupSettings() {
  const config = {
    enabled: elements.watchBackupEnabled.checked,
    time: elements.watchBackupTime.value || "03:00",
    retention: Number(elements.watchBackupRetention.value) || 14,
  };
  await postWatchBackupAction({ action: "configure", config });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  setMessage("Watch-history backup schedule saved.", "success");
}

async function createWatchBackupNow() {
  const button = elements.createWatchBackupButton;
  button.disabled = true;
  button.textContent = "Backing up...";
  try {
    const result = await postWatchBackupAction({ action: "create" });
    state.watchBackups = null;
    await loadWatchBackups({ force: true });
    setMessage(`Created ${result.backup?.name || "watch-history backup"}.`, "success");
  } finally {
    button.disabled = false;
    button.textContent = "Back Up Now";
  }
}

async function downloadWatchBackup(filename) {
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

async function uploadWatchBackupFile(file) {
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
  setMessage(`Backup file added: ${body.file?.name || name}.`, "success");
  return body.file;
}

async function restoreWatchBackup(filename, clearMode = "reconcile", dryRun = false) {
  if (dryRun) {
    const result = await postWatchBackupAction({ action: "restore", filename, dryRun: true });
    const summary = result.restore || {};
    setMessage(`Backup valid: ${summary.watchHistory || 0} history, ${summary.playstate || 0} playstate, ${summary.playbackProgress || 0} progress rows.`, "success");
    return;
  }

  const wipe = clearMode === "wipe";
  const approved = await openConfirmDialog({
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

    clearDerivedUiCaches();
    await Promise.all([loadHistory({ force: true }), loadStats({ force: true })]);
    state.watchBackups = null;
    await loadWatchBackups({ force: true });

    if (jobResult && jobResult.success === false) {
      setMessage(`Restore finished with errors: ${jobResult.error || "see terminal"}.`, "error");
    } else {
      setMessage(`Watch history restored from ${payload.filename} and pushed to connected apps.`, "success");
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
function openEditDateDialog(_container, id, currentWatchedAt, onSaved) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel">
      <h3>Edit Watch Date</h3>
      <label class="field-label">
        Watched at
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
  const results = [];
  const seenShows = new Set();
  const seenMovies = new Set();

  // TV shows (deduplicated by title)
  for (const s of (state.showsRaw || [])) {
    if (results.length >= 4) break;
    if (!(s.title || "").toLowerCase().includes(q)) continue;
    if (seenShows.has(s.title)) continue;
    seenShows.add(s.title);
    results.push({ _type: "show", title: s.title, poster: s.poster_url || s.posterUrl || "", href: `/tvshow/${slug(s.title)}`, sub: "TV Show" });
  }

  // Movies
  for (const m of (state.history || [])) {
    if (results.length >= 7) break;
    if (m.media_type !== "movie") continue;
    if (!(m.title || "").toLowerCase().includes(q)) continue;
    if (seenMovies.has(m.title)) continue;
    seenMovies.add(m.title);
    results.push({ _type: "movie", title: m.title, poster: m.poster_url || "", href: `/movie/${m.id}`, sub: "Movie" });
  }

  // Episodes (search episode title)
  const seenEps = new Set();
  for (const e of (state.history || [])) {
    if (results.length >= 8) break;
    if (e.media_type !== "episode") continue;
    const epTitle = e.title || "";
    if (!epTitle.toLowerCase().includes(q)) continue;
    const key = `${e.show_title}|${epTitle}`;
    if (seenEps.has(key)) continue;
    seenEps.add(key);
    const showTitle = e.show_title || showTitleFrom(epTitle);
    const showEntry = (state.showsRaw || []).find((s) => slug(s.title) === slug(showTitle));
    const poster = showEntry?.poster_url || showEntry?.posterUrl || e.poster_url || "";
    const sNum = e.season ? `S${String(e.season).padStart(2, "0")}` : "";
    const eNum = e.episode ? `E${String(e.episode).padStart(2, "0")}` : "";
    const coord = [sNum, eNum].filter(Boolean).join("·");
    const sub = [showTitle, coord, "Episode"].filter(Boolean).join(" · ");
    results.push({ _type: "episode", title: epTitle, poster, href: `/tvshow/${slug(showTitle)}`, sub });
  }

  const discoveryState = state.globalDiscoveryResults.get(q);
  for (const item of (discoveryState?.results || [])) {
    if (results.length >= 14) break;
    const mediaType = item.media_type || (item.title ? "movie" : "tv");
    const title = item.title || item.name || "Unknown title";
    const duplicate = results.some((result) => result._type !== "episode" && result.title.toLowerCase() === title.toLowerCase());
    if (duplicate || !["movie", "tv"].includes(mediaType)) continue;
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);
    results.push({
      _type: mediaType === "movie" ? "movie" : "show",
      title,
      poster: tmdbPoster(item.poster_path),
      href: mediaType === "movie" ? `/movie/tmdb/${item.id}` : `/tvshow/tmdb/${item.id}`,
      sub: `${mediaType === "movie" ? "Movie" : "TV Show"}${year ? ` · ${year}` : ""} · TMDB`,
    });
  }

  if (!results.length && !discoveryState?.loading) return;

  const anchor = document.querySelector(".global-search");
  if (!anchor) return;

  const dd = document.createElement("div");
  dd.id = "globalSearchDropdown";
  dd.innerHTML = `
    <div class="gsd-header">Top Results for "<strong>${escapeHtml(query)}</strong>"</div>
    ${results.map((r) => `
      <button class="global-search-result" data-href="${escapeAttribute(r.href)}" tabindex="0">
        ${r.poster ? `<img src="${escapeAttribute(r.poster)}" alt="" class="gsr-thumb" loading="lazy">` : `<span class="gsr-thumb gsr-thumb--empty"></span>`}
        <span class="gsr-text">
          <span class="gsr-title">${escapeHtml(r.title)}</span>
          <span class="gsr-sub">${escapeHtml(r.sub)}</span>
        </span>
      </button>`).join("")}
    ${discoveryState?.loading ? `<div class="gsd-loading">Searching TMDB…</div>` : ""}
    <button class="gsd-more" data-search="${escapeAttribute(query)}">View All Results</button>
  `;

  anchor.appendChild(dd);

  dd.addEventListener("click", (e) => {
    const more = e.target.closest(".gsd-more");
    if (more) {
      closeGlobalSearchDropdown();
      state.explorerSearch = more.dataset.search;
      if (elements.explorerSearchInput) elements.explorerSearchInput.value = state.explorerSearch;
      selectView("explorer");
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

function openEditImageDialog(_container, id, _currentPosterUrl, tmdbData, onSaved) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide glass-panel">
      <h3>Choose Poster</h3>
      <p class="edit-dialog-status" style="margin:0;"></p>
      <div class="edit-image-grid poster-search-grid"></div>
      <label class="field-label" style="margin-top: 0.75rem;">
        YouTube URL <span class="muted-copy" style="font-weight:normal;">(paste to fetch thumbnails)</span>
        <div style="display:flex;gap:0.5rem;">
          <input type="url" class="field yt-url-input" placeholder="https://www.youtube.com/watch?v=..." style="flex:1;" />
          <button class="button-ghost yt-fetch-btn" type="button">Fetch</button>
        </div>
      </label>
      <label class="field-label" style="margin-top: 0.5rem;">
        Custom image URL
        <input type="url" class="field edit-image-input" placeholder="https://..." value="" />
      </label>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;

  const gridEl = overlay.querySelector(".poster-search-grid");
  const status = overlay.querySelector(".edit-dialog-status");
  const urlInput = overlay.querySelector(".edit-image-input");
  const ytInput = overlay.querySelector(".yt-url-input");
  const ytFetchBtn = overlay.querySelector(".yt-fetch-btn");

  const renderGrid = (posters, selectFirst = true) => {
    gridEl.innerHTML = posters.map((url, i) => `
      <button class="edit-image-option" type="button" data-url="${escapeAttribute(url)}">
        <img src="${escapeAttribute(url)}" alt="Poster ${i + 1}" loading="lazy" onerror="this.closest('button').style.display='none'" />
      </button>
    `).join("");
    gridEl.querySelectorAll(".edit-image-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        urlInput.value = btn.dataset.url;
        gridEl.querySelectorAll(".edit-image-option").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });
    if (selectFirst) {
      urlInput.value = posters[0];
      gridEl.querySelector(".edit-image-option")?.classList.add("selected");
    }
  };

  const fetchYouTubeThumbnails = async () => {
    const videoId = extractYouTubeId(ytInput.value.trim());
    if (!videoId) { status.textContent = "Could not find a YouTube video ID in that URL."; return; }
    status.textContent = "Fetching YouTube thumbnails…";
    // YouTube provides several thumbnail resolutions; maxresdefault may 404 for older videos
    const candidates = [
      `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    ];
    // Probe which ones actually exist by loading them as images
    const valid = await Promise.all(candidates.map((url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > 120 ? url : null); // 120px wide = YouTube's "no thumbnail" placeholder
      img.onerror = () => resolve(null);
      img.src = url;
    })));
    const found = valid.filter(Boolean);
    if (!found.length) { status.textContent = "No thumbnails found for that video."; return; }
    status.textContent = "";
    renderGrid(found);
  };

  ytFetchBtn.addEventListener("click", fetchYouTubeThumbnails);
  ytInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchYouTubeThumbnails(); } });

  const loadPosters = async () => {
    status.textContent = "Loading posters…";
    const tmdbId = tmdbData?.id;
    const mediaType = tmdbData?.title !== undefined ? "movie" : "tv";
    if (state.savedConfig?.tmdb?.configured && tmdbId) {
      try {
        const res = await fetch(`/api/tmdb-images?mediaType=${encodeURIComponent(mediaType)}&tmdbId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() });
        const data = await res.json();
        const posters = (data.posters || []).slice(0, 20).map((p) => tmdbPoster(p.file_path));
        if (posters.length) {
          status.textContent = "";
          renderGrid(posters);
          return;
        }
      } catch (e) { /* fall through */ }
    }
    // Fallback: use any images already on tmdbData
    const fallback = [];
    if (tmdbData?.poster_path) fallback.push(tmdbPoster(tmdbData.poster_path));
    if (tmdbData?.backdrop_path) fallback.push(`https://image.tmdb.org/t/p/w780${tmdbData.backdrop_path}`);
    if (fallback.length) { status.textContent = ""; renderGrid(fallback); }
    else { status.textContent = state.savedConfig?.tmdb?.configured ? "No posters found." : "Configure a TMDB API key to browse posters."; }
  };

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) { status.textContent = "Please select or enter an image URL."; return; }
    status.textContent = "Saving…";
    try {
      await apiUpdateWatch(id, { poster_url: url });
      overlay.remove();
      onSaved?.({ poster_url: url });
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
            <img src="${escapeAttribute(poster)}" alt="" onerror="this.src='/favicon.svg'" />
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
        ? `<img src="${escapeAttribute(meta.thumbnails[0])}" alt="thumbnail" style="width:120px;height:68px;object-fit:cover;border-radius:4px;flex-shrink:0;" onerror="this.style.display='none'" />`
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
            ${posterUrl ? `<img src="${escapeAttribute(posterUrl)}" alt="" onerror="this.style.display='none'" />` : ""}
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
  renderLogs().catch(() => {});
  return state.debugLogs.at(-1);
}

function logsText() {
  return logsToText(state.debugLogs);
}

function storedAdminToken() {
  return readStoredAdminToken([TOKEN_KEY, LEGACY_UPPER_TOKEN_KEY], state.token);
}

function nowPlayingUrl() {
  return buildNowPlayingUrl(window.location.origin, storedAdminToken());
}

function bootstrapTokenFromUrl() {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const hasAuthParams = /(?:[?&#](?:adminToken|username|token)=)|(?:^#(?:adminToken|username|token)=)/i.test(`${search}${hash}`);

  if (!hasAuthParams) return;

  scrubTokenFromLocation();
}

bootstrapTokenFromUrl();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function sanitizeTitle(value) {
  const raw = String(value || "").trim();
  if (!raw || /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) return "";
  return raw;
}

function safeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (window.location.protocol === "https:" && url.protocol === "http:") return "";
    return /^https?:\/\//i.test(raw) ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function compactPosterUrl(value) {
  const raw = String(value || "").trim();
  if (isCachedStorageImageUrl(raw)) return raw;
  const url = safeImageUrl(raw);
  if (!url) return "";
  return url.replace(/(https:\/\/image\.tmdb\.org\/t\/p\/)original\//i, `$1${TMDB_POSTER_SIZE}/`);
}

function persistentPosterCacheKey() {
  const userKey = state.firebaseUser?.uid || state.firebaseUser?.email || "local";
  return `${POSTER_LOOKUP_PERSISTED_CACHE_KEY}:${userKey}`;
}

function readPersistentPosterCache() {
  try {
    const raw = localStorage.getItem(persistentPosterCacheKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    return [];
  }
}

// In-memory mirror of the persisted poster cache so each poster resolution
// doesn't pay a full localStorage JSON parse/stringify round trip. Writes are
// debounced and flushed when the page is hidden or unloaded.
let posterCacheMirror = null;
let posterCacheFlushTimer = null;

function flushPosterCacheMirror() {
  if (posterCacheFlushTimer) {
    clearTimeout(posterCacheFlushTimer);
    posterCacheFlushTimer = null;
  }
  if (!posterCacheMirror) return;
  try {
    localStorage.setItem(posterCacheMirror.key, JSON.stringify({ entries: posterCacheMirror.entries }));
  } catch (error) {
    // Poster storage is best-effort; missing entries can still resolve through the API.
  }
}

function schedulePosterCacheFlush() {
  if (posterCacheFlushTimer) return;
  posterCacheFlushTimer = setTimeout(() => {
    posterCacheFlushTimer = null;
    flushPosterCacheMirror();
  }, 500);
}

function posterCacheEntries() {
  const key = persistentPosterCacheKey();
  if (!posterCacheMirror || posterCacheMirror.key !== key) {
    flushPosterCacheMirror();
    posterCacheMirror = { key, entries: readPersistentPosterCache() };
  }
  return posterCacheMirror.entries;
}

window.addEventListener("pagehide", flushPosterCacheMirror);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPosterCacheMirror();
});

function clearPersistentPosterLookupCache() {
  if (posterCacheFlushTimer) {
    clearTimeout(posterCacheFlushTimer);
    posterCacheFlushTimer = null;
  }
  posterCacheMirror = null;
  try {
    localStorage.removeItem(persistentPosterCacheKey());
  } catch (error) {}
}

function cachedPosterLookup(posterId) {
  if (!posterId) return undefined;
  if (state.posterLookupCache.has(posterId)) return state.posterLookupCache.get(posterId) || "";

  const now = Date.now();
  const allEntries = posterCacheEntries();
  const entries = allEntries.filter((entry) => now - Number(entry.savedAt || 0) <= POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS);
  if (entries.length !== allEntries.length) {
    posterCacheMirror.entries = entries;
    schedulePosterCacheFlush();
  }
  const cached = entries.find((entry) => entry.id === posterId);
  if (!cached) return undefined;

  const url = typeof cached.url === "string" && isCachedStorageImageUrl(cached.url) ? cached.url : "";
  if (cached.url && !url) {
    posterCacheMirror.entries = entries.filter((entry) => entry.id !== posterId);
    schedulePosterCacheFlush();
    return undefined;
  }
  state.posterLookupCache.set(posterId, url);
  return url;
}

function rememberPosterLookup(posterId, posterUrl) {
  if (!posterId) return;
  const url = isCachedStorageImageUrl(posterUrl) ? posterUrl : "";
  const savedAt = Date.now();
  state.posterLookupCache.set(posterId, url);

  const entries = posterCacheEntries()
    .filter((entry) => entry.id !== posterId && savedAt - Number(entry.savedAt || 0) <= POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS)
    .concat({ id: posterId, url, savedAt });
  if (entries.length > POSTER_LOOKUP_PERSISTED_CACHE_LIMIT) {
    entries.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    entries.length = POSTER_LOOKUP_PERSISTED_CACHE_LIMIT;
  }
  posterCacheMirror.entries = entries;
  schedulePosterCacheFlush();
}

function historyVersionFromRows(rows = []) {
  const newest = rows.reduce((latest, row) => {
    const watchedAt = String(row?.watched_at || "");
    return watchedAt > latest ? watchedAt : latest;
  }, "");
  return newest ? `rows:${newest}:${rows.length}` : "empty";
}

function persistentDashboardHistoryCacheKey() {
  const userKey = state.firebaseUser?.uid || state.firebaseUser?.email || "local";
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
  const userKey = state.firebaseUser?.uid || state.firebaseUser?.email || "local";
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
  } catch (error) {}
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

function posterServerConfig(source = "") {
  const key = String(source || "").toLowerCase();
  if (key.includes("plex")) return { ...state.savedConfig.plex, source: "plex" };
  if (key.includes("emby")) return { ...state.savedConfig.emby, source: "emby" };
  if (key.includes("jellyfin")) return { ...state.savedConfig.jellyfin, source: "jellyfin" };
  return {};
}

function configuredImageUrl(path, item = {}) {
  const raw = String(path || "").trim();
  const server = posterServerConfig(item.source);
  const baseUrl = String(server.baseUrl || server.url || "").trim().replace(/\/+$/, "");
  if (!raw || !baseUrl) return "";

  try {
    const url = new URL(raw, `${baseUrl}/`);
    if (server.source === "plex" && (server.token || server.apiKey)) {
      url.searchParams.set("X-Plex-Token", server.token || server.apiKey);
    }
    if ((server.source === "emby" || server.source === "jellyfin") && (server.apiKey || server.api_key)) {
      url.searchParams.set("api_key", server.apiKey || server.api_key);
    }
    if (window.location.protocol === "https:" && url.protocol === "http:") return "";
    return url.toString();
  } catch (error) {
    return "";
  }
}

function isCachedStorageImageUrl(value = "") {
  const raw = String(value || "").trim();
  // Locally cached artwork is served from /media/posters or /media/backdrops.
  return raw.startsWith("/media/posters/") || raw.startsWith("/media/backdrops/");
}

function posterUrlFor(item = {}) {
  if (item.id != null) {
    const cached = cachedPosterLookup(String(item.id));
    if (cached !== undefined) return cached || "";
  }
  const raw = item.poster_url || item.posterUrl || item.imageUrl || item.thumb || "";
  if (isCachedStorageImageUrl(raw)) return raw;
  if (raw.startsWith("https://img.youtube.com/")) return raw;
  if (item.id != null) return "";
  if (raw) {
    return configuredImageUrl(raw, item);
  }
  return "";
}

function posterMarkup(item = {}, className = "media-poster") {
  const url = posterUrlFor(item);
  const label = item.title || "Media poster";
  const posterId = item.id != null ? ` data-poster-id="${escapeAttribute(String(item.id))}"` : "";
  if (!url) return `<span class="${className} poster-fallback"${posterId} aria-hidden="true"></span>`;
  return `<img class="${className}"${posterId} src="${escapeAttribute(url)}" alt="${escapeAttribute(label)} poster" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
}

function posterFallbackElement(className = "media-poster", posterId = "") {
  const fallback = document.createElement("span");
  fallback.className = `${className} poster-fallback`.trim();
  fallback.setAttribute("aria-hidden", "true");
  if (posterId) fallback.dataset.posterId = posterId;
  return fallback;
}

async function lookupPosterUrl(posterId, { fallback = false } = {}) {
  if (!posterId) return "";
  if (!fallback) {
    const cached = cachedPosterLookup(posterId);
    if (cached !== undefined) return cached || "";
  }
  if (!state.token) {
    return "";
  }

  const cacheKey = fallback ? `${posterId}:fallback` : posterId;
  let lookup = state.posterLookupInflight.get(cacheKey);
  if (!lookup) {
    const url = new URL("/api/poster", window.location.origin);
    url.searchParams.set("id", posterId);
    if (fallback) url.searchParams.set("fallback", "1");
    lookup = fetch(url, { headers: authHeaders() })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        if (!body.url) {
          return "MISSING";
        }
        const usableUrl = compactPosterUrl(body.url);
        if (usableUrl || fallback) return usableUrl;
        return lookupPosterUrl(posterId, { fallback: true });
      })
      .catch((error) => {
        console.warn("Poster lookup failed", error);
        return "ERROR";
      })
      .finally(() => state.posterLookupInflight.delete(cacheKey));
    state.posterLookupInflight.set(cacheKey, lookup);
  }

  const posterUrl = await lookup;
  if (posterUrl === "ERROR") {
    return "";
  }
  const finalUrl = posterUrl === "MISSING" ? "" : posterUrl;
  rememberPosterLookup(posterId, finalUrl || "");
  return finalUrl || "";
}

function shouldHydratePosterElement(element) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  return rect.bottom >= -120 && rect.right >= -120 && rect.top <= viewportHeight + 360 && rect.left <= viewportWidth + 120;
}

async function hydratePosterFallbacks(container = document.body) {
  if (!container) return;
  const fallbacks = [...container.querySelectorAll("[data-poster-id].poster-fallback")].filter((fallback) => {
    const posterId = fallback.dataset.posterId;
    return posterId && !state.posterLookupCache.has(posterId) && shouldHydratePosterElement(fallback);
  });
  if (!fallbacks.length) return;

  const hydrateOne = async (fallback) => {
    const posterId = fallback.dataset.posterId;
    if (!posterId || state.posterLookupCache.has(posterId)) return;

    const posterUrl = await lookupPosterUrl(posterId);
    if (!posterUrl || !fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

    const image = document.createElement("img");
    image.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
    bindPosterImageErrorHandler(image);
    image.src = posterUrl;
    image.alt = `${fallback.getAttribute("aria-label") || "Media poster"}`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.dataset.posterId = posterId;
    fallback.replaceWith(image);
  };

  const workers = Array.from({ length: Math.min(POSTER_LOOKUP_CONCURRENCY, fallbacks.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < fallbacks.length; index += POSTER_LOOKUP_CONCURRENCY) {
      await hydrateOne(fallbacks[index]);
    }
  });

  await Promise.allSettled(workers);
}

function bindPosterImageErrorHandler(image) {
  if (image.dataset.posterErrorBound) return;
  image.dataset.posterErrorBound = "1";
  image.addEventListener("error", async () => {
    const posterId = image.dataset.posterId;
    if (!posterId || image.dataset.posterFallbackAttempted === "1") {
      if (posterId) state.posterLookupCache.set(posterId, "");
      image.replaceWith(posterFallbackElement(image.className, posterId));
      return;
    }

    image.dataset.posterFallbackAttempted = "1";
    const brokenUrl = image.currentSrc || image.src;
    const fallbackUrl = await lookupPosterUrl(posterId, { fallback: true });
    if (fallbackUrl && fallbackUrl !== brokenUrl && image.isConnected) {
      image.src = fallbackUrl;
      return;
    }

    state.posterLookupCache.set(posterId, "");
    if (image.isConnected) image.replaceWith(posterFallbackElement(image.className, posterId));
  });
}

function hydratePosterImages(container = document.body) {
  if (!container) return;
  for (const image of container.querySelectorAll("img[data-poster-id]")) {
    bindPosterImageErrorHandler(image);
  }
}

function hydratePosters(container = document.body) {
  hydratePosterImages(container);
  hydratePosterFallbacks(container).catch(() => {});
}

function snippet(code, language = "text") {
  const trimmed = String(code).trim();
  return `
    <div class="copy-block">
      <button class="copy-button" type="button" data-copy="${escapeAttribute(trimmed)}" aria-label="Copy ${escapeHtml(language)} snippet">Copy</button>
      <pre><code>${escapeHtml(trimmed)}</code></pre>
    </div>
  `;
}

function terminalOutput(text) {
  return `<pre class="terminal-output"><code>${escapeHtml(text)}</code></pre>`;
}

function telemetryLineValue(telemetry = "", label = "") {
  const prefix = `${label}:`;
  const line = String(telemetry || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

function historyAction(entry = {}) {
  const action = String(entry.sync_action || "").toLowerCase();
  if (["unwatched", "unplayed"].includes(action)) return "Marked Unwatched";
  const telemetryAction = telemetryLineValue(entry.sync_dispatch_telemetry, "Action");
  if (/unwatched|unplayed/i.test(telemetryAction)) return "Marked Unwatched";
  return "Marked Watched";
}

function isWatchedHistoryAction(entry = {}) {
  return historyAction(entry) !== "Marked Unwatched";
}

function syncStatus(entry = {}) {
  const telemetry = String(entry.sync_dispatch_telemetry || "");
  if (telemetry.includes("Force Sync resolved status to")) {
    return { tone: "success", label: "Full sync complete", detail: telemetry };
  }
  const status = telemetryLineValue(telemetry, "Dispatch status").toLowerCase();
  const origin = telemetryLineValue(telemetry, "Origin").toLowerCase();
  const details = telemetryLineValue(telemetry, "Details").toLowerCase();
  const hasTargetTelemetry = telemetryTargetStates(telemetry).length > 0;
  if (origin.endsWith("_initial_sync") && !hasTargetTelemetry && details.includes("awaiting outbound sync telemetry")) {
    return { tone: "success", label: "Sync skipped intentionally", detail: "This row came from an initial history import and has no active outbound sync job." };
  }
  if (status === "success") {
    return { tone: "success", label: "Full sync complete", detail: "All configured target apps accepted this watched-state change." };
  }
  if (["pending", "queued", "in_progress", "in progress"].includes(status)) {
    return { tone: "pending", label: "Sync in progress", detail: "Propagation is queued or waiting for target app responses." };
  }
  if (status === "skipped") {
    return { tone: "success", label: "Sync skipped intentionally", detail: "No outbound sync was required for this history row." };
  }
  return { tone: "error", label: "Sync needs attention", detail: status ? "One or more target apps did not confirm this watched-state change." : "No dispatch telemetry was recorded for this history row." };
}

function historySyncPill(entry = {}) {
  return `
    <span class="history-sync-row">
      <span class="history-action-pill ${sourceClass(entry.source)}">${escapeHtml(platformBadge(entry.source))} - ${escapeHtml(historyAction(entry))}</span>
      ${renderSyncStatusDot(entry)}
    </span>
  `;
}

function getActiveTargets() {
  const targets = [];
  if (state.savedConfig.plex?.baseUrl && state.savedConfig.plex?.token && !state.savedConfig.plex?.disabled) targets.push("plex");
  if (state.savedConfig.emby?.baseUrl && state.savedConfig.emby?.apiKey && state.savedConfig.emby?.userId && !state.savedConfig.emby?.disabled) targets.push("emby");
  if (state.savedConfig.jellyfin?.baseUrl && state.savedConfig.jellyfin?.apiKey && state.savedConfig.jellyfin?.userId && !state.savedConfig.jellyfin?.disabled) targets.push("jellyfin");
  return targets;
}

function sourcePlatform(value = "") {
  const source = String(value || "").toLowerCase();
  if (source.startsWith("plex")) return "plex";
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  return "";
}

function normalizeTargetStatus(value = "") {
  const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["fulfilled", "ok", "complete", "completed"].includes(status)) return "success";
  if (["queued", "in_progress", "checking"].includes(status)) return "pending";
  if (["not_found", "not_attempted", "unavailable"].includes(status)) return "skipped";
  return status || "pending";
}

function targetStateUnavailable(state = {}) {
  const text = `${state.rawStatus || state.status || ""} ${state.detail || ""}`.toLowerCase();
  return text.includes("no matching") || text.includes("not_found") || text.includes("not found") || text.includes("unavailable");
}

function targetStateNoop(state = {}) {
  const text = `${state.rawStatus || state.status || ""} ${state.detail || ""}`.toLowerCase();
  return text.includes("not attempted") || text.includes("historical import") || text.includes("stored locally");
}

function hasConfirmedMediaAvailability(entry = {}, states = []) {
  const activeTargets = getActiveTargets();
  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");
  if (telemetry.includes("Force Sync resolved status to success")) return true;
  if (activeTargets.includes(sourcePlatform(entry.source))) return true;
  return states.some((state) => normalizeTargetStatus(state.status) === "success");
}

function sharedLibraryAvailability(entry = {}, states = telemetryTargetStates(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "")) {
  if (!hasConfirmedMediaAvailability(entry, states)) return null;
  return { statusClass: "success", statusLabel: "Available" };
}

function getMediaTargetSyncStatus(entry = {}) {
  const activeTargets = getActiveTargets();
  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");
  
  if (telemetry.includes("Force Sync resolved status to success")) {
    return activeTargets.map(target => ({ target, status: "success" }));
  }
  
  const states = telemetryTargetStates(telemetry);
  const source = String(entry.source || "").toLowerCase();
  const available = hasConfirmedMediaAvailability(entry, states);
  
  return activeTargets.map((target) => {
    if (source === target || source.startsWith(`${target}_`)) {
      return { target, status: "success" };
    }
    const match = states.find((s) => s.target === target);
    if (match) {
      const status = normalizeTargetStatus(match.status);
      if (status === "success" || status === "pending" || status === "error") {
        return { target, status };
      }
      if ((targetStateUnavailable(match) || targetStateNoop(match)) && !available) {
        return { target, status: "skipped", hidden: true, detail: match.detail };
      }
      if (targetStateUnavailable(match) && available) {
        return { target, status: "error", detail: match.detail };
      }
      if (targetStateNoop(match) && available) {
        return { target, status: "pending", detail: match.detail };
      }
      return { target, status: "skipped", detail: match.detail };
    }
    
    if (telemetry.includes("Details: Historical import stored locally") || telemetry.includes("Origin: import")) {
      return { target, status: "skipped", hidden: true };
    }
    
    if (!available) {
      return { target, status: "skipped", hidden: true };
    }

    return { target, status: "pending" };
  });
}

function getSyncStatusTone(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "success";
  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "";
  if (statuses.some((s) => s.status === "error")) {
    return "error";
  }
  if (statuses.some((s) => s.status === "pending")) {
    return "pending";
  }
  return "success";
}

function getSyncStatusTooltip(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "No targets configured";
  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "No sync status needed";
  return `Watched sync: ${statuses.map(s => `${platformBadge(s.target)} ${s.status}`).join(", ")}`;
}

function renderSyncStatusDot(entry = {}, style = "") {
  const tone = getSyncStatusTone(entry);
  if (!tone) return "";
  const tooltip = getSyncStatusTooltip(entry);
  const styleAttr = style ? ` style="${escapeAttribute(style)}"` : "";
  return `<span class="sync-status-dot sync-status-dot--${tone}" data-sync-status-dot="true" role="button" tabindex="0" title="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}"${styleAttr}></span>`;
}

function showAvailIssuePopup(anchorEl) {
  const existing = document.getElementById("avail-issue-popup");
  if (existing) existing.remove();

  const message = anchorEl.dataset.availIssue || "Unknown issue.";
  const lines = message.split("\\n");
  const [headline, ...steps] = lines;

  const popup = document.createElement("div");
  popup.id = "avail-issue-popup";
  popup.className = "avail-issue-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-modal", "false");

  const stepsHtml = steps.length
    ? `<ol class="avail-issue-steps">${steps.map(s => `<li>${escapeHtml(s.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>`
    : "";

  popup.innerHTML = `
    <button class="avail-issue-close" type="button" aria-label="Close">✕</button>
    <b class="avail-issue-headline">${escapeHtml(headline)}</b>
    ${stepsHtml ? `<p class="avail-issue-fix-label">Steps to fix:</p>${stepsHtml}` : ""}
  `;

  document.body.appendChild(popup);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  const popupW = 280;
  let left = rect.left + window.scrollX;
  let top = rect.bottom + window.scrollY + 6;
  if (left + popupW > window.innerWidth - 12) left = window.innerWidth - popupW - 12;
  if (left < 8) left = 8;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  const closePopup = (event) => {
    if (!popup.contains(event?.target) || event?.target.classList.contains("avail-issue-close")) {
      popup.remove();
      document.removeEventListener("click", outsideClick, true);
      document.removeEventListener("keydown", escKey);
    }
  };
  const outsideClick = (event) => {
    if (!popup.contains(event.target) && event.target !== anchorEl) closePopup(event);
  };
  const escKey = (event) => { if (event.key === "Escape") closePopup(); };

  popup.querySelector(".avail-issue-close").addEventListener("click", closePopup);
  setTimeout(() => {
    document.addEventListener("click", outsideClick, true);
    document.addEventListener("keydown", escKey);
  }, 0);
}

function renderAvailabilityPills(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";
  
  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");
  const states = telemetryTargetStates(telemetry);
  const source = String(entry.source || "").toLowerCase();
  const sharedAvailability = sharedLibraryAvailability(entry, states);
  
  return activeTargets.map((target) => {
    let statusClass = "pending";
    let issueDetail = "";
    
    if (sharedAvailability) {
      statusClass = sharedAvailability.statusClass;
    } else if (source === target || source.startsWith(`${target}_`)) {
      statusClass = "success";
    } else {
      const match = states.find((s) => s.target === target);
      if (match) {
        if (match.status === "success") {
          statusClass = "success";
        } else if (match.status === "skipped" && (match.detail.includes("No matching") || match.detail.includes("not_found") || match.detail.includes("not found"))) {
          statusClass = "error";
          issueDetail = `${platformBadge(target)} could not find this title in your library. Steps to fix:\n1. Confirm the title exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check that your ${platformBadge(target)} server URL and credentials are correct in Settings.\n4. Use Force Sync to re-check all platforms.`;
        } else if (match.status === "error") {
          const detailLower = String(match.detail || "").toLowerCase();
          if (detailLower.includes("not found") || detailLower.includes("404") || detailLower.includes("not_found")) {
            statusClass = "error";
            issueDetail = `${platformBadge(target)} returned a 'not found' error for this title. Steps to fix:\n1. Confirm the title exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check your server URL and API credentials in Settings.`;
          } else {
            statusClass = "error";
            issueDetail = `${platformBadge(target)} reported an error: ${match.detail || "unknown error"}. Steps to fix:\n1. Check your ${platformBadge(target)} server is running and reachable.\n2. Verify your API key / token in Settings.\n3. Use Force Sync to retry.`;
          }
        } else {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} sync is still in progress. Steps to fix:\n1. Wait a moment and refresh.\n2. If it stays pending, use Force Sync.\n3. Check the Sync Jobs panel for details.`;
        }
      } else {
        if (telemetry.includes("Historical import stored locally") || telemetry.includes("Origin: import")) {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} sync has not run yet for this imported item. Steps to fix:\n1. Use Force Sync to push this watched-state to all platforms.\n2. Check the Sync Jobs panel for progress.`;
        } else {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} availability is unknown. Steps to fix:\n1. Use Force Sync to check all platforms.\n2. Verify ${platformBadge(target)} credentials in Settings.`;
        }
      }
    }
    
    const displayTarget = platformBadge(target);
    const issueAttr = (statusClass !== "success" && issueDetail) ? ` data-avail-issue="${escapeAttribute(issueDetail)}" role="button" tabindex="0" style="cursor:pointer;"` : "";
    return `<span class="target-pill avail-pill" data-status="${statusClass}"${issueAttr} title="${escapeAttribute(displayTarget)}">${escapeHtml(displayTarget)}</span>`;
  }).join(" ");
}

function renderShowAvailabilityPills(show = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";
  
  const episodes = show.episodes || [];
  const watchedEpisodes = episodes.filter(e => isWatchedHistoryAction(e));
  const sharedAvailable = watchedEpisodes.some((episode) => sharedLibraryAvailability(episode));
  
  return activeTargets.map((target) => {
    let statusClass = "pending";
    let issueDetail = "";
    
    let anyAvailable = false;
    let anyChecked = false;
    let allUnavailable = true;
    
    for (const ep of watchedEpisodes) {
      const source = String(ep.source || "").toLowerCase();
      if (source === target || source.startsWith(`${target}_`)) {
        anyAvailable = true;
        anyChecked = true;
        allUnavailable = false;
        break;
      }
      
      const telemetry = String(ep.sync_dispatch_telemetry || ep.syncDispatchTelemetry || "");
      const states = telemetryTargetStates(telemetry);
      const match = states.find((s) => s.target === target);
      if (match) {
        anyChecked = true;
        if (match.status === "success") {
          anyAvailable = true;
          allUnavailable = false;
          break;
        } else if (match.status === "skipped" && (match.detail.includes("No matching") || match.detail.includes("not_found") || match.detail.includes("not found"))) {
          // Continue loop
        } else {
          allUnavailable = false;
        }
      } else {
        allUnavailable = false;
      }
    }
    
    if (sharedAvailable || anyAvailable) {
      statusClass = "success";
    } else if (anyChecked && allUnavailable && watchedEpisodes.length > 0) {
      statusClass = "error";
      issueDetail = `${platformBadge(target)} could not find this show in your library. Steps to fix:\n1. Confirm the show exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check that your server URL and credentials are correct in Settings.\n4. Use Force Sync to re-check.`;
    } else {
      statusClass = "pending";
      issueDetail = `${platformBadge(target)} availability is still being determined. Steps to fix:\n1. Use Force Sync to push watched-state to all platforms.\n2. Check the Sync Jobs panel for details.\n3. Verify ${platformBadge(target)} credentials in Settings.`;
    }
    
    const displayTarget = platformBadge(target);
    const issueAttr = (statusClass !== "success" && issueDetail) ? ` data-avail-issue="${escapeAttribute(issueDetail)}" role="button" tabindex="0" style="cursor:pointer;"` : "";
    return `<span class="target-pill avail-pill" data-status="${statusClass}"${issueAttr} title="${escapeAttribute(displayTarget)}">${escapeHtml(displayTarget)}</span>`;
  }).join(" ");
}

function renderMediaSyncPills(entry = {}, showRetry = true) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";
  
  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "";
  const allSynced = statuses.every((s) => s.status === "success" || s.status === "skipped");
  
  const pillsHtml = statuses
    .map((s) => {
      const statusClass = s.status === "success" ? "success" : s.status === "pending" ? "pending" : "error";
      return `<span class="target-pill" data-status="${statusClass}" style="font-size: 0.62rem; padding: 0.1rem 0.35rem; margin-right: 0.2rem;" title="${escapeAttribute(`${platformBadge(s.target)}: ${s.status}`)}">${escapeHtml(platformBadge(s.target))}</span>`;
    })
    .join("");
    
  const retryButtonHtml = (showRetry && !allSynced)
    ? `<button class="retry-sync-btn" type="button" data-retry-sync-id="${escapeAttribute(entry.id)}" title="Retry syncing watched state to all platforms">Retry</button>`
    : "";
    
  return `
    <div class="media-sync-row">
      <div class="media-sync-pills">
        ${pillsHtml}
      </div>
      ${retryButtonHtml}
    </div>
  `;
}

function telemetryTargetStates(telemetry = "") {
  const rows = [];
  for (const line of String(telemetry || "").split(/\r?\n/)) {
    const match = line.match(/^(?:Target\s+)?(Plex|Emby|Jellyfin)\s+(?:progress\s+)?status:\s*([^-]+)(?:\s+-\s*(.*))?$/i);
    if (!match) continue;
    rows.push({
      target: match[1].toLowerCase(),
      status: normalizeTargetStatus(match[2]),
      rawStatus: match[2].trim().toLowerCase(),
      detail: (match[3] || "").trim(),
    });
  }
  return rows;
}

function syncJobSortWeight(job = {}) {
  const status = syncStatus(job).tone;
  if (status === "pending") return 0;
  if (status === "error") return 1;
  return 2;
}

function renderTargetPills(job = {}) {
  const targets = telemetryTargetStates(job.sync_dispatch_telemetry);
  if (!targets.length) return `<span class="target-pill" data-status="error">No target telemetry</span>`;
  return targets
    .map((target) => {
      const status = target.status === "success" ? "success" : target.status === "pending" ? "pending" : "error";
      const detail = target.detail ? ` - ${target.detail}` : "";
      return `<span class="target-pill" data-status="${status}" title="${escapeAttribute(`${platformBadge(target.target)} ${target.status}${detail}`)}">${escapeHtml(platformBadge(target.target))}: ${escapeHtml(target.status)}</span>`;
    })
    .join("");
}

function syncHistoryTone(entry = {}) {
  const status = String(entry.status || "").toLowerCase();
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (status === "error" || targets.some((target) => String(target.status || "").toLowerCase() === "error")) return "error";
  if (["pending", "queued", "in_progress", "partial"].includes(status)) return "pending";
  return "success";
}

function syncHistoryActionLabel(entry = {}) {
  const action = String(entry.action || "").toLowerCase();
  if (action === "progress") return "Resume Progress";
  if (action === "unwatched" || action === "unplayed") return "Marked Unwatched";
  return "Marked Watched";
}

function syncHistoryTargetPills(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (!targets.length) return `<span class="target-pill" data-status="pending">No target detail</span>`;
  return targets
    .map((target) => {
      const status = String(target.status || "unknown").toLowerCase();
      const tone = status === "success" ? "success" : status === "error" ? "error" : "pending";
      const detail = target.detail ? ` - ${target.detail}` : "";
      return `<span class="target-pill" data-status="${tone}" title="${escapeAttribute(`${platformBadge(target.target)} ${status}${detail}`)}">${escapeHtml(platformBadge(target.target))}: ${escapeHtml(status)}</span>`;
    })
    .join("");
}

function renderSyncJobs() {
  if (!elements.syncJobsPanel) return;

  if (state.syncJobsLoading) {
    elements.syncJobsPanel.innerHTML = `<div class="empty-log"><b>Loading sync jobs</b><span>Fetching current watched-state dispatch rows.</span></div>`;
    if (elements.syncSummary) elements.syncSummary.textContent = "Loading";
    return;
  }

  const jobs = [...state.syncJobs].sort((a, b) => syncJobSortWeight(a) - syncJobSortWeight(b) || String(b.watched_at || "").localeCompare(String(a.watched_at || "")));
  const pendingCount = jobs.filter((job) => syncStatus(job).tone === "pending").length;
  const errorCount = jobs.filter((job) => syncStatus(job).tone === "error").length;

  if (elements.syncSummary) {
    elements.syncSummary.textContent = jobs.length ? `${jobs.length} outstanding / ${pendingCount} pending / ${errorCount} needs attention` : "All clear";
    elements.syncSummary.className = `status-pill ${errorCount ? "status-error" : pendingCount ? "status-warning" : "status-ready"}`;
  }

  if (!jobs.length) {
    elements.syncJobsPanel.innerHTML = `<div class="empty-log"><b>No outstanding sync jobs</b><span>Recent watched-state dispatches have completed or were intentionally skipped.</span></div>`;
    return;
  }

  elements.syncJobsPanel.innerHTML = jobs
    .map((job) => {
      const status = syncStatus(job);
      const dispatchStatus = telemetryLineValue(job.sync_dispatch_telemetry, "Dispatch status") || "missing";
      const details = telemetryLineValue(job.sync_dispatch_telemetry, "Details") || status.detail;
      return `
        <article class="sync-job-card" data-history-id="${escapeAttribute(job.id)}">
          <div class="sync-job-main">
            <span class="sync-status-dot sync-status-dot--${status.tone}" aria-hidden="true"></span>
            <div class="sync-job-title">
              <b>${escapeHtml(job.title || "Unknown media")}</b>
              <span>${escapeHtml(platformBadge(job.source))} - ${escapeHtml(historyAction(job))} - ${escapeHtml(formatDate(job.watched_at))}</span>
            </div>
            <span class="status-pill ${status.tone === "pending" ? "status-warning" : "status-error"}">${escapeHtml(status.label)}</span>
          </div>
          <div class="sync-job-meta">
            <div><span>Dispatch</span><b>${escapeHtml(dispatchStatus)}</b></div>
            <div><span>Media</span><b>${escapeHtml(job.media_type || "unknown")}</b></div>
            <div><span>IDs</span><b>${escapeHtml(idLine(job) || "No provider IDs")}</b></div>
            <div><span>Details</span><b>${escapeHtml(details)}</b></div>
          </div>
          <div class="sync-target-row">${renderTargetPills(job)}</div>
          <pre class="sync-telemetry">${escapeHtml(job.sync_dispatch_telemetry || "No sync telemetry recorded.")}</pre>
        </article>
      `;
    })
    .join("");
}

function renderSyncHistory() {
  if (!elements.syncHistoryPanel) return;

  if (state.syncHistoryLoading) {
    elements.syncHistoryPanel.innerHTML = `<div class="empty-log"><b>Loading sync history</b><span>Fetching recent propagation attempts.</span></div>`;
    if (elements.syncHistorySummary) elements.syncHistorySummary.textContent = "Loading";
    return;
  }

  const history = [...state.syncHistory].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const errorCount = history.filter((entry) => syncHistoryTone(entry) === "error").length;

  if (elements.syncHistorySummary) {
    elements.syncHistorySummary.textContent = history.length ? `${history.length} recent / ${errorCount} failed` : "No history";
    elements.syncHistorySummary.className = `status-pill ${errorCount ? "status-error" : history.length ? "status-ready" : "status-muted"}`;
  }

  if (!history.length) {
    elements.syncHistoryPanel.innerHTML = `<div class="empty-log"><b>No sync history yet</b><span>New webhook, cron, and resume propagation attempts will appear here.</span></div>`;
    return;
  }

  elements.syncHistoryPanel.innerHTML = history
    .map((entry) => {
      const tone = syncHistoryTone(entry);
      const debug = entry.rawPayloadDebug && Object.keys(entry.rawPayloadDebug).length ? JSON.stringify(entry.rawPayloadDebug, null, 2) : "";
      return `
        <details class="sync-history-card">
          <summary class="sync-history-summary">
            <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
            <b>${escapeHtml(entry.title || "Unknown media")}</b>
          </summary>
          <div class="sync-job-main">
            <div class="sync-job-title">
              <span>${escapeHtml(platformBadge(entry.source))} - ${escapeHtml(syncHistoryActionLabel(entry))} - ${escapeHtml(formatDate(entry.timestamp))}</span>
            </div>
            <span class="status-pill ${tone === "error" ? "status-error" : tone === "pending" ? "status-warning" : "status-ready"}">${escapeHtml(entry.status || "unknown")}</span>
          </div>
          <div class="sync-job-meta">
            <div><span>Action</span><b>${escapeHtml(syncHistoryActionLabel(entry))}</b></div>
            <div><span>Media</span><b>${escapeHtml(entry.mediaType || "unknown")}</b></div>
            <div><span>Source</span><b>${escapeHtml(platformBadge(entry.source))}</b></div>
            <div><span>Details</span><b>${escapeHtml(entry.details || "No details")}</b></div>
          </div>
          <div class="sync-target-row">${syncHistoryTargetPills(entry)}</div>
          ${debug ? `<pre class="sync-telemetry">${escapeHtml(debug)}</pre>` : ""}
        </details>
      `;
    })
    .join("");
}

async function loadSyncJobs({ force = false } = {}) {
  if (!state.token || (state.syncJobsLoading && !force)) return state.syncJobs;
  state.syncJobsLoading = true;
  renderSyncJobs();
  try {
    const url = new URL("/api/sync-jobs", window.location.origin);
    url.searchParams.set("status", "outstanding");
    url.searchParams.set("limit", "150");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync jobs load failed with ${response.status}`);
    state.syncJobs = Array.isArray(body.jobs) ? body.jobs : [];
    state.syncJobsLoaded = true;
    return state.syncJobs;
  } finally {
    state.syncJobsLoading = false;
    renderSyncJobs();
  }
}

async function loadSyncHistory({ force = false } = {}) {
  if (!state.token || (state.syncHistoryLoading && !force)) return state.syncHistory;
  state.syncHistoryLoading = true;
  renderSyncHistory();
  try {
    const url = new URL("/api/sync-history", window.location.origin);
    url.searchParams.set("limit", "100");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync history load failed with ${response.status}`);
    state.syncHistory = Array.isArray(body.history) ? body.history : [];
    state.syncHistoryLoaded = true;
    return state.syncHistory;
  } finally {
    state.syncHistoryLoading = false;
    renderSyncHistory();
  }
}

function activeSessionsKey(sessions = []) {
  if (!sessions.length) return "empty";
  return sessions
    .map((session) => {
      const progress = Math.round(Number(session.progress ?? computeProgress(session.offsetMs, session.durationMs) ?? 0));
      return [
        session.source || "",
        session.sessionId || session.id || "",
        session.mediaType || session.media_type || "",
        session.title || "",
        session.season ?? "",
        session.episode ?? "",
        progress,
      ].join("|");
    })
    .sort()
    .join("::");
}

function setActiveSessions(sessions = [], { force = false } = {}) {
  const nextKey = activeSessionsKey(sessions);
  if (!force && nextKey === state.nowPlayingSessionKey) return false;
  state.activeSessions = sessions;
  state.nowPlayingSessionKey = nextKey;
  renderActiveSessions();
  return true;
}

function adminTokenGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>Admin Sign-In</b>
      <p><b>What it is:</b> The local username and password for this self-hosted instance.</p>
      <ol>
        <li>Defaults to <code>admin</code> / <code>admin</code> on first run.</li>
        <li>Override by setting <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> environment variables (e.g. in <code>docker-compose.yml</code>).</li>
        <li>Use that username and password to sign in to this dashboard.</li>
        <li>External integrations (webhooks) authenticate with the API key shown after sign-in, stored in <code>data/config.json</code>.</li>
      </ol>
    </div>
  `;
}

function plexCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>PLEX_URL and PLEX_TOKEN Credential Extraction</b>
      <h3>Finding your PLEX_URL</h3>
      <ul>
        <li>If Plex is running on the same computer or local network, it usually defaults to <code>http://127.0.0.1:32400</code> or <code>http://localhost:32400</code>.</li>
        <li>If Plex is running on another machine, use that server's local IP address with port <code>32400</code>, such as <code>http://192.168.1.50:32400</code>.</li>
        <li>If you use a secure remote domain like <code>https://plex.example.com</code>, confirm it by opening Plex Web and checking the browser URL bar while connected to your server.</li>
        <li>You can also confirm the advertised LAN and remote addresses in Plex server network settings.</li>
      </ul>
      <h3>Finding your PLEX_TOKEN</h3>
      <ol>
        <li>Open a web browser, go to your Plex Web App, and sign in.</li>
        <li>Navigate to any library item, either a movie or a specific TV episode.</li>
        <li>Click the vertical ellipsis <code>...</code> button to open the context menu.</li>
        <li>Click <b>Get Info</b> from the menu.</li>
        <li>In the bottom-right corner of the pop-up modal, click the <b>View XML</b> text link.</li>
        <li>A new browser tab will open displaying raw XML code. Look at the address bar at the very top of your browser.</li>
        <li>Scroll to the absolute end of the URL string and locate <code>X-Plex-Token=</code>. Copy the exact alphanumeric string that follows it.</li>
        <li><b>Warning:</b> keep this private and do not commit it to public git history.</li>
      </ol>
    </div>
  `;
}

function embyCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>EMBY_URL, EMBY_API_KEY, and EMBY_USER_ID Credential Extraction</b>
      <h3>Finding your EMBY_URL</h3>
      <ul>
        <li>If Emby is running locally, it is usually <code>http://localhost:8096</code>.</li>
        <li>If Emby is on another local server, use that server IP address with port <code>8096</code>.</li>
        <li>If you use a reverse proxy or public domain, use the secure URL you normally open in the browser, such as <code>https://emby.example.com</code>.</li>
      </ul>
      <h3>Generating your EMBY_API_KEY</h3>
      <ol>
        <li>Open your Emby Server web dashboard as an administrator.</li>
        <li>Click the gear icon in the top right to access <b>Server Settings</b>.</li>
        <li>In the left-hand sidebar, scroll down to the <b>Advanced</b> section and click <b>API Keys</b>.</li>
        <li>Click the <b>New API Key</b> button.</li>
        <li>Enter an app name identifier, for example <code>Plembfin Tracker</code>, and click OK.</li>
        <li>Copy the newly generated long character string from the table.</li>
      </ol>
      <h3>Finding your EMBY_USER_ID</h3>
      <ol>
        <li>In the Emby Server Settings left sidebar, click <b>Users</b>.</li>
        <li>Click on your active user account profile.</li>
        <li>Look at your browser's address bar URL.</li>
        <li>Extract the string value following <code>?userId=</code>. This is your unique identifier string.</li>
      </ol>
    </div>
  `;
}

function jellyfinCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>JELLYFIN_URL, JELLYFIN_API_KEY, and JELLYFIN_USER_ID Credential Extraction</b>
      <h3>Finding your JELLYFIN_URL</h3>
      <ul>
        <li>If Jellyfin is running locally, it defaults to <code>http://localhost:8096</code> or <code>http://127.0.0.1:8096</code>.</li>
        <li>If Jellyfin is on another local server, use that server IP address with port <code>8096</code>.</li>
        <li>If you use a reverse proxy or public domain, use the secure URL you normally open in the browser, such as <code>https://jellyfin.example.com</code>.</li>
      </ul>
      <h3>Generating your JELLYFIN_API_KEY</h3>
      <ol>
        <li>Open your Jellyfin Dashboard using an administrator profile.</li>
        <li>Select the <b>Dashboard</b> menu option under the <b>Administration</b> section.</li>
        <li>Scroll down the left settings panel until you reach the <b>Advanced</b> header and select <b>API Keys</b>.</li>
        <li>Click the <code>+</code> icon button to generate a token. Name it <code>Plembfin Bridge</code>.</li>
        <li>Instantly copy the resulting string.</li>
      </ol>
      <h3>Finding your JELLYFIN_USER_ID</h3>
      <ol>
        <li>Go to your Jellyfin Dashboard settings page.</li>
        <li>Under the <b>Administration</b> header, click <b>Users</b>.</li>
        <li>Select your primary user profile card.</li>
        <li>Inspect the browser address bar. The long alphanumeric string right after <code>/users?userId=</code> is your true Jellyfin User ID.</li>
      </ol>
    </div>
  `;
}

function webhookWarning() {
  const url = `${window.location.origin}/api/webhook`;
  return `
    <div class="guide-callout warning-callout" style="gap: var(--space-3); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08);">
      <b style="font-size: 1.1rem; color: #fde68a;">Webhook Setup & Unwatched Sync Guide</b>
      <p>Configure your media servers to send played and unplayed/unwatched events to your Plembfin webhook URL:</p>
      
      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2);">
        <h3 style="margin: 0; color: #f1f5f9; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #eab308;"></span>
          1. Plex Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>Plex does not support sending unwatched (unscrobble) events via native webhooks or Tautulli.</li>
          <li>For resume sync, Plex webhook traffic must include playback lifecycle events such as <code>media.play</code>, <code>media.resume</code>, <code>media.pause</code>, <code>media.stop</code>, and <code>media.scrobble</code>. Plembfin reads <code>viewOffset</code> and <code>duration</code> when Plex provides them.</li>
          <li><b>Real-time Sync (Daemon):</b> To sync unwatched status instantly, run our lightweight local daemon script:
            <pre style="margin: 0.4rem 0; padding: 0.5rem; background: #090c0f; border: 1px solid var(--line); border-radius: 4px; overflow: auto; font-family: monospace; font-size: 0.72rem; line-height: 1.4; color: #dbe3ea;"><code>PLEX_URL="http://localhost:32400" PLEX_TOKEN="YOUR_TOKEN" PLEMBFIN_WEBHOOK_URL="${url}" PLEX_USERNAME="YOUR_USERNAME" node scripts/plexWebSocketMonitor.js</code></pre>
          </li>
          <li><b>Cron Sync (Fallback):</b> Plembfin's background cron worker polls Plex periodically to check recently watched items and sync them to other servers if they are marked unwatched on Plex.</li>
          <li>For general playback events, set up webhooks according to the <a href="https://support.plex.tv/articles/115002267687-webhooks/?utm_campaign=Plex%20Apps&utm_medium=Plex%20Web&utm_source=Plex%20Apps" target="_blank" rel="noopener noreferrer" style="color: #4b96e6; text-decoration: underline;">Plex Webhook Documentation</a>.</li>
        </ul>
      </div>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--line); padding-top: var(--space-2);">
        <h3 style="margin: 0; color: #f1f5f9; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #10b981;"></span>
          2. Emby Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>In Emby Server Settings ➔ <b>Webhooks</b>, add a new webhook pointing to your Plembfin webhook URL.</li>
          <li>Under <b>Events</b>, check the following boxes:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><b>Playback</b>: Check <code>Start</code>, <code>Pause</code>, <code>Unpause</code>, and <code>Stop</code></li>
              <li><b>Users</b>: Check <code>Mark Played</code> and <code>Mark Unplayed</code></li>
            </ul>
          </li>
          <li>Resume sync uses Emby's <code>Pause</code> and <code>Stop</code> events. Those payloads need to include <code>PlaybackPositionTicks</code> or <code>PositionTicks</code>.</li>
        </ul>
      </div>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--line); padding-top: var(--space-2);">
        <h3 style="margin: 0; color: #f1f5f9; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #4b96e6;"></span>
          3. Jellyfin Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>Install the <b>Webhooks</b> plugin in the Jellyfin Dashboard (under Plugins).</li>
          <li>Add a new Generic Webhook named <code>plembfin</code> pointing to your Plembfin webhook URL.</li>
          <li>Check <b>Enable</b>.</li>
          <li>Under <b>Notification Type</b>, check the following boxes:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><code>Playback Start</code></li>
              <li><code>Playback Progress</code></li>
              <li><code>Playback Stop</code></li>
              <li><code>User Data Saved</code> <i>(Crucial: sends events when items are marked watched or unwatched)</i></li>
            </ul>
          </li>
          <li>Under <b>Item Type</b>, select:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><code>Movies</code></li>
              <li><code>Episodes</code></li>
            </ul>
          </li>
          <li>Check <b>Send All Properties (ignores template)</b>.</li>
          <li>Resume sync depends on Jellyfin sending <code>PlaybackPositionTicks</code>, <code>PositionTicks</code>, or item <code>UserData</code> playback position fields.</li>
        </ul>
      </div>
    </div>
  `;
}

function cronSyncGuide() {
  const endpoint = `${window.location.origin}/api/cron-sync`;
  return `
    <section class="guide-callout" id="cron-sync-setup">
      <b>Firebase Scheduled Worker</b>
      <p>The Firebase version runs <code>scheduledSync</code> every minute through Cloud Functions for Firebase and Cloud Scheduler. The dashboard does not need to stay open, and no external uptime monitor is required.</p>
      <h3>Manual trigger</h3>
      <ol>
        <li>Sign in to the dashboard with Firebase Auth.</li>
        <li>Call <code>/api/cron-sync</code> from this dashboard or another authenticated client if you need an immediate run.</li>
        <li>The scheduled worker remains the primary background path and runs independently of the manual endpoint.</li>
      </ol>
      <h3>Authenticated request</h3>
      ${snippet(`${endpoint}

Authorization: Bearer FIREBASE_ID_TOKEN`, "http")}
      <h3>What this runs</h3>
      <p>The worker writes the cron heartbeat, polls Plex, Emby, and Jellyfin for active playback, updates Firestore live cache rows, detects completed sessions after 90% progress, writes completed watches to <code>watchHistory</code>, dispatches outbound watched-state sync, and checks recent Plex items for unwatched removals.</p>
    </section>
  `;
}

      function rebuildPlaystateGuide() {
        return `
          <p><b>scripts/rebuildPlaystateDatabase.js</b> is the one-time database reset tool for rebuilding Plembfin from a Trakt export and the latest live Plex state. It preserves saved server/admin settings, clears media history and sync state, imports Trakt and Plex history, writes canonical playstate rows, then converges Plex, Emby, and Jellyfin.</p>
          <p>Run the dry run first. It reads the Trakt export folder and configured media server APIs, but does not write because <code>--write</code> is omitted. Only run the write command after the convergence plan looks safe.</p>
          <section class="guide-callout">
            <b>What the write pass changes</b>
            <ol>
              <li>Clears <code>watchHistory</code>, <code>playstate</code>, <code>playbackProgress</code>, sync logs, active-session cache, live-tracking cache, and derived history caches.</li>
              <li>Preserves saved Plex, Emby, Jellyfin, TMDB, and admin configuration.</li>
              <li>Imports Trakt <code>watched-history-*.json</code> and current watched movie/show exports.</li>
              <li>Pulls Plex full play history, current Plex watched state, and target-library availability from the live Plex API.</li>
              <li>Skips items unavailable in a target library instead of issuing thousands of failed mark-watched requests.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Dry run</b>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/rebuildPlaystateDatabase.js --trakt-dir &quot;C:\\Users\\lasik\\Downloads\\trakt-export-lasikie&quot;" aria-label="Copy dry-run command">Copy</button>
              <pre><code>node scripts/rebuildPlaystateDatabase.js --trakt-dir "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie"</code></pre>
            </div>
          </section>
          <section class="guide-callout">
            <b>Write pass</b>
            <p>This clears and rebuilds Plembfin media data, then applies the convergence plan to all configured media servers.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/rebuildPlaystateDatabase.js --trakt-dir &quot;C:\\Users\\lasik\\Downloads\\trakt-export-lasikie&quot; --write" aria-label="Copy write command">Copy</button>
              <pre><code>node scripts/rebuildPlaystateDatabase.js --trakt-dir "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie" --write</code></pre>
            </div>
          </section>
        `;
      }

      function exportPlexHistoryGuide() {
        return `
          <p><b>scripts/exportPlexHistory.js</b> can be adapted for this Firebase repo if you later choose to seed old Plex history. Webhooks and live session polling only see future activity, while this Firebase version intentionally starts with an empty Firestore archive.</p>
          <p>Use it once when you want to bootstrap a fresh deployment, or again if you are migrating an existing Plex library and need the cloud history to reflect years of prior viewing. The script does not need the browser open after launch; it reads the local configuration block, streams rows to the import API in batches, and finishes with a deterministic summary.</p>
          <section class="guide-callout">
            <b>Token discovery walkthrough</b>
            <ol>
              <li>Open a desktop browser such as Chrome, Firefox, Edge, or Safari.</li>
              <li>Navigate to the Plex Web App and sign in with an administrative account.</li>
              <li>Open any movie or series row from your library.</li>
              <li>Open the item action menu and select <b>Get Info</b>.</li>
              <li>Click <b>View XML</b> in the lower-right corner of the dialog to open the raw metadata page.</li>
              <li>Do not inspect the XML content itself. Look at the browser address bar and scroll to the end of the URL.</li>
              <li>Find the query parameter named <code>X-Plex-Token=</code> and copy the long alphanumeric string immediately after it.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Execution workflow</b>
            <p>If you add this utility later, configure PLEX_URL, the harvested PLEX_TOKEN, and a Firebase ID token for the import API before running it.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/exportPlexHistory.js" aria-label="Copy bash snippet">Copy</button>
              <pre><code>node scripts/exportPlexHistory.js</code></pre>
            </div>
            ${terminalOutput(`🚀 Initiating Local Plex History Extraction Engine...
      ✔ Connection established to local server at http://127.0.0.1:32400
      ℹ Found 3 media library sections to process.

      [1/3] Processing Section: "Movies" (ID: 1)
      → Found 450 watched titles. Streaming to Firebase in chunks...
      └── Chunks: [██████████████████████████████] 100% | Sent 5/5 batches successfully.

      [2/3] Processing Section: "TV Shows" (ID: 2)
      → Traversing underlying episodes. Found 1,200 tracked played logs.
      └── Chunks: [██████████████████████████████] 100% | Sent 12/12 batches successfully.

      🎉 [SUCCESS] Historic data migration finalized!
      Total Rows Synced to Firestore Archive: 1,650 items.
      Ecosystem is fully synchronized and ready for live playback tracking.`)}
          </section>
        `;
      }

      function forcePushHistoryGuide() {
        return `
          <p><b>scripts/forcePushHistory.js</b> is the ecosystem equalizer if you later add it to this Firebase repo. It reads the master Firestore-backed history archive from your website, resolves each row against Plex, Emby, and Jellyfin, and replays the played state back out through their APIs so all three servers converge on the same watch record.</p>
          <p>It is meant for catch-up and repair, not for routine polling. Use it when you want to reconcile a clean server, recover from a migration, or make a newly joined platform match the canonical watch archive with no manual checkbox clicking.</p>
          <section class="guide-callout">
            <b>Platform setup walkthrough</b>
            <ol>
              <li>Open the Emby server settings page and sign in as an administrator.</li>
              <li>Navigate to <b>Advanced</b>, then <b>API Keys</b>, and generate an API key if needed.</li>
              <li>Open the target Emby user profile and copy the user ID from the browser URL parameter that follows <code>?userId=</code>.</li>
              <li>Repeat the same flow in Jellyfin: open the admin dashboard, create or confirm the API key, then copy the user identifier from the profile URL.</li>
              <li>Paste the harvested server URLs, API keys, and user IDs into the header block at the top of <code>scripts/forcePushHistory.js</code>.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Execution workflow</b>
            <p>Open scripts/forcePushHistory.js in your editor, configure your server credentials in the file header, then run the command below from the project root to synchronize your media ecosystem.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/forcePushHistory.js" aria-label="Copy bash snippet">Copy</button>
              <pre><code>node scripts/forcePushHistory.js</code></pre>
            </div>
            ${terminalOutput(`🔄 Initiating Central Database Outward Force-Push Matrix...
      ✔ Fetched 1,650 master tracking history logs from website API.
      ℹ Mapping provider GUID parameters across target endpoints...

      [PROCESSING] Index: 001/1650 | 'Dimension 20 - S01E01' ➔ Synchronizing...
      ├── Plex Server Client API: [SKIPPED] (Already marked watched)
      ├── Emby Server Client API: [SUCCESS] Item resolved (ID: 8849) ➔ Sent PlayState HTTP 200 OK
      └── Jellyfin Server Client API: [SUCCESS] Cache-busted (ID: 9412) ➔ Sent PlayState HTTP 200 OK

      ⏳ Applying 150ms structural rate-limit protection delay...
      [PROCESSING] Index: 002/1650 | 'The Curse of Oak Island' ➔ Synchronizing...
      └── Continuing batch redistribution across all configured servers.

      🎉 [SUCCESS] Outward catch-up synchronization task completed across all servers!`)}
          </section>
        `;
      }

      const HELP_TOPICS = [
        // ── Overview ──────────────────────────────────────────────────────
        {
          id: "getting-started",
          category: "Overview",
          title: "Getting Started",
          description: "Initial setup from Firebase auth to first webhook",
          badges: ["FIREBASE_AUTH", "PLEX_URL", "EMBY_API_KEY", "JELLYFIN_API_KEY"],
          body: () => `
            <p>Plembfin is a self-hosted watch-state bridge. It listens for playback events from Plex, Emby, and Jellyfin via webhooks, records them in a local SQLite database, and propagates the watched or unwatched state to every other connected platform automatically. A background worker runs every minute so sync continues even when the dashboard is closed.</p>
            <p>Follow these steps to get from zero to a fully synchronised setup:</p>
            <ol>
              <li><b>Sign in</b> — Log in with your admin username and password (defaults to <code>admin</code> / <code>admin</code>; override with <code>ADMIN_USERNAME</code> / <code>ADMIN_PASSWORD</code>). See the <a href="#" data-help-topic-link="firebase-auth">Admin Sign-In</a> guide for details.</li>
              <li><b>Add credentials</b> — Open <b>Settings → Apps</b> and fill in the server URL, token or API key, and user ID for each platform you use. Click <b>Save Configuration</b>.</li>
              <li><b>Configure webhooks</b> — Point each media server at your Plembfin webhook URL, including your API key. See the <a href="#" data-help-topic-link="webhooks">Webhook Setup</a> guide for per-server instructions.</li>
              <li><b>Verify</b> — Open <b>Settings → Tools → System Integrity Check</b> and run the diagnostic. All probes should return green before you rely on live sync.</li>
              <li><b>Import history (optional)</b> — Use the Trakt History Importer in <b>Settings → Tools</b> to seed your local archive from a Trakt export, then run Full Sync Watchstates to push everything to your media servers.</li>
            </ol>
            <h3>How the system works</h3>
            <p>When a webhook event arrives at <code>/api/webhook</code>, Plembfin normalises the payload from whichever server sent it into a unified media object. The <code>phase</code> field drives the response: active playback upserts a live session; a completed watch inserts a <code>watch_history</code> record and triggers immediate propagation to the other platforms; an unplayed event deletes the record and marks it unwatched everywhere. A loop-detection store prevents echo loops when the propagation itself fires a webhook back.</p>
            <p>The scheduled worker runs every minute in-process. It polls active sessions, detects completed watches that crossed the 90% threshold, dispatches any outstanding sync jobs, and checks recent Plex items for unwatched removals — even when the dashboard is closed.</p>
          `,
        },

        // ── Credentials ───────────────────────────────────────────────────
        {
          id: "firebase-auth",
          category: "Credentials",
          title: "Admin Sign-In",
          description: "Local username/password and API key",
          badges: ["FIREBASE_AUTH"],
          body: () => `
            <p>Plembfin uses a local username and password to gate access to the dashboard, and an API key to gate webhooks and external integrations. Every <code>/api/*</code> request is verified server-side — unauthenticated requests are rejected before they touch the database.</p>
            ${adminTokenGuide()}
          `,
        },
        {
          id: "plex",
          category: "Credentials",
          title: "Plex",
          description: "Server URL and token extraction",
          badges: ["PLEX_URL", "PLEX_TOKEN"],
          body: () => `
            <p>Plembfin connects to your Plex server directly using its local or remote URL and a user token. The token identifies the account whose watch state is read and updated. Enter both in <b>Settings → Apps → Plex Setup</b> and click Save Configuration.</p>
            ${plexCredentialGuide()}
          `,
        },
        {
          id: "emby",
          category: "Credentials",
          title: "Emby",
          description: "API key, server URL, and user ID",
          badges: ["EMBY_API_KEY", "EMBY_USER_ID"],
          body: () => `
            <p>Plembfin uses the Emby HTTP API to read and write watch states. You need a server-level API key (not a user password) and the internal user ID of the account whose playstate should be synchronised. Enter these in <b>Settings → Apps → Emby Setup</b> and click Save Configuration.</p>
            ${embyCredentialGuide()}
          `,
        },
        {
          id: "jellyfin",
          category: "Credentials",
          title: "Jellyfin",
          description: "API key, server URL, and user ID",
          badges: ["JELLYFIN_API_KEY", "JELLYFIN_USER_ID"],
          body: () => `
            <p>Plembfin uses the Jellyfin HTTP API to read and write watch states. You need a server-level API key generated in the Jellyfin admin dashboard and the internal user ID of the account whose playstate should be synchronised. Enter these in <b>Settings → Apps → Jellyfin Setup</b> and click Save Configuration.</p>
            ${jellyfinCredentialGuide()}
          `,
        },

        // ── Webhooks ──────────────────────────────────────────────────────
        {
          id: "webhooks",
          category: "Webhooks",
          title: "Webhook Setup",
          description: "Configuring Plex, Emby, and Jellyfin to send events",
          badges: ["FIREBASE_AUTH"],
          body: () => {
            const url = `${window.location.origin}/api/webhook`;
            return `
              <p>Webhooks are how your media servers notify Plembfin the moment something is watched, paused, stopped, or marked as unplayed. Each server needs to be told where to send events — that is your unique webhook URL below. Plembfin accepts events from all three platforms on the same endpoint and normalises them into a single internal format.</p>
              <p>Your webhook URL:</p>
              ${snippet(url, "url")}
              ${webhookWarning()}
            `;
          },
        },

        // ── Sync ──────────────────────────────────────────────────────────
        {
          id: "sync-worker",
          category: "Sync",
          title: "Background Sync Worker",
          description: "Cron schedule, resume sync, and loop detection",
          badges: ["FIREBASE_AUTH"],
          body: () => {
            const url = `${window.location.origin}/api/webhook`;
            return `
              <p>Plembfin keeps your watch states converged through two complementary mechanisms: immediate webhook propagation for real-time events, and a scheduled background worker for polling, catch-up, and recovery.</p>
              <h3>What the worker does each minute</h3>
              <ul>
                <li>Writes a heartbeat timestamp to <code>runtimeState</code> so you can confirm it is running.</li>
                <li>Polls Plex, Emby, and Jellyfin for active playback sessions and upserts live cache rows.</li>
                <li>Checks whether any active sessions have crossed the 90% watched threshold and commits completed watches to <code>watchHistory</code>.</li>
                <li>Dispatches outstanding sync jobs — records that were written but not yet propagated to all platforms.</li>
                <li>Checks recent Plex items for unwatched removals and propagates the unplayed state to Emby and Jellyfin.</li>
              </ul>
              <h3>Resume progress sync</h3>
              <p>When a stop or pause event arrives with a playback position below 90% of the item's duration, Plembfin stores the resume offset (in ticks) and pushes it to the other two platforms. Positions under one minute are ignored to avoid noise from accidental plays. The next time you open the item on a different platform it will offer to resume from where you left off.</p>
              <h3>Loop detection</h3>
              <p>When Plembfin propagates a watch event to Emby or Jellyfin, that server fires its own webhook back to Plembfin. The <code>loopStore</code> in-memory map tracks recently-processed events keyed by platform and media identifier. Any incoming webhook that matches a recently-dispatched event is detected as an echo and dropped before it can trigger another propagation round.</p>
              ${cronSyncGuide()}
            `;
          },
        },
        {
          id: "sync-dashboard",
          category: "Sync",
          title: "Sync Dashboard",
          description: "Reading the job queue and sync history panels",
          badges: [],
          body: () => `
            <p>The <b>Settings → Sync</b> tab shows the current state of the sync queue and a log of recent propagation attempts. Use it to diagnose failures, check whether outstanding jobs are backed up, or confirm that a specific watched item was sent successfully.</p>
            <h3>Job queue</h3>
            <p>Each row in the sync jobs panel represents a <code>watchHistory</code> record that has at least one platform it still needs to reach. The row shows the media title, the target platform, the last attempt timestamp, and the current status. Rows clear automatically once all targets confirm success.</p>
            <p>Use <b>Force Sync</b> to immediately run the full sync pass on demand and stream the output to the terminal below the controls. Use <b>Run Cron Sync</b> to trigger the scheduled worker manually — useful for testing that the worker endpoint is reachable and that credentials are valid.</p>
            <h3>Sync history</h3>
            <p>The history panel shows the most recent sync dispatch results in reverse chronological order. Each row records the media title, the target platform, the HTTP status the platform returned, and whether the dispatch succeeded or failed. Persistent failures on a specific platform usually indicate a credential or connectivity problem — open <b>Settings → Tools → System Integrity Check</b> to probe that server directly.</p>
          `,
        },

        // ── Scripts ───────────────────────────────────────────────────────
        {
          id: "rebuild-playstate",
          category: "Scripts",
          title: "Rebuild Playstate Database",
          description: "Full reset and reimport from a Trakt export + live Plex state",
          badges: ["FIREBASE_AUTH", "PLEX_TOKEN", "EMBY_API_KEY", "JELLYFIN_API_KEY"],
          body: () => rebuildPlaystateGuide(),
        },
        {
          id: "force-push-history",
          category: "Scripts",
          title: "Force Push History",
          description: "Replay the Firestore archive to Emby and Jellyfin",
          badges: ["EMBY_API_KEY", "EMBY_USER_ID", "JELLYFIN_API_KEY", "JELLYFIN_USER_ID"],
          body: () => forcePushHistoryGuide(),
        },
      ];

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

function handleRouting(path) {
  const parts = path.split('#');
  const pathPart = parts[0];
  const hashPart = parts[1] || "";

  const pathname = pathPart.endsWith("/") && pathPart.length > 1 ? pathPart.slice(0, -1) : pathPart;
  const previousExplorerListRoute = state.activeView === "explorer" && !state.mediaDetailInline
    ? (state.explorerMode === "shows" ? "/tvshows" : "/movies")
    : "";
  const isExplorerListRoute = pathname === "/movies" || pathname === "/tvshows";
  if (!isExplorerListRoute || (previousExplorerListRoute && previousExplorerListRoute !== pathname)) clearSearchInputs();
  
  if (!pathname.startsWith("/person")) {
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
    const movieId = decodeURIComponent(movieMatch[1]);
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = state.explorerMode || "movies";
    }
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.activeMovieModalId = movieId;
    openMovieInlineDetail(movieId).catch((error) => setMessage(error.message, "error"));
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
    openShowInlineDetail(showKey, seasonNum, episodeNum).catch((error) => setMessage(error.message, "error"));
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
    if (parts[2]) {
      state.activeHelpTopic = parts[2];
    } else {
      state.activeHelpTopic = "getting-started";
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
  if (elements.explorerSearchInput) elements.explorerSearchInput.value = "";
  if (elements.globalSearchInput) elements.globalSearchInput.value = "";
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
      url = `/movie/${state.activeMovieModalId}`;
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
  } else if (targetView !== "dashboard") {
    url = `/${targetView}`;
  }
  
  const currentUrl = window.location.pathname + window.location.hash;
  if (currentUrl !== url) {
    navigateTo(url);
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
  if (state.activeView === "explorer") renderExplorer();
  if (state.activeView !== "explorer") {
    state.explorerLoadObserver?.disconnect();
    state.explorerLoadObserver = undefined;
    updateAlphaFilter();
  }

  if (state.activeView !== "dashboard") {
    state.dashboardPosterObserver?.disconnect();
    state.dashboardPosterObserver = undefined;
  }

  if (state.activeView === "settings") {
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
    if (state.activeSettingsTab === "logs") renderLogs().catch(() => {});
    if (state.configLoaded) {
      renderSettingsStatus("Configuration ready.", "success");
    }
  }
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

  const jellyfinActive = elements.jellyfinEnabled.checked;
  elements.jellyfinServerUrl.disabled = !jellyfinActive;
  elements.jellyfinApiKey.disabled = !jellyfinActive;
  elements.jellyfinUserId.disabled = !jellyfinActive;
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

  elements.tmdbApiKey.value = "";
  elements.tmdbApiKey.placeholder = config.tmdb?.configured ? "Configured - enter a new key to replace it" : "TMDB API key";
  if (elements.youtubeApiKey) elements.youtubeApiKey.value = config.youtube?.apiKey || "";
  
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
    state.firebaseUser = result.user;
    state.token = result.token;
    elements.adminEmail.value = username;
    elements.currentAdminPassword.value = "";
    elements.newAdminPassword.value = "";
    elements.confirmAdminPassword.value = "";
    localStorage.setItem("firebaseAdminEmail", username);
    renderAdminCredentialsStatus("Login updated. Other dashboard sessions have been signed out.", "success");
    setMessage(`Login updated for ${username}.`, "success");
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
  renderSettingsStatus("Configuration loaded from Firestore.", "success");
  renderDashboard();
  renderActiveSessions();
  renderSyncHistory();
  refreshHelpIfVisible();
  return body.config || {};
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

    state.savedConfig = {
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
    }

    const response = await fetch("/api/config", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Save failed with ${response.status}`);

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

async function loadStats({ force = false } = {}) {
  if (!state.token || state.statsLoading || (state.statsLoaded && !force)) return state.stats;
  state.statsLoading = true;

  try {
    const url = new URL("/api/history", window.location.origin);
    url.searchParams.set("stats", "only");
    const response = await fetch(url, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Stats load failed with ${response.status}`);

    state.stats = body.stats || state.stats;
    state.statsLoaded = true;
    renderStats();
    return state.stats;
  } finally {
    state.statsLoading = false;
  }
}

async function loadActiveSessions() {
  if (!state.token || state.nowPlayingRequestActive) return state.activeSessions;

  state.nowPlayingRequestActive = true;
  const url = nowPlayingUrl();
  logDebug("Initiating request loop to /api/now-playing unified backend route...", { url: `${url.pathname}?token=present` });

  let response;
  let bodyText = "";
  try {
    response = await fetch(url, {
      headers: authHeaders(),
      cache: "no-store",
    });
    bodyText = await response.clone().text().catch(() => "");
  } catch (error) {
    const message = `Now-playing fetch failed. Reason: FETCH_FAILED (${error?.message || "network request failed"})`;
    logDebug(message);
    throw new Error(message);
  } finally {
    state.nowPlayingLastFetchAt = Date.now();
    state.nowPlayingRequestActive = false;
  }

  logDebug(`Now-playing API returned HTTP ${response.status} ${response.statusText || ""}`.trim(), {
    bodyPreview: bodyText.slice(0, 1200),
  });

  let body = [];
  try {
    body = bodyText ? JSON.parse(bodyText) : [];
  } catch (error) {
    const message = `Now-playing payload parsing exception: ${error?.message || "invalid JSON response"}`;
    logDebug(message, { bodyPreview: bodyText.slice(0, 1200) });
    setActiveSessions([]);
    return [];
  }
  if (!response.ok) {
    const message = `Now playing failed with HTTP ${response.status}`;
    logDebug(message, body);
    setActiveSessions([]);
    return [];
  }

  const refreshToken = response.headers.get("X-Now-Playing-Refresh") || "";
  let sessions = Array.isArray(body) ? body : Array.isArray(body.sessions) ? body.sessions : [];
  logDebug(`Now-playing payload parsed successfully. Active sessions: ${sessions.length}`, sessions);

  // Always poll local network in parallel — Firebase only captures sessions that sent webhooks
  // (Plex webhooks work; Emby/Jellyfin playback events may not be configured).
  // Merge local sessions so all three platforms show up regardless.
  logDebug("Starting parallel direct browser local network probes to supplement Firebase sessions.");
  const localSessions = await fetchLocalActiveSessions(configFromInputs(), logDebug);
  if (localSessions.length) {
    logDebug(`Local probes returned ${localSessions.length} session(s). Merging with Firebase sessions.`, localSessions);
    for (const local of localSessions) {
      const isDuplicate = sessions.some(
        (s) =>
          s.source === local.source &&
          s.title === local.title &&
          s.season === local.season &&
          s.episode === local.episode
      );
      if (!isDuplicate) sessions.push(local);
    }
  } else {
    logDebug("Local probes returned zero active sessions.");
  }

  const refreshChanged = Boolean(refreshToken && refreshToken !== state.nowPlayingRefreshToken);

  state.nowPlayingRefreshToken = refreshToken || state.nowPlayingRefreshToken;
  setActiveSessions(sessions);

  if (refreshChanged) {
    loadHistory().catch((error) => setMessage(error.message, "error"));
  }

  return sessions;
}

function pollNowPlayingOnce() {
  if (!state.token || state.activeView !== "dashboard" || document.hidden) {
    stopHistoryPolling();
    return;
  }
  loadActiveSessions().catch((error) => {
    logDebug(`Now Playing poll failed: ${error?.message || "unknown error"}`);
  });
}

function startHistoryPolling() {
  stopHistoryPolling();
  if (!state.token || state.activeView !== "dashboard" || document.hidden) return;

  logDebug(`Starting Now Playing polling (every ${NOW_PLAYING_POLL_MS / 1000}s).`);
  // SSE streaming via /api/now-playing?stream=1 does not survive the Firebase
  // Hosting proxy in production (responses are buffered), so the dashboard polls
  // the non-streaming endpoint on an interval instead. Visibility-gated so it
  // pauses when the tab is hidden or the user leaves the dashboard.
  pollNowPlayingOnce();
  state.nowPlayingInterval = setInterval(pollNowPlayingOnce, NOW_PLAYING_POLL_MS);
}

function stopHistoryPolling() {
  if (state.nowPlayingInterval) {
    clearInterval(state.nowPlayingInterval);
    state.nowPlayingInterval = undefined;
  }
  logDebug("Stopped Now Playing polling.");
}

function syncNowPlayingPolling() {
  if (state.activeView === "dashboard") {
    startHistoryPolling();
    return;
  }

  stopHistoryPolling();
}

function getRowFitLimit(rowElement) {
  // Dashboard history rows scroll horizontally, so render a generous
  // number of cards regardless of viewport width rather than only as
  // many as fit on screen.
  if (rowElement && (rowElement.id === "tvHistoryRow" || rowElement.id === "movieHistoryRow")) {
    return 24;
  }
  const width = rowElement ? rowElement.clientWidth : 0;
  if (width <= 0) return 10;
  const maxCards = Math.floor((width + 12) / 172);
  return Math.max(2, maxCards);
}

function stablePosterIdentity(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered.includes("favicon") || lowered.includes("placeholder") || lowered.includes("no-poster")) return "";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.hostname.toLowerCase().includes("image.tmdb.org")) {
      return `tmdb-poster:${url.pathname.split("/").filter(Boolean).pop() || raw}`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function mediaRecordIdentity(record = {}, mode = "") {
  if (mode === "shows" || record.media_type === "episode") {
    const title = record.show_title || record.title || "";
    return `show:${slug(title)}`;
  }
  const poster = stablePosterIdentity(record.poster_url || record.posterUrl || record.imageUrl || record.thumb || "");
  if (poster) return `movie:poster:${poster}`;
  if (record.imdb_id) return `movie:imdb:${String(record.imdb_id).toLowerCase()}`;
  if (record.tmdb_id) return `movie:tmdb:${String(record.tmdb_id).toLowerCase()}`;
  if (record.tvdb_id) return `movie:tvdb:${String(record.tvdb_id).toLowerCase()}`;
  return `movie:title:${slug(record.title)}`;
}

function dedupeMediaRecords(records = [], mode = "") {
  const map = new Map();
  for (const record of records) {
    const key = mediaRecordIdentity(record, mode);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, record);
      continue;
    }
    const existingDate = existing.latest_watched_at || existing.watched_at || "";
    const recordDate = record.latest_watched_at || record.watched_at || "";
    if (recordDate > existingDate) map.set(key, record);
  }
  return [...map.values()];
}

function prefetchDashboardHistoryTmdb(tvEntries, movieEntries) {
  if (!state.token) return;
  const seen = new Set();
  for (const entry of movieEntries) {
    const key = `movie|${entry.tmdb_id || ""}|${String(entry.title || "").toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      fetchTmdbDetails("movie", entry.tmdb_id, entry.title);
    }
  }
  for (const entry of tvEntries) {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    const showKeySlug = slug(showTitle);
    const show = state.showsRaw.find((s) => slug(s.title) === showKeySlug);
    const tmdbId = show?.tmdb_id || entry.tmdb_id;
    const key = `tv|${tmdbId || ""}|${String(showTitle || "").toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      fetchTmdbDetails("tv", tmdbId, showTitle);
    }
  }
}

function renderDashboard() {
  if (!state.history.length) {
    if (elements.tvHistoryRow) {
      elements.tvHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>No watch history yet</b>
          <span>Import a Trakt export or send watched webhooks to start building the archive.</span>
        </div>
      `;
    }
    if (elements.movieHistoryRow) {
      elements.movieHistoryRow.innerHTML = "";
    }
    return;
  }

  // Filter TV shows (episodes) and Movies
  const tvHistory = state.history.filter((entry) => entry.media_type === "episode");
  const movieHistory = dedupeMediaRecords(state.history.filter((entry) => entry.media_type === "movie"), "movies");

  let visibleTv = [];
  let visibleMovies = [];

  // Render TV Shows Row
  if (elements.tvHistoryRow) {
    if (!tvHistory.length) {
      elements.tvHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>No TV history in this preview</b>
          <span>New watched episodes will appear here.</span>
        </div>
      `;
    } else {
      const tvFitLimit = getRowFitLimit(elements.tvHistoryRow);
      visibleTv = tvHistory.slice(0, tvFitLimit);

      let html = visibleTv.map(renderHistoryCard).join("");
      elements.tvHistoryRow.innerHTML = html;
      hydratePosters(elements.tvHistoryRow);
    }
  }

  // Render Movies Row
  if (elements.movieHistoryRow) {
    if (!movieHistory.length) {
      elements.movieHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>No movie history in this preview</b>
          <span>New watched movies will appear here.</span>
        </div>
      `;
    } else {
      const movieFitLimit = getRowFitLimit(elements.movieHistoryRow);
      visibleMovies = movieHistory.slice(0, movieFitLimit);

      let html = visibleMovies.map(renderHistoryCard).join("");
      elements.movieHistoryRow.innerHTML = html;
      hydratePosters(elements.movieHistoryRow);
    }
  }

  if (visibleTv.length || visibleMovies.length) {
    prefetchDashboardHistoryTmdb(visibleTv, visibleMovies);
  }

  observeDashboardPosters();
}

function renderHistoryCard(entry) {
  const isEpisode = entry.media_type === "episode";

  if (isEpisode) {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    let epTitle = entry.episode_title;
    let needsResolve = false;
    if (!epTitle || /^Episode \d+$/i.test(String(epTitle).trim())) {
      const text = String(entry.title || "").trim();
      const suffixMatch = text.match(/S\d{1,2}E\d{1,2}\s+-\s+(.+)$/i);
      if (suffixMatch?.[1]) {
        epTitle = suffixMatch[1].trim();
      } else {
        if (!epTitle) {
          epTitle = `Episode ${entry.episode}`;
        }
        needsResolve = true;
      }
    }

    if (needsResolve) {
      setTimeout(() => {
        const el = document.querySelector(`[data-history-id="${entry.id}"] .history-card-episode-title`);
        resolveEpisodeTitleFromTmdb(entry, el);
      }, 50);
    }

    const canonicalShowName = showName(entry.title);
    const showKeySlug = slug(canonicalShowName);
    const href = entry.tmdb_id ? `/tvshow/tmdb/${entry.tmdb_id}` : `/tvshow/${showKeySlug}`;

    return `
      <a class="movie-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}">
        ${posterMarkup(entry, "movie-poster")}
        <div class="movie-card-body">
          <div class="movie-card-title-row" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.15rem; min-width: 0; width: 100%; flex-direction: column;">
            <b style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; font-size: 0.95rem;" title="${escapeAttribute(showTitle)}">${escapeHtml(showTitle)}</b>
            <span class="history-card-episode-title" style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; color: var(--text); font-size: 0.85rem;" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>
            <span class="history-card-coord" style="color: var(--muted); font-size: 0.75rem;">S${entry.season}·E${entry.episode}</span>
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 0.15rem;">
              <span class="history-card-watched-date" style="color: var(--muted); font-size: 0.75rem;">${formatDate(entry.watched_at)}</span>
              ${renderSyncStatusDot(entry, "")}
            </div>
          </div>
        </div>
      </a>
    `;
  } else {
    // Movie
    const href = entry.tmdb_id ? `/movie/tmdb/${entry.tmdb_id}` : `/movie/${entry.id}`;
    return `
      <a class="movie-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}">
        ${posterMarkup(entry, "movie-poster")}
        <div class="movie-card-body">
          <div class="movie-card-title-row" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.15rem; min-width: 0; width: 100%; flex-direction: column;">
            <b style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; font-size: 0.95rem;" title="${escapeAttribute(entry.title)}">${escapeHtml(entry.title)}</b>
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 0.15rem;">
              <span class="history-card-watched-date" style="color: var(--muted); font-size: 0.75rem;">${formatDate(entry.watched_at)}</span>
              ${renderSyncStatusDot(entry, "")}
            </div>
          </div>
        </div>
      </a>
    `;
  }
}

function renderActiveSessions() {
  if (!elements.nowPlayingGrid) return;

  if (!state.activeSessions.length) {
    elements.nowPlayingGrid.innerHTML = `
      <div class="idle-state">
        <b>No media currently playing.</b>
      </div>
    `;
    if (elements.nowPlayingStatus) elements.nowPlayingStatus.textContent = "";
    return;
  }

  elements.nowPlayingGrid.innerHTML = state.activeSessions
    .map((session) => {
      const progress = Math.max(0, Math.min(100, Number(session.progress ?? computeProgress(session.offsetMs, session.durationMs))));
      const href = nowPlayingHref(session);
      return `
        <button class="now-card-large live-now-card" type="button" data-now-playing-href="${escapeAttribute(href)}" aria-label="Open ${escapeAttribute(session.title)} details">
          ${posterMarkup(session, "now-poster-large")}
          <div class="now-meta">
            <div class="now-card-head">
              <span class="source-badge ${sourceClass(session.source)}">${escapeHtml(platformBadge(session.source))}</span>
              <span class="stream-indicator">Live</span>
            </div>
            <b>${escapeHtml(session.title)}</b>
            <small>${escapeHtml(formatNowPlayingMeta(session))}</small>
            <div class="progress-track" aria-label="Playback progress"><span style="width: ${progress}%"></span></div>
            <time>${escapeHtml(formatPlaybackClock(session.offsetMs, session.durationMs))}</time>
          </div>
        </button>
      `;
    })
    .join("");

  if (elements.nowPlayingStatus) {
    elements.nowPlayingStatus.textContent = "";
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function futureListDate(isoString) {
  if (!isoString) return "";
  const today = new Date().toISOString().slice(0, 10);
  if (isoString < today) return "";
  return formatListDate(isoString);
}

function formatListDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(d);
}

// Friendlier labels for TMDB's `status` field, used as a fallback in the
// "Next Airing" column when a show has no upcoming scheduled episode.
function showStatusLabel(status) {
  switch (status) {
    case "Returning Series": return "Returning";
    case "In Production": return "In production";
    case "Post Production": return "Post-production";
    case "Planned": return "Planned";
    case "Canceled": return "Canceled";
    case "Ended": return "Ended";
    case "Pilot": return "Pilot";
    default: return status || "";
  }
}

// Cell content for the "Next Airing" column: a future air date when TMDB has
// one scheduled, otherwise the show's status (Returning / Ended / etc.).
// Returns { text, isStatus } so the caller can style status differently.
function nextAiringCell(tmdb) {
  if (!tmdb) return { text: "", isStatus: false };
  // Prefer the backend-derived next_airing_date (computed from the season episode
  // list); fall back to TMDB's own next_episode_to_air when it isn't present.
  const raw = tmdb.next_airing_date || tmdb.next_episode_to_air?.air_date || "";
  const date = raw ? futureListDate(raw) : "";
  if (date) return { text: date, isStatus: false };
  return { text: showStatusLabel(tmdb.status), isStatus: true };
}

function formatDateShort(date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" }).format(date);
}

function renderStats() {
  if (elements.totalWatches) elements.totalWatches.textContent = formatNumber(state.stats.totalWatches || 0);
  if (elements.totalMovies) elements.totalMovies.textContent = formatNumber(state.stats.uniqueMoviesLogged || 0);
  if (elements.totalEpisodes) elements.totalEpisodes.textContent = formatNumber(state.stats.totalTvEpisodesTracked || 0);

  if (elements.topPlatform) {
    const platform = state.stats.topSource;
    elements.topPlatform.textContent = platform && platform !== "none" ? platformName(platform) : "None";
  }

  if (elements.dbSize) {
    elements.dbSize.textContent = formatBytes(state.stats.dbSizeBytes || 0);
  }

  if (elements.trackingSpan) {
    if (state.stats.firstWatch && state.stats.lastWatch) {
      const first = new Date(state.stats.firstWatch);
      const last = new Date(state.stats.lastWatch);
      const diffTime = Math.abs(last - first);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      elements.trackingSpan.textContent = `${diffDays} days`;
      elements.trackingSpan.title = `${formatDateShort(first)} to ${formatDateShort(last)}`;
    } else {
      elements.trackingSpan.textContent = "N/A";
    }
  }

  renderRankingTable(elements.sourceRanking, state.stats.sourceBreakdown || [], "platform");
  renderRankingTable(elements.topShows, state.stats.topShows || [], "series");
  if (elements.monthChart) renderMonthChart();
}

function renderRankingTable(container, rows = [], labelKey) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="empty-log"><b>No data yet</b><span>Import history or wait for completed webhooks.</span></div>`;
    return;
  }

  const max = Math.max(...rows.map((row) => Number(row.count || 0)), 1);
  container.innerHTML = `
    <div class="ranking-table">
      <div class="ranking-head">
        <span>#</span>
        <span>${labelKey === "platform" ? "Platform" : "Series"}</span>
        <span>Relative volume</span>
        <span>Watch count</span>
      </div>
      ${rows
        .map(
          (row, index) => `
            <article class="ranking-row">
              <span>${index + 1}</span>
              <b>${escapeHtml(labelKey === "platform" ? platformName(row.source) : row.title)}</b>
              <div class="mini-bar"><span style="width: ${(Number(row.count || 0) / max) * 100}%"></span></div>
              <em>${formatNumber(row.count)}</em>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderMonthChart() {
  const rows = state.stats.monthlyActivity || [];
  if (!rows.length) {
    elements.monthChart.innerHTML = `<div class="empty-log"><b>No monthly activity yet</b><span>Completed watches will appear here.</span></div>`;
    return;
  }

  const max = Math.max(...rows.map((row) => Number(row.count || 0)), 1);
  elements.monthChart.innerHTML = rows
    .map(
      (row) => `
        <article class="month-column">
          <span style="height: ${Math.max(8, (Number(row.count || 0) / max) * 100)}%"></span>
          <b>${formatNumber(row.count)}</b>
          <small>${escapeHtml(row.month)}</small>
        </article>
      `,
    )
    .join("");
}

function syncExplorerControlsState() {
  const backBtn = document.querySelector("#explorerBackButton");
  const controls = document.querySelector(".explorer-controls");
  const heading = document.querySelector(".explorer-heading-sticky");
  if (state.mediaDetailInline) {
    backBtn?.classList.remove("hidden");
    controls?.classList.add("hidden");
    heading?.classList.add("is-media-detail");
    syncInlineMediaDetailHeading(state.explorerMode);
  } else {
    backBtn?.classList.add("hidden");
    controls?.classList.remove("hidden");
    heading?.classList.remove("is-media-detail");
  }
}

function syncInlineMediaDetailHeading(mode = state.explorerMode || "movies") {
  if (!state.mediaDetailInline) return;
  const normalized = mode === "shows" ? "shows" : "movies";
  if (elements.explorerTitle) {
    elements.explorerTitle.textContent = normalized === "shows" ? "TV Shows" : "Movies";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = "";
  }
}

function renderExplorer() {
  syncExplorerControlsState();
  if (state.mediaDetailInline) return;
  for (const button of elements.explorerButtons) {
    button.classList.toggle("active", button.dataset.explorerMode === state.explorerMode);
  }
  const activeView = currentExplorerView();
  for (const button of elements.explorerViewButtons || []) {
    button.classList.toggle("active", button.dataset.explorerView === activeView);
  }
  if (elements.explorerPosterSizeLabel) {
    elements.explorerPosterSizeLabel.style.display = activeView === "overview" ? "none" : "";
  }
  applyExplorerPosterWidth();
  if (elements.explorerSort) {
    const sort = currentExplorerSort();
    elements.explorerSort.value = sort;
    // Only show "Next Airing" option for shows
    for (const opt of elements.explorerSort.options) {
      if (opt.value === "next_air_asc") opt.hidden = state.explorerMode !== "shows";
    }
  }
  if (elements.explorerTitle) {
    const mode = state.mediaDetailInline && state.activeShowModalKey ? "shows" : state.explorerMode;
    elements.explorerTitle.textContent = mode === "shows" ? "TV Shows" : "Movies";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = state.mediaDetailInline ? "" : (state.savedConfig?.plex?.username || "Watched history library");
  }

  const search = elements.explorerSearchInput ? elements.explorerSearchInput.value.trim() : state.explorerSearch;
  state.explorerSearch = search;
  if (elements.globalSearchInput && elements.globalSearchInput.value !== state.explorerSearch) {
    elements.globalSearchInput.value = state.explorerSearch;
  }

  if (state.mediaDetailInline) {
    return;
  }

  if (state.explorerMode === "movies") {
    renderMovieExplorer();
    return;
  }

  renderShowExplorer();
}

function explorerQueryKey(mode) {
  return [mode, currentExplorerSort(), state.explorerSearch].join("|");
}

function firstAlphaLetter(title) {
  if (!title) return "#";
  const stripped = String(title).replace(/^(the |a |an )/i, "").trim();
  const ch = stripped.charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}

const ALPHA_LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];

function updateAlphaFilter() {
  const nav = elements.alphaFilterNav;
  if (!nav) return;

  if (state.mediaDetailInline || state.activeView !== "explorer") {
    nav.classList.add("hidden");
    return;
  }

  const items = state.explorerMode === "movies" ? state.moviesRaw : state.showsRaw;
  const hasItems = items.length > 0;
  nav.classList.toggle("hidden", !hasItems);
  if (!hasItems) return;

  const hasMore = state.explorerMode === "movies" ? state.moviesHasMore : state.showsHasMore;
  const loaded = new Set(items.map((it) => firstAlphaLetter(it.title)));

  nav.innerHTML = ALPHA_LETTERS.map((letter) => {
    const definitivelyEmpty = !hasMore && !loaded.has(letter);
    return `<button class="${definitivelyEmpty ? "alpha-empty" : ""}" data-alpha="${letter}" title="${letter === "#" ? "Numbers / symbols" : letter}" ${definitivelyEmpty ? "disabled" : ""}>${letter}</button>`;
  }).join("");
}

let alphaScrolling = false;

async function handleAlphaFilterClick(e) {
  const btn = e.target.closest("[data-alpha]");
  if (!btn || btn.disabled || alphaScrolling) return;

  const letter = btn.dataset.alpha;
  const panel = elements.explorerPanel;
  const nav = elements.alphaFilterNav;
  if (!panel || !nav) return;

  for (const b of nav.querySelectorAll("[data-alpha]")) b.classList.remove("alpha-current");
  btn.classList.add("alpha-current");

  function scrollToTarget(el) {
    const headingEl = document.querySelector(".explorer-heading-sticky");
    const topOffset = headingEl ? headingEl.getBoundingClientRect().bottom + 8 : 60;
    const rect = el.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top - topOffset, behavior: "smooth" });
  }

  let target = panel.querySelector(`[data-alpha-letter="${letter}"]`);
  if (target) {
    scrollToTarget(target);
    return;
  }

  alphaScrolling = true;
  try {
    const mode = state.explorerMode;
    const loadFn = mode === "movies" ? loadExplorerMovies : loadExplorerShows;
    const hasMore = () => (mode === "movies" ? state.moviesHasMore : state.showsHasMore);

    while (hasMore() && !panel.querySelector(`[data-alpha-letter="${letter}"]`)) {
      await loadFn();
    }

    target = panel.querySelector(`[data-alpha-letter="${letter}"]`);
    if (target) {
      scrollToTarget(target);
    } else {
      btn.classList.remove("alpha-current");
      btn.classList.add("alpha-empty");
      btn.disabled = true;
    }
  } finally {
    alphaScrolling = false;
  }
}

function resetMovieExplorer(key = explorerQueryKey("movies")) {
  state.moviesRaw = [];
  state.moviesOffset = 0;
  state.moviesHasMore = true;
  state.moviesLoading = false;
  state.moviesQueryKey = key;
  state.explorerScrollArmed = false;
}

function resetShowExplorer(key = explorerQueryKey("shows")) {
  state.showsRaw = [];
  state.showsOffset = 0;
  state.showsHasMore = true;
  state.showsLoading = false;
  state.showsQueryKey = key;
  state.explorerScrollArmed = false;
}

function renderExplorerSentinel(mode, hasMore, loading) {
  if (!hasMore && !loading) return "";
  return `
    <div class="explorer-scroll-sentinel" data-explorer-sentinel="${mode}" aria-live="polite">
      <span>${loading ? "Loading..." : ""}</span>
    </div>
  `;
}

function observeExplorerSentinel(mode) {
  state.explorerLoadObserver?.disconnect();
  state.explorerLoadObserver = undefined;

  const sentinel = elements.explorerPanel?.querySelector(`[data-explorer-sentinel="${mode}"]`);
  if (!sentinel || !("IntersectionObserver" in window)) return;

  state.explorerLoadObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!state.explorerScrollArmed) return;
      if (mode === "movies") loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
      if (mode === "shows") loadExplorerShows().catch((error) => setMessage(error.message, "error"));
    },
    { rootMargin: "1200px 0px 1200px 0px" },
  );
  state.explorerLoadObserver.observe(sentinel);
}

function observeDashboardPosters() {
  state.dashboardPosterObserver?.disconnect();
  if (!("IntersectionObserver" in window)) return;

  state.dashboardPosterObserver = new IntersectionObserver(
    async (entries) => {
      const fallbacks = entries
        .filter((entry) => entry.isIntersecting && entry.target.classList.contains("poster-fallback"))
        .map((entry) => entry.target);

      if (!fallbacks.length) return;

      const hydrateOne = async (fallback) => {
        const posterId = fallback.dataset.posterId;
        if (!posterId || state.posterLookupCache.has(posterId)) return;

        const posterUrl = await lookupPosterUrl(posterId);
        if (!posterUrl || !fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

        const image = document.createElement("img");
        image.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
        bindPosterImageErrorHandler(image);
        image.src = posterUrl;
        image.alt = `${fallback.getAttribute("aria-label") || "Media poster"}`;
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.dataset.posterId = posterId;
        fallback.replaceWith(image);
      };

      for (const fallback of fallbacks) {
        await hydrateOne(fallback);
      }
    },
    { rootMargin: "200px" },
  );

  const tvRow = elements.tvHistoryRow;
  const movieRow = elements.movieHistoryRow;
  if (tvRow) {
    for (const fallback of tvRow.querySelectorAll("[data-poster-id].poster-fallback")) {
      state.dashboardPosterObserver.observe(fallback);
    }
  }
  if (movieRow) {
    for (const fallback of movieRow.querySelectorAll("[data-poster-id].poster-fallback")) {
      state.dashboardPosterObserver.observe(fallback);
    }
  }
}

let _explorerPrefetchObserver = null;

function observeExplorerTmdbPrefetch(container) {
  _explorerPrefetchObserver?.disconnect();
  if (!("IntersectionObserver" in window)) return;
  _explorerPrefetchObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const mediaType = el.dataset.prefetchType;
        const tmdbId = el.dataset.prefetchTmdb;
        const title = el.dataset.prefetchTitle;
        // In the default "posters" grid the only thing TMDB details supplies is a
        // poster_path for cards whose poster hasn't resolved yet. Cards that already
        // rendered an <img> need nothing — skip them so we don't fire a request per
        // card. List/overview views always need the metadata (dates, runtime, eps).
        const needsMeta = currentExplorerView() === "list" || currentExplorerView() === "overview" || (mediaType === "tv" && currentExplorerView() === "posters");
        const needsPoster = !!el.querySelector(".poster-fallback[data-poster-id]");
        if (!needsMeta && !needsPoster) {
          _explorerPrefetchObserver?.unobserve(el);
          continue;
        }
        if (mediaType && title) {
          if (state.token) {
            fetchTmdbDetails(mediaType, tmdbId || undefined, title).then((data) => {
              if (!el.isConnected) return;
              if (data?.poster_path) {
                const posterUrl = tmdbPoster(data.poster_path);
                if (posterUrl) {
                  const fallback = el.querySelector(".poster-fallback[data-poster-id]");
                  if (fallback) {
                    const posterId = fallback.dataset.posterId;
                    state.posterLookupCache.set(posterId, posterUrl);
                    const img = document.createElement("img");
                    img.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
                    img.src = posterUrl;
                    img.alt = title;
                    img.loading = "lazy";
                    img.decoding = "async";
                    img.referrerPolicy = "no-referrer";
                    img.dataset.posterId = posterId;
                    fallback.replaceWith(img);
                  }
                }
              }
              if (currentExplorerView() === "list" && data) {
                const isMovie = mediaType === "movie";
                const releaseEl = el.querySelector("[data-list-release]");
                if (releaseEl && !releaseEl.textContent.trim()) {
                  const raw = isMovie ? data.release_date : data.first_air_date;
                  if (raw) releaseEl.textContent = formatListDate(raw);
                }
                const yearEl = el.querySelector("[data-list-year]");
                if (yearEl && !yearEl.textContent.trim()) {
                  const raw = isMovie ? data.release_date : data.first_air_date;
                  if (raw) yearEl.textContent = raw.slice(0, 4);
                }
                if (isMovie) {
                  const runtimeEl = el.querySelector("[data-list-runtime]");
                  if (runtimeEl && !runtimeEl.textContent.trim() && data.runtime) {
                    runtimeEl.textContent = `${data.runtime} min`;
                  }
                } else {
                  const nextAirEl = el.querySelector("[data-list-next-air]");
                  if (nextAirEl && !nextAirEl.textContent.trim()) {
                    const nextAiring = nextAiringCell(data);
                    if (nextAiring.text) {
                      nextAirEl.textContent = nextAiring.text;
                      nextAirEl.classList.toggle("list-next-air-status", nextAiring.isStatus);
                    }
                  }
                  const epsEl = el.querySelector("[data-list-eps]");
                  if (epsEl && data.number_of_episodes) {
                    const watched = parseInt(epsEl.dataset.watched || "0") || 0;
                    const total = data.number_of_episodes;
                    const pct = Math.round((watched / total) * 100);
                    epsEl.dataset.total = String(total);
                    epsEl.outerHTML = `<div class="list-eps-progress" data-list-eps data-watched="${watched}" data-total="${total}"><div class="list-eps-bar-track"><div class="list-eps-bar-fill" style="width:${pct}%"></div></div><span class="list-eps-label">${watched} / ${total}</span></div>`;
                  }
                }
              }
              const progressPill = el.querySelector(".show-progress-pill");
              if (progressPill && data?.number_of_episodes) {
                const watched = parseInt(progressPill.dataset.watched || "0") || 0;
                const total = data.number_of_episodes;
                progressPill.dataset.total = String(total);
                progressPill.textContent = `${watched}/${total} Watched`;
              }
              if (state.explorerSortShows === "next_air_asc" && mediaType === "tv") {
                scheduleNextAirResort();
              }
              if (currentExplorerView() === "overview" && data) {
                const attrsEl = el.querySelector("[data-overview-attrs]");
                const textEl = el.querySelector("[data-overview-text]");
                if (attrsEl && !attrsEl.textContent.trim()) {
                  const isMovie = mediaType === "movie";
                  const year = isMovie ? data.release_date?.slice(0, 4) : data.first_air_date?.slice(0, 4);
                  const genres = data.genres?.slice(0, 3).map((g) => g.name).join(" · ") || "";
                  const epCount = !isMovie && el.querySelector("[data-overview-attrs]")?.dataset?.epCount;
                  const parts = [year, genres].filter(Boolean);
                  attrsEl.textContent = parts.join(" · ");
                }
                if (textEl && !textEl.textContent.trim() && data.overview) {
                  textEl.textContent = data.overview;
                }
              }
            }).catch(() => {});
            _explorerPrefetchObserver?.unobserve(el);
          }
        } else {
          _explorerPrefetchObserver?.unobserve(el);
        }
      }
    },
    { rootMargin: "200px 0px 200px 0px" },
  );
  for (const el of container.querySelectorAll("[data-prefetch-type]")) {
    _explorerPrefetchObserver.observe(el);
  }
}

let _nextAirResortTimer = null;
function scheduleNextAirResort() {
  clearTimeout(_nextAirResortTimer);
  _nextAirResortTimer = setTimeout(() => {
    if (state.explorerSortShows === "next_air_asc" && state.explorerMode === "shows") renderShowExplorer();
  }, 600);
}

function currentExplorerView() {
  return state.explorerMode === "shows" ? state.explorerViewShows : state.explorerViewMovies;
}

function currentExplorerSort() {
  return state.explorerMode === "shows" ? state.explorerSortShows : state.explorerSortMovies;
}

function setCurrentExplorerSort(value) {
  if (state.explorerMode === "shows") {
    state.explorerSortShows = value;
    localStorage.setItem(EXPLORER_SORT_KEY_SHOWS, value);
  } else {
    state.explorerSortMovies = value;
    localStorage.setItem(EXPLORER_SORT_KEY_MOVIES, value);
  }
}

function currentPosterWidthKey() {
  const mode = state.explorerMode === "shows" ? "shows" : "movies";
  const view = currentExplorerView();
  return `plembfin:posterWidth:${mode}:${view}`;
}

function applyExplorerPosterWidth() {
  const saved = localStorage.getItem(currentPosterWidthKey()) || "160px";
  document.documentElement.style.setProperty("--poster-width", saved);
  if (elements.explorerPosterSize) elements.explorerPosterSize.value = parseInt(saved) || 160;
}

function explorerGridClass(isShows = false) {
  const base = isShows ? "movie-grid explorer-show-grid" : "movie-grid";
  const view = currentExplorerView();
  if (view === "list") return `explorer-list-view ${isShows ? "shows-list" : "movies-list"}`;
  if (view === "overview") return "explorer-overview-view";
  return base;
}

function sortArrow(colKey) {
  const s = currentExplorerSort();
  if (s === `${colKey}_asc`) return `<span class="sort-arrow">↑</span>`;
  if (s === `${colKey}_desc`) return `<span class="sort-arrow">↓</span>`;
  return "";
}

function applyListHeaderSort(key) {
  const asc = `${key}_asc`, desc = `${key}_desc`;
  setCurrentExplorerSort(currentExplorerSort() === asc ? desc : asc);
  if (elements.explorerSort) elements.explorerSort.value = currentExplorerSort();
  if (state.explorerMode === "shows") {
    state.showsRaw = []; state.showsOffset = 0; state.showsHasMore = true; state.showsLoading = false;
  } else {
    state.moviesRaw = []; state.moviesOffset = 0; state.moviesHasMore = true; state.moviesLoading = false;
  }
  renderExplorer();
}

function resolvedTmdbCache(mediaType, tmdbId, title) {
  if (!tmdbId && !title) return null;
  const key = `${mediaType}|${tmdbId || ""}|${String(title || "").toLowerCase()}`;
  const cached = state.tmdbDetailsCache.get(key);
  if (!cached || typeof cached.then === "function") return null;
  return cached;
}

function renderMovieCard(movie) {
  if (currentExplorerView() === "list") return renderMovieListCard(movie);
  if (currentExplorerView() === "overview") return renderMovieOverviewCard(movie);
  return `
    <div class="movie-card" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}">
      ${posterMarkup(movie, "movie-poster")}
      <div class="movie-card-body">
        <div class="movie-card-title-row" style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; min-width: 0; width: 100%;">
          <b style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</b>
          ${renderSyncStatusDot(movie, "margin-left: 0.25rem;")}
        </div>
        <span>${formatDate(movie.watched_at)}</span>
      </div>
    </div>
  `;
}

function renderListHeader(isShows) {
  if (isShows) {
    return `
      <div class="explorer-list-header">
        <span></span>
        <span class="list-header-sortable" data-sort-key="title">Series Title${sortArrow("title")}</span>
        <span>Source</span>
        <span class="list-header-sortable" data-sort-key="next_air">Next Airing${sortArrow("next_air")}</span>
        <span>Seasons</span>
        <span>Episodes</span>
        <span class="list-header-sortable" data-sort-key="watched">Last Watched${sortArrow("watched")}</span>
        <span>Year</span>
      </div>
    `;
  }
  return `
    <div class="explorer-list-header">
      <span></span>
      <span class="list-header-sortable" data-sort-key="title">Title${sortArrow("title")}</span>
      <span>Source</span>
      <span>Release Date</span>
      <span class="list-header-sortable" data-sort-key="watched">Watched${sortArrow("watched")}</span>
      <span>Year</span>
      <span>Runtime</span>
      <span></span>
    </div>
  `;
}

function renderMovieListCard(movie) {
  const sourceBadge = movie.source ? `<span class="source-badge ${sourceClass(movie.source)}">${escapeHtml(platformBadge(movie.source))}</span>` : "";
  const tmdb = resolvedTmdbCache("movie", movie.tmdb_id, movie.title);
  const releaseDate = tmdb?.release_date ? formatListDate(tmdb.release_date) : "";
  const runtime = tmdb?.runtime ? `${tmdb.runtime} min` : "";
  const year = tmdb?.release_date?.slice(0, 4) || "";
  return `
    <div class="movie-card explorer-list-card" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}">
      ${posterMarkup(movie, "list-thumb-poster")}
      <span class="list-card-title" title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</span>
      <div class="list-card-col list-card-platform">${sourceBadge}</div>
      <span class="list-card-col list-card-release" data-list-release>${escapeHtml(releaseDate)}</span>
      <span class="list-card-col">${escapeHtml(formatDate(movie.watched_at))}</span>
      <span class="list-card-col list-card-year" data-list-year>${escapeHtml(year)}</span>
      <span class="list-card-col" data-list-runtime>${escapeHtml(runtime)}</span>
      <div class="list-card-col list-card-sync">${renderSyncStatusDot(movie)}</div>
    </div>
  `;
}

function renderMovieOverviewCard(movie) {
  const tmdb = resolvedTmdbCache("movie", movie.tmdb_id, movie.title);
  const year = tmdb?.release_date?.slice(0, 4) || "";
  const genres = tmdb?.genres?.slice(0, 3).map((g) => escapeHtml(g.name)).join(" &middot; ") || "";
  const overview = tmdb?.overview || "";
  const sourceBadge = movie.source ? `<span class="source-badge ${sourceClass(movie.source)}">${escapeHtml(platformBadge(movie.source))}</span>` : "";
  return `
    <div class="movie-card explorer-overview-card" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}">
      ${posterMarkup(movie, "overview-thumb-poster")}
      <div class="overview-card-meta">
        <div class="overview-card-header">
          <b title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</b>
          <div class="overview-card-badges">${sourceBadge}${renderSyncStatusDot(movie)}</div>
        </div>
        <div class="overview-card-attrs" data-overview-attrs>${[year, genres].filter(Boolean).join(" &middot; ")}</div>
        <p class="overview-card-text" data-overview-text>${escapeHtml(overview)}</p>
        <span class="overview-card-date">${formatDate(movie.watched_at)}</span>
      </div>
    </div>
  `;
}

function renderMovieExplorer() {
  if (state.mediaDetailInline) return;
  const key = explorerQueryKey("movies");
  if (state.moviesQueryKey !== key) resetMovieExplorer(key);

  if (!state.moviesRaw.length && state.moviesHasMore && !state.moviesLoading && state.token) {
    loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
  }

  if (!state.moviesRaw.length && state.moviesLoading) {
    elements.explorerPanel.innerHTML = emptyExplorer("Loading movies...");
    return;
  }

  const movieGrid = state.moviesRaw.length
    ? `<div class="${explorerGridClass()}">${currentExplorerView() === "list" ? renderListHeader(false) : ""}${state.moviesRaw.map(renderMovieCard).join("")}</div>${renderExplorerSentinel("movies", state.moviesHasMore, state.moviesLoading)}`
    : emptyExplorer("No movies logged yet");
  elements.explorerPanel.innerHTML = movieGrid;
  hydratePosters(elements.explorerPanel);
  observeExplorerSentinel("movies");
  observeExplorerTmdbPrefetch(elements.explorerPanel);
  updateAlphaFilter();
}

async function loadExplorerMovies() {
  if (state.moviesLoading || !state.moviesHasMore) return;
  state.moviesLoading = true;
  renderMovieExplorer();

  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.moviesOffset));
    url.searchParams.set("sort", currentExplorerSort());
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);

    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    if (!body) {
      const res = await fetch(url, { headers: authHeaders() });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Movies load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }

    const movies = Array.isArray(body.movies) ? body.movies : [];
    state.moviesRaw = dedupeMediaRecords([...state.moviesRaw, ...movies], "movies");
    state.moviesOffset += movies.length;
    state.moviesHasMore = movies.length === EXPLORER_PAGE_SIZE;
  } finally {
    state.moviesLoading = false;
    renderMovieExplorer();
  }
}

function renderShowExplorer() {
  if (state.mediaDetailInline) return;
  const key = explorerQueryKey("shows");
  if (state.showsQueryKey !== key) resetShowExplorer(key);

  if (!state.showsRaw.length && state.showsHasMore && !state.showsLoading && state.token) {
    loadExplorerShows().catch((error) => setMessage(error.message, "error"));
  }

  if (!state.showsRaw.length && state.showsLoading) {
    elements.explorerPanel.innerHTML = emptyExplorer("Loading TV shows...");
    return;
  }

  const showsToRender = state.explorerSortShows === "next_air_asc"
    ? [...state.showsRaw].sort((a, b) => {
        const tmdbA = resolvedTmdbCache("tv", a.tmdb_id, a.title);
        const tmdbB = resolvedTmdbCache("tv", b.tmdb_id, b.title);
        const dateA = tmdbA?.next_episode_to_air?.air_date;
        const dateB = tmdbB?.next_episode_to_air?.air_date;
        if (dateA && dateB) return dateA.localeCompare(dateB);
        if (dateA) return -1;
        if (dateB) return 1;
        return String(a.title).localeCompare(String(b.title));
      })
    : state.showsRaw;

  elements.explorerPanel.innerHTML = showsToRender.length
    ? `<div class="${explorerGridClass(true)}">${currentExplorerView() === "list" ? renderListHeader(true) : ""}${showsToRender.map(renderShowRecord).join("")}</div>${renderExplorerSentinel("shows", state.showsHasMore, state.showsLoading)}`
    : emptyExplorer("No TV episodes logged yet");
  hydratePosters(elements.explorerPanel);
  observeExplorerSentinel("shows");
  observeExplorerTmdbPrefetch(elements.explorerPanel);
  updateAlphaFilter();
}

async function loadExplorerShows() {
  if (state.showsLoading || !state.showsHasMore) return;
  state.showsLoading = true;
  renderShowExplorer();

  try {
    const url = new URL("/api/shows", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.showsOffset));
    url.searchParams.set("sort", state.explorerSortShows === "next_air_asc" ? "title_asc" : state.explorerSortShows);
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);

    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    if (!body) {
      const res = await fetch(url, { headers: authHeaders() });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Shows load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }

    const shows = Array.isArray(body.shows) ? body.shows : [];
    state.showsRaw = dedupeMediaRecords([...state.showsRaw, ...shows], "shows");
    state.showsOffset += shows.length;
    state.showsHasMore = shows.length === EXPLORER_PAGE_SIZE;
  } finally {
    state.showsLoading = false;
    renderShowExplorer();
  }
}

function mergeShowDetail(show = {}) {
  if (!show?.title) return null;
  const showKey = slug(show.title);
  const existingIndex = state.showsRaw.findIndex((item) => slug(item.title) === showKey);
  if (existingIndex >= 0) {
    state.showsRaw[existingIndex] = { ...state.showsRaw[existingIndex], ...show };
    return state.showsRaw[existingIndex];
  }
  state.showsRaw.push(show);
  return show;
}

async function loadShowDetail(show = {}) {
  const showTitle = show.title || "";
  const showKey = slug(showTitle);
  const cacheKey = show.id || showKey || showTitle;
  if (!cacheKey) return null;
  if (state.showDetailInflight.has(cacheKey)) return state.showDetailInflight.get(cacheKey);

  const request = (async () => {
    const url = new URL("/api/show", window.location.origin);
    if (show.id) url.searchParams.set("id", show.id);
    if (showTitle) url.searchParams.set("title", showTitle);
    const response = await fetch(url, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Show detail failed ${response.status}`);
    return mergeShowDetail(body.show || null);
  })().finally(() => state.showDetailInflight.delete(cacheKey));

  state.showDetailInflight.set(cacheKey, request);
  return request;
}

function matchesExplorerSearch(entry = {}, search = "") {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;

  const haystack = [
    entry.title,
    entry.imdb_id,
    entry.tmdb_id,
    entry.tvdb_id,
    entry.source,
    entry.season,
    entry.episode,
  ]
    .filter((value) => value != null && String(value).trim())
    .map((value) => String(value).toLowerCase())
    .join(" ");

  return haystack.includes(needle);
}

function sortExplorerItems(items, sortMode) {
  return [...items].sort((a, b) => {
    if (sortMode === "title_asc") return String(a.title).localeCompare(String(b.title)) || watchedTime(b) - watchedTime(a);
    if (sortMode === "title_desc") return String(b.title).localeCompare(String(a.title)) || watchedTime(b) - watchedTime(a);
    if (sortMode === "watched_asc") return watchedTime(a) - watchedTime(b) || String(a.title).localeCompare(String(b.title));
    return watchedTime(b) - watchedTime(a) || String(a.title).localeCompare(String(b.title));
  });
}

function sortShowEntries(entries, sortMode) {
  return [...entries].sort(([titleA, seasonsA], [titleB, seasonsB]) => {
    if (sortMode === "title_asc") return titleA.localeCompare(titleB) || latestWatched(seasonsB) - latestWatched(seasonsA);
    if (sortMode === "title_desc") return titleB.localeCompare(titleA) || latestWatched(seasonsB) - latestWatched(seasonsA);
    if (sortMode === "watched_asc") return earliestWatched(seasonsA) - earliestWatched(seasonsB) || titleA.localeCompare(titleB);
    return latestWatched(seasonsB) - latestWatched(seasonsA) || titleA.localeCompare(titleB);
  });
}

function watchedTime(entry) {
  const time = new Date(entry?.watched_at || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function allSeasonEpisodes(seasons) {
  return [...seasons.values()].flat();
}

function latestWatched(seasons) {
  return Math.max(...allSeasonEpisodes(seasons).map(watchedTime), 0);
}

function earliestWatched(seasons) {
  const times = allSeasonEpisodes(seasons).map(watchedTime).filter(Boolean);
  return times.length ? Math.min(...times) : 0;
}

function representativeEpisode(seasons) {
  return sortExplorerItems(allSeasonEpisodes(seasons), "watched_desc")[0] || {};
}

function groupShows(episodes) {
  const shows = new Map();
  for (const episode of episodes) {
    if (!isWatchedHistoryAction(episode)) continue;
    const title = showName(episode.title);
    if (!shows.has(title)) shows.set(title, new Map());
    const seasons = shows.get(title);
    const season = Number(episode.season) || 0;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push(episode);
  }
  return shows;
}

function seasonsFromShowRecord(show = {}) {
  const seasons = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    const season = Number(episode.season) || 0;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push(episode);
  }
  return seasons;
}

function summaryEpisodeFromShow(show = {}) {
  const representative = show.representative_episode || show.representativeEpisode || {};
  return {
    ...representative,
    id: representative.id || show.id || show.title,
    title: sanitizeTitle(representative.title) || sanitizeTitle(show.title) || "Unknown Show",
    media_type: representative.media_type || "episode",
    watched_at: representative.watched_at || show.latest_watched_at || "",
    source: representative.source || show.source || "",
    imdb_id: representative.imdb_id || show.imdb_id || null,
    tmdb_id: representative.tmdb_id || show.tmdb_id || null,
    tvdb_id: representative.tvdb_id || show.tvdb_id || null,
    poster_url: representative.poster_url || show.poster_url || show.posterUrl || null,
  };
}

function renderShowRecord(show = {}) {
  const displayTitle = sanitizeTitle(show.title) || "Unknown Show";
  const showKey = slug(displayTitle);
  const representative = summaryEpisodeFromShow(show);
  const seasons = Array.isArray(show.episodes) && show.episodes.length ? seasonsFromShowRecord(show) : null;
  const episodeCount = show.episode_count || (seasons ? allSeasonEpisodes(seasons).length : 0);
  const seasonCount = show.season_count || (seasons ? seasons.size : 0);
  const latestEpisode = seasons ? representativeEpisode(seasons) : representative;
  const tmdbId = show.tmdb_id || "";

  if (currentExplorerView() === "list") {
    const tmdbShow = resolvedTmdbCache("tv", tmdbId, displayTitle);
    const year = tmdbShow?.first_air_date?.slice(0, 4) || "";
    const totalEps = show.total_episodes || tmdbShow?.number_of_episodes || 0;
    const nextAiring = nextAiringCell(tmdbShow);
    const pct = totalEps ? Math.round((episodeCount / totalEps) * 100) : null;
    const episodeProgressHtml = totalEps
      ? `<div class="list-eps-progress" data-list-eps data-watched="${episodeCount}" data-total="${totalEps}"><div class="list-eps-bar-track"><div class="list-eps-bar-fill" style="width:${pct}%"></div></div><span class="list-eps-label">${episodeCount} / ${totalEps}</span></div>`
      : `<span class="list-card-col" data-list-eps data-watched="${episodeCount}" data-total="0">${episodeCount}</span>`;
    const sourceEl = latestEpisode?.source ? `<span class="source-badge ${sourceClass(latestEpisode.source)}">${escapeHtml(platformBadge(latestEpisode.source))}</span>` : "";
    return `
      <article class="explorer-list-card explorer-list-show-card" data-show-key="${escapeAttribute(showKey)}" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
        ${posterMarkup(latestEpisode, "list-thumb-poster")}
        <span class="list-card-title">${escapeHtml(displayTitle)}</span>
        <div class="list-card-col list-card-platform">${sourceEl}</div>
        <span class="list-card-col${nextAiring.isStatus && nextAiring.text ? " list-next-air-status" : ""}" data-list-next-air>${escapeHtml(nextAiring.text)}</span>
        <span class="list-card-col">${escapeHtml(String(seasonCount || ""))}</span>
        ${episodeProgressHtml}
        <span class="list-card-col">${latestEpisode?.watched_at ? escapeHtml(formatDate(latestEpisode.watched_at)) : ""}</span>
        <span class="list-card-col list-card-year" data-list-year>${escapeHtml(year)}</span>
      </article>
    `;
  }

  if (currentExplorerView() === "overview") {
    const tmdb = resolvedTmdbCache("tv", tmdbId, displayTitle);
    const genres = tmdb?.genres?.slice(0, 3).map((g) => escapeHtml(g.name)).join(" &middot; ") || "";
    const overview = tmdb?.overview || "";
    const firstYear = tmdb?.first_air_date?.slice(0, 4) || "";
    return `
      <article class="explorer-overview-card explorer-overview-show-card" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
        <button class="folder-trigger overview-show-poster-btn" type="button" data-show-key="${escapeAttribute(showKey)}" style="border:0;background:transparent;padding:0;display:block;">
          ${posterMarkup(latestEpisode, "overview-thumb-poster")}
        </button>
        <div class="overview-card-meta">
          <div class="overview-card-header">
            <button class="folder-trigger overview-show-title-btn" type="button" data-show-key="${escapeAttribute(showKey)}" style="border:0;background:transparent;padding:0;text-align:left;cursor:pointer;"><b>${escapeHtml(displayTitle)}</b></button>
          </div>
          <div class="overview-card-attrs" data-overview-attrs>${[firstYear, genres].filter(Boolean).join(" &middot; ")}${episodeCount ? `${firstYear || genres ? " &middot; " : ""}${episodeCount} ep${episodeCount !== 1 ? "s" : ""}` : ""}</div>
          <p class="overview-card-text" data-overview-text>${escapeHtml(overview)}</p>
        </div>
      </article>
    `;
  }

  const tmdbShow = resolvedTmdbCache("tv", tmdbId, displayTitle);
  const totalEps = show.total_episodes || tmdbShow?.number_of_episodes || 0;

  return `
    <article class="folder-card" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
      <button class="folder-trigger" type="button" data-show-key="${escapeAttribute(showKey)}" style="border: 0; background: transparent; padding: 0; width: 100%; text-align: left; display: block;">
        <div style="position: relative; display: block; width: 100%;">
          ${posterMarkup(latestEpisode, "explorer-folder-poster")}
          <span class="show-progress-pill" data-watched="${episodeCount}" data-total="${totalEps}">
            ${totalEps ? `${episodeCount}/${totalEps} Watched` : `${episodeCount} Watched`}
          </span>
        </div>
        <div class="movie-card-body" style="margin-top: 0.5rem;">
          <b>${escapeHtml(displayTitle)}</b>
        </div>
      </button>
    </article>
  `;
}

function renderShowFolder(showTitle, seasons, tmdbId) {
  const showKey = slug(showTitle);
  const latestEpisode = representativeEpisode(seasons);

  return `
    <article class="folder-card" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId || "")}" data-prefetch-title="${escapeAttribute(showTitle)}">
      <button class="folder-trigger" type="button" data-show-key="${showKey}" style="border: 0; background: transparent; padding: 0; width: 100%; text-align: left; display: block;">
        ${posterMarkup(latestEpisode, "explorer-folder-poster")}
        <div class="movie-card-body" style="margin-top: 0.5rem;">
          <b>${escapeHtml(showTitle)}</b>
        </div>
      </button>
    </article>
  `;
}

function renderSeasonFolder(showKey, season, episodes) {
  const seasonKey = `${showKey}:s${season}`;
  const expanded = state.expandedSeasons.has(seasonKey);
  const sortedEpisodes = sortExplorerItems(episodes, currentExplorerSort());

  return `
    <article class="season-card">
      <button class="season-trigger" type="button" data-season-key="${seasonKey}" aria-expanded="${expanded}">
        <span class="accordion-chevron ${expanded ? "expanded" : ""}">▼</span>
        <b>Season ${String(season || "?").padStart(2, "0")}</b>
        <span>${episodes.length} watched episodes</span>
      </button>
      <div class="episode-list ${expanded ? "" : "hidden"}">
        ${sortedEpisodes
          .map((episode) => {
            return `
              <article class="episode-row" style="display: flex; flex-direction: column; align-items: stretch; gap: 0.5rem; padding: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem; min-width: 0;">
                  ${posterMarkup(episode, "explorer-episode-poster")}
                  <span class="episode-code">[ E${String(episode.episode || "?").padStart(2, "0")} ]</span>
                  <b style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.35rem;">
                    [ ${escapeHtml(episodeTitle(episode.title, episode.episode))} ]
                    ${renderSyncStatusDot(episode)}
                  </b>
                  <button class="debug-badge" type="button" data-history-id="${episode.id}">${formatDate(episode.watched_at)}</button>
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    </article>
  `;
}

function emptyExplorer(message) {
  return `<div class="empty-log"><b>${escapeHtml(message)}</b><span>Import history or wait for webhook events.</span></div>`;
}

function renderDbStatus(isOnline) {
  if (!elements.dbStatus) return;
  elements.dbStatus.innerHTML = `
    <span class="target-pill" data-status="${isOnline ? "success" : "error"}">${isOnline ? "Connected" : "Unavailable"}</span>
    <p>Total rows visible to this query: ${formatNumber(state.stats.totalWatches || 0)}</p>
    <p>Backend store: <code>Cloud Firestore</code></p>
  `;
}

function helpBadgeValue(token = "") {
  const key = String(token || "").trim().toUpperCase();
  if (key === "FIREBASE_AUTH") return { label: "ADMIN", value: state.firebaseUser?.email || "" };
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
  const categories = [...new Set(HELP_TOPICS.map((topic) => topic.category))];
  elements.helpMenu.innerHTML = categories
    .map(
      (category) => `
        <section class="help-menu-group">
          <p>${escapeHtml(category)}</p>
          ${HELP_TOPICS.filter((topic) => topic.category === category)
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

  const topic = HELP_TOPICS.find((item) => item.id === state.activeHelpTopic) || HELP_TOPICS[0];
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
  if (!HELP_TOPICS.some((topic) => topic.id === topicId)) return;
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
  elements.logsTerminal.scrollTop = elements.logsTerminal.scrollHeight;
}

function syncLogsRefresh() {
  const shouldRefresh = state.activeView === "settings" && state.activeSettingsTab === "logs" && state.token;
  if (shouldRefresh && !state.logsRefreshInterval) {
    renderLogs().catch(() => {});
    state.logsRefreshInterval = window.setInterval(() => {
      if (state.activeView === "settings" && state.activeSettingsTab === "logs") {
        renderLogs().catch(() => {});
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

function startOfWeek(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return startOfWeek(new Date());
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

function toDateInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDayName(value) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(value);
}

function formatDayDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(value);
}

function formatWeekRange(start, endExclusive) {
  const end = addDays(endExclusive, -1);
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function formatShortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function platformName(value) {
  const normalized = normalizePlatformSource(value);
  const text = normalized.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizePlatformSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  return "plex";
}

function platformBadge(value) {
  return platformName(value);
}

function sourceClass(value) {
  return `source-${normalizePlatformSource(value)}`;
}

function computeProgress(offsetMs = 0, durationMs = 0) {
  if (!durationMs) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(offsetMs || 0) / Number(durationMs || 1)) * 100)));
}

function formatDuration(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatPlaybackClock(offsetMs = 0, durationMs = 0) {
  return `${formatDuration(offsetMs)} / ${formatDuration(durationMs)}`;
}

function formatNowPlayingMeta(session = {}) {
  const parts = [session.mediaType || "unknown"];
  if (session.season != null) parts.push(`Season ${String(session.season).padStart(2, "0")}`);
  if (session.episode != null) parts.push(`Episode ${String(session.episode).padStart(2, "0")}`);
  if (session.client?.deviceName) parts.push(session.client.deviceName);
  if (session.client?.userName) parts.push(session.client.userName);
  return parts.join(" / ");
}

function idLine(entry) {
  const ids = [
    entry.imdb_id ? `IMDb ${entry.imdb_id}` : "",
    entry.tmdb_id ? `TMDB ${entry.tmdb_id}` : "",
    entry.tvdb_id ? `TVDB ${entry.tvdb_id}` : "",
    entry.season ? `S${String(entry.season).padStart(2, "0")}` : "",
    entry.episode ? `E${String(entry.episode).padStart(2, "0")}` : "",
  ].filter(Boolean);
  return ids.join(" / ");
}

function showName(title) {
  const text = String(title || "Unknown Show").trim();
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

function episodeTitle(title, episodeNumber) {
  const text = String(title || "Episode").trim();
  const suffixMatch = text.match(/S\d{1,2}E\d{1,2}\s+-\s+(.+)$/i);
  if (suffixMatch?.[1]) return suffixMatch[1].trim();
  const parts = text.split(" - ");
  if (parts.length > 1) {
    const candidate = parts.slice(1).join(" - ").trim();
    if (candidate && !/^S\d{1,2}E\d{1,2}$/i.test(candidate)) return candidate;
  }
  return episodeNumber ? `Episode ${String(episodeNumber).padStart(2, "0")}` : text;
}

function slug(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function historyById(id) {
  return state.history.find((entry) => String(entry.id) === String(id));
}

function movieById(id) {
  return state.history.find((entry) => String(entry.id) === String(id)) ||
         state.moviesRaw.find((entry) => String(entry.id) === String(id)) ||
         state.activeSessions.find((entry) => String(entry.id || entry.key) === String(id));
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
  if (localMovie?.id) return `/movie/${encodeURIComponent(localMovie.id)}`;
  if (ids.tmdb) return `/movie/tmdb/${ids.tmdb}`;
  return `/movie/${encodeURIComponent(session.id || session.key || session.title || "unknown")}`;
}

function showTitleFrom(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
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
      // no-store: the real cache is server-side (Firestore, status-aware TTL).
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

async function fetchTmdbDetails(mediaType, tmdbId, title) {
  const cacheKey = `${mediaType}|${tmdbId || ""}|${String(title || "").toLowerCase()}`;
  if (state.tmdbDetailsCache.has(cacheKey)) return state.tmdbDetailsCache.get(cacheKey);

  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  _tmdbBatchQueue.push({
    item: { mediaType, tmdbId: tmdbId || undefined, title: title || undefined },
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
      <div class="cast-compact-row">
        ${cast.slice(0, 20).map((actor) => {
          const avatarUrl = tmdbProfile(actor.profile_path) || "/favicon.svg";
          return `
            <div class="cast-member-card" style="cursor: pointer;" onclick="window.showCastMemberDetails('${actor.id}', '${escapeAttribute(actor.name)}')">
              <img class="cast-avatar-img" src="${escapeAttribute(avatarUrl)}" alt="${escapeAttribute(actor.name)}" onerror="this.src='/favicon.svg';" />
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
              <div class="trailer-thumb-container" data-video-key="${video.key}" data-video-name="${escapeAttribute(video.name)}" onclick="window.playTrailer(this, '${video.key}', '${escapeAttribute(video.name)}')">
                <img class="trailer-thumb" src="https://img.youtube.com/vi/${video.key}/mqdefault.jpg" alt="${escapeAttribute(video.name)}" onerror="this.src='/favicon.svg';" />
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
                ${hasLong ? `<button class="action-pill review-toggle-btn" type="button" onclick="const p=this.previousElementSibling.querySelector('.review-content');p.classList.toggle('expanded');this.textContent=p.classList.contains('expanded')?'Show Less':'Read More';">Read More</button>` : ""}
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
              <img class="season-poster-img" src="${escapeAttribute(poster)}" alt="${escapeAttribute(item.name || "")}" onerror="this.src='/favicon.svg';" />
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
  return `<aside class="media-facts-rail ${placement === "sidebar" ? "media-facts-rail--sidebar" : ""}" aria-label="Media facts">${facts.map(([label, value]) => `
    <div class="media-fact"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
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

  const tmdbData = await fetchTmdbDetails("tv", show.tmdb_id, show.title);

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
      posterUrl = tmdbPoster(tmdbData.poster_path);
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
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(showTitle)} poster" onerror="this.src='/favicon.svg';" />
        <div class="immersive-meta">
          <span class="format-badge">Season ${activeSeasonNum}</span>
          <h2 class="immersive-title">${escapeHtml(showTitle)}</h2>
          <p class="immersive-subtitle">${premiered}</p>
          
          <div class="ratings-row">
            ${ratingBadgeHtml}
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
                  <img class="season-poster-img" src="${seasonPoster}" alt="${escapeHtml(s.name)}" onerror="this.src='/favicon.svg';" />
                  <span class="season-poster-name">${escapeHtml(s.name || `Season ${s.season_number}`)}</span>
                </div>
              `;
            })
            .join("")}
        </div>
      </section>
    </div>
  `;
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

function tmdbImage(path, size = "w300") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : "";
}

function tmdbPoster(path) {
  return path ? `/api/tmdb-poster?path=${encodeURIComponent(path)}` : "";
}

function tmdbProfile(path) {
  return path ? `/api/tmdb-profile?path=${encodeURIComponent(path)}` : "";
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

function buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, resolvedTmdbId = "") {
  const watchedMap = watchedEpisodesByKey(show);
  const localSeasons = seasonsFromShowRecord(show);
  const rows = [];

  for (const season of seasonsList.filter((item) => Number(item.season_number) > 0)) {
    const seasonNumber = Number(season.season_number);
    const tmdbSeason = seasonDetailsByNumber.get(seasonNumber);
    const tmdbEpisodes = Array.isArray(tmdbSeason?.episodes) ? tmdbSeason.episodes : [];

    if (tmdbEpisodes.length) {
      for (const episode of tmdbEpisodes) {
        const episodeNumber = Number(episode.episode_number);
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
  const url = safeImageUrl(episode.stillUrl) || safeImageUrl(episode.posterUrl);
  if (!url) return `<span class="episode-thumb poster-fallback" aria-hidden="true"></span>`;
  return `<img class="episode-thumb" src="${escapeAttribute(url)}" alt="${escapeAttribute(episode.title)} thumbnail" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
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
        </div>

        <div class="watch-date-custom">
          <label for="watchDateCustomInput">Or pick a specific date</label>
          <div class="watch-date-custom-row">
            <input id="watchDateCustomInput" type="date" value="${escapeAttribute(customValue)}" max="${escapeAttribute(customValue)}" />
            <button class="button-primary" type="button" data-watch-date-choice="custom">Use date</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderWatchDatePrompt(action) {
  if (!action) return "";
  const customValue = new Date().toISOString().slice(0, 10);
  if (action.scope === "movie") return renderMovieWatchDatePrompt(action, customValue);
  const episodeCount = action.episodes.length;
  const them = episodeCount === 1 ? "this episode" : "these episodes";
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
          <button class="watch-date-pick" type="button" data-watch-date-choice="release">
            <span class="watch-date-pick-title">Day of release</span>
            <span class="watch-date-pick-sub">Use each episode's air date</span>
          </button>
          <button class="watch-date-pick" type="button" data-watch-date-choice="now">
            <span class="watch-date-pick-title">Now</span>
            <span class="watch-date-pick-sub">Today, ${escapeHtml(formatTmdbDate(customValue))}</span>
          </button>
        </div>

        <div class="watch-date-custom">
          <label for="watchDateCustomInput">Or pick a specific date</label>
          <div class="watch-date-custom-row">
            <input id="watchDateCustomInput" type="date" value="${escapeAttribute(customValue)}" max="${escapeAttribute(customValue)}" />
            <button class="button-primary" type="button" data-watch-date-choice="custom">Use date</button>
          </div>
        </div>
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
  const episodeRows = buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, tmdbData?.id || show.tmdb_id || "");
  const watchedRows = episodeRows.filter((episode) => episode.watched);
  const metadataEpisodeCount = seasonsList.reduce((total, season) => total + Number(season.episode_count || 0), 0);
  const totalCount = Math.max(episodeRows.length, metadataEpisodeCount, watchedRows.length, 1);
  const watchedCount = watchedRows.length || [...watchedEpisodesByKey(show).keys()].length;
  const progressPercent = Math.max(0, Math.min(100, Math.round((watchedCount / totalCount) * 100)));
  const representative = representativeEpisode(seasonsMap);
  const backdropUrl = tmdbData?.cached_backdrop_url || tmdbImage(tmdbData?.backdrop_path, "original");
  const posterUrl = tmdbData?.cached_poster_url || tmdbPoster(tmdbData?.poster_path) || posterUrlFor(representative);
  const overview = tmdbData?.overview || "No synopsis available.";
  const premiered = tmdbData?.first_air_date ? `Premiered ${formatTmdbDate(tmdbData.first_air_date)}` : "Release date unknown";
  const rating = tmdbData?.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "";
  const ratingPillsHtml = renderExternalRatingPills("tv", tmdbData, showTitle, rating);
  const uniqueSources = [...new Set((show.episodes || []).map((episode) => episode.source || "unknown"))].filter((source) => source !== "unknown");

  state.showModalEpisodes = episodeRows;
  state.showModalEpisodeIndex = new Map(episodeRows.map((episode) => [episode.key, episode]));

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
  const selectedSeasonEpisodesHtml = selectedSeasonRecord ? `
    <section class="show-season-block" id="showSeason${selectedSeasonNumber}">
      <div class="show-season-head">
        <span class="show-season-label">${selectedSeasonSummary.watchedInSeason} of ${selectedSeasonSummary.seasonTotal || "?"} episodes watched</span>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
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
                <p>${escapeHtml(episode.overview)}</p>
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
    return `
      <article class="season-accordion ${isActive ? "is-open" : ""}">
        <button class="season-accordion-trigger" type="button" data-season-accordion="${seasonNumber}" aria-expanded="${isActive}" aria-controls="${panelId}">
          <span class="season-accordion-title">
            <strong>${escapeHtml(season.name || seasonLabel(seasonNumber))}</strong>
            <span class="season-episode-count">${escapeHtml(seasonMetaText)}</span>
          </span>
          <span class="season-accordion-meta">
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

  const showImdbId = show.imdb_id || representativeEpisode(seasonsMap)?.imdb_id || "";
  const showImdbLinkHtml = showImdbId ? `<a class="action-pill" href="https://www.imdb.com/title/${escapeAttribute(showImdbId)}" target="_blank" rel="noopener noreferrer">View on IMDb</a>` : "";

  setMediaDetailActions(`
    <button class="action-pill" type="button" data-watch-scope="show" ${(unwatchedRows.length && !isSaving) ? "" : "disabled"}>
      ${isSavingShow ? "Saving watched state…" : "Mark whole show watched"}
    </button>
    ${watchedRows.length ? `<button class="action-pill media-edit-show-date-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">Edit Show Watch Date</button>` : ""}
    ${tmdbOnly ? "" : `
      <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-poster-url="${escapeAttribute(show.poster_url || "")}">Edit Image</button>
      <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-title="${escapeAttribute(showTitle)}" data-media-type="tv">Fix Match</button>
      <button class="action-pill media-merge-show-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">Merge</button>
    `}
    ${showImdbLinkHtml}
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || "")}');"></div>
    <div class="immersive-container media-detail-page">

      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || "/favicon.svg")}" alt="${escapeAttribute(showTitle)} poster" onerror="this.src='/favicon.svg';" />
        <div class="immersive-meta">
          <h2 class="immersive-title">${escapeHtml(showTitle)}</h2>
          <p class="immersive-subtitle">${escapeHtml(premiered)}</p>

          <div class="ratings-row">
            ${ratingPillsHtml}
            ${showModalStatus(loading, hasTmdbKey, Boolean(tmdbData))}
          </div>

          <p class="immersive-overview">${escapeHtml(overview)}</p>

          <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
            <div class="availability-row">
              <span class="availability-label">Availability</span>
              <div class="avail-pills-row">${renderShowAvailabilityPills(show)}</div>
            </div>
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
        ${renderMediaFacts(tmdbData, "tv", "sidebar")}
      </header>

      ${seasonsSectionHtml}

      ${renderCastSection(tmdbData)}

      ${renderTrailersReviewsSection(tmdbData)}
      ${renderRelatedShowsSection(tmdbData)}
    </div>
    ${renderWatchDatePrompt(state.pendingWatchAction)}
  `;
  hydratePosters(root);
  // Highlight only — no scrolling when navigating from dashboard
}

async function hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken) {
  const show = mergeShowWithLoadedHistory(state.showsRaw.find((s) => slug(s.title) === showKey));
  if (!show) return;

  const tmdbData = await fetchTmdbDetails("tv", show.tmdb_id, show.title);
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;

  const seasonsList = (tmdbData?.seasons?.length ? tmdbData.seasons : fallbackSeasonList(seasonsFromShowRecord(show))).filter((season) => Number(season.season_number) > 0);
  renderShowModalContent(show, { activeSeasonNum, tmdbData, seasonDetailsByNumber: new Map(), loading: true });

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
      const response = await fetch(`/api/show?id=${encodeURIComponent(showKey)}`, { headers: authHeaders() });
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
    show = await loadShowDetail(show).catch((error) => {
      console.error("Failed to load show detail", error);
      setMessage(`Failed to load show details: ${error.message}`, "error");
      return show;
    });
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
  const root = mediaDetailRoot();
  root.querySelector(".watch-date-overlay")?.remove();
  root.insertAdjacentHTML("beforeend", renderWatchDatePrompt(action));
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

function watchedAtForChoice(choice, episode, customDate) {
  if (choice === "release") return dateAtMiddayIso(episode.airDate);
  if (choice === "custom") return dateAtMiddayIso(customDate);
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
    episode_number: episode.episodeNumber,
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
  const customDate = root.querySelector("#watchDateCustomInput")?.value || "";
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

  for (let index = 0; index < records.length; index += IMPORT_BATCH_SIZE) {
    const batch = records.slice(index, index + IMPORT_BATCH_SIZE);
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

async function applyWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  if (action?.scope === "movie") return applyMovieWatchDateChoice(choice);
  if (!action?.episodes?.length) return;

  const root = mediaDetailRoot();
  const customDate = root.querySelector("#watchDateCustomInput")?.value || "";
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
            termLog("👉 FIX: Verify that the Server URL is correct, the target server is currently online, and there are no network rules/firewalls blocking the connection from the Firebase Cloud Functions runtime.", "success");
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
  const movie = state.moviesRaw.find((item) => String(item.id) === String(id))
    || state.history.find((item) => String(item.id) === String(id));
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
  if (state.mediaDetailInline && state.activeShowModalKey === showKey) {
    await renderImmersiveShowModal(showKey, activeSeasonNum, activeEpisodeNum);
  } else {
    prepareInlineMediaDetail("shows");
    await renderImmersiveShowModal(showKey, activeSeasonNum, activeEpisodeNum);
  }
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
    <button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">Mark unwatched</button>
    <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-poster-url="${escapeAttribute(movie.poster_url || "")}">Edit Image</button>
    <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">Fix Match</button>
  `);
  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(localPoster)}');"></div>
    <div class="immersive-container media-detail-page is-loading-metadata">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(localPoster)}" alt="${escapeAttribute(movie.title || "Movie")} poster" onerror="this.src='/favicon.svg';" />
        <div class="immersive-meta">
          <span class="media-kicker">Movie · Loading metadata</span>
          <h2 class="immersive-title">${escapeHtml(movie.title || "Unknown movie")}</h2>
          <div class="avail-pills-row">${renderAvailabilityPills(movie)}</div>
          <p class="immersive-overview">Your library record is ready. Synopsis, cast, providers and related media are loading.</p>
        </div>
      </header>
    </div>
  `;

  const tmdbData = await fetchTmdbDetails("movie", movie.tmdb_id, movie.title);
  if (_mediaRenderToken !== renderToken) return; // navigated away while loading

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
    if (tmdbData.poster_path) {
      posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path);
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

  const ratingBadgeHtml = rating !== "N/A" ? `
    ${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}
  ` : "";

  const imdbId = movie.imdb_id || tmdbData?.imdb_id || "";
  const imdbLinkHtml = imdbId ? `<a class="action-pill" href="https://www.imdb.com/title/${escapeAttribute(imdbId)}" target="_blank" rel="noopener noreferrer">View on IMDb</a>` : "";

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
    <button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">Mark unwatched</button>
    <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-poster-url="${escapeAttribute(movie.poster_url || "")}">Edit Image</button>
    <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">Fix Match</button>
    ${ytWatchBtn}
    ${imdbLinkHtml}
    <button class="action-pill action-pill-danger" type="button" ${isSaving ? "disabled" : ""} data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">Delete</button>
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${backdropUrl || posterUrl}');"></div>
    <div class="immersive-container media-detail-page">

      <header class="immersive-header">
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(movieTitle)} poster" onerror="this.src='/favicon.svg';" />
        <div class="immersive-meta">
          <h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>
          <p class="immersive-subtitle">${released}${youtubeMeta?.channelName ? ` &middot; ${escapeHtml(youtubeMeta.channelName)}` : ""}</p>

          <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}
            <div class="avail-pills-row">
              ${renderAvailabilityPills(movie)}
            </div>
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
                    <img class="season-poster-img" src="${recPoster}" alt="${escapeHtml(rec.title)}" onerror="this.src='/favicon.svg';" />
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
  let posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path) || "/favicon.svg";
  let overview = tmdbData.overview || "No synopsis available.";
  let released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : "Unknown Release Date";
  let rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "N/A";
  let recommendations = [];

  recommendations = tmdbData.recommendations?.results || [];

  const ratingBadgeHtml = rating !== "N/A" ? `
    ${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}
  ` : "";

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${backdropUrl || posterUrl}');"></div>
    <div class="immersive-container media-detail-page">
      
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(movieTitle)} poster" onerror="this.src='/favicon.svg';" />
        <div class="immersive-meta">
          <h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>
          <p class="immersive-subtitle">${released}</p>
          
          <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}
            <div class="avail-pills-row">
              ${renderAvailabilityPills({})}
            </div>
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
                    <img class="season-poster-img" src="${recPoster}" alt="${escapeHtml(rec.title)}" onerror="this.src='/favicon.svg';" />
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
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  const eyebrowEl = elements.debugModal.querySelector(".eyebrow");
  if (eyebrowEl) {
    eyebrowEl.textContent = "Sync diagnostic audit";
  }
}

function mediaDetailRoot() {
  return state.mediaDetailInline ? elements.explorerPanel : elements.modalBody;
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
  document.querySelector(".explorer-controls")?.classList.add("hidden");
}

function setMediaDetailActions(html) {
  const el = document.getElementById("mediaDetailActions");
  if (el) el.innerHTML = html || "";
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
  document.querySelector(".explorer-controls")?.classList.remove("hidden");
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
  state.firebaseUser = result.user;
  state.token = result.token;
  if (elements.settingsUsername) elements.settingsUsername.value = cleanEmail;
  localStorage.setItem("firebaseAdminEmail", cleanEmail);
  if (result.token === "plembfin-local-admin") {
    localStorage.setItem(TOKEN_KEY, result.token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
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
  startHistoryPolling();
  setMessage("Dashboard unlocked.", "success");
}

async function lockDashboard() {
  stopHistoryPolling();
  state.token = "";
  state.firebaseUser = undefined;
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
  await signOutAdmin().catch(() => {});
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

async function parseSelectedFiles(files) {
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

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
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

function renderImportPreview() {
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

function renderImportActivity() {
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

async function startImport() {
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
    setMessage(`Import complete. Inserted ${inserted}, updated ${updated}, skipped ${skipped}, rejected ${rejected}.`, "success");
    clearDerivedUiCaches();
    await loadHistory();
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

async function runSystemIntegrityCheck() {
  const button = elements.runCompleteCheckButton;
  const container = elements.completeCheckResults;
  
  if (!button || !container) return;
  
  button.disabled = true;
  button.textContent = "Running diagnostics...";
  container.classList.remove("hidden");
  container.innerHTML = `<div class="idle-state"><b>Running integrity checks...</b></div>`;
  
  const results = [];
  
  // 1. Check Firestore-backed history API
  try {
    const startTime = Date.now();
    const response = await fetch("/api/history?limit=1", { headers: authHeaders() });
    const elapsed = Date.now() - startTime;
    if (response.ok) {
      results.push({ name: "Cloud Firestore History", status: "success", detail: `Connected successfully. Response time: ${elapsed}ms.` });
    } else {
      results.push({ name: "Cloud Firestore History", status: "error", detail: `Server responded with HTTP ${response.status}.` });
    }
  } catch (error) {
    results.push({ name: "Cloud Firestore History", status: "error", detail: `Connection failed: ${error.message}` });
  }
  
  // 2. Check Firestore settings document
  try {
    await loadSavedConfig();
    results.push({ name: "Firestore Settings", status: "success", detail: "Read server-side media configuration successfully." });
  } catch (error) {
    results.push({ name: "Firestore Settings", status: "error", detail: `Failed to read config: ${error.message}` });
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
    let helpTopic = "";
    
    if (res.status === "success") {
      statusLabel = "Online";
      pillStyle = "border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.12); color: #a7f3d0;";
    } else if (res.status === "error") {
      statusLabel = "Failed";
      pillStyle = "border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); color: #fecdd3;";
    } else if (res.status === "skipped") {
      statusLabel = "Not Configured";
      pillStyle = "border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.12); color: #fde68a;";
    } else if (res.status === "warning") {
      statusLabel = "Warnings Detected";
      pillStyle = "border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12); color: #fef08a;";
    }

    if (res.status !== "success") {
      if (res.name === "Scheduled Cron Job") {
        fixInstruction = "Fix: Confirm the Firebase scheduledSync function is deployed and Cloud Scheduler has invoked it. You can also run /api/cron-sync manually while signed in.";
        helpTopic = "webhooks";
      } else if (res.name === "Cloud Firestore History") {
        fixInstruction = "Fix: Confirm Firestore is enabled and the Firebase Functions service account can access it.";
      } else if (res.name === "Firestore Settings") {
        fixInstruction = "Fix: Confirm Firestore is enabled and save media server settings again.";
      } else if (res.name === "Webhook Listener Endpoint") {
        fixInstruction = "Fix: Confirm the latest Firebase Hosting deployment rewrites /api/webhook to the api function.";
      } else if (res.name === "Outbound Playstate Sync") {
        fixInstruction = "Fix: Open the latest history row debug details, review sync_dispatch_telemetry, then correct the failed platform credentials or provider-ID match.";
      } else if (res.name === "Plex Media Server") {
        fixInstruction = "Fix: Enter the Plex Server URL and Plex Token in Settings, then confirm the server is reachable from Firebase Functions.";
      } else if (res.name === "Plex Realtime Notifications") {
        fixInstruction = "Fix: Ensure any reverse proxy / Cloudflare in front of Plex forwards WebSocket upgrades on /:/websockets/notifications, or set the Plex Server URL to the direct LAN address (e.g. http://192.168.x.x:32400). Unwatch sync still works via the fallback poll until this is fixed.";
        helpTopic = "webhooks";
      } else if (res.name === "Emby Media Server") {
        fixInstruction = "Fix: Enter the Emby Server URL, API Key, and User ID in Settings, then confirm the server is reachable from Firebase Functions.";
      } else if (res.name === "Jellyfin Media Server") {
        fixInstruction = "Fix: Enter the Jellyfin Server URL, API Key, and User ID in Settings, then confirm the server is reachable from Firebase Functions.";
      }
    }
    
    return `
      <div class="ranking-row" style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-3); width: 100%;">
        <div style="display: grid; gap: 2px;">
          <b>${escapeHtml(res.name)}</b>
          <span style="font-size: 0.8rem; color: var(--muted);">${escapeHtml(res.detail)}</span>
          ${fixInstruction ? `<span style="font-size: 0.8rem; color: var(--text);">${escapeHtml(fixInstruction)}</span>` : ""}
          ${helpTopic ? `<button type="button" data-help-topic-link="${escapeAttribute(helpTopic)}" style="width: fit-content; border: 1px solid var(--line); background: var(--panel-3); color: var(--text); border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.78rem; font-weight: 800;">Open setup guide</button>` : ""}
        </div>
        <span class="target-pill" style="padding: 0.2rem 0.5rem; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; border: 1px solid; border-radius: 999px; ${pillStyle}">${statusLabel}</span>
      </div>
    `;
  }).join("");
  
  button.disabled = false;
  button.textContent = "Run System Diagnostic";
}

async function runRepairWorkflow() {
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

      // If nothing changed this pass, stop
      if (!converted && !backfilled) {
        appendLog(`${passLabel} made no changes; stopping.`);
        break;
      }

      // small delay between passes
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
  // refresh history / settings view
  clearDerivedUiCaches();
  await loadHistory().catch(() => {});
  return { converted: totalConverted, backfilled: totalBackfilled };
}

async function runDedupHistory() {
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
          try { finalResult = JSON.parse(trimmed.substring(8)); } catch (_) {}
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

async function runTraktBackfill() {
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
    const maxBatches = 2000; // safety cap
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

      // get remaining count
      let remaining = null;
      try {
        const st = await fetch(`/api/admin-backfill-status`, { headers: authHeaders() });
        const stBody = await st.json().catch(() => ({}));
        remaining = Number(stBody.remaining ?? stBody.missing ?? null);
      } catch (err) {
        // ignore
      }

      status.textContent = remaining != null ? `Batch ${batch + 1}: backfilled ${backfilled}. Remaining: ${remaining}` : `Batch ${batch + 1}: backfilled ${backfilled}`;

      // stop conditions
      if ((backfilled === 0 && lastBackfilled === 0) || (remaining === 0)) {
        if (logEl) logEl.textContent = `${new Date().toISOString()} - No further progress; stopping.\n` + logEl.textContent;
        break;
      }
      lastBackfilled = backfilled;

      // small pause before next batch to avoid hammering
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

async function runFullSyncWatchstates() {
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

    clearDerivedUiCaches();
    status.textContent = "Complete";
    status.className = "status-pill status-ready";
    setMessage(`Full sync complete. Watched rows: ${totals.watched.processed}. Progress rows: ${totals.progress.processed}.`, "success");
  } catch (error) {
    status.textContent = "Error";
    status.className = "status-pill status-error";
    appendFullSyncLog(`ERROR: ${error.message}`);
    setMessage(`Full sync failed: ${error.message}`, "error");
    throw error;
  } finally {
    state.fullSyncActive = false;
    button.disabled = false;
    button.textContent = "Full Sync Watchstates";
  }
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

        // Poll GET /api/force-sync every 2s to read Firestore-buffered log lines
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
              try { finalResult = JSON.parse(line.substring(8)); } catch (_) {}
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
        document.querySelector(".explorer-controls")?.classList.remove("hidden");
      }
      closeMobileMenu();
      selectView(button.dataset.view);
    });
  });

  const hamburgerButton = document.getElementById("hamburgerButton");
  const topnav = document.querySelector(".topnav");
  if (hamburgerButton && topnav) {
    function initMobileMenu() {
      const isMobile = window.innerWidth <= 760;
      if (isMobile) {
        topnav.classList.add("nav-closed");
        topnav.classList.remove("nav-open");
      } else {
        hamburgerButton.classList.remove("active");
        topnav.classList.remove("nav-closed");
        topnav.classList.remove("nav-open");
      }
    }
    initMobileMenu();
    window.addEventListener("resize", initMobileMenu);

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
      .finally(() => renderLogs().catch(() => {}));
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

  elements.lockButton.addEventListener("click", lockDashboard);
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
    const row = e.target.closest(".horizontal-scroll-row, .trailer-scroll-row, .cast-scroll-row");
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
      openEditDateDialog(container, editDateBtn.dataset.editId, editDateBtn.dataset.watchedAt, ({ watched_at }) => {
        editDateBtn.dataset.watchedAt = watched_at;
        const span = container.querySelector(".progress-label-row span");
        if (span) span.textContent = `Watched on ${formatDate(watched_at)}`;
        const entry = state.history.find((h) => h.id === editDateBtn.dataset.editId);
        if (entry) entry.watched_at = watched_at;
      });
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
        }
      }
      openEditImageDialog(container, id, editImageBtn.dataset.posterUrl, tmdbData, ({ poster_url }) => {
        editImageBtn.dataset.posterUrl = poster_url;
        const posterImg = container.querySelector(".immersive-poster-img");
        if (posterImg) posterImg.src = poster_url;
        const backdrop = container.querySelector(".modal-backdrop-image");
        if (backdrop) backdrop.style.backgroundImage = `url('${poster_url}')`;
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
        if (mediaType === "movie") {
          const movie = state.history.find((h) => h.id === fixMatchBtn.dataset.editId);
          if (movie) { movie.tmdb_id = tmdb_id; renderMovieImmersiveModalContent(movie).catch(() => {}); }
        } else if (state.activeShowModalKey) {
          const show = state.showsRaw.find((s) => slug(s.title) === state.activeShowModalKey);
          if (show) { show.tmdb_id = tmdb_id; openShowInlineDetail(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode).catch(() => {}); }
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
      openEditDateDialog(null, id, editDateIconBtn.dataset.watchedAt, ({ watched_at }) => {
        editDateIconBtn.dataset.watchedAt = watched_at;
        // Update the time element this icon is inside
        const timeEl = editDateIconBtn.closest("time");
        if (timeEl) timeEl.innerHTML = `Watched ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        // Also update movie watch status row if present
        const span = editDateIconBtn.closest(".progress-label-row")?.querySelector("span");
        if (span) span.innerHTML = `Watched on ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        const entry = state.history.find((h) => h.id === id);
        if (entry) entry.watched_at = watched_at;
      });
      return;
    }

    const availIssueEl = event.target.closest("[data-avail-issue]");
    if (availIssueEl) {
      showAvailIssuePopup(availIssueEl);
      return;
    }

    const helpLink = event.target.closest("[data-help-topic-link]");
    if (helpLink) {
      openHelpTopic(helpLink.dataset.helpTopicLink);
      return;
    }

    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      copyToClipboard(copyButton.dataset.copy);
      return;
    }

    const watchDateCancel = event.target.closest("[data-watch-date-cancel]");
    if (watchDateCancel) {
      closeWatchDatePrompt();
      return;
    }

    const watchDateChoice = event.target.closest("[data-watch-date-choice]");
    if (watchDateChoice) {
      applyWatchDateChoice(watchDateChoice.dataset.watchDateChoice).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const watchButton = event.target.closest("[data-watch-scope]");
    if (watchButton) {
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
      const isTvRow = event.target.closest("#tvHistoryRow");
      if (isTvRow && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const entry = state.history.find(e => e.id === historyRow.dataset.historyId);
        if (entry) {
          const canonicalShowName = showName(entry.title);
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
        navigateTo(`/movie/${historyRow.dataset.historyId}`);
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
    const user = currentFirebaseUser();
    const text = user ? `Signed in as ${user.username || user.email || "admin"}.` : "Sign in again from the lock screen.";
    const tone = user ? "success" : "error";
    renderAdminCredentialsStatus(text, tone);
    setMessage(text, tone);
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

  elements.plexEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.embyEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.jellyfinEnabled?.addEventListener("change", syncSettingsInputsDisabledState);

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
    state.explorerSearch = elements.globalSearchInput.value.trim();
    if (elements.explorerSearchInput) elements.explorerSearchInput.value = state.explorerSearch;
    selectView("explorer");
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

  elements.globalSearchInput?.addEventListener("focus", () => {
    const query = elements.globalSearchInput.value.trim();
    if (query) renderGlobalSearchDropdown(query);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".global-search")) closeGlobalSearchDropdown();
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
      runFullSyncWatchstates().catch(() => {});
    });
  }

  if (elements.runCronSyncButton) {
    elements.runCronSyncButton.addEventListener("click", () => {
      triggerCronSync().catch(() => {});
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
      triggerForceSync().catch(() => {});
    });
  }

  if (elements.stopSyncButton) {
    elements.stopSyncButton.addEventListener("click", () => {
      triggerStopSync().catch(() => {});
    });
  }

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
    window.clearTimeout(state.dashboardHistoryResizeTimer);
    state.dashboardHistoryResizeTimer = window.setTimeout(() => {
      if (state.activeView === "dashboard") renderDashboard();
    }, 120);
  });

  window.addEventListener("scroll", () => {
    if (state.activeView !== "explorer") return;
    state.explorerScrollArmed = true;
    if (state.posterHydrateScrollScheduled) return;
    state.posterHydrateScrollScheduled = true;
    window.requestAnimationFrame(() => {
      state.posterHydrateScrollScheduled = false;
      hydratePosters(elements.explorerPanel);
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
    handleRouting(window.location.pathname + window.location.hash);
    applyActiveView();
  });

  elements.explorerPosterSize?.addEventListener("input", (e) => {
    const val = e.target.value;
    document.documentElement.style.setProperty("--poster-width", `${val}px`);
    localStorage.setItem(currentPosterWidthKey(), `${val}px`);
  });

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

function initialize() {
  bindElements();
  loadAppVersion();
  bootstrapTokenFromUrl();
  handleRouting(window.location.pathname + window.location.hash);
  attachEvents();
  applyExplorerPosterWidth();
  elements.adminEmail.value = localStorage.getItem("firebaseAdminEmail") || "";
  elements.adminToken.value = "";
  elements.settingsUsername.value = elements.adminEmail.value;
  elements.webhookUrl.textContent = `${window.location.origin}/api/webhook`;
  if (elements.cronSyncUrl) {
    elements.cronSyncUrl.textContent = `${window.location.origin}/api/cron-sync`;
  }
  selectView(state.activeView);
  populateConfigForm({});
  renderDashboard();
  renderActiveSessions();
  renderStats();
  renderExplorer();
  renderHelp();
  renderLogs().catch(() => {});
  renderImportPreview();
  renderWatchBackups();
  renderDbStatus(false);
  renderSettingsStatus("Configuration not loaded yet.");

  onFirebaseAuthChange((user, token) => {
    state.authReady = true;
    state.firebaseUser = user || undefined;
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
      } catch (e) {}

      const fullPath = window.location.pathname + window.location.hash;
      if (fullPath.startsWith("/movie/") || fullPath.startsWith("/tvshow/") || fullPath.startsWith("/person/")) {
        handleRouting(fullPath);
      }
    }
    if (user && token && !state.configLoaded) {
      elements.settingsUsername.value = user.username || user.email || "";
      localStorage.setItem("firebaseAdminEmail", user.email || "");
      setUnlocked(true);
      selectView(state.activeView);
      loadSavedConfig()
        .then(() => {
          if (state.activeView === "dashboard") return loadHistory();
          if (state.activeView === "stats") return loadStats();
          return null;
        })
        .then(() => startHistoryPolling())
        .catch((error) => {
          renderDbStatus(false);
          setMessage(`${error.message} Signed in, but dashboard APIs are not responding yet.`, "error");
        });
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

window.playTrailer = function(el, videoKey, videoName) {
  const container = el.closest('.trailer-scroll-row');
  if (container) {
    container.querySelectorAll('.trailer-thumb-container').forEach(thumbCont => {
      if (thumbCont !== el && thumbCont.querySelector('iframe')) {
        const key = thumbCont.dataset.videoKey;
        const name = thumbCont.dataset.videoName;
        thumbCont.innerHTML = `
          <img class="trailer-thumb" src="https://img.youtube.com/vi/${key}/mqdefault.jpg" alt="${escapeAttribute(name)}" onerror="this.src='/favicon.svg';" />
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
(function() {
  let photos = [];
  let current = 0;
  let scale = 1;
  let lb = null;

  function render() {
    const img = lb.querySelector('.photo-lightbox-img');
    img.src = photos[current];
    scale = 1;
    img.style.transform = '';
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

      // Zoom buttons
      lb.addEventListener('click', (e) => {
        if (e.target.dataset.lbClose !== undefined || e.target === lb) { close(); return; }
        const z = e.target.dataset.lbZoom;
        if (z === undefined) return;
        const img = lb.querySelector('.photo-lightbox-img');
        if (z === '0') scale = 1;
        else if (z === '1') scale = Math.min(scale + 0.5, 5);
        else scale = Math.max(scale - 0.5, 0.5);
        img.style.transform = scale === 1 ? '' : `scale(${scale})`;
      });

      // Wheel zoom
      lb.querySelector('.photo-lightbox-img-wrap').addEventListener('wheel', (e) => {
        e.preventDefault();
        const img = lb.querySelector('.photo-lightbox-img');
        scale = Math.min(5, Math.max(0.5, scale - e.deltaY * 0.001));
        img.style.transform = scale === 1 ? '' : `scale(${scale})`;
      }, { passive: false });

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
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', (e) => {
    if (!lb || lb.style.display === 'none') return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') { current = (current - 1 + photos.length) % photos.length; render(); }
    if (e.key === 'ArrowRight') { current = (current + 1) % photos.length; render(); }
  });

  window.openPhotoLightbox = function(srcs, index) { open(srcs, index); };
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

window.showCastMemberDetails = function(personId, personName) {
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
  document.querySelector(".explorer-controls")?.classList.add("hidden");

  const root = mediaDetailRoot();

  if (elements.explorerTitle) {
    elements.explorerTitle.textContent = personName || "Cast Member Profile";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = "Cast Member Biography and Filmography";
  }

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
    
    const castCredits = (data.combined_credits?.cast || []);
    const profileUrl = tmdbProfile(data.profile_path) || '/favicon.svg';
    
    // Initialize temporary filter/sort preferences on state if not set
    state.personCreditsFilter = state.personCreditsFilter || "all";
    state.personCreditsSort = state.personCreditsSort || "popularity";
    
    root.innerHTML = `
      <div class="person-profile-container" style="padding-top: var(--space-4);">
        <div class="person-profile-sidebar">
          <img class="person-profile-img" src="${escapeAttribute(profileUrl)}" alt="${escapeAttribute(data.name)}" onerror="this.src='/favicon.svg';" />
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
                  <img class="person-photo-thumb" src="${escapeAttribute(tmdbProfile(img.file_path))}" loading="lazy" alt="${escapeAttribute(data.name)}" onclick="window.openPhotoLightbox(window._personPhotos, ${i})" onerror="this.style.display='none';" />
                `).join('')}
              </div>
            </div>`;
          })()}

          <div class="person-credits-section" style="margin-top: 2rem;">
            <div class="person-credits-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-4); border-bottom: 1px solid var(--line-strong); padding-bottom: var(--space-3);">
              <h3 style="margin: 0;">Filmography (<span id="personCreditsCount">${castCredits.length}</span>)</h3>
              <div class="person-credits-controls" style="display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap;">
                <select id="personCreditsFilter" class="field" style="width: auto; min-width: 120px; font-size: 0.85rem; padding: var(--space-1) var(--space-2);">
                  <option value="all" ${state.personCreditsFilter === "all" ? "selected" : ""}>All Media</option>
                  <option value="movie" ${state.personCreditsFilter === "movie" ? "selected" : ""}>Movies</option>
                  <option value="tv" ${state.personCreditsFilter === "tv" ? "selected" : ""}>TV Shows</option>
                </select>
                <select id="personCreditsSort" class="field" style="width: auto; min-width: 150px; font-size: 0.85rem; padding: var(--space-1) var(--space-2);">
                  <option value="popularity" ${state.personCreditsSort === "popularity" ? "selected" : ""}>Popularity</option>
                  <option value="date_desc" ${state.personCreditsSort === "date_desc" ? "selected" : ""}>Date (Newest)</option>
                  <option value="date_asc" ${state.personCreditsSort === "date_asc" ? "selected" : ""}>Date (Oldest)</option>
                </select>
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

    const filterSelect = root.querySelector("#personCreditsFilter");
    const sortSelect = root.querySelector("#personCreditsSort");
    const gridEl = root.querySelector("#personCreditsGrid");
    const countEl = root.querySelector("#personCreditsCount");

    const updateGrid = () => {
      state.personCreditsFilter = filterSelect.value;
      state.personCreditsSort = sortSelect.value;
      
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

      const libraryTvCredits = [];
      if (filtered.length === 0) {
        gridEl.innerHTML = `<p class="muted-copy" style="grid-column: 1 / -1; text-align: center; padding: 2rem 0;">No matching filmography items found.</p>`;
      } else {
        gridEl.innerHTML = filtered.map(credit => {
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

          // "In Library" = on a media server. "Watched" = in watch history but not on a server.
          // The server provides credit.in_library / credit.in_watch_history as authoritative signals.
          // findLibraryItem may also find items via the local watched-movies lookup — those are
          // watched but not necessarily server-sourced, so we rely on credit.in_library for the badge.
          const isInLibrary = !!credit.in_library;
          const isWatched = !!(credit.in_watch_history || credit.in_library ||
            (!isTv && filmographyLookup.allWatchedMovies.some(m => String(m.tmdb_id||"")=== String(credit.id))) ||
            (isTv && filmographyLookup.allWatchedShows.some(s => String(s.tmdb_id||"")=== String(credit.id))));
          
          if (libItem && isInLibrary) {
            // In Library card: item is physically on a media server
            const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
            const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
            if (isTv) libraryTvCredits.push({ credit, libItem, title });
            const href = libItem.type === "tvshow" ? `/tvshow/${libItem.key}` : `/movie/${libItem.id}`;
            return `
              <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
                <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" onerror="this.src='/favicon.svg';" />
                <div class="person-credit-info">
                  <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                  <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
                  <span class="person-credit-year">${isTv ? 'TV Show' : 'Movie'}</span>
                </div>
                <span class="person-credit-badges">
                  <span class="library-badge">In Library</span>
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </a>
            `;
          } else if (libItem && isWatched) {
            // Watched card: item is in watch history but NOT on a media server
            const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
            const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
            if (isTv) libraryTvCredits.push({ credit, libItem, title });
            const href = libItem.type === "tvshow" ? `/tvshow/${libItem.key}` : `/movie/${libItem.id}`;
            return `
              <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
                <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" onerror="this.src='/favicon.svg';" />
                <div class="person-credit-info">
                  <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                  <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
                  <span class="person-credit-year">${isTv ? 'TV Show' : 'Movie'}</span>
                </div>
                <span class="person-credit-badges">
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </a>
            `;
          } else {
            const href = isTv ? `/tvshow/tmdb/${credit.id}` : `/movie/tmdb/${credit.id}`;
            return `
              <a class="person-credit-card" href="${escapeAttribute(href)}" data-tmdb-id="${credit.id}" data-tmdb-media-type="${credit.media_type}" data-tmdb-title="${escapeAttribute(title)}">
                <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" onerror="this.src='/favicon.svg';" />
                <div class="person-credit-info">
                  <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                  <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
                  <span class="person-credit-year">${isTv ? 'TV Show' : 'Movie'}</span>
                </div>
              </a>
            `;
          }
        }).join("");
      }

      if (libraryTvCredits.length > 0) {
        hydratePersonFilmographyWatchStatuses(personId, libraryTvCredits);
      }
    };

    filterSelect?.addEventListener("change", updateGrid);
    sortSelect?.addEventListener("change", updateGrid);

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

window.openLibraryItem = function(mediaType, idOrKey, title, isLibraryItem = true, tmdbId = null) {
  const modal = elements.personModal;
  if (modal) modal.classList.add("hidden");
  
  if (isLibraryItem) {
    if (mediaType === "show" || mediaType === "tv") {
      navigateTo(`/tvshow/${idOrKey}`);
    } else if (mediaType === "movie") {
      navigateTo(`/movie/${idOrKey}`);
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

  const tmdbData = await fetchTmdbDetails("tv", tmdbId, null);
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

