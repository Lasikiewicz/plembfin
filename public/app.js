import { buildAuthHeaders, buildNowPlayingUrl, currentFirebaseUser, onFirebaseAuthChange, readStoredAdminToken, scrubTokenFromLocation, signInAdmin, signOutAdmin } from "./modules/auth.js";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs } from "./modules/logs.js";
import { connectionLabel, connectionPayloadFromElements } from "./modules/settings.js";
import { fetchLocalActiveSessions } from "./modules/timeline.js";

const TOKEN_KEY = "adminToken";
const LEGACY_UPPER_TOKEN_KEY = "ADMIN_TOKEN";
const LEGACY_TOKEN_KEY = "sync_admin_token";
const ACTIVE_VIEW_KEY = "history_active_view";
const ACTIVE_SETTINGS_TAB_KEY = "history_active_settings_tab";
const IMPORT_BATCH_SIZE = 100;
const IMPORT_MAX_ATTEMPTS = 4;
const IMPORT_RETRY_BASE_MS = 1500;
const NOW_PLAYING_POLL_MS = 5000;
const POSTER_LOOKUP_CONCURRENCY = 4;
const TMDB_POSTER_SIZE = "w342";
const HISTORY_PREVIEW_LIMIT = 6;
const EXPLORER_PAGE_SIZE = 6;
const EXPLORER_CACHE_TTL_MS = 2 * 60 * 1000;
const PRIMARY_VIEWS = ["dashboard", "stats", "explorer", "settings", "help", "logs"];
const SETTINGS_TABS = ["general", "apps", "importer", "complete-check", "tools"];

const state = {
  token: readStoredAdminToken([TOKEN_KEY, LEGACY_UPPER_TOKEN_KEY, LEGACY_TOKEN_KEY]),
  authReady: false,
  firebaseUser: undefined,
  activeView: localStorage.getItem(ACTIVE_VIEW_KEY) || "dashboard",
  activeSettingsTab: localStorage.getItem(ACTIVE_SETTINGS_TAB_KEY) || "general",
  historyWeekStart: startOfWeek(new Date()),
  history: [],
  activeSessions: [],
  savedConfig: {},
  stats: {
    totalWatches: 0,
    uniqueMoviesLogged: 0,
    totalTvEpisodesTracked: 0,
    sourceBreakdown: [],
    topShows: [],
    monthlyActivity: [],
  },
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
  explorerSort: "watched_desc",
  posterLookupCache: new Map(),
  posterLookupInflight: new Map(),
  explorerPageCache: new Map(),
  explorerLoadObserver: undefined,
  expandedShows: new Set(),
  expandedSeasons: new Set(),
  activeHelpTopic: "settings",
  importRecords: [],
  importFileNames: [],
  importLogs: ["[idle] Waiting for files."],
  importProgressValue: 0,
  importActive: false,
  debugLogs: readStoredDebugLogs(),
  nowPlayingInterval: undefined,
  nowPlayingRequestActive: false,
  nowPlayingRefreshToken: "",
  configLoaded: false,
};

const elements = {};

function bindElements() {
  Object.assign(elements, {
    appShell: document.querySelector("#appShell"),
    authForm: document.querySelector("#authForm"),
    authPanel: document.querySelector("#authPanel"),
    adminToken: document.querySelector("#adminToken"),
    adminEmail: document.querySelector("#adminEmail"),
    clearImportButton: document.querySelector("#clearImportButton"),
    closeModalButton: document.querySelector("#closeModalButton"),
    copyToast: document.querySelector("#copyToast"),
    clearLogsButton: document.querySelector("#clearLogsButton"),
    copyLogsButton: document.querySelector("#copyLogsButton"),
    dbStatus: document.querySelector("#dbStatus"),
    debugModal: document.querySelector("#debugModal"),
    explorerPanel: document.querySelector("#explorerPanel"),
    explorerSearchInput: document.querySelector("#explorerSearchInput"),
    explorerSort: document.querySelector("#explorerSort"),
    helpCanvas: document.querySelector("#helpCanvas"),
    helpMenu: document.querySelector("#helpMenu"),
    historyTable: document.querySelector("#historyTable"),
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
    plexServerUrl: document.querySelector("#plexServerUrl"),
    plexToken: document.querySelector("#plexToken"),
    plexUsername: document.querySelector("#plexUsername"),
    tmdbApiKey: document.querySelector("#tmdbApiKey"),
    embyServerUrl: document.querySelector("#embyServerUrl"),
    embyApiKey: document.querySelector("#embyApiKey"),
    embyUserId: document.querySelector("#embyUserId"),
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
    settingsToken: document.querySelector("#settingsToken"),
    settingsForm: document.querySelector("#settingsForm"),
    settingsStatus: document.querySelector("#settingsStatus"),
    settingsTabButtons: [...document.querySelectorAll("[data-settings-tab]")],
    settingsPanels: [...document.querySelectorAll("[data-settings-panel]")],
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
    updateTokenButton: document.querySelector("#updateTokenButton"),
    webhookUrl: document.querySelector("#webhookUrl"),
    runCompleteCheckButton: document.querySelector("#runCompleteCheckButton"),
    completeCheckResults: document.querySelector("#completeCheckResults"),
    testConnectionButtons: [...document.querySelectorAll("[data-test-connection]")],
    testConnectionStatuses: [...document.querySelectorAll("[data-test-status]")],
    tabButtons: [...document.querySelectorAll("[data-view]")],
    explorerButtons: [...document.querySelectorAll("[data-explorer-mode]")],
    viewPanels: [...document.querySelectorAll("[data-view-panel]")],
  });
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function logDebug(message, details) {
  state.debugLogs = appendDebugLog(state.debugLogs, message, details);
  renderLogs();
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

function safeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return /^https?:\/\//i.test(raw) ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function compactPosterUrl(value) {
  const url = safeImageUrl(value);
  if (!url) return "";
  return url.replace(/(https:\/\/image\.tmdb\.org\/t\/p\/)original\//i, `$1${TMDB_POSTER_SIZE}/`);
}

function cachedExplorerPage(key) {
  const cached = state.explorerPageCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.savedAt > EXPLORER_CACHE_TTL_MS) {
    state.explorerPageCache.delete(key);
    return null;
  }
  return cached.body;
}

function rememberExplorerPage(key, body) {
  state.explorerPageCache.set(key, { savedAt: Date.now(), body });
  if (state.explorerPageCache.size > 40) {
    const oldestKey = state.explorerPageCache.keys().next().value;
    state.explorerPageCache.delete(oldestKey);
  }
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
    return url.toString();
  } catch (error) {
    return "";
  }
}

