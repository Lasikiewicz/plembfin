import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml } from "./utils.js?v=20260903b";
import { hydratePosters } from "./images.js?v=20260903b";
import { hydrateMediaAppLinks } from "./media-detail-shared.js?v=20260903b";
import { renderDashboardUpNextCard, updateDashboardRowWithMotion } from "./dashboard.js?v=20260904a";

const UP_NEXT_TTL_MS = 2 * 60 * 1000;
const UP_NEXT_TIMEOUT_MS = 20000;
const UP_NEXT_DISMISSED_KEY = "plembfin:upNextDismissed:v1";
const UP_NEXT_CACHE_KEY = "plembfin:upNextCache:v4";
const UP_NEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UP_NEXT_SYNC_TIMEOUT_MS = 60_000;
// Mirrors dashboard.js's DASHBOARD_CARD_EXIT_MS so overlapping refreshes wait
// for a removal exit to finish before repainting the rail with a fresh
// snapshot (otherwise the exit is cut short by the immediate innerHTML swap).
const UP_NEXT_EXIT_MS = 200;

let _cb = {};
let actionsBound = false;
let cacheHydrated = false;
let dismissedUpNext = readDismissedUpNext();
let upNextExitDeferred = false;
let upNextExitRepaintTimer = null;

function readDismissedUpNext() {
  try {
    const raw = JSON.parse(localStorage.getItem(UP_NEXT_DISMISSED_KEY) || "{}");
    if (Array.isArray(raw)) {
      const map = {};
      for (const id of raw) {
        if (id) map[String(id).trim()] = Date.now();
      }
      return map;
    }
    if (raw && typeof raw === "object") return raw;
    return {};
  } catch {
    return {};
  }
}

function persistDismissedUpNext() {
  try {
    const entries = Object.entries(dismissedUpNext);
    const bounded = Object.fromEntries(entries.slice(-300));
    localStorage.setItem(UP_NEXT_DISMISSED_KEY, JSON.stringify(bounded));
  } catch {
  }
}

function upNextCoordinateDismissalKey(item = {}) {
  const mediaType = String(item.media_type || item.mediaType || "").trim().toLowerCase();
  if (mediaType !== "episode") return "";
  const showTitle = String(item.show_title || item.showTitle || "")
    .trim()
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const season = Number(item.season);
  const episode = Number(item.episode);
  if (!showTitle || item.season == null || item.episode == null || item.season === "" || item.episode === "" || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) return "";
  return `episode:${showTitle}:s${season}:e${episode}`;
}

function upNextDismissalKeys(item = {}, mediaKey = "") {
  const keys = new Set();
  const id = String(item.id || "").trim();
  const itemMediaKey = String(item.media_key || item.mediaKey || mediaKey || "").trim();
  if (id) keys.add(id);
  if (itemMediaKey) keys.add(itemMediaKey);
  const providerItemId = String(item.provider_item_id || item.providerItemId || "").trim();
  if (providerItemId) keys.add(providerItemId);
  const providerItems = item.provider_items || item.providerItems || {};
  for (const values of Object.values(providerItems)) {
    for (const value of (Array.isArray(values) ? values : [values])) {
      const providerId = String(value || "").trim();
      if (providerId) keys.add(providerId);
    }
  }
  const coordinate = upNextCoordinateDismissalKey(item);
  if (coordinate) keys.add(coordinate);
  return [...keys].filter(Boolean);
}

export function isUpNextItemDismissed(item) {
  if (!item) return false;
  const keys = upNextDismissalKeys(item);
  const dismissedAt = keys.map((key) => dismissedUpNext[key]).find(Boolean);
  if (!dismissedAt) return false;

  const updatedAt = Number(item.updated_at || item.updatedAt || 0);
  if (updatedAt && updatedAt > dismissedAt && (Number(item.position_ms) > 0 || Number(item.progress) > 0)) {
    for (const key of keys) delete dismissedUpNext[key];
    persistDismissedUpNext();
    return false;
  }
  return true;
}

