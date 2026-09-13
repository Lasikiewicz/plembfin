import { buildAuthHeaders } from "./auth.js?v=1.1.0.1.0";
import { state, elements } from "./state.js?v=1.1.0.1.0";
import { escapeHtml } from "./utils.js?v=1.1.0.1.0";
import { hydratePosters } from "./images.js?v=1.1.0.1.0";
import { hydrateMediaAppLinks } from "./media-detail-shared.js?v=1.1.0.1.0";
import { renderDashboardUpNextCard, updateDashboardRowWithMotion } from "./dashboard.js?v=1.1.0.1.0";

const UP_NEXT_TTL_MS = 2 * 60 * 1000;
const UP_NEXT_TIMEOUT_MS = 20000;
const UP_NEXT_DISMISSED_KEY = "plembfin:upNextDismissed:v1";
// v6 invalidates snapshots created before canonical episode identity and
// scheduled Part Watched artwork repair were applied.
const UP_NEXT_CACHE_KEY = "plembfin:upNextCache:v6";
const UP_NEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UP_NEXT_SYNC_TIMEOUT_MS = 60_000;
const UP_NEXT_PROVIDERS = new Set(["plex", "emby", "jellyfin"]);
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
  for (const [provider, values] of Object.entries(providerItems)) {
    if (!UP_NEXT_PROVIDERS.has(String(provider || "").toLowerCase())) continue;
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

export function removeUpNextItem(itemId, details = {}) {
  const id = String(itemId || "").trim();
  const mediaKey = String(details.media_key || details.mediaKey || "").trim();
  if (!id && !mediaKey) return;
  const removedIndex = state.upNextItems.findIndex((item) => String(item?.id || "") === id || String(item?.media_key || "") === mediaKey);
  const removedItem = removedIndex >= 0
    ? state.upNextItems[removedIndex]
    : { ...details, id: details.id || id, media_key: details.media_key || mediaKey || id };
  // The server records the dismissal; this only hides the card immediately so
  // the rail does not wait for the round trip.
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

// Dismissals live on the server now, so this is simply what the server says
// is dismissed. The local map below survives only as a migration source for
// browsers that dismissed things before the move.
function dismissedUpNextItems() {
  return Array.isArray(state.upNextDismissed) ? state.upNextDismissed : [];
}

async function loadDismissedUpNext() {
  if (!state.token) return [];
  try {
    const response = await fetch("/api/up-next/dismissed", { headers: buildAuthHeaders(state.token) });
    if (!response.ok) return state.upNextDismissed || [];
    const body = await response.json();
    state.upNextDismissed = Array.isArray(body.items) ? body.items : [];
  } catch {
    // Leave the last known list in place; the count is not worth failing the
    // dashboard over.
  }
  return state.upNextDismissed;
}

// One-time move of this browser's stored dismissals to the server. Until it
// runs, a browser that dismissed items before the change would show them back
// in the queue.
async function migrateLocalDismissals() {
  const entries = Object.keys(dismissedUpNext || {});
  if (!entries.length || !state.token) return false;
  const items = (Array.isArray(state.upNextItems) ? state.upNextItems : [])
    .filter((item) => isUpNextItemDismissed(item));
  if (!items.length) {
    // Nothing in the current queue matches, so the stored keys are stale.
    dismissedUpNext = {};
    persistDismissedUpNext();
    return false;
  }
  for (const item of items) {
    await fetch("/api/up-next/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
      body: JSON.stringify({
        media_key: item.media_key || item.id,
        media_type: item.media_type || "",
        title: item.title || "",
        show_title: item.show_title || "",
        season: item.season ?? "",
        episode: item.episode ?? "",
        tmdb_id: item.tmdb_id || item.show_tmdb_id || "",
        imdb_id: item.imdb_id || item.show_imdb_id || "",
        tvdb_id: item.tvdb_id || item.show_tvdb_id || "",
        provider_items: item.provider_items || {},
      }),
    }).catch(() => null);
  }
  dismissedUpNext = {};
  persistDismissedUpNext();
  return true;
}

function upNextItemLabel(item = {}) {
  const isEpisode = String(item.media_type || item.mediaType || "").toLowerCase() === "episode";
  if (!isEpisode) {
    const year = String(item.year || "").trim();
    return { title: String(item.title || "Untitled"), detail: year ? `Movie · ${year}` : "Movie" };
  }
  const show = String(item.show_title || item.showTitle || item.title || "Untitled");
  const season = Number(item.season);
  const episode = Number(item.episode);
  const coordinate = Number.isInteger(season) && Number.isInteger(episode) ? `S${season} · E${episode}` : "";
  const episodeTitle = String(item.episode_title || item.episodeTitle || "").trim();
  return { title: show, detail: [coordinate, episodeTitle].filter(Boolean).join(" · ") || "Episode" };
}

// Clears the local dismissal so the card returns to the rail. The caller is
// responsible for pushing the restored queue outward; restoring here and
// pushing there keeps a failed provider push from silently re-hiding a card
// the user explicitly asked to see again.
export async function restoreDismissedUpNextItems(entries = []) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return 0;
  let restored = 0;
  for (const entry of list) {
    const response = await fetch("/api/up-next/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
      body: JSON.stringify({ id: entry.id }),
    }).catch(() => null);
    if (response?.ok) restored += 1;
  }
  if (!restored) return 0;
  await loadDismissedUpNext();
  state.upNextExitIds = [];
  await loadUpNext({ force: true });
  return restored;
}

