import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml } from "./utils.js?v=20260824h";
import { hydratePosters } from "./images.js?v=20260831m";
import { hydrateMediaAppLinks } from "./media-detail-shared.js?v=20260831j";
import { renderDashboardUpNextCard, updateDashboardRowWithMotion } from "./dashboard.js?v=20260831m";

const UP_NEXT_TTL_MS = 2 * 60 * 1000;
const UP_NEXT_TIMEOUT_MS = 20000;
const UP_NEXT_DISMISSED_KEY = "plembfin:upNextDismissed:v1";
const UP_NEXT_CACHE_KEY = "plembfin:upNextCache:v1";
const UP_NEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _cb = {};
let actionsBound = false;
let cacheHydrated = false;
const dismissedUpNextIds = readDismissedUpNextIds();

function readDismissedUpNextIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(UP_NEXT_DISMISSED_KEY) || "[]");
    return new Set(Array.isArray(stored) ? stored.map((id) => String(id || "").trim()).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function persistDismissedUpNextIds() {
  try {
    // Keep this bounded so a long-lived local install cannot accumulate an
    // unbounded list of old episode coordinates.
    const values = [...dismissedUpNextIds].slice(-300);
    localStorage.setItem(UP_NEXT_DISMISSED_KEY, JSON.stringify(values));
  } catch {
    // Local suppression is best effort; the current in-memory view still
    // updates even when browser storage is unavailable.
  }
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
    };
  } catch {
    return null;
  }
}

function persistUpNextCache(items = state.upNextItems, { savedAt = Date.now(), version = state.upNextVersion } = {}) {
  try {
    localStorage.setItem(UP_NEXT_CACHE_KEY, JSON.stringify({
      savedAt,
      version,
      items: (Array.isArray(items) ? items : []).slice(0, 100),
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
  if (!cachedItems.items.length) return;
  // Leave loadedAt at zero so the network still reconciles the cache; the
  // cached cards simply get a head start while that request is in flight.
  state.upNextItems = cachedItems.items;
  state.upNextLoadedAt = 0;
  state.upNextFromCache = true;
}

function visibleUpNextItems() {
  return state.upNextItems.filter((item) => !dismissedUpNextIds.has(String(item?.id || "")));
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
    loadUpNext({ force: true }).catch((error) => _cb.setMessage?.(error.message, "error"));
  });
}

export function resetUpNext({ preserveItems = false } = {}) {
  state.upNextRequestVersion += 1;
  state.upNextAbortController?.abort();
  state.upNextAbortController = null;
  if (!preserveItems) {
    state.upNextItems = [];
    state.upNextVersion = 0;
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
    commitPanel(`<div class="empty-log up-next-empty-state"><b>No episodes queued</b><span>Watch a TV episode to start building your Up Next list.</span></div>`);
    return;
  }

  if (section) section.classList.remove("hidden");
  const html = items.slice(0, 30).map((item, index) => renderDashboardUpNextCard({
    ...item,
    eager_poster: index < 6,
  })).join("");
  commitPanel(html, () => {
    hydratePosters(panel);
    hydrateMediaAppLinks(panel).catch(() => { });
  });
}

export async function removeUpNextItem(itemId, details = {}) {
  const id = String(itemId || "").trim();
  if (!id) return;
  dismissedUpNextIds.add(id);
  persistDismissedUpNextIds();
  state.upNextExitIds = [id];
  persistUpNextCache(state.upNextItems.filter((item) => String(item?.id || "") !== id));
  renderUpNext();

  try {
    const response = await fetch("/api/up-next/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
      cache: "no-store",
      body: JSON.stringify({
        media_type: "episode",
        title: details.title || "",
        tmdb_id: details.tmdbId || "",
        tvdb_id: details.tvdbId || "",
        season: details.season || "",
        episode: details.episode || "",
        episode_title: details.episodeTitle || "",
        air_date: details.airDate || "",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);

    const clearedTargets = Array.isArray(body.targetStates)
      ? body.targetStates.filter((target) => target.status === "fulfilled").map((target) => target.target)
      : [];
    const targetText = clearedTargets.length ? ` Resume cleared in ${clearedTargets.join(", ")}.` : "";
    _cb.setMessage?.(`Removed from Up Next in Plembfin.${targetText}`, "success");
  } catch {
    // The local dismissal is already applied. A missing/older server route or
    // a disconnected media server must not put the card back in the dashboard.
    _cb.setMessage?.("Removed from Up Next in Plembfin. Connected-app resume state was unchanged.", "success");
  }
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
    state.upNextFromCache = body.cacheStale === true;
    state.upNextLoadedAt = state.upNextFromCache ? 0 : Date.now();
    persistUpNextCache(state.upNextItems, {
      savedAt: state.upNextFromCache ? Number(body.builtAt || 0) || Date.now() : Date.now(),
      version: state.upNextVersion,
    });
  } catch (error) {
    if (requestVersion !== state.upNextRequestVersion) return;
    state.upNextErrorCode = error?.name === "AbortError"
      ? "TIMEOUT"
      : error?.code || (Number(error?.status) === 404 ? "SERVER_ROUTE_MISSING" : Number(error?.status) === 401 ? "UNAUTHORIZED" : "");
    state.upNextError = error?.name === "AbortError" ? "The request timed out." : (error.message || "Try again later.");
    _cb.setMessage?.(`Up Next: ${state.upNextError}`, "error");
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