function posterUrlFor(item = {}) {
  const cachedUrl = item.id != null ? state.posterLookupCache.get(String(item.id)) : "";
  if (cachedUrl) return cachedUrl;
  const raw = item.poster_url || item.posterUrl || item.imageUrl || item.thumb || "";
  return compactPosterUrl(raw) || configuredImageUrl(raw, item);
}

function posterMarkup(item = {}, className = "media-poster") {
  const url = posterUrlFor(item);
  const label = item.title || "Media poster";
  const posterId = item.id != null ? ` data-poster-id="${escapeAttribute(String(item.id))}"` : "";
  if (!url) return `<span class="${className} poster-fallback"${posterId} aria-hidden="true"></span>`;
  return `<img class="${className}"${posterId} src="${escapeAttribute(url)}" alt="${escapeAttribute(label)} poster" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
}

async function hydratePosterFallbacks(container = document.body) {
  if (!container) return;
  const fallbacks = [...container.querySelectorAll("[data-poster-id].poster-fallback")].filter((fallback) => {
    const posterId = fallback.dataset.posterId;
    return posterId && !state.posterLookupCache.has(posterId);
  });
  if (!fallbacks.length) return;

  const hydrateOne = async (fallback) => {
    const posterId = fallback.dataset.posterId;
    if (!posterId || state.posterLookupCache.has(posterId)) return;

    let lookup = state.posterLookupInflight.get(posterId);
    if (!lookup) {
      lookup = fetch(`/api/poster?id=${encodeURIComponent(posterId)}`, { headers: authHeaders() })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.url) return "";
          return compactPosterUrl(body.url);
        })
        .catch(() => "")
        .finally(() => state.posterLookupInflight.delete(posterId));
      state.posterLookupInflight.set(posterId, lookup);
    }

    const posterUrl = await lookup;
    state.posterLookupCache.set(posterId, posterUrl || null);
    if (!posterUrl || !fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

    const image = document.createElement("img");
    image.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
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

function adminTokenGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>Firebase Auth Admin Sign-In</b>
      <p><b>What it is:</b> The email/password account created in Firebase Authentication and allowlisted through <code>ADMIN_EMAILS</code> or <code>ADMIN_UIDS</code>.</p>
      <ol>
        <li>Open the Firebase console and select the Plembfin Firebase project.</li>
        <li>Enable <b>Email/Password</b> in Firebase Authentication sign-in providers.</li>
        <li>Create the admin user account.</li>
        <li>Set the Functions runtime variable <code>ADMIN_EMAILS</code> to that email address.</li>
        <li>Use that email and password to sign in to this dashboard.</li>
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
        {
          id: "settings",
          category: "Configuration",
          title: "Settings Page",
          badges: ["FIREBASE_AUTH", "PLEX_URL", "EMBY_API_KEY", "JELLYFIN_API_KEY"],
          body: () => `
            <p>The Settings view is the control center for all server credentials and operational endpoints. It stores the Plex, Emby, and Jellyfin connection details used by the backend worker, exposes the webhook listener, and shows the web-cron trigger that can keep the cache synchronized even when the dashboard is closed.</p>
            <p>When values are saved here, the Help badges become green and reveal a quick copy action. That lets you move between tabs without retyping hostnames, API keys, or user identifiers.</p>
            ${adminTokenGuide()}
            ${plexCredentialGuide()}
            ${embyCredentialGuide()}
            ${jellyfinCredentialGuide()}
            ${webhookWarning()}
            <ol>
              <li>Sign in with your Firebase Auth admin account.</li>
              <li>Fill the Plex, Emby, and Jellyfin input cards.</li>
              <li>Click <b>Save Configuration</b> to commit the data.</li>
              <li>Reload the page to confirm the fields repopulate automatically.</li>
            </ol>
          `,
        },
        {
          id: "webhooks",
          category: "Operations",
          title: "Webhook and Cron Sync",
          badges: ["FIREBASE_AUTH"],
          body: () => {
            const url = `${window.location.origin}/api/webhook`;
            return `
              <p>Plembfin uses a combination of direct webhooks and a scheduled background worker to keep your watch states in sync:</p>
              <ul>
                <li><b>Webhook Listener:</b> Point your media servers at this URL for immediate, real-time tracking. It processes playback sessions and instant play/unplay updates, committing them to your database and coordinating immediate propagation to the other platforms.</li>
                <li><b>Scheduled Worker:</b> Firebase runs the backend background worker every minute. It polls active playback sessions, commits completed watches, and runs the Plex unwatched check even when the dashboard is closed.</li>
              </ul>
              <p>Resume progress sync uses stop/progress payloads below 90% watched. Plembfin stores the last resume point, ignores tiny positions under one minute, and pushes that position to the other two platforms so the same movie or episode can continue from the last stopped point.</p>
              <p>Your unique Webhook URL is:</p>
              ${snippet(url, "url")}
              ${cronSyncGuide()}
              ${webhookWarning()}
            `;
          },
        },
        {
          id: "export-plex-history",
          category: "Local Utilities",
          title: "scripts/exportPlexHistory.js",
          badges: ["PLEX_URL", "PLEX_TOKEN", "FIREBASE_AUTH"],
          body: () => exportPlexHistoryGuide(),
        },
        {
          id: "force-push-history",
          category: "Local Utilities",
          title: "scripts/forcePushHistory.js",
          badges: ["EMBY_API_KEY", "EMBY_USER_ID", "JELLYFIN_API_KEY", "JELLYFIN_USER_ID"],
          body: () => forcePushHistoryGuide(),
        },
        {
          id: "plex",
          category: "Credentials",
          title: "Plex Setup",
          badges: ["PLEX_URL", "PLEX_TOKEN"],
          body: () => `${plexCredentialGuide()}${webhookWarning()}`,
        },
        {
          id: "emby",
          category: "Credentials",
          title: "Emby Setup",
          badges: ["EMBY_API_KEY", "EMBY_USER_ID"],
          body: () => `${embyCredentialGuide()}${webhookWarning()}`,
        },
        {
          id: "jellyfin",
          category: "Credentials",
          title: "Jellyfin Setup",
          badges: ["JELLYFIN_API_KEY", "JELLYFIN_USER_ID"],
          body: () => `${jellyfinCredentialGuide()}${webhookWarning()}`,
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
  elements.statusPill.className = `session-dot ${isUnlocked ? "unlocked" : "locked"}`;
  elements.statusPill.setAttribute("aria-label", isUnlocked ? "Unlocked session" : "Locked session");
  elements.statusPill.title = isUnlocked ? "Unlocked" : "Locked";
}

function selectView(view) {
  const legacyImporterView = view === "importer";
  const requestedView = legacyImporterView ? "settings" : view;
  state.activeView = PRIMARY_VIEWS.includes(requestedView) ? requestedView : "dashboard";
  localStorage.setItem(ACTIVE_VIEW_KEY, state.activeView);
  if (legacyImporterView) selectSettingsTab("importer");

  for (const button of elements.tabButtons) {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  }

  for (const panel of elements.viewPanels) {
    panel.classList.toggle("hidden", panel.dataset.viewPanel !== state.activeView);
  }

  if (state.activeView === "help") renderHelp();
  if (state.activeView === "stats") renderStats();
  if (state.activeView === "explorer") renderExplorer();
  if (state.activeView !== "explorer") {
    state.explorerLoadObserver?.disconnect();
    state.explorerLoadObserver = undefined;
  }
  if (state.activeView === "logs") renderLogs();
  if (state.activeView === "settings") selectSettingsTab(state.activeSettingsTab);
  if (state.activeView === "settings" && state.configLoaded) {
    renderSettingsStatus("Configuration ready.", "success");
  }
  if (state.token) {
    syncNowPlayingPolling();
  }
}

function selectSettingsTab(tab) {
  state.activeSettingsTab = SETTINGS_TABS.includes(tab) ? tab : "general";
  localStorage.setItem(ACTIVE_SETTINGS_TAB_KEY, state.activeSettingsTab);

  for (const button of elements.settingsTabButtons || []) {
    button.classList.toggle("active", button.dataset.settingsTab === state.activeSettingsTab);
  }

  for (const panel of elements.settingsPanels || []) {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
  }
}

function configFromInputs() {
  return {
    plex: {
      baseUrl: elements.plexServerUrl.value.trim(),
      token: elements.plexToken.value.trim(),
      username: elements.plexUsername.value.trim(),
    },
    tmdb: {
      apiKey: elements.tmdbApiKey?.value.trim() || "",
    },
    emby: {
      baseUrl: elements.embyServerUrl.value.trim(),
      apiKey: elements.embyApiKey.value.trim(),
      userId: elements.embyUserId.value.trim(),
    },
    jellyfin: {
      baseUrl: elements.jellyfinServerUrl.value.trim(),
      apiKey: elements.jellyfinApiKey.value.trim(),
      userId: elements.jellyfinUserId.value.trim(),
    },
  };
}

function populateConfigForm(config = {}) {
  elements.plexServerUrl.value = config.plex?.baseUrl || config.plex?.url || "";
  elements.plexToken.value = config.plex?.token || config.plex?.apiKey || "";
  elements.plexUsername.value = config.plex?.username || "";
  elements.embyServerUrl.value = config.emby?.baseUrl || config.emby?.url || "";
  elements.embyApiKey.value = config.emby?.apiKey || config.emby?.api_key || "";
  elements.embyUserId.value = config.emby?.userId || "";
  elements.jellyfinServerUrl.value = config.jellyfin?.baseUrl || config.jellyfin?.url || "";
  elements.tmdbApiKey.value = config.tmdb?.apiKey || "";
  elements.jellyfinApiKey.value = config.jellyfin?.apiKey || config.jellyfin?.api_key || "";
  elements.jellyfinUserId.value = config.jellyfin?.userId || "";
}

function renderSettingsStatus(text, tone = "muted") {
  if (!elements.settingsStatus) return;
  elements.settingsStatus.textContent = text;
  elements.settingsStatus.dataset.tone = tone;
}

async function loadSavedConfig() {
  const response = await fetch("/api/config", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Config load failed with ${response.status}`);

  state.savedConfig = body.config || {};
  state.lastCron = body.lastCron;
  state.lastWebhook = body.lastWebhook;
  populateConfigForm(body.config || {});
  state.configLoaded = true;
  renderSettingsStatus("Configuration loaded from Firestore.", "success");
  renderDashboard();
  renderActiveSessions();
  refreshHelpIfVisible();
  return body.config || {};
}