export function dismissUpNextId(id, mediaKey = "", details = {}) {
  const cleanId = String(id || "").trim();
  const cleanKey = String(mediaKey || "").trim();
  if (cleanId) dismissedUpNext[cleanId] = Date.now();
  if (cleanKey) dismissedUpNext[cleanKey] = Date.now();
  for (const key of upNextDismissalKeys({ ...details, id: cleanId, media_key: cleanKey })) {
    dismissedUpNext[key] = Date.now();
  }
  persistDismissedUpNext();
}

export function removeUpNextItem(itemId, details = {}) {
  const id = String(itemId || "").trim();
  const mediaKey = String(details.media_key || details.mediaKey || "").trim();
  if (!id && !mediaKey) return;
  const removedIndex = state.upNextItems.findIndex((item) => String(item?.id || "") === id || String(item?.media_key || "") === mediaKey);
  const removedItem = removedIndex >= 0
    ? state.upNextItems[removedIndex]
    : { ...details, id: details.id || id, media_key: details.media_key || mediaKey || id };
  dismissUpNextId(id, mediaKey, details);
  state.upNextExitIds = [id || mediaKey];
  state.upNextItems = state.upNextItems.filter((item) => String(item?.id || "") !== id && String(item?.media_key || "") !== mediaKey);
  persistUpNextCache(visibleUpNextItems());
  renderUpNext();
  return { item: removedItem, index: Math.max(0, removedIndex) };
}

export function restoreUpNextItem(removal = {}) {
  const item = removal?.item;
  if (!item || typeof item !== "object") return;
  for (const key of upNextDismissalKeys(item)) delete dismissedUpNext[key];
  persistDismissedUpNext();
  const itemId = String(item.id || item.media_key || "").trim();
  if (!itemId || state.upNextItems.some((candidate) => String(candidate?.id || candidate?.media_key || "") === itemId)) return;
  const index = Math.max(0, Math.min(Number(removal.index) || 0, state.upNextItems.length));
  state.upNextItems = [
    ...state.upNextItems.slice(0, index),
    item,
    ...state.upNextItems.slice(index),
  ];
  state.upNextExitIds = [];
  persistUpNextCache(visibleUpNextItems());
  renderUpNext();
}

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

function upNextItemKey(item) {
  return String(item?.id || item?.media_key || item?.mediaKey || "").trim();
}

// The server projection is authoritative and already de-duplicates its own
// candidate merge, but a stale cached/filtered snapshot can still hold two
// rows that resolve to the same card. Collapse by stable key so the rendered
// rail never paints a duplicate tile regardless of which pass produced it.
function dedupeUpNextItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = upNextItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function upNextExitStillAnimating() {
  return Boolean(elements.upNextPanel?.querySelector?.(".dashboard-card-exit"));
}

// An overlapping refresh (forced load, SSE revalidate, history rebuild) can
// arrive while a removed tile is mid-flight. The exit's own scheduled swap
// paints the pre-exchange state, then this trailing repaint applies the
// freshest snapshot once the animation has finished - so the tile is never
// yanked away mid-fade but the updated rail is still applied right after it.
function scheduleUpNextExitRepaint() {
  if (upNextExitDeferred) return;
  upNextExitDeferred = true;
  if (upNextExitRepaintTimer) window.clearTimeout(upNextExitRepaintTimer);
  upNextExitRepaintTimer = window.setTimeout(() => {
    upNextExitRepaintTimer = null;
    upNextExitDeferred = false;
    renderUpNext();
  }, UP_NEXT_EXIT_MS + 40);
}

function visibleUpNextItems() {
  const items = Array.isArray(state.upNextItems) ? state.upNextItems : [];
  return dedupeUpNextItems(items.filter((item) => !isUpNextItemDismissed(item)));
}

