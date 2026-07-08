import { readStoredAdminToken } from "./auth.js";
import { readStoredDebugLogs } from "./logs.js";

const TOKEN_KEY = "adminToken";
const LEGACY_UPPER_TOKEN_KEY = "ADMIN_TOKEN";
const LEGACY_TOKEN_KEY = "sync_admin_token";

export const ACTIVE_VIEW_KEY = "history_active_view";
export const ACTIVE_SETTINGS_TAB_KEY = "history_active_settings_tab";
export const EXPLORER_SORT_KEY_MOVIES = "plembfin:explorerSort:movies";
export const EXPLORER_SORT_KEY_SHOWS = "plembfin:explorerSort:shows";
export const EXPLORER_VIEW_KEY_MOVIES = "plembfin:explorerView:movies";
export const EXPLORER_VIEW_KEY_SHOWS = "plembfin:explorerView:shows";
export const HIDE_WATCHED_KEY_SHOWS = "plembfin:hideWatched:shows";
export const HIDE_ENDED_KEY_SHOWS = "plembfin:hideEnded:shows";
export const HISTORY_VIEW_KEY = "plembfin:historyView";
export const HISTORY_FILTER_KEY = "plembfin:historyFilter";
export const HISTORY_VIEW_MODES = ["grid", "list", "cards"];
export const HISTORY_FILTERS = ["all", "movies", "shows"];
export const DASHBOARD_HISTORY_VIEW_KEY = "plembfin:dashboardHistoryView";
export const DASHBOARD_HISTORY_VIEW_MODES = ["cards", "posters"];
export const PRIMARY_VIEWS = ["dashboard", "stats", "explorer", "upcoming", "settings", "help", "search", "history"];
export const SETTINGS_TABS = ["general", "apps", "api-keys", "tools", "backups", "sync", "logs", "changelog", "cache"];

function _startOfWeek(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return _startOfWeek(new Date());
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date;
}

export const state = {
  token: readStoredAdminToken([TOKEN_KEY, LEGACY_UPPER_TOKEN_KEY, LEGACY_TOKEN_KEY]),
  authReady: false,
  mustChangePassword: false,
  currentUser: undefined,
  activeView: localStorage.getItem(ACTIVE_VIEW_KEY) || "dashboard",
  activeSettingsTab: localStorage.getItem(ACTIVE_SETTINGS_TAB_KEY) || "general",
  activeBackupsTab: localStorage.getItem("activeBackupsTab") || "settings",
  remoteBackupFiles: [],
  remoteBackupFilesLoading: false,
  historyWeekStart: _startOfWeek(new Date()),
  history: [],
  historyVersion: "",
  historyLoadPromise: null,
  dashboardHistoryFilter: "all",
  dashboardHistoryViewMode: DASHBOARD_HISTORY_VIEW_MODES.includes(localStorage.getItem(DASHBOARD_HISTORY_VIEW_KEY)) ? localStorage.getItem(DASHBOARD_HISTORY_VIEW_KEY) : "cards",
  dashboardHistoryResizeTimer: undefined,
  activeSessions: [],
  syncJobs: [],
  syncJobsLoaded: false,
  syncJobsLoading: false,
  syncHistory: [],
  syncHistoryLoaded: false,
  syncHistoryLoading: false,
  changelog: null,
  savedConfig: {},
  stats: {
    totalWatches: 0,
    uniqueMoviesLogged: 0,
    totalTvEpisodesTracked: 0,
    sourceBreakdown: [],
    topShows: [],
    monthlyActivity: [],
    reports: { all: null, years: [], months: [] },
  },
  statsMediaFilter: "all",
  statsPeriodType: "all",
  statsPeriodValue: "all",
  statsLoaded: false,
  statsLoading: false,
  upcomingMonth: "",
  upcomingByMonth: new Map(),
  upcomingLoadingMonth: "",
  upcomingSearch: "",
  upcomingSearchLoading: false,
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
  hideWatchedShows: localStorage.getItem(HIDE_WATCHED_KEY_SHOWS) === "true",
  hideEndedShows: localStorage.getItem(HIDE_ENDED_KEY_SHOWS) === "true",
  partWatchedRaw: [],
  partWatchedOffset: 0,
  partWatchedHasMore: true,
  partWatchedLoading: false,
  partWatchedQueryKey: "",
  explorerViewMovies: localStorage.getItem(EXPLORER_VIEW_KEY_MOVIES) || "posters",
  explorerViewShows: localStorage.getItem(EXPLORER_VIEW_KEY_SHOWS) || "posters",
  posterLookupCache: new Map(),
  posterLookupInflight: new Map(),
  tmdbDetailsCache: new Map(),
  tmdbSeasonCache: new Map(),
  globalDiscoveryResults: new Map(),
  globalSearchRequestToken: 0,
  searchQuery: "",
  searchFilter: "all",
  searchResults: [],
  searchLoading: false,
  globalSearchRemoteTimer: undefined,
  explorerPageCache: new Map(),
  explorerLoadObserver: undefined,
  dashboardPosterObserver: undefined,
  explorerScrollArmed: false,
  posterHydrateScrollScheduled: false,
  historyViewSearch: "",
  historyViewMode: HISTORY_VIEW_MODES.includes(localStorage.getItem(HISTORY_VIEW_KEY)) ? localStorage.getItem(HISTORY_VIEW_KEY) : "cards",
  historyViewFilter: HISTORY_FILTERS.includes(localStorage.getItem(HISTORY_FILTER_KEY)) ? localStorage.getItem(HISTORY_FILTER_KEY) : "all",
  historyViewSearchTimer: undefined,
  historyViewRaw: [],
  historyViewOffset: 0,
  historyViewHasMore: true,
  historyViewLoading: false,
  historyViewLoadObserver: undefined,
  historyViewScrollArmed: false,
  expandedShows: new Set(),
  expandedSeasons: new Set(),
  activeShowModalKey: null,
  activeShowTmdbId: null,
  activeShowModalSeason: null,
  activeShowModalEpisode: null,
  showModalAllSeasonsExpanded: false,
  showModalRequestToken: 0,
  showModalEpisodes: [],
  showModalEpisodeIndex: new Map(),
  activeShowRenderContext: null,
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
  seerrConfigured: false,
  seerrSupports4k: { movie: false, tv: false },
  seerrMediaStatusCache: new Map(),
  fullSyncActive: false,
  backupImport: null,
  watchBackups: null,
  watchBackupsLoading: false,
  cacheStats: null,
  cacheStatsLoading: false,
  internalHistoryCount: history.state?.index || 0,
};

export const elements = {};