async function saveSavedConfig() {
  const config = configFromInputs();
  const response = await fetch("/api/config", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Config save failed with ${response.status}`);

  state.savedConfig = config;
  state.configLoaded = true;
  renderSettingsStatus("Configuration saved.", "success");
  renderDashboard();
  renderActiveSessions();
  refreshHelpIfVisible();
  setMessage("Configuration saved.", "success");
  return body;
}

async function loadHistory() {
  const url = new URL("/api/history", window.location.origin);
  url.searchParams.set("limit", String(HISTORY_PREVIEW_LIMIT));

  const response = await fetch(url, { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `History load failed with ${response.status}`);

  state.history = Array.isArray(body.history) ? body.history : [];
  state.stats = body.stats || state.stats;
  renderDashboard();
  renderStats();
  if (state.activeView === "explorer") renderExplorer();
  renderDbStatus(true);
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
    state.activeSessions = [];
    renderActiveSessions();
    return [];
  }
  if (!response.ok) {
    const message = `Now playing failed with HTTP ${response.status}`;
    logDebug(message, body);
    state.activeSessions = [];
    renderActiveSessions();
    return [];
  }

  const refreshToken = response.headers.get("X-Now-Playing-Refresh") || "";
  let sessions = Array.isArray(body) ? body : Array.isArray(body.sessions) ? body.sessions : [];
  logDebug(`Now-playing payload parsed successfully. Active sessions: ${sessions.length}`, sessions);

  if (!sessions.length) {
    logDebug("Firebase now-playing cache returned zero sessions. Starting direct browser local network fallback probes.");
    const localSessions = await fetchLocalActiveSessions(configFromInputs(), logDebug);
    if (localSessions.length) {
      sessions = localSessions;
      logDebug(`Hybrid local fallback returned ${localSessions.length} active sessions.`, localSessions);
    } else {
      logDebug("Hybrid local fallback returned zero active sessions.");
    }
  }

  const refreshChanged = Boolean(refreshToken && refreshToken !== state.nowPlayingRefreshToken);

  state.activeSessions = sessions;
  state.nowPlayingRefreshToken = refreshToken || state.nowPlayingRefreshToken;
  renderActiveSessions();

  if (refreshChanged) {
    loadHistory().catch((error) => setMessage(error.message, "error"));
  }

  return sessions;
}

function startHistoryPolling() {
  stopHistoryPolling();
  if (!state.token || state.activeView !== "dashboard") return;

  logDebug(`Starting Now Playing background polling loop at ${Math.round(NOW_PLAYING_POLL_MS / 1000)} second cadence.`);
  loadActiveSessions().catch((error) => setMessage(error.message, "error"));
  state.nowPlayingInterval = window.setInterval(() => {
    if (state.activeView !== "dashboard" || !state.token) {
      stopHistoryPolling();
      return;
    }

    loadActiveSessions().catch((error) => setMessage(error.message, "error"));
  }, NOW_PLAYING_POLL_MS);
}

function stopHistoryPolling() {
  if (!state.nowPlayingInterval) return;
  window.clearInterval(state.nowPlayingInterval);
  state.nowPlayingInterval = undefined;
  logDebug("Stopped Now Playing background polling loop.");
}

function syncNowPlayingPolling() {
  if (state.activeView === "dashboard") {
    startHistoryPolling();
    return;
  }

  stopHistoryPolling();
}

function renderDashboard() {
  if (!state.history.length) {
    elements.historyTable.innerHTML = `
      <div class="empty-log">
        <b>No watch history yet</b>
        <span>Import a Trakt export or send watched webhooks to start building the archive.</span>
      </div>
    `;
    return;
  }

  const recent = state.history.slice(0, HISTORY_PREVIEW_LIMIT);
  elements.historyTable.innerHTML = `
    <div class="movie-grid">
      ${recent
        .map(
          (entry) => `
            <button class="movie-card" type="button" data-history-id="${entry.id}">
              ${posterMarkup(entry, "movie-poster")}
              <div class="movie-card-body">
                <b>${escapeHtml(entry.title)}</b>
                <span>${formatDate(entry.watched_at)}</span>
                <small>${escapeHtml(idLine(entry))}</small>
              </div>
            </button>
          `,
        )
        .join("")}
    </div>
  `;
  hydratePosterFallbacks(elements.historyTable).catch(() => {});
}

function renderActiveSessions() {
  if (!elements.nowPlayingGrid) return;

  if (!state.activeSessions.length) {
    elements.nowPlayingGrid.innerHTML = `
      <div class="idle-state">
        <b>Entire media ecosystem is idle.</b>
      </div>
    `;
    if (elements.nowPlayingStatus) elements.nowPlayingStatus.textContent = `${Math.round(NOW_PLAYING_POLL_MS / 1000)}s polling`;
    return;
  }

  elements.nowPlayingGrid.innerHTML = state.activeSessions
    .map((session) => {
      const progress = Math.max(0, Math.min(100, Number(session.progress ?? computeProgress(session.offsetMs, session.durationMs))));
      return `
        <article class="now-card-large live-now-card">
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
        </article>
      `;
    })
    .join("");

  if (elements.nowPlayingStatus) {
    elements.nowPlayingStatus.textContent = `${Math.round(NOW_PLAYING_POLL_MS / 1000)}s polling`;
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDateShort(date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" }).format(date);
}

function renderStats() {
  if (elements.totalWatches) elements.totalWatches.textContent = formatNumber(state.stats.totalWatches || 0);
  if (elements.totalMovies) elements.totalMovies.textContent = formatNumber(state.stats.uniqueMoviesLogged || 0);
  if (elements.totalEpisodes) elements.totalEpisodes.textContent = formatNumber(state.stats.totalTvEpisodesTracked || 0);

  if (elements.topPlatform) {
    const platform = state.stats.topSource || "None";
    elements.topPlatform.textContent = platformName(platform);
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

function renderExplorer() {
  for (const button of elements.explorerButtons) {
    button.classList.toggle("active", button.dataset.explorerMode === state.explorerMode);
  }
  if (elements.explorerSort) {
    elements.explorerSort.value = state.explorerSort;
  }

  const search = elements.explorerSearchInput ? elements.explorerSearchInput.value.trim() : state.explorerSearch;
  state.explorerSearch = search;

  if (state.explorerMode === "movies") {
    renderMovieExplorer();
    return;
  }

  renderShowExplorer();
}

function explorerQueryKey(mode) {
  return [mode, state.explorerSort, state.explorerSearch].join("|");
}

function resetMovieExplorer(key = explorerQueryKey("movies")) {
  state.moviesRaw = [];
  state.moviesOffset = 0;
  state.moviesHasMore = true;
  state.moviesLoading = false;
  state.moviesQueryKey = key;
}

function resetShowExplorer(key = explorerQueryKey("shows")) {
  state.showsRaw = [];
  state.showsOffset = 0;
  state.showsHasMore = true;
  state.showsLoading = false;
  state.showsQueryKey = key;
}

function renderExplorerSentinel(mode, hasMore, loading) {
  if (!hasMore && !loading) return "";
  return `
    <div class="explorer-scroll-sentinel" data-explorer-sentinel="${mode}" aria-live="polite">
      <span>${loading ? "Loading..." : "Scroll for more"}</span>
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
      if (mode === "movies") loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
      if (mode === "shows") loadExplorerShows().catch((error) => setMessage(error.message, "error"));
    },
    { rootMargin: "900px 0px 900px 0px" },
  );
  state.explorerLoadObserver.observe(sentinel);
}