function closeDismissedUpNextModal() {
  document.querySelector(".up-next-dismissed-overlay")?._upNextClose?.();
}

export function openDismissedUpNextModal() {
  closeDismissedUpNextModal();
  const items = dismissedUpNextItems();
  const byId = new Map(items.map((entry) => [String(entry.id), entry]));
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay settings-modal-overlay up-next-dismissed-overlay";
  const rows = items.map((entry) => {
    const label = upNextItemLabel(entry.item && Object.keys(entry.item).length ? entry.item : entry);
    return `
      <li class="up-next-dismissed-row">
        <div class="up-next-dismissed-copy">
          <b>${escapeHtml(label.title)}</b>
          <span>${escapeHtml(label.detail)}</span>
        </div>
        <button class="button-ghost" type="button" data-up-next-restore="${escapeHtml(String(entry.id))}">Add back</button>
      </li>
    `;
  }).join("");
  const body = items.length
    ? `<p class="up-next-dismissed-intro">Dismissed on every device. Adding one back returns it to Up Next and pushes the queue to your media servers.</p>
       <ul class="up-next-dismissed-list">${rows}</ul>`
    : `<p class="up-next-dismissed-intro">Nothing dismissed is currently unwatched in Plembfin.</p>`;
  overlay.innerHTML = `
    <div class="edit-dialog settings-modal up-next-dismissed-modal" role="dialog" aria-modal="true" aria-label="Dismissed Up Next items">
      <header class="settings-modal-head">
        <h3>Dismissed Up Next</h3>
        <button class="settings-modal-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="settings-modal-body">${body}</div>
      <footer class="settings-modal-foot">
        <div class="settings-modal-actions">
          ${items.length > 1 ? `<button class="button-ghost" type="button" data-up-next-restore-all>Add all back</button>` : ""}
          <button class="button-ghost settings-modal-cancel" type="button">Close</button>
        </div>
      </footer>
    </div>
  `;
  const onKeydown = (event) => { if (event.key === "Escape") close(); };
  const close = () => {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  };
  overlay._upNextClose = close;
  const restoreAndPush = async (restoreItems) => {
    close();
    const restored = await restoreDismissedUpNextItems(restoreItems);
    if (!restored) return;
    _cb.setMessage?.(
      `Added ${restored} item${restored === 1 ? "" : "s"} back to Up Next; pushing to your media servers…`,
      "success",
    );
    syncUpNextToProviders().catch(() => { });
  };
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector(".settings-modal-close").addEventListener("click", close);
  overlay.querySelector(".settings-modal-cancel").addEventListener("click", close);
  overlay.querySelector("[data-up-next-restore-all]")?.addEventListener("click", () => restoreAndPush(items));
  overlay.querySelectorAll("[data-up-next-restore]").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = byId.get(button.dataset.upNextRestore);
      if (entry) restoreAndPush([entry]);
    });
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
  overlay.querySelector("[data-up-next-restore], .settings-modal-close")?.focus({ preventScroll: true });
}

function renderUpNextDismissedControl() {
  const button = elements.upNextDismissedButton;
  if (!button) return;
  const count = state.token ? dismissedUpNextItems().length : 0;
  button.classList.toggle("hidden", count === 0);
  button.disabled = count === 0 || state.upNextSyncing === true;
  const label = `Show ${count} dismissed Up Next item${count === 1 ? "" : "s"}`;
  button.textContent = String(count);
  button.title = label;
  button.setAttribute("aria-label", label);
}