function renderUpNextSyncControl() {
  const button = elements.upNextSyncButton;
  if (!button) return;
  const syncing = state.upNextSyncing === true;
  const loading = state.upNextLoading === true;
  const signedIn = Boolean(state.token);
  button.disabled = !signedIn || syncing || loading;
  button.setAttribute("aria-busy", String(syncing));
  button.title = syncing
    ? "Syncing Plembfin's Up Next list to connected media apps…"
    : signedIn
      ? "Sync Plembfin's Up Next list to Plex, Emby, and Jellyfin"
      : "Sign in to sync Up Next to connected media apps";
  button.setAttribute("aria-label", syncing ? "Syncing Up Next to connected media apps" : "Sync Up Next to connected media apps");
}

function upNextSyncPayloadItem(item = {}) {
  return {
    id: item.id || item.media_key || "",
    media_key: item.media_key || item.mediaKey || item.id || "",
    media_type: item.media_type || item.mediaType || "",
    queue_kind: item.queue_kind || item.queueKind || "",
    title: item.title || item.episode_title || item.show_title || "",
    show_title: item.show_title || item.showTitle || "",
    episode_title: item.episode_title || item.episodeTitle || "",
    season: item.season ?? "",
    episode: item.episode ?? "",
    imdb_id: item.imdb_id || item.imdbId || "",
    tmdb_id: item.tmdb_id || item.tmdbId || "",
    tvdb_id: item.tvdb_id || item.tvdbId || "",
    position_ms: item.position_ms ?? item.positionMs ?? 0,
    duration_ms: item.duration_ms ?? item.durationMs ?? 0,
    progress: item.progress ?? 0,
    provider_items: item.provider_items || item.providerItems || {},
    provider: item.provider || item.source || "",
    provider_item_id: item.provider_item_id || item.providerItemId || "",
  };
}

function upNextSyncMessage(body = {}) {
  const providerNames = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
  const configuredFeeds = Array.isArray(body.feeds) ? body.feeds : [];
  const syncedProviders = [...new Set(configuredFeeds
    .filter((feed) => feed?.status === "succeeded")
    .map((feed) => providerNames[String(feed.provider || "").toLowerCase()])
    .filter(Boolean))];
  const failedFeeds = configuredFeeds.filter((feed) => feed?.status === "failed");
  const dismissals = Array.isArray(body.providerDismissals) ? body.providerDismissals : [];
  const dismissed = dismissals.filter((entry) => entry?.status === "fulfilled").length;
  const dismissalFailures = dismissals.filter((entry) => entry?.status !== "fulfilled").length;
  const unsupportedFeeds = [...new Set((Array.isArray(body.unsupported) ? body.unsupported : [])
    .map((entry) => `${providerNames[String(entry?.provider || "").toLowerCase()] || entry?.provider || "Provider"} ${entry?.feed_kind === "next_up" ? "Next Up" : "feed"}`))];
  const progressTargets = new Set();
  for (const result of (Array.isArray(body.progress) ? body.progress : [])) {
    for (const target of (result?.targetStates || [])) {
      if (target?.status === "success" && providerNames[target.target]) progressTargets.add(providerNames[target.target]);
    }
  }
  const intro = syncedProviders.length
    ? `Plembfin Up Next synced with ${upNextListLabel(syncedProviders)}.`
    : "Plembfin Up Next sync completed.";
  const details = [];
  if (dismissed) details.push(`${dismissed} removed item${dismissed === 1 ? "" : "s"} hidden on connected apps`);
  if (progressTargets.size) details.push(`resume position sent to ${upNextListLabel([...progressTargets])}`);
  if (unsupportedFeeds.length) details.push(`${upNextListLabel(unsupportedFeeds)} cannot be rewritten by their native APIs`);
  if (failedFeeds.length) {
    details.push(`${upNextListLabel([...new Set(failedFeeds.map((feed) => providerNames[String(feed.provider || "").toLowerCase()] || feed.provider || "provider"))])} feed refresh failed`);
  }
  if (dismissalFailures) details.push(`${dismissalFailures} provider dismissal${dismissalFailures === 1 ? "" : "s"} failed`);
  return {
    text: [intro, ...details].join(" "),
    tone: unsupportedFeeds.length || failedFeeds.length || dismissalFailures ? "muted" : "success",
  };
}