function renderMovieCard(movie) {
  return `
    <button class="movie-card" type="button" data-history-id="${movie.id}">
      ${posterMarkup(movie, "movie-poster")}
      <div class="movie-card-body">
        <b>${escapeHtml(movie.title)}</b>
        <span>${formatDate(movie.watched_at)}</span>
        <small>${escapeHtml(idLine(movie))}</small>
      </div>
    </button>
  `;
}

function renderMovieExplorer() {
  const key = explorerQueryKey("movies");
  if (state.moviesQueryKey !== key) resetMovieExplorer(key);

  if (!state.moviesRaw.length && state.moviesHasMore && !state.moviesLoading && state.token) {
    loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
  }

  if (!state.moviesRaw.length && state.moviesLoading) {
    elements.explorerPanel.innerHTML = emptyExplorer("Loading movies...");
    return;
  }

  elements.explorerPanel.innerHTML = state.moviesRaw.length
    ? `<div class="movie-grid">${state.moviesRaw.map(renderMovieCard).join("")}</div>${renderExplorerSentinel("movies", state.moviesHasMore, state.moviesLoading)}`
    : emptyExplorer("No movies logged yet");
  hydratePosterFallbacks(elements.explorerPanel).catch(() => {});
  observeExplorerSentinel("movies");
}