function renderUpNextControls() {
  renderUpNextSyncControl();
  renderUpNextDismissedControl();
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

// The server applies dismissals now, so whatever it returns is already the
// visible queue. The local map is consulted only while a pre-migration browser
// still has stored keys, and is cleared as soon as they are migrated.
function visibleUpNextItems() {
  const items = Array.isArray(state.upNextItems) ? state.upNextItems : [];
  const pendingLocal = Object.keys(dismissedUpNext || {}).length > 0;
  const filtered = pendingLocal ? items.filter((item) => !isUpNextItemDismissed(item)) : items;
  return dedupeUpNextItems(filtered);
}

function renderUpNextSyncControl() {
  const button = elements.upNextSyncButton;
  if (!button) return;
  const syncing = state.upNextSyncing === true;
  const loading = state.upNextLoading === true;
  const signedIn = Boolean(state.token);
  const syncEnabled = state.savedConfig?.upNextSync?.enabled !== false;
  button.disabled = !signedIn || !syncEnabled || syncing || loading;
  button.setAttribute("aria-busy", String(syncing));
  button.title = syncing
    ? "Pushing Plembfin Up Next to Plex, Emby, and Jellyfin…"
    : !signedIn
      ? "Sign in to push Up Next to your media servers"
      : !syncEnabled
        ? "Up Next sync is disabled in Settings → Sync → Sync Tuning"
        : "Push Plembfin Up Next to Plex, Emby, and Jellyfin";
  button.setAttribute("aria-label", syncing
    ? "Pushing Plembfin Up Next to connected media servers"
    : !signedIn
      ? "Sign in to push Up Next to your media servers"
      : !syncEnabled
        ? "Up Next sync is disabled in Settings, Sync Tuning"
        : "Push Plembfin Up Next to Plex, Emby, and Jellyfin");
}

function upNextSyncPayloadItem(item = {}) {
  const providerItems = Object.fromEntries(Object.entries(item.provider_items || item.providerItems || {})
    .map(([provider, ids]) => [String(provider || "").toLowerCase(), ids])
    .filter(([provider]) => UP_NEXT_PROVIDERS.has(provider)));
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
    show_imdb_id: item.show_imdb_id || item.showImdbId || "",
    show_tmdb_id: item.show_tmdb_id || item.showTmdbId || "",
    show_tvdb_id: item.show_tvdb_id || item.showTvdbId || "",
    episode_imdb_id: item.episode_imdb_id || item.episodeImdbId || "",
    episode_tmdb_id: item.episode_tmdb_id || item.episodeTmdbId || "",
    episode_tvdb_id: item.episode_tvdb_id || item.episodeTvdbId || "",
    position_ms: item.position_ms ?? item.positionMs ?? 0,
    duration_ms: item.duration_ms ?? item.durationMs ?? 0,
    progress: item.progress ?? 0,
    provider_items: providerItems,
    provider: item.provider || item.source || "",
    provider_item_id: item.provider_item_id || item.providerItemId || "",
  };
}