export async function syncUpNextToProviders() {
  if (!state.token || state.upNextSyncing) return null;
  const items = visibleUpNextItems().slice(0, 30).map(upNextSyncPayloadItem);
  state.upNextSyncing = true;
  renderUpNextSyncControl();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), UP_NEXT_SYNC_TIMEOUT_MS);
  try {
    const response = await fetch("/api/up-next/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
      body: JSON.stringify({ items }),
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Up Next sync failed (${response.status})`);
    const message = upNextSyncMessage(body);
    _cb.setMessage?.(message.text, message.tone);
    // Re-read the provider snapshots after the outbound reconciliation. Local
    // dismissals still filter cards while the provider feeds catch up.
    await loadUpNext({ force: true });
    return body;
  } catch (error) {
    const detail = error?.name === "AbortError" ? "The provider sync timed out." : (error?.message || "Try again later.");
    _cb.setMessage?.(`Could not sync Plembfin Up Next to connected media apps: ${detail}`, "muted");
    return null;
  } finally {
    window.clearTimeout(timeout);
    state.upNextSyncing = false;
    renderUpNextSyncControl();
  }
}

export function initUpNext(callbacks = {}) {
  _cb = callbacks;
  hydrateUpNextCache();
  if (actionsBound) return;
  actionsBound = true;
  elements.upNextPanel?.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-up-next-retry]");
    if (!retry) return;
    event.preventDefault();
    loadUpNext({ force: true }).catch(() => { });
  });
  elements.upNextSyncButton?.addEventListener("click", (event) => {
    event.preventDefault();
    syncUpNextToProviders().catch(() => { });
  });
  renderUpNextSyncControl();
}

export function resetUpNext({ preserveItems = false } = {}) {
  if (upNextExitRepaintTimer) {
    window.clearTimeout(upNextExitRepaintTimer);
    upNextExitRepaintTimer = null;
  }
  upNextExitDeferred = false;
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
  state.upNextSyncing = false;
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
  renderUpNextSyncControl();
  if (!panel) return;

  hydrateUpNextCache();
  renderUpNextSourceStatus();

  panel.classList.add("dashboard-history-card-row");

  const pendingExitIds = [...new Set([
    ...(Array.isArray(state.upNextExitIds) ? state.upNextExitIds : []),
    ...(Array.isArray(exitIds) ? exitIds : []),
  ].map((id) => String(id || "").trim()).filter(Boolean))];
  state.upNextExitIds = [];

  // A removed tile keeps its exit animation until the scheduled swap fires.
  // If an overlapping refresh tries to repaint while that tile is still
  // mid-fade, defer and repaint once the exit has finished instead of yanking
  // the card off the rail before it animates away.
  if (!pendingExitIds.length && upNextExitStillAnimating()) {
    scheduleUpNextExitRepaint();
    return;
  }

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
    hydratePosters(panel, { allowNetwork: false });
    hydrateMediaAppLinks(panel, { allowNetwork: true }).catch(() => { });
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
    const nextIds = new Set(nextItems.filter((item) => !isUpNextItemDismissed(item)).map((item) => String(item?.id || "")).filter(Boolean));
    state.upNextExitIds = [...previousIds].filter((id) => !nextIds.has(id));
    state.upNextItems = nextItems;
    const responseVersion = Number(body.upNextVersion);
    if (Number.isFinite(responseVersion) && responseVersion > 0) state.upNextVersion = responseVersion;
    state.upNextSourceVersion = String(body.sourceVersion || "");
    state.upNextSourceStatus = Array.isArray(body.sourceStatus) ? body.sourceStatus : [];
    state.upNextFromCache = body.cacheStale === true;
    state.upNextLoadedAt = state.upNextFromCache ? 0 : Date.now();
    persistUpNextCache(visibleUpNextItems(), {
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