async function loadExplorerMovies() {
  if (state.moviesLoading || !state.moviesHasMore) return;
  state.moviesLoading = true;
  renderMovieExplorer();

  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.moviesOffset));
    url.searchParams.set("sort", state.explorerSort);
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);

    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    if (!body) {
      const res = await fetch(url, { headers: authHeaders(), cache: "force-cache" });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Movies load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }

    const movies = Array.isArray(body.movies) ? body.movies : [];
    state.moviesRaw = [...state.moviesRaw, ...movies];
    state.moviesOffset += movies.length;
    state.moviesHasMore = movies.length === EXPLORER_PAGE_SIZE;
  } finally {
    state.moviesLoading = false;
    renderMovieExplorer();
  }
}

function renderShowExplorer() {
  const key = explorerQueryKey("shows");
  if (state.showsQueryKey !== key) resetShowExplorer(key);

  if (!state.showsRaw.length && state.showsHasMore && !state.showsLoading && state.token) {
    loadExplorerShows().catch((error) => setMessage(error.message, "error"));
  }

  if (!state.showsRaw.length && state.showsLoading) {
    elements.explorerPanel.innerHTML = emptyExplorer("Loading TV shows...");
    return;
  }

  elements.explorerPanel.innerHTML = state.showsRaw.length
    ? `<div class="movie-grid explorer-show-grid">${state.showsRaw.map(renderShowRecord).join("")}</div>${renderExplorerSentinel("shows", state.showsHasMore, state.showsLoading)}`
    : emptyExplorer("No TV episodes logged yet");
  hydratePosterFallbacks(elements.explorerPanel).catch(() => {});
  observeExplorerSentinel("shows");
}