function upNextSyncMessage(body = {}) {
  if (body.disabled) {
    return {
      text: "Up Next sync is disabled in Settings → Sync → Sync Tuning.",
      tone: "muted",
    };
  }
  const providerNames = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
  const configuredFeeds = Array.isArray(body.feeds) ? body.feeds : [];
  const pushedProviders = [...new Set((Array.isArray(body.pushedProviders) ? body.pushedProviders : [])
    .map((provider) => providerNames[String(provider || "").toLowerCase()])
    .filter(Boolean))];
  const failedFeeds = configuredFeeds.filter((feed) => feed?.status === "failed");
  const dismissals = Array.isArray(body.providerDismissals) ? body.providerDismissals : [];
  const dismissed = dismissals.filter((entry) => entry?.status === "fulfilled").length;
  const dismissalFailures = dismissals.filter((entry) => entry?.status !== "fulfilled").length;
  const playlists = Array.isArray(body.playlists) ? body.playlists : [];
  const railSeeds = Array.isArray(body.railSeeds) ? body.railSeeds : [];
  const playlistFailures = playlists.filter((playlist) => !["succeeded"].includes(playlist?.status));
  const unsupportedFeeds = [...new Set((Array.isArray(body.unsupported) ? body.unsupported : [])
    .filter((entry) => UP_NEXT_PROVIDERS.has(String(entry?.provider || "").toLowerCase()))
    .map((entry) => `${providerNames[String(entry?.provider || "").toLowerCase()] || entry?.provider || "Provider"} ${entry?.feed_kind === "next_up" ? "Next Up" : "feed"}`))];
  const progressTargets = new Set();
  for (const result of (Array.isArray(body.progress) ? body.progress : [])) {
    for (const target of (result?.targetStates || [])) {
      if (target?.status === "success" && providerNames[target.target]) progressTargets.add(providerNames[target.target]);
    }
  }
  const intro = pushedProviders.length
    ? `Plembfin Up Next pushed to ${upNextListLabel(pushedProviders)}.`
    : "Plembfin Up Next push completed.";
  const details = [];
  const updatedPlaylists = playlists.filter((playlist) => playlist?.status === "succeeded");
  if (updatedPlaylists.length) {
    details.push(`${updatedPlaylists.map((playlist) => `${providerNames[playlist.provider] || playlist.provider} list has ${Number(playlist.final_count || 0)} item${Number(playlist.final_count || 0) === 1 ? "" : "s"}`).join("; ")}`);
  }
  for (const playlist of playlistFailures) {
    const label = providerNames[playlist?.provider] || playlist?.provider || "Provider";
    const missing = Number(playlist?.missing_count || 0);
    details.push(`${label} list ${playlist?.status === "partial" ? `is missing ${missing} item${missing === 1 ? "" : "s"}` : "could not be updated"}`);
  }
  const seeded = railSeeds.reduce((total, seed) => total + Number(seed?.seeded_count || 0), 0);
  const seedFailures = railSeeds.reduce((total, seed) => total + Number(seed?.failed_count || 0), 0);
  if (seeded) details.push(`${seeded} item${seeded === 1 ? "" : "s"} added to Continue Watching`);
  if (seedFailures) details.push(`${seedFailures} Continue Watching update${seedFailures === 1 ? "" : "s"} failed`);
  if (dismissed) details.push(`${dismissed} removed item${dismissed === 1 ? "" : "s"} hidden on connected apps`);
  if (progressTargets.size) details.push(`resume position sent to ${upNextListLabel([...progressTargets])}`);
  if (unsupportedFeeds.length) details.push(`${upNextListLabel(unsupportedFeeds)} ${unsupportedFeeds.length === 1 ? "is" : "are"} calculated by the native API and ${unsupportedFeeds.length === 1 ? "was" : "were"} left unchanged`);
  if (failedFeeds.length) {
    details.push(`${upNextListLabel([...new Set(failedFeeds.map((feed) => providerNames[String(feed.provider || "").toLowerCase()] || feed.provider || "provider"))])} feed refresh failed`);
  }
  if (dismissalFailures) details.push(`${dismissalFailures} provider dismissal${dismissalFailures === 1 ? "" : "s"} failed`);
  return {
    text: [intro, ...details].join(" "),
    tone: unsupportedFeeds.length || failedFeeds.length || dismissalFailures || playlistFailures.length || seedFailures ? "muted" : "success",
  };
}

export async function syncUpNextToProviders() {
  if (!state.token || state.upNextSyncing) return null;
  if (state.savedConfig?.upNextSync?.enabled === false) {
    _cb.setMessage?.("Up Next sync is disabled in Settings → Sync → Sync Tuning.", "muted");
    return null;
  }
  // The rendered rail is intentionally capped at 30 cards, but the loaded
  // Plembfin snapshot (up to the server's 100-item bound) is authoritative.
  // Push the complete snapshot so off-screen provider items are reconciled too.
  const items = visibleUpNextItems().slice(0, 100).map(upNextSyncPayloadItem);
  state.upNextSyncing = true;
  renderUpNextControls();
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
    // Re-read the provider snapshots after the push and any known resume
    // checkpoints. Local dismissals still filter cards while provider feeds
    // catch up.
    await loadUpNext({ force: true });
    return body;
  } catch (error) {
    const detail = error?.name === "AbortError" ? "The provider push timed out." : (error?.message || "Try again later.");
    _cb.setMessage?.(`Could not push Plembfin Up Next to your media servers: ${detail}`, "muted");
    return null;
  } finally {
    window.clearTimeout(timeout);
    state.upNextSyncing = false;
    renderUpNextControls();
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
  document.addEventListener("plembfin:config-changed", () => renderUpNextControls());
  elements.upNextDismissedButton?.addEventListener("click", (event) => {
    event.preventDefault();
    openDismissedUpNextModal();
  });
  renderUpNextControls();
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
  state.upNextForceRefreshQueued = false;
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
  renderUpNextControls();
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
    if (fromSse || force) state.upNextRefreshQueued = true;
    if (force) state.upNextForceRefreshQueued = true;
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
    if (await migrateLocalDismissals()) {
      await loadDismissedUpNext();
      Promise.resolve().then(() => loadUpNext({ force: true })).catch(() => { });
    } else {
      await loadDismissedUpNext();
    }
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
      const forceRefreshQueued = state.upNextForceRefreshQueued;
      state.upNextRefreshQueued = false;
      state.upNextForceRefreshQueued = false;
      if (refreshQueued && (forceRefreshQueued || state.activeView === "dashboard")) {
        Promise.resolve().then(() => loadUpNext({ force: forceRefreshQueued, fromSse: !forceRefreshQueued })).catch(() => { });
      }
    }
  }
}

export function refreshUpNext() {
  return loadUpNext({ force: true });
}
