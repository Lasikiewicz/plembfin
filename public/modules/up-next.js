import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml } from "./utils.js?v=20260824h";
import { hydratePosters } from "./images.js?v=20260831m";
import { hydrateMediaAppLinks } from "./media-detail-shared.js?v=20260831j";
import { renderDashboardUpNextCard, updateDashboardRowWithMotion } from "./dashboard.js?v=20260831m";

const UP_NEXT_TTL_MS = 2 * 60 * 1000;
const UP_NEXT_TIMEOUT_MS = 20000;
const UP_NEXT_CACHE_KEY = "plembfin:upNextCache:v3";
const UP_NEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _cb = {};
let actionsBound = false;
let cacheHydrated = false;

const UP_NEXT_PROVIDER_LABELS = {
  plex: "Plex",
  emby: "Emby",
  jellyfin: "Jellyfin",
};

const UP_NEXT_FEED_LABELS = {
  resume: "Resume",
  next_up: "Next Up",
};

const UP_NEXT_NETWORK_REASONS = {
  ENOTFOUND: "DNS could not find the server",
  EAI_AGAIN: "DNS lookup temporarily failed",
  ECONNREFUSED: "the server refused the connection",
  ECONNRESET: "the connection was reset",
  ETIMEDOUT: "the connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  UND_ERR_SOCKET: "the connection closed unexpectedly",
  EACCES: "the network request was denied",
  ERR_TLS_CERT_ALTNAME_INVALID: "the TLS certificate could not be verified",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the TLS certificate could not be verified",
  CERT_HAS_EXPIRED: "the TLS certificate could not be verified",
};

function upNextFeedLabel(feed) {
  const provider = UP_NEXT_PROVIDER_LABELS[feed?.provider] || String(feed?.provider || "Provider");
  const feedKind = UP_NEXT_FEED_LABELS[feed?.feed_kind] || String(feed?.feed_kind || "Feed").replace(/_/g, " ");
  return `${provider} ${feedKind}`;
}

function upNextFailureReason(feed) {
  const raw = String(feed?.last_error || "").replace(/\s+/g, " ").trim();
  if (!raw) return "the refresh failed";
  if (/timed out|timeout/i.test(raw)) return "the request timed out";

  const statusMatch = raw.match(/\b(?:http\s*)?(?:status\s*[:=]?\s*)?(\d{3})\b/i);
  if (statusMatch && /\b(?:http|status)\b/i.test(raw)) {
    return `the server returned HTTP ${statusMatch[1]}`;
  }

  const codeMatch = raw.match(/\b(?:UND_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|E[A-Z0-9_]+|CERT_[A-Z0-9_]+|DEPTH_ZERO_SELF_SIGNED_CERT)\b/i);
  const code = codeMatch?.[0]?.toUpperCase() || "";
  if (code && UP_NEXT_NETWORK_REASONS[code]) return UP_NEXT_NETWORK_REASONS[code];
  if (/fetch failed|could not be reached|request failed/i.test(raw)) return "the server could not be reached";
  if (code) return `the upstream request failed (${code})`;
  return raw.replace(/[.!?]+$/, "").slice(0, 180) || "the refresh failed";
}