async function loadExplorerShows() {
  if (state.showsLoading || !state.showsHasMore) return;
  state.showsLoading = true;
  renderShowExplorer();

  try {
    const url = new URL("/api/shows", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.showsOffset));
    url.searchParams.set("sort", state.explorerSort);
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);

    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    if (!body) {
      const res = await fetch(url, { headers: authHeaders(), cache: "force-cache" });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Shows load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }

    const shows = Array.isArray(body.shows) ? body.shows : [];
    state.showsRaw = [...state.showsRaw, ...shows];
    state.showsOffset += shows.length;
    state.showsHasMore = shows.length === EXPLORER_PAGE_SIZE;
  } finally {
    state.showsLoading = false;
    renderShowExplorer();
  }
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
    const season = Number(episode.season) || 0;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push(episode);
  }
  return seasons;
}

function renderShowRecord(show = {}) {
  return renderShowFolder(show.title || "Unknown Show", seasonsFromShowRecord(show));
}

function renderShowFolder(showTitle, seasons) {
  const showKey = slug(showTitle);
  const expanded = state.expandedShows.has(showKey);
  const episodeCount = [...seasons.values()].reduce((total, episodes) => total + episodes.length, 0);
  const latestEpisode = representativeEpisode(seasons);

  return `
    <article class="folder-card">
      <button class="folder-trigger" type="button" data-show-key="${showKey}" aria-expanded="${expanded}">
        <span class="accordion-chevron ${expanded ? "expanded" : ""}">v</span>
        ${posterMarkup(latestEpisode, "explorer-folder-poster")}
        <span class="folder-title">
          <b>${escapeHtml(showTitle)}</b>
          <span>${seasons.size} seasons - ${episodeCount} episodes</span>
        </span>
        <time datetime="${escapeHtml(latestEpisode.watched_at || "")}">${formatDate(latestEpisode.watched_at)}</time>
      </button>
      <div class="folder-children ${expanded ? "" : "hidden"}">
        ${[...seasons.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([season, episodes]) => renderSeasonFolder(showKey, season, episodes)).join("")}
      </div>
    </article>
  `;
}

