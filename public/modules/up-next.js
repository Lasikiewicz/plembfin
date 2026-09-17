import { buildAuthHeaders } from "./auth.js?v=1.1.1.7.3";
import { state, elements } from "./state.js?v=1.1.1.7.3";
import { escapeAttribute, escapeHtml, slug } from "./utils.js?v=1.1.1.7.3";
import { hydratePosters } from "./images.js?v=1.1.1.7.3";
import { hydrateMediaAppLinks } from "./media-detail-shared.js?v=1.1.1.7.3";
import { renderDashboardUpNextCard, updateDashboardRowWithMotion } from "./dashboard.js?v=1.1.1.7.3";
import { renderMediaCard } from "./media-card.js?v=1.1.1.7.3";

const UP_NEXT_TTL_MS = 2 * 60 * 1000;
const UP_NEXT_TIMEOUT_MS = 20000;
const UP_NEXT_DISMISSED_KEY = "plembfin:upNextDismissed:v1";
// v6 invalidates snapshots created before canonical episode identity and
// scheduled Part Watched artwork repair were applied.
const UP_NEXT_CACHE_KEY = "plembfin:upNextCache:v6";
const UP_NEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UP_NEXT_SYNC_TIMEOUT_MS = 60_000;
const UP_NEXT_PROVIDERS = new Set(["plex", "emby", "jellyfin"]);
const UP_NEXT_CONNECTION_HELP_URL = "https://plembfin.com/docs/troubleshooting/#media-server-connection-failures";
const UP_NEXT_CONNECTION_HELP_THRESHOLD = 2;
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