function upNextListLabel(values) {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length <= 1) return unique[0] || "Connected service";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(", ")}, and ${unique.at(-1)}`;
}

function renderUpNextSourceStatus() {
  const status = elements.upNextSourceStatus;
  if (!status) return;
  const failedFeeds = state.token && Array.isArray(state.upNextSourceStatus)
    ? state.upNextSourceStatus.filter((feed) => ["failed", "partial"].includes(feed.status))
    : [];
  const unavailable = failedFeeds.length > 0;
  if (unavailable) {
    const providerLabels = upNextListLabel(failedFeeds.map((feed) => UP_NEXT_PROVIDER_LABELS[feed?.provider] || feed?.provider));
    const reasons = [...new Set(failedFeeds.map(upNextFailureReason))];
    const scope = failedFeeds.length === 1
      ? upNextFeedLabel(failedFeeds[0])
      : `${providerLabels} feeds`;
    const reason = reasons.length === 1 ? reasons[0] : "some refresh requests failed";
    const hasSavedItems = visibleUpNextItems().length > 0
      || failedFeeds.some((feed) => Number(feed?.active_generation || 0) > 0 && Number(feed?.item_count || 0) > 0);
    const fallback = hasSavedItems ? "Showing saved items." : "Using the local fallback.";
    const copy = `${scope} unavailable — ${reason}. ${fallback}`;
    const details = failedFeeds
      .map((feed) => `${upNextFeedLabel(feed)}: ${String(feed?.last_error || "No error detail recorded.")}`)
      .join("\n");
    status.textContent = copy;
    status.title = `${details}\n\nPlembfin will retry during the next sync. If this continues, check Settings → Connections.`;
    status.setAttribute("aria-label", copy);
  } else {
    status.textContent = "";
    status.title = "";
    status.removeAttribute("aria-label");
  }
  status.classList.toggle("hidden", !unavailable);
}

function readUpNextCache() {
  try {
    const stored = JSON.parse(localStorage.getItem(UP_NEXT_CACHE_KEY) || "null");
    if (!stored || !Array.isArray(stored.items)) return null;
    const savedAt = Number(stored.savedAt || 0);
    if (!savedAt || Date.now() - savedAt > UP_NEXT_CACHE_TTL_MS) return null;
    return {
      savedAt,
      version: Number(stored.version || 0),
      items: stored.items.slice(0, 100),
      sourceVersion: String(stored.sourceVersion || ""),
      sourceStatus: Array.isArray(stored.sourceStatus) ? stored.sourceStatus : [],
    };
  } catch {
    return null;
  }
}

function persistUpNextCache(items = state.upNextItems, {
  savedAt = Date.now(),
  version = state.upNextVersion,
  sourceVersion = state.upNextSourceVersion,
  sourceStatus = state.upNextSourceStatus,
} = {}) {
  try {
    localStorage.setItem(UP_NEXT_CACHE_KEY, JSON.stringify({
      savedAt,
      version,
      items: (Array.isArray(items) ? items : []).slice(0, 100),
      sourceVersion,
      sourceStatus: Array.isArray(sourceStatus) ? sourceStatus : [],
    }));
  } catch {
    // A full/private browser storage area should not make the dashboard fail.
  }
}

function hydrateUpNextCache() {
  if (cacheHydrated || state.upNextItems.length) return;
  cacheHydrated = true;
  const cachedItems = readUpNextCache();
  if (!cachedItems) return;
  if (Number.isFinite(cachedItems.version) && cachedItems.version > 0) {
    state.upNextVersion = cachedItems.version;
  }
  state.upNextSourceVersion = cachedItems.sourceVersion || "";
  state.upNextSourceStatus = cachedItems.sourceStatus || [];
  if (!cachedItems.items.length) return;
  // Leave loadedAt at zero so the network still reconciles the cache; the
  // cached cards simply get a head start while that request is in flight.
  state.upNextItems = cachedItems.items;
  state.upNextLoadedAt = 0;
  state.upNextFromCache = true;
}

function visibleUpNextItems() {
  return Array.isArray(state.upNextItems) ? state.upNextItems : [];
}

export function initUpNext(callbacks = {}) {
  _cb = callbacks;
  hydrateUpNextCache();
  if (actionsBound || !elements.upNextPanel) return;
  actionsBound = true;
  elements.upNextPanel.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-up-next-retry]");
    if (!retry) return;
    event.preventDefault();
    loadUpNext({ force: true }).catch(() => { });
  });
}

export function resetUpNext({ preserveItems = false } = {}) {
  state.upNextRequestVersion += 1;
  state.upNextAbortController?.abort();
  state.upNextAbortController = null;
  if (!preserveItems) {
    state.upNextItems = [];
    state.upNextVersion = 0;
    state.upNextSourceVersion = "";
    state.upNextSourceStatus = [];
    state.upNextFromCache = false;
    cacheHydrated = false;
  }
  state.upNextLoading = false;
  state.upNextLoadedAt = 0;
  state.upNextError = "";
  state.upNextErrorCode = "";
  state.upNextExitIds = [];
  state.upNextRefreshQueued = false;
}

function upNextErrorPresentation() {
  if (state.upNextErrorCode === "SERVER_ROUTE_MISSING" || /\bnot found\b/i.test(state.upNextError)) {
    return {
      title: "Restart Plembfin to load Up Next",
      detail: "The local server is running an older build. Restart it, then try again.",
    };
  }
  if (state.upNextErrorCode === "UNAUTHORIZED") {
    return {
      title: "Sign in again to load Up Next",
      detail: "Your local session has expired.",
    };
  }
  return { title: "Up Next is unavailable", detail: state.upNextError || "Try again later." };
}

export function renderUpNext({ exitIds = [] } = {}) {
  const panel = elements.upNextPanel;
  const section = elements.upNextSection;
  if (!panel) return;

  hydrateUpNextCache();
  renderUpNextSourceStatus();

  panel.classList.add("dashboard-history-card-row");

  const pendingExitIds = [...new Set([
    ...(Array.isArray(state.upNextExitIds) ? state.upNextExitIds : []),
    ...(Array.isArray(exitIds) ? exitIds : []),
  ].map((id) => String(id || "").trim()).filter(Boolean))];
  state.upNextExitIds = [];

  const commitPanel = (html, onCommitted) => updateDashboardRowWithMotion(panel, html, {
    exitKeys: pendingExitIds,
    onCommitted,
  });

  if (!state.token) {
    if (section) section.classList.add("hidden");
    commitPanel("");
    return;
  }

  const items = visibleUpNextItems();

  if (state.upNextLoading && !state.upNextItems.length) {
    if (section) section.classList.remove("hidden");
    commitPanel(`<div class="empty-log up-next-empty-state"><b>Loading Up Next…</b></div>`);
    return;
  }

  if (state.upNextError && !state.upNextItems.length) {
    if (section) section.classList.remove("hidden");
    const presentation = upNextErrorPresentation();
    commitPanel(`<div class="empty-log up-next-empty-state" role="alert"><b>${escapeHtml(presentation.title)}</b><span>${escapeHtml(presentation.detail)}</span><button class="button-ghost" type="button" data-up-next-retry>Try again</button></div>`);
    return;
  }

  if (!items.length) {
    if (section) section.classList.remove("hidden");
    commitPanel(`<div class="empty-log up-next-empty-state"><b>No movies or episodes queued</b><span>Start watching a movie or TV episode to build your Up Next list.</span></div>`);
    return;
  }

  if (section) section.classList.remove("hidden");
  const html = items.slice(0, 30).map((item, index) => renderDashboardUpNextCard({
    ...item,
    eager_poster: index < 12,
  })).join("");
  commitPanel(html, () => {
    hydratePosters(panel);
    hydrateMediaAppLinks(panel).catch(() => { });
  });
}

export async function loadUpNext({ force = false, fromSse = false } = {}) {
  if (!state.token) return;
  if (state.upNextLoading) {
    if (fromSse) state.upNextRefreshQueued = true;
    return;
  }
  hydrateUpNextCache();
  if (!force && !fromSse && state.upNextLoadedAt && Date.now() - state.upNextLoadedAt < UP_NEXT_TTL_MS) {
    renderUpNext();
    return;
  }

  const requestVersion = state.upNextRequestVersion + 1;
  state.upNextRequestVersion = requestVersion;
  const controller = new AbortController();
  state.upNextAbortController = controller;
  state.upNextLoading = true;
  state.upNextError = "";
  state.upNextErrorCode = "";
  renderUpNext();
  const timeout = setTimeout(() => controller.abort(), UP_NEXT_TIMEOUT_MS);

  try {
    const params = force ? "refresh=1" : "revalidate=1";
    const response = await fetch(`/api/up-next?${params}`, {
      headers: buildAuthHeaders(state.token),
      cache: force ? "reload" : "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const requestError = new Error(body.error || `Up Next load failed (${response.status})`);
      requestError.status = response.status;
      requestError.code = body.code || "";
      throw requestError;
    }
    if (requestVersion !== state.upNextRequestVersion) return;
    const previousIds = new Set(visibleUpNextItems().map((item) => String(item?.id || "")).filter(Boolean));
    const nextItems = Array.isArray(body.items) ? body.items : [];
    const nextIds = new Set(nextItems.map((item) => String(item?.id || "")).filter(Boolean));
    state.upNextExitIds = [...previousIds].filter((id) => !nextIds.has(id));
    state.upNextItems = nextItems;
    const responseVersion = Number(body.upNextVersion);
    if (Number.isFinite(responseVersion) && responseVersion > 0) state.upNextVersion = responseVersion;
    state.upNextSourceVersion = String(body.sourceVersion || "");
    state.upNextSourceStatus = Array.isArray(body.sourceStatus) ? body.sourceStatus : [];
    state.upNextFromCache = body.cacheStale === true;
    state.upNextLoadedAt = state.upNextFromCache ? 0 : Date.now();
    persistUpNextCache(state.upNextItems, {
      savedAt: state.upNextFromCache ? Number(body.builtAt || 0) || Date.now() : Date.now(),
      version: state.upNextVersion,
      sourceVersion: state.upNextSourceVersion,
      sourceStatus: state.upNextSourceStatus,
    });
  } catch (error) {
    if (requestVersion !== state.upNextRequestVersion) return;
    state.upNextErrorCode = error?.name === "AbortError"
      ? "TIMEOUT"
      : error?.code || (Number(error?.status) === 404 ? "SERVER_ROUTE_MISSING" : Number(error?.status) === 401 ? "UNAUTHORIZED" : "");
    state.upNextError = error?.name === "AbortError" ? "The request timed out." : (error.message || "Try again later.");
  } finally {
    clearTimeout(timeout);
    if (requestVersion === state.upNextRequestVersion) {
      state.upNextAbortController = null;
      state.upNextLoading = false;
      renderUpNext();
      const refreshQueued = state.upNextRefreshQueued;
      state.upNextRefreshQueued = false;
      if (refreshQueued && state.activeView === "dashboard") {
        Promise.resolve().then(() => loadUpNext({ fromSse: true })).catch(() => { });
      }
    }
  }
}

export function refreshUpNext() {
  return loadUpNext({ force: true });
}