function renderSeasonFolder(showKey, season, episodes) {
  const seasonKey = `${showKey}:s${season}`;
  const expanded = state.expandedSeasons.has(seasonKey);
  const sortedEpisodes = sortExplorerItems(episodes, state.explorerSort);

  return `
    <article class="season-card">
      <button class="season-trigger" type="button" data-season-key="${seasonKey}" aria-expanded="${expanded}">
        <span class="accordion-chevron ${expanded ? "expanded" : ""}">▼</span>
        <b>Season ${String(season || "?").padStart(2, "0")}</b>
        <span>${episodes.length} watched episodes</span>
      </button>
      <div class="episode-list ${expanded ? "" : "hidden"}">
        ${sortedEpisodes
          .map(
            (episode) => `
              <article class="episode-row">
                ${posterMarkup(episode, "explorer-episode-poster")}
                <span class="episode-code">[ E${String(episode.episode || "?").padStart(2, "0")} ]</span>
                <b>[ ${escapeHtml(episodeTitle(episode.title, episode.episode))} ]</b>
                <button class="debug-badge" type="button" data-history-id="${episode.id}">${formatDate(episode.watched_at)}</button>
              </article>
            `,
          )
          .join("")}
      </div>
    </article>
  `;
}

function emptyExplorer(message) {
  return `<div class="empty-log"><b>${escapeHtml(message)}</b><span>Import history or wait for webhook events.</span></div>`;
}

function renderDbStatus(isOnline) {
  elements.dbStatus.innerHTML = `
    <span class="target-pill" data-status="${isOnline ? "success" : "error"}">${isOnline ? "Connected" : "Unavailable"}</span>
    <p>Total rows visible to this query: ${formatNumber(state.stats.totalWatches || 0)}</p>
    <p>Backend store: <code>Cloud Firestore</code></p>
  `;
}