function identityValues(item = {}, kind = "tmdb") {
  const capitalized = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return [
    item[`${kind}_id`],
    item[`show_${kind}_id`],
    item[`${kind}Id`],
    item[`show${capitalized}Id`],
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

export function manualShowMatches(show = {}, candidate = {}) {
  const ids = ["tmdb", "tvdb", "imdb"];
  const sameId = ids.some((kind) => {
    const left = identityValues(show, kind);
    const right = identityValues(candidate, kind);
    return left.some((value) => right.includes(value));
  });
  if (sameId) return true;
  const leftTitle = slug(show.title || show.show_title || show.showTitle || "");
  const rightTitle = slug(candidate.title || candidate.show_title || candidate.showTitle || "");
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

export function isShowInUpNext(show = {}) {
  if ((state.upNextManualShows || []).some((candidate) => manualShowMatches(show, candidate))) return true;
  return (state.upNextItems || []).some((candidate) => (
    String(candidate?.media_type || candidate?.mediaType || "").toLowerCase() === "episode"
    && manualShowMatches(show, candidate)
  ));
}

function showFromUpNextButton(button) {
  const d = button?.dataset || {};
  return {
    title: d.upNextShowTitle || "TV show",
    tmdb_id: d.upNextShowTmdbId || "",
    tvdb_id: d.upNextShowTvdbId || "",
    imdb_id: d.upNextShowImdbId || "",
    poster_url: d.upNextShowPosterUrl || "",
  };
}

export function upNextShowActionHtml(show = {}) {
  const selected = isShowInUpNext(show);
  const title = show.title || show.show_title || "TV show";
  const action = selected ? "remove" : "add";
  return `
    <button class="action-pill action-pill-ghost media-up-next-show-btn${selected ? " is-added" : ""}" type="button"
      data-up-next-show-add
      data-up-next-show-action="${action}"
      data-up-next-show-title="${escapeAttribute(title)}"
      data-up-next-show-tmdb-id="${escapeAttribute(show.tmdb_id || show.tmdbId || show.show_tmdb_id || "")}"
      data-up-next-show-tvdb-id="${escapeAttribute(show.tvdb_id || show.tvdbId || show.show_tvdb_id || "")}"
      data-up-next-show-imdb-id="${escapeAttribute(show.imdb_id || show.imdbId || show.show_imdb_id || "")}"
      data-up-next-show-poster-url="${escapeAttribute(show.poster_url || show.posterUrl || show.show_poster_url || "")}"
      title="${selected ? "Remove this show from the dashboard Up Next rail" : "Add the next unwatched episode to the dashboard Up Next rail"}">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        ${selected ? '<path d="M3 8h10" />' : '<path d="M8 3v10M3 8h10" />'}
      </svg>
      <span>${selected ? "Remove from <br>Up Next" : "Add to <br>Up Next"}</span>
    </button>
  `;
}

export function upNextAttentionOptions(error, action = "update") {
  const verb = action === "remove" ? "remove" : "add";
  const message = String(error?.message || `Could not ${verb} this show to Up Next`).trim();
  if (error?.code === "UP_NEXT_SHOW_ROUTE_MISSING") {
    return {
      title: `Could not ${verb} show in Up Next`,
      explanation: "The media page is newer than the Plembfin server currently handling requests. The server returned HTTP 404 for the Up Next show endpoint, so it does not have this feature loaded.",
      recommendations: [
        "Stop and restart Plembfin so the local server loads the current build.",
        "Reload the media page after the restart, then add the show to Up Next again.",
        "If it still fails, open Settings → Logs and check that the page and server are using the same Plembfin installation.",
      ],
    };
  }
  return {
    title: `Could not ${verb} show in Up Next`,
    explanation: `Plembfin could not ${verb} this show in the dashboard Up Next rail. The request reported: ${message}`,
    recommendations: [
      "Try the action again once; this may be a temporary request failure.",
      "If it keeps failing, open Settings → Logs and check the Up Next request details.",
    ],
  };
}

export async function addShowToUpNext(button) {
  if (!button || button.disabled) return;
  const title = button.dataset.upNextShowTitle || "TV show";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const label = button.querySelector("span");
  const originalLabel = label?.innerHTML || "";
  let actionSucceeded = false;
  if (label) label.innerHTML = "Adding…";
  try {
    const response = await fetch("/api/up-next/show", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
      body: JSON.stringify({
        title,
        tmdb_id: button.dataset.upNextShowTmdbId || "",
        tvdb_id: button.dataset.upNextShowTvdbId || "",
        imdb_id: button.dataset.upNextShowImdbId || "",
        poster_url: button.dataset.upNextShowPosterUrl || "",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 404 && body.error === "Not found"
        ? "The running Plembfin server does not support adding TV shows to Up Next (POST /api/up-next/show). Restart Plembfin, reload this page, and try again."
        : body.error || `Could not add "${title}" to Up Next`);
      error.status = response.status;
      if (response.status === 404 && body.error === "Not found") error.code = "UP_NEXT_SHOW_ROUTE_MISSING";
      throw error;
    }
    if (Array.isArray(body.manualShows)) state.upNextManualShows = body.manualShows;
    clearLocalUpNextDismissalsForShow({
      title,
      tmdb_id: button.dataset.upNextShowTmdbId || "",
      tvdb_id: button.dataset.upNextShowTvdbId || "",
      imdb_id: button.dataset.upNextShowImdbId || "",
    });
    button.classList.add("is-added");
    if (label) label.innerHTML = "Remove from <br>Up Next";
    else button.textContent = "Remove from up next";
    button.dataset.upNextShowAction = "remove";
    button.dataset.upNextShowToggle = "remove";
    button.title = "Remove this show from the dashboard Up Next rail";
    actionSucceeded = true;
    _cb.setMessage?.(`Added "${title}" to Up Next`, "success");
    await loadUpNext({ force: true });
  } finally {
    if (!actionSucceeded && label) label.innerHTML = originalLabel;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

export async function removeManualShowFromUpNext(show = {}) {
  const manual = (state.upNextManualShows || []).find((candidate) => manualShowMatches(show, candidate)) || null;
  const response = await fetch("/api/up-next/show", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
    body: JSON.stringify({
      remove: true,
      id: manual?.id || "",
      title: show.title || manual?.title || "TV show",
      tmdb_id: show.tmdb_id || show.tmdbId || manual?.tmdb_id || "",
      tvdb_id: show.tvdb_id || show.tvdbId || manual?.tvdb_id || "",
      imdb_id: show.imdb_id || show.imdbId || manual?.imdb_id || "",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Could not remove "${show.title || manual?.title || "TV show"}" from Up Next`);
  if (Array.isArray(body.manualShows)) state.upNextManualShows = body.manualShows;
  return Boolean(body.removed);
}

export async function removeShowFromUpNext(button) {
  if (!button || button.disabled) return;
  const show = showFromUpNextButton(button);
  const manual = (state.upNextManualShows || []).find((candidate) => manualShowMatches(show, candidate)) || null;
  const item = (state.upNextItems || []).find((candidate) => (
    String(candidate?.media_type || candidate?.mediaType || "").toLowerCase() === "episode"
    && manualShowMatches(show, candidate)
  )) || null;
  if (!manual && !item) return;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const label = button.querySelector("span");
  const originalLabel = label?.innerHTML || "";
  let actionSucceeded = false;
  if (label) label.innerHTML = "Removing…";
  try {
    if (item) {
      const response = await fetch("/api/up-next/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
        body: JSON.stringify({
          media_key: item.media_key || item.id || "",
          media_type: "episode",
          queue_kind: item.queue_kind || item.queueKind || "next_up",
          title: item.title || item.episode_title || show.title,
          show_title: item.show_title || item.showTitle || show.title,
          tmdb_id: item.tmdb_id || item.tmdbId || item.show_tmdb_id || item.showTmdbId || show.tmdb_id,
          imdb_id: item.imdb_id || item.imdbId || item.show_imdb_id || item.showImdbId || show.imdb_id,
          tvdb_id: item.tvdb_id || item.tvdbId || item.show_tvdb_id || item.showTvdbId || show.tvdb_id,
          season: item.season ?? "",
          episode: item.episode ?? "",
          provider_items: item.provider_items || item.providerItems || {},
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not remove "${show.title}" from Up Next`);
      removeUpNextItem(item.id || item.media_key, item, { showScope: true });
    }

    if (manual || item) await removeManualShowFromUpNext(show);

    button.classList.remove("is-added");
    if (label) label.innerHTML = "Add to <br>Up Next";
    else button.textContent = "Add to up next";
    button.dataset.upNextShowAction = "add";
    button.dataset.upNextShowToggle = "add";
    button.title = "Add the next unwatched episode to the dashboard Up Next rail";
    actionSucceeded = true;
    _cb.setMessage?.(`Removed "${show.title}" from Up Next`, "success");
    await loadUpNext({ force: true });
  } finally {
    if (!actionSucceeded && label) label.innerHTML = originalLabel;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

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

function upNextShowDismissalKeys(item = {}) {
  const mediaType = String(item.media_type || item.mediaType || "").trim().toLowerCase();
  if (mediaType !== "episode") return [];
  const keys = [];
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    const id = String(item[`show_${provider}_id`] || item[`show${provider.charAt(0).toUpperCase()}${provider.slice(1)}Id`] || "").trim();
    if (id) keys.push(`show:${provider}:${id.toLowerCase()}`);
  }
  const showTitle = String(item.show_title || item.showTitle || "")
    .trim()
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (showTitle) keys.push(`show:title:${showTitle}`);
  return [...new Set(keys)];
}

// Adding a show from its media page is an explicit request to make it
// eligible again. The server removes its dismissal, but older browser
// sessions can still have the pre-server dismissal key in localStorage. Clear
// every matching local key before the refreshed projection is rendered so the
// newly added card cannot be filtered out locally.
function clearLocalUpNextDismissalsForShow(show = {}) {
  const identity = {
    media_type: "episode",
    show_title: show.title || show.show_title || show.showTitle || "",
    show_tmdb_id: show.tmdb_id || show.tmdbId || show.show_tmdb_id || show.showTmdbId || "",
    show_tvdb_id: show.tvdb_id || show.tvdbId || show.show_tvdb_id || show.showTvdbId || "",
    show_imdb_id: show.imdb_id || show.imdbId || show.show_imdb_id || show.showImdbId || "",
  };
  const keys = new Set(upNextShowDismissalKeys(identity));
  const candidates = [
    ...(Array.isArray(state.upNextItems) ? state.upNextItems : []),
    ...dismissedUpNextItems().map((entry) => {
      const snapshot = dismissalSnapshot(entry);
      return {
        ...snapshot,
        ...entry,
        title: entry.show_title || snapshot.show_title || snapshot.showTitle || snapshot.title || "",
        show_title: entry.show_title || snapshot.show_title || snapshot.showTitle || "",
        show_tmdb_id: entry.show_tmdb_id || snapshot.show_tmdb_id || snapshot.showTmdbId || "",
        show_tvdb_id: entry.show_tvdb_id || snapshot.show_tvdb_id || snapshot.showTvdbId || "",
        show_imdb_id: entry.show_imdb_id || snapshot.show_imdb_id || snapshot.showImdbId || "",
        media_type: "episode",
      };
    }),
  ];
  let changed = false;
  for (const candidate of candidates) {
    if (!manualShowMatches(show, candidate)) continue;
    for (const key of upNextDismissalKeys(candidate)) {
      if (!Object.prototype.hasOwnProperty.call(dismissedUpNext, key)) continue;
      delete dismissedUpNext[key];
      changed = true;
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(dismissedUpNext, key)) continue;
    delete dismissedUpNext[key];
    changed = true;
  }
  if (changed) persistDismissedUpNext();
  return changed;
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
  for (const key of upNextShowDismissalKeys(item)) keys.add(key);
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

export function removeUpNextItem(itemId, details = {}, { showScope = false } = {}) {
  const id = String(itemId || "").trim();
  const mediaKey = String(details.media_key || details.mediaKey || "").trim();
  if (!id && !mediaKey) return;
  const removedIndex = state.upNextItems.findIndex((item) => String(item?.id || "") === id || String(item?.media_key || "") === mediaKey);
  const removedItem = removedIndex >= 0
    ? state.upNextItems[removedIndex]
    : { ...details, id: details.id || id, media_key: details.media_key || mediaKey || id };
  const showKeys = showScope ? new Set(upNextShowDismissalKeys(removedItem)) : new Set();
  const matchesRemoval = (item) => {
    const isSameItem = String(item?.id || "") === id || String(item?.media_key || "") === mediaKey;
    if (isSameItem) return true;
    return showKeys.size > 0 && upNextShowDismissalKeys(item).some((key) => showKeys.has(key));
  };
  const removedItems = state.upNextItems.filter(matchesRemoval);
  // The caller keeps the card in a pending-removal state until the server has
  // accepted the dismissal. Once that happens, remove every visible episode
  // from the same series in one repaint and let the row play its exit motion.
  state.upNextExitIds = removedItems.map((item) => String(item?.id || item?.media_key || "")).filter(Boolean);
  if (!removedItems.length) state.upNextExitIds = [id || mediaKey].filter(Boolean);
  const removedPendingKeys = new Set([removedItem, ...removedItems].flatMap((item) => upNextPendingRemovalKeys(item)));
  state.upNextPendingRemovalKeys = (state.upNextPendingRemovalKeys || []).filter((key) => !removedPendingKeys.has(key));
  state.upNextItems = state.upNextItems.filter((item) => !matchesRemoval(item));
  persistUpNextCache(visibleUpNextItems());
  renderUpNext();
  return { item: removedItem, items: removedItems.length ? removedItems : [removedItem], index: Math.max(0, removedIndex) };
}

export function restoreUpNextItem(removal = {}) {
  const items = (Array.isArray(removal?.items) ? removal.items : [removal?.item])
    .filter((item) => item && typeof item === "object");
  if (!items.length) return;
  for (const item of items) for (const key of upNextDismissalKeys(item)) delete dismissedUpNext[key];
  persistDismissedUpNext();
  const index = Math.max(0, Math.min(Number(removal.index) || 0, state.upNextItems.length));
  const existingIds = new Set(state.upNextItems.map((candidate) => String(candidate?.id || candidate?.media_key || "")).filter(Boolean));
  const restored = items.filter((item) => {
    const itemId = String(item.id || item.media_key || "").trim();
    if (!itemId || existingIds.has(itemId)) return false;
    existingIds.add(itemId);
    return true;
  });
  if (!restored.length) return;
  state.upNextItems = [
    ...state.upNextItems.slice(0, index),
    ...restored,
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

function dismissalSnapshot(entry = {}) {
  return entry?.item && typeof entry.item === "object" && Object.keys(entry.item).length
    ? entry.item
    : entry;
}

function dismissalMediaType(entry = {}) {
  const item = dismissalSnapshot(entry);
  return String(entry.media_type || item.media_type || item.mediaType || "").trim().toLowerCase() === "episode"
    ? "episode"
    : "movie";
}

function dismissalShowKey(entry = {}) {
  const item = dismissalSnapshot(entry);
  if (dismissalMediaType(entry) !== "episode") return `movie:${String(entry.id || item.id || "").trim()}`;
  const tmdb = String(entry.show_tmdb_id || item.show_tmdb_id || item.showTmdbId || "").trim();
  const tvdb = String(entry.show_tvdb_id || item.show_tvdb_id || item.showTvdbId || "").trim();
  const imdb = String(entry.show_imdb_id || item.show_imdb_id || item.showImdbId || "").trim().toLowerCase();
  const title = String(entry.show_title || item.show_title || item.showTitle || "").trim();
  if (tmdb) return `show:tmdb:${tmdb.toLowerCase()}`;
  if (tvdb) return `show:tvdb:${tvdb.toLowerCase()}`;
  if (imdb) return `show:imdb:${imdb}`;
  return `show:title:${slug(title || entry.title || item.title || "untitled")}`;
}

function dismissalShowKeys(entry = {}) {
  if (dismissalMediaType(entry) !== "episode") return [];
  const item = dismissalSnapshot(entry);
  return upNextShowDismissalKeys({
    media_type: "episode",
    show_title: entry.show_title || item.show_title || item.showTitle || "",
    show_tmdb_id: entry.show_tmdb_id || item.show_tmdb_id || item.showTmdbId || "",
    show_tvdb_id: entry.show_tvdb_id || item.show_tvdb_id || item.showTvdbId || "",
    show_imdb_id: entry.show_imdb_id || item.show_imdb_id || item.showImdbId || "",
  });
}

function dismissedUpNextGroups() {
  const groups = new Map();
  for (const entry of dismissedUpNextItems()) {
    const key = dismissalShowKey(entry);
    let group = groups.get(key);
    if (!group) {
      group = { key, entries: [], representative: entry };
      groups.set(key, group);
    }
    group.entries.push(entry);
    const candidate = dismissalSnapshot(entry);
    const current = dismissalSnapshot(group.representative);
    if (!current?.show_poster_url && (candidate?.show_poster_url || candidate?.showPosterUrl || candidate?.canonical_poster_url)) {
      group.representative = entry;
    }
  }
  return [...groups.values()];
}

function dismissedUpNextCardRecord(group) {
  const source = dismissalSnapshot(group.representative);
  const isEpisode = dismissalMediaType(group.representative) === "episode";
  if (!isEpisode) {
    return {
      ...source,
      id: `dismissed:${group.key}`,
      media_type: "movie",
      title: group.representative.title || source.title || "Untitled",
      meta: "Dismissed from Up Next",
      description: "This movie will stay out of Up Next until you add it back.",
    };
  }
  const showTitle = group.representative.show_title || source.show_title || source.showTitle || source.title || "Unknown show";
  const showTmdbId = group.representative.show_tmdb_id || source.show_tmdb_id || source.showTmdbId || "";
  const showTvdbId = group.representative.show_tvdb_id || source.show_tvdb_id || source.showTvdbId || "";
  const showImdbId = group.representative.show_imdb_id || source.show_imdb_id || source.showImdbId || "";
  const showPoster = source.show_poster_url || source.showPosterUrl || source.canonical_poster_url || source.canonicalPosterUrl || "";
  return {
    ...source,
    id: `dismissed:${group.key}`,
    media_type: "tv",
    title: showTitle,
    tmdb_id: showTmdbId,
    tvdb_id: showTvdbId,
    imdb_id: showImdbId,
    show_tmdb_id: showTmdbId,
    show_tvdb_id: showTvdbId,
    show_imdb_id: showImdbId,
    poster_url: showPoster || source.poster_url || source.posterUrl || "",
    show_poster_url: showPoster,
    meta: "Dismissed from Up Next",
    description: "This show will stay out of Up Next until you add it back.",
  };
}

function upNextPendingRemovalKeys(item = {}) {
  const mediaType = String(item.media_type || item.mediaType || "").trim().toLowerCase();
  const normalized = {
    ...item,
    media_type: mediaType,
    show_title: item.show_title || item.showTitle || "",
    show_tmdb_id: item.show_tmdb_id || item.showTmdbId || (mediaType === "episode" ? item.tmdb_id || item.tmdbId || "" : ""),
    show_tvdb_id: item.show_tvdb_id || item.showTvdbId || (mediaType === "episode" ? item.tvdb_id || item.tvdbId || "" : ""),
    show_imdb_id: item.show_imdb_id || item.showImdbId || (mediaType === "episode" ? item.imdb_id || item.imdbId || "" : ""),
  };
  return upNextDismissalKeys(normalized);
}

function isUpNextRemovalPending(item) {
  const pending = new Set(state.upNextPendingRemovalKeys || []);
  return upNextPendingRemovalKeys(item).some((key) => pending.has(key));
}

function upNextWatchEpisodeIdentity(episode = {}) {
  return {
    ...episode,
    media_type: "episode",
    show_title: episode.show_title || episode.showTitle || "",
    show_tmdb_id: episode.show_tmdb_id || episode.showTmdbId || "",
    show_tvdb_id: episode.show_tvdb_id || episode.showTvdbId || "",
    show_imdb_id: episode.show_imdb_id || episode.showImdbId || "",
    season: episode.season ?? episode.seasonNumber ?? "",
    episode: episode.episode ?? episode.episodeNumber ?? "",
    media_key: episode.media_key || episode.mediaKey || "",
  };
}

function upNextWatchedActionKeys(action = {}) {
  const episodes = [
    ...(Array.isArray(action.episodes) ? action.episodes : []),
    ...(Array.isArray(action.resyncEpisodes) ? action.resyncEpisodes : []),
  ];
  if (action.scope === "show") {
    const anchor = upNextWatchEpisodeIdentity({
      showTitle: action.showTitle || action.show_title || episodes[0]?.showTitle || "",
      showTmdbId: action.showTmdbId || action.show_tmdb_id || episodes[0]?.showTmdbId || "",
      showTvdbId: action.showTvdbId || action.show_tvdb_id || episodes[0]?.showTvdbId || "",
      showImdbId: action.showImdbId || action.show_imdb_id || episodes[0]?.showImdbId || "",
    });
    return upNextShowDismissalKeys(anchor);
  }
  return [...new Set(episodes.flatMap((episode) => {
    const identity = upNextWatchEpisodeIdentity(episode);
    return [
      upNextCoordinateDismissalKey(identity),
      identity.media_key,
      identity.provider_item_id || identity.providerItemId || "",
    ].filter(Boolean);
  }))];
}

function upNextShowIdentityMatches(left = {}, right = {}) {
  const leftKeys = new Set(upNextShowDismissalKeys({
    media_type: "episode",
    show_title: left.show_title || left.showTitle || "",
    show_tmdb_id: left.show_tmdb_id || left.showTmdbId || "",
    show_tvdb_id: left.show_tvdb_id || left.showTvdbId || "",
    show_imdb_id: left.show_imdb_id || left.showImdbId || "",
  }));
  const rightKeys = upNextShowDismissalKeys({
    media_type: "episode",
    show_title: right.show_title || right.showTitle || "",
    show_tmdb_id: right.show_tmdb_id || right.showTmdbId || "",
    show_tvdb_id: right.show_tvdb_id || right.showTvdbId || "",
    show_imdb_id: right.show_imdb_id || right.showImdbId || "",
  });
  return rightKeys.some((key) => leftKeys.has(key));
}

function upNextActionEpisodeMatches(item = {}, action = {}) {
  const itemIdentity = upNextWatchEpisodeIdentity(item);
  const itemCoordinate = upNextCoordinateDismissalKey(itemIdentity);
  if (!itemCoordinate) return false;
  const episodes = [
    ...(Array.isArray(action.episodes) ? action.episodes : []),
    ...(Array.isArray(action.resyncEpisodes) ? action.resyncEpisodes : []),
  ];
  return episodes.some((episode) => {
    const episodeIdentity = upNextWatchEpisodeIdentity(episode);
    return upNextCoordinateDismissalKey(episodeIdentity) === itemCoordinate
      && upNextShowIdentityMatches(itemIdentity, episodeIdentity);
  });
}

function isUpNextWatchedRemovalPending(item) {
  const pending = new Set(state.upNextPendingWatchedRemovalKeys || []);
  if (!pending.size) return false;
  return upNextDismissalKeys(item).some((key) => pending.has(key));
}

// Marking a show watched changes the canonical watch state before the derived
// Up Next snapshot necessarily catches up. Remove its cards locally right
// away, then keep an optimistic identity filter active while any concurrent
// sync/revalidation still returns the old snapshot.
export function removeWatchedUpNextItems(action = {}) {
  const keys = upNextWatchedActionKeys(action);
  if (!keys.length) return 0;
  const pending = new Set(state.upNextPendingWatchedRemovalKeys || []);
  keys.forEach((key) => pending.add(key));
  state.upNextPendingWatchedRemovalKeys = [...pending];

  const removedItems = (Array.isArray(state.upNextItems) ? state.upNextItems : [])
    .filter(isUpNextWatchedRemovalPending);
  if (!removedItems.length) return 0;

  state.upNextExitIds = removedItems
    .map((item) => String(item?.id || item?.media_key || "").trim())
    .filter(Boolean);
  state.upNextItems = state.upNextItems.filter((item) => !isUpNextWatchedRemovalPending(item));
  persistUpNextCache(visibleUpNextItems());
  renderUpNext();
  return removedItems.length;
}

// Unwatching a TV show makes its next episode eligible for Up Next again. A
// dismissal is therefore stale at that point: restore every server-side
// dismissal for the show and clear the optimistic watched-removal filter that
// could otherwise hide the freshly restored card during the next refresh.
export async function removeDismissedUpNextItems(action = {}) {
  const keys = new Set(upNextWatchedActionKeys({ ...action, scope: "show" }));
  if (!keys.size) return 0;

  state.upNextPendingWatchedRemovalKeys = (state.upNextPendingWatchedRemovalKeys || [])
    .filter((key) => !keys.has(key));
  const entries = dismissedUpNextItems().filter((entry) => (
    dismissalShowKeys(entry).some((key) => keys.has(key))
  ));
  if (!entries.length) return 0;
  return restoreDismissedUpNextItems(entries);
}

function filterPendingWatchedUpNextItems(nextItems = [], { authoritative = false } = {}) {
  const pending = new Set(state.upNextPendingWatchedRemovalKeys || []);
  if (!pending.size) return nextItems;
  const serverStillHasPendingItems = nextItems.some(isUpNextWatchedRemovalPending);
  // A stale cache is allowed to omit the card before reintroducing it from a
  // second provider snapshot. Keep the optimistic watched filter alive until
  // a fresh projection has actually confirmed the item is gone.
  if (!serverStillHasPendingItems && authoritative) {
    state.upNextPendingWatchedRemovalKeys = [];
    return nextItems;
  }
  return nextItems.filter((item) => !isUpNextWatchedRemovalPending(item));
}

function isUpNextWatchSaving(item = {}) {
  const savingActions = [
    ...(state.savingWatchActions || []),
    ...(state.savingUnwatchActions || []),
  ];
  for (const action of savingActions) {
    if (action?.scope === "show") {
      const actionKeys = new Set(upNextWatchedActionKeys(action));
      if (upNextShowDismissalKeys(item).some((key) => actionKeys.has(key))) return true;
    } else if (upNextActionEpisodeMatches(item, action)) {
      return true;
    }
  }
  return false;
}

function preservePendingUpNextItems(nextItems = []) {
  const currentItems = Array.isArray(state.upNextItems) ? state.upNextItems : [];
  const pendingItems = currentItems.filter(isUpNextRemovalPending);
  if (!pendingItems.length) return nextItems;
  const nextByKey = new Map(nextItems.map((item) => [upNextItemKey(item), item]));
  const seen = new Set();
  const preserved = [];
  for (const current of currentItems) {
    const key = upNextItemKey(current);
    if (!key || seen.has(key)) continue;
    if (isUpNextRemovalPending(current) && !nextByKey.has(key)) {
      preserved.push(current);
      seen.add(key);
    }
  }
  if (!preserved.length) return nextItems;
  return [...preserved, ...nextItems.filter((item) => !seen.has(upNextItemKey(item)))];
}

export function setUpNextRemovalPending(item, pending = true) {
  const keys = upNextPendingRemovalKeys(item);
  if (!keys.length) return;
  const next = new Set(state.upNextPendingRemovalKeys || []);
  for (const key of keys) {
    if (pending) next.add(key);
    else next.delete(key);
  }
  state.upNextPendingRemovalKeys = [...next];
  renderUpNext();
}

// A watch action can start from the show detail page while the dashboard rail
// is still mounted. Re-render it immediately so the same Saving animation is
// visible there, not only for actions launched from an Up Next card.
export function setUpNextWatchSavingState() {
  renderUpNext();
}

export function setUpNextUnwatchSavingState() {
  renderUpNext();
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
  const groups = dismissedUpNextGroups();
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay settings-modal-overlay up-next-dismissed-overlay";
  const cards = groups.map((group) => {
    const record = dismissedUpNextCardRecord(group);
    return renderMediaCard(record, {
      variant: "up-next-dismissed",
      meta: record.meta,
      showSource: false,
      actionsHtml: `<button class="button-ghost" type="button" data-up-next-restore-group="${escapeHtml(group.key)}">Add back</button>`,
    });
  }).join("");
  const body = items.length
    ? `<p class="up-next-dismissed-intro">Dismissed on every device. Adding a card back returns it to Up Next and pushes the queue to your media servers.</p>
       <div class="up-next-dismissed-card-grid">${cards}</div>`
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
          ${groups.length > 1 ? `<button class="button-ghost" type="button" data-up-next-restore-all>Add all back</button>` : ""}
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
  overlay.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-media-card-href]");
    if (link || event.target === overlay) close();
  }, true);
  overlay.querySelector(".settings-modal-close").addEventListener("click", close);
  overlay.querySelector(".settings-modal-cancel").addEventListener("click", close);
  overlay.querySelector("[data-up-next-restore-all]")?.addEventListener("click", () => restoreAndPush(items));
  overlay.querySelectorAll("[data-up-next-restore-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = byKey.get(button.dataset.upNextRestoreGroup);
      if (group) restoreAndPush(group.entries);
    });
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
  hydratePosters(overlay, { allowNetwork: true });
  overlay.querySelector("[data-up-next-restore-group], .settings-modal-close")?.focus({ preventScroll: true });
}

function renderUpNextDismissedControl() {
  const button = elements.upNextDismissedButton;
  if (!button) return;
  const count = state.token ? dismissedUpNextGroups().length : 0;
  button.classList.toggle("hidden", count === 0);
  button.disabled = count === 0 || state.upNextSyncing === true;
  const label = `Show ${count} dismissed Up Next card${count === 1 ? "" : "s"}`;
  button.querySelector(".up-next-dismissed-count").textContent = String(count);
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

const UP_NEXT_NATIVE_RAIL_LABELS = {
  plex: "Continue Watching",
  emby: "Continue Watching",
  jellyfin: "Next Up",
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

function upNextNativeRailLabel(provider) {
  return UP_NEXT_NATIVE_RAIL_LABELS[String(provider || "").toLowerCase()] || "native Up Next rail";
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
    const providerIssues = new Map();
    for (const feed of failedFeeds) {
      const provider = String(feed?.provider || "provider").toLowerCase();
      if (!providerIssues.has(provider)) providerIssues.set(provider, []);
      providerIssues.get(provider).push(feed);
    }
    const providerLabels = upNextListLabel([...providerIssues.keys()]
      .map((provider) => UP_NEXT_PROVIDER_LABELS[provider] || provider));
    const details = failedFeeds
      .map((feed) => `${upNextFeedLabel(feed)}: ${String(feed?.last_error || "No error detail recorded.")}`)
      .join("\n");
    const rows = [...providerIssues.entries()].map(([provider, feeds]) => {
      const providerLabel = UP_NEXT_PROVIDER_LABELS[provider] || provider;
      const feedDetail = feeds
        .map((feed) => `${upNextFeedLabel(feed)}: ${upNextFailureReason(feed)}`)
        .join(" · ");
      const retrying = state.upNextConnectionRetryingProvider === provider;
      const retryError = state.upNextConnectionRetryErrorProvider === provider
        ? state.upNextConnectionRetryError
        : "";
      const retryAttempts = Number(state.upNextConnectionRetryAttempts?.[provider] || 0);
      const showHelp = retryAttempts >= UP_NEXT_CONNECTION_HELP_THRESHOLD;
      return `
        <div class="up-next-source-status-row">
          <div class="up-next-source-status-row-copy">
            <strong>${escapeHtml(providerLabel)} connection unavailable</strong>
          </div>
          <span class="up-next-source-status-separator" aria-hidden="true">—</span>
          <button class="button-ghost up-next-source-retry" type="button"
            data-up-next-retry-connection="${escapeAttribute(provider)}"
            aria-label="Retry ${escapeAttribute(providerLabel)} connection"
            title="${escapeAttribute(retryError ? `Retry failed: ${retryError}. ${feedDetail}` : feedDetail)}"
            ${retrying ? "disabled aria-busy=\"true\"" : ""}>${retrying ? "Checking…" : "Retry Connection"}</button>
          ${showHelp ? `<a class="up-next-source-help" href="${UP_NEXT_CONNECTION_HELP_URL}" target="_blank" rel="noopener noreferrer" aria-label="Open help for ${escapeAttribute(providerLabel)} connection failures">Help</a>` : ""}
        </div>
      `;
    }).join("");
    const copy = `${providerLabels} ${providerIssues.size === 1 ? "is" : "are"} unavailable.`;
    status.innerHTML = rows;
    status.title = `${details}\n\nPlembfin retries failed provider connections every few minutes. If a retry keeps failing, check Settings → Connections.`;
    status.setAttribute("aria-label", copy);
  } else {
    status.innerHTML = "";
    status.title = "";
    status.removeAttribute("aria-label");
  }
  status.classList.toggle("hidden", !unavailable);
}

export async function retryUpNextConnection(provider) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!UP_NEXT_PROVIDERS.has(normalizedProvider) || !state.token || state.upNextConnectionRetryingProvider) return null;
  const providerLabel = UP_NEXT_PROVIDER_LABELS[normalizedProvider] || normalizedProvider;
  state.upNextConnectionRetryingProvider = normalizedProvider;
  state.upNextConnectionRetryError = "";
  state.upNextConnectionRetryErrorProvider = "";
  renderUpNextSourceStatus();
  try {
    const response = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
      body: JSON.stringify({ type: normalizedProvider }),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      const error = new Error(body.error || `Could not connect to ${providerLabel}`);
      error.status = response.status;
      throw error;
    }
    state.upNextConnectionRetryAttempts = { ...(state.upNextConnectionRetryAttempts || {}) };
    delete state.upNextConnectionRetryAttempts[normalizedProvider];
    _cb.setMessage?.(`${providerLabel} connection restored. Refreshing Up Next…`, "success");
    await loadUpNext({ force: true });
    return body;
  } catch (error) {
    const attempts = Number(state.upNextConnectionRetryAttempts?.[normalizedProvider] || 0) + 1;
    state.upNextConnectionRetryAttempts = {
      ...(state.upNextConnectionRetryAttempts || {}),
      [normalizedProvider]: attempts,
    };
    state.upNextConnectionRetryError = upNextFailureReason({ last_error: error?.message || "Connection failed" });
    state.upNextConnectionRetryErrorProvider = normalizedProvider;
    _cb.setMessage?.(`Could not connect to ${providerLabel}: ${state.upNextConnectionRetryError}`, "error");
    renderUpNextSourceStatus();
    return null;
  } finally {
    state.upNextConnectionRetryingProvider = "";
    renderUpNextSourceStatus();
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
  const label = button.querySelector(".up-next-sync-label");
  button.disabled = !signedIn || !syncEnabled || syncing || loading;
  button.setAttribute("aria-busy", String(syncing));
  if (label) label.textContent = syncing ? "Syncing…" : "";
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
  const jellyfinRail = body.jellyfinRail && typeof body.jellyfinRail === "object" ? body.jellyfinRail : {};
  const providerRails = Array.isArray(body.providerRails) ? body.providerRails : [];
  const legacyRailCleanup = Array.isArray(body.legacyRailCleanup) ? body.legacyRailCleanup : [];
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
  const railSummaries = providerRails.length ? providerRails : (jellyfinRail.provider ? [jellyfinRail] : []);
  const railFailures = railSummaries.reduce((total, rail) => total + Number(rail?.failed_count || 0), 0);
  const refreshedByRail = railSummaries
    .filter((rail) => Number(rail?.refreshed_count ?? rail?.promoted_count ?? 0) > 0)
    .map((rail) => {
      const count = Number(rail.refreshed_count ?? rail.promoted_count ?? 0);
      const provider = providerNames[String(rail?.provider || "").toLowerCase()] || "Provider";
      return `${provider}: ${upNextNativeRailLabel(rail.provider)} refreshed for ${count} item${count === 1 ? "" : "s"}`;
    });
  const legacyCleared = railSummaries.reduce((total, rail) => total + Number(rail?.cleared_legacy_seed_count || 0), 0)
    + legacyRailCleanup.filter((entry) => entry?.status === "cleared").length;
  const legacyFailures = legacyRailCleanup.filter((entry) => entry?.status !== "cleared").length;
  if (refreshedByRail.length) details.push(refreshedByRail.join("; "));
  if (legacyCleared) details.push(`cleared ${legacyCleared} legacy native-rail position${legacyCleared === 1 ? "" : "s"}`);
  if (railFailures) details.push(`native Up Next rail refresh failed for ${railFailures} item${railFailures === 1 ? "" : "s"}`);
  if (dismissed) details.push(`${dismissed} removed item${dismissed === 1 ? "" : "s"} hidden on connected apps`);
  if (progressTargets.size) details.push(`resume position sent to ${upNextListLabel([...progressTargets])}`);
  if (unsupportedFeeds.length) details.push(`${upNextListLabel(unsupportedFeeds)} ${unsupportedFeeds.length === 1 ? "is" : "are"} calculated by the native API and ${unsupportedFeeds.length === 1 ? "was" : "were"} left unchanged`);
  if (failedFeeds.length) {
    details.push(`${upNextListLabel([...new Set(failedFeeds.map((feed) => providerNames[String(feed.provider || "").toLowerCase()] || feed.provider || "provider"))])} feed refresh failed`);
  }
  if (dismissalFailures) details.push(`${dismissalFailures} provider dismissal${dismissalFailures === 1 ? "" : "s"} failed`);
  return {
    text: [intro, ...details].join(" "),
    tone: unsupportedFeeds.length || failedFeeds.length || dismissalFailures || railFailures || legacyFailures ? "muted" : "success",
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
  elements.upNextSourceStatus?.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-up-next-retry-connection]");
    if (!retry) return;
    event.preventDefault();
    retryUpNextConnection(retry.dataset.upNextRetryConnection).catch(() => { });
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
  state.upNextConnectionRetryingProvider = "";
  state.upNextConnectionRetryAttempts = {};
  state.upNextConnectionRetryError = "";
  state.upNextConnectionRetryErrorProvider = "";
  state.upNextLoadedAt = 0;
  state.upNextError = "";
  state.upNextErrorCode = "";
  state.upNextExitIds = [];
  state.upNextPendingRemovalKeys = [];
  if (!preserveItems) state.upNextPendingWatchedRemovalKeys = [];
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
    saving: item.pending_sync === true || isUpNextWatchSaving(item),
    pending_removal: isUpNextRemovalPending(item),
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
    const fetchedItems = Array.isArray(body.items) ? body.items : [];
    const nextItems = filterPendingWatchedUpNextItems(
      preservePendingUpNextItems(fetchedItems),
      { authoritative: body.cacheStale !== true },
    );
    const nextIds = new Set(nextItems.filter((item) => !isUpNextItemDismissed(item)).map((item) => String(item?.id || "")).filter(Boolean));
    state.upNextExitIds = [...previousIds].filter((id) => !nextIds.has(id));
    state.upNextItems = nextItems;
    if (Array.isArray(body.manualShows)) state.upNextManualShows = body.manualShows;
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