function helpBadgeValue(token = "") {
  const key = String(token || "").trim().toUpperCase();
  if (key === "FIREBASE_AUTH") return { label: "FIREBASE_AUTH", value: state.firebaseUser?.email || "" };
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
                  ${escapeHtml(topic.title)}
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
      <h2>${escapeHtml(topic.category)} - ${escapeHtml(topic.title)}</h2>
      ${tokenBadges(topic.badges)}
    </div>
    <div class="help-doc-body">${topic.body()}</div>
  `;
}

function openHelpTopic(topicId) {
  if (!HELP_TOPICS.some((topic) => topic.id === topicId)) return;
  state.activeHelpTopic = topicId;
  selectView("help");
  window.setTimeout(() => elements.helpCanvas?.scrollIntoView({ block: "start" }), 0);
}

function renderLogs() {
  if (!elements.logsTerminal) return;
  elements.logsTerminal.textContent = logsText() || "[no local diagnostic logs captured yet]";
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
  const text = String(value || "unknown").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function platformBadge(value) {
  const platform = String(value || "unknown").toLowerCase();
  return platformName(platform);
}

function sourceClass(value) {
  return `source-${String(value || "unknown").toLowerCase()}`;
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

async function openHistoryDebugModal(id) {
  const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `History detail failed with ${response.status}`);
  openDebugModal(body.row || historyById(id));
}

function openDebugModal(entry) {
  if (!entry) return;
  elements.debugModal.classList.remove("hidden");
  document.querySelector("#debugModalTitle").textContent = entry.title || "History row";
  elements.modalBody.innerHTML = `
    <section class="diagnostic-grid">
      <div><span>Title</span><b>${escapeHtml(entry.title || "Unknown")}</b></div>
      <div><span>Media type</span><b>${escapeHtml(entry.media_type || "unknown")}</b></div>
      <div><span>IMDb</span><b>${escapeHtml(entry.imdb_id || "None")}</b></div>
      <div><span>TMDB</span><b>${escapeHtml(entry.tmdb_id || "None")}</b></div>
      <div><span>TVDB</span><b>${escapeHtml(entry.tvdb_id || "None")}</b></div>
      <div><span>Source</span><b>${escapeHtml(platformName(entry.source))}</b></div>
      <div><span>Season</span><b>${escapeHtml(entry.season ?? "None")}</b></div>
      <div><span>Episode</span><b>${escapeHtml(entry.episode ?? "None")}</b></div>
      <div><span>Watched at</span><b>${escapeHtml(formatDate(entry.watched_at))}</b></div>
    </section>
    <section class="telemetry-block">
      <p>Sync dispatch telemetry</p>
      <pre>${escapeHtml(entry.sync_dispatch_telemetry || "No sync telemetry recorded for this row.")}</pre>
    </section>
  `;
}

function closeDebugModal() {
  elements.debugModal.classList.add("hidden");
}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

async function unlockWithToken(password, email = elements.adminEmail?.value) {
  const cleanEmail = String(email || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanEmail || !cleanPassword) {
    setMessage("Enter your Firebase admin email and password.", "error");
    return;
  }

  const result = await signInAdmin(cleanEmail, cleanPassword);
  state.firebaseUser = result.user;
  state.token = result.token;
  if (elements.settingsToken) elements.settingsToken.value = cleanEmail;
  localStorage.setItem("firebaseAdminEmail", cleanEmail);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_UPPER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  setUnlocked(true);
  selectView(state.activeView);
  await loadHistory();
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
  state.activeSessions = [];
  state.importRecords = [];
  state.importFileNames = [];
  state.importLogs = ["[idle] Waiting for files."];
  state.importProgressValue = 0;
  state.nowPlayingRefreshToken = "";
  state.configLoaded = false;
  state.savedConfig = {};
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_UPPER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  await signOutAdmin().catch(() => {});
  elements.adminToken.value = "";
  if (elements.settingsToken) elements.settingsToken.value = "";
  populateConfigForm({});
  renderDashboard();
  renderActiveSessions();
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
  await loadHistory().catch(() => {});
  return { converted: totalConverted, backfilled: totalBackfilled };
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
    button.addEventListener("click", () => selectView(button.dataset.view));
  });

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
    renderLogs();
  });

  elements.copyLogsButton.addEventListener("click", () => {
    copyToClipboard(logsText() || "[no local diagnostic logs captured yet]");
  });

  elements.settingsTabButtons.forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
  });


  elements.explorerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.explorerMode = button.dataset.explorerMode;
      renderExplorer();
    });
  });

  elements.explorerSort?.addEventListener("change", () => {
    state.explorerSort = elements.explorerSort.value || "watched_desc";
    renderExplorer();
  });

  elements.helpMenu.addEventListener("click", (event) => {
    const topicButton = event.target.closest("[data-help-topic]");
    if (!topicButton) return;
    state.activeHelpTopic = topicButton.dataset.helpTopic;
    renderHelp();
  });

  elements.lockButton.addEventListener("click", lockDashboard);
  elements.closeModalButton.addEventListener("click", closeDebugModal);
  elements.debugModal.addEventListener("click", (event) => {
    if (event.target === elements.debugModal) closeDebugModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDebugModal();
  });

  document.addEventListener("click", (event) => {
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

    const historyRow = event.target.closest("[data-history-id]");
    if (historyRow) {
      openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const showTrigger = event.target.closest("[data-show-key]");
    if (showTrigger) {
      toggleSet(state.expandedShows, showTrigger.dataset.showKey);
      renderExplorer();
      return;
    }

    const seasonTrigger = event.target.closest("[data-season-key]");
    if (seasonTrigger) {
      toggleSet(state.expandedSeasons, seasonTrigger.dataset.seasonKey);
      renderExplorer();
    }
  });

  elements.updateTokenButton.addEventListener("click", async () => {
    const user = currentFirebaseUser();
    setMessage(user ? `Signed in as ${user.email || "Firebase admin"}.` : "Sign in again from the lock screen.", user ? "success" : "error");
  });

  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSavedConfig().catch((error) => {
      renderSettingsStatus(error.message, "error");
      setMessage(error.message, "error");
    });
  });

  elements.explorerSearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.explorerSearchTimer);
    state.explorerSearchTimer = window.setTimeout(() => {
      state.explorerSearch = elements.explorerSearchInput.value.trim();
      renderExplorer();
    }, 220);
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
}

function initialize() {
  bootstrapTokenFromUrl();
  bindElements();
  attachEvents();
  elements.adminEmail.value = localStorage.getItem("firebaseAdminEmail") || "";
  elements.adminToken.value = "";
  elements.settingsToken.value = elements.adminEmail.value;
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
  renderLogs();
  renderImportPreview();
  renderDbStatus(false);
  renderSettingsStatus("Configuration not loaded yet.");

  onFirebaseAuthChange((user, token) => {
    state.authReady = true;
    state.firebaseUser = user || undefined;
    state.token = token || "";
    if (user && token && !state.configLoaded) {
      elements.settingsToken.value = user.email || "";
      localStorage.setItem("firebaseAdminEmail", user.email || "");
      setUnlocked(true);
      selectView(state.activeView);
      loadHistory()
        .then(() => loadSavedConfig())
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

function showCopyToast() {
  elements.copyToast.classList.remove("hidden");
  window.clearTimeout(showCopyToast.timer);
  showCopyToast.timer = window.setTimeout(() => {
    elements.copyToast.classList.add("hidden");
  }, 1300);
}
