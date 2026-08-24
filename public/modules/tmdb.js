import { buildAuthHeaders } from "./auth.js";
import { state } from "./state.js";
import { showTitleFrom, slug } from "./utils.js";

let _tmdbBatchQueue = [];
let _tmdbBatchTimer = null;

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function flushTmdbBatch() {
  _tmdbBatchTimer = null;
  const batch = _tmdbBatchQueue;
  _tmdbBatchQueue = [];
  if (!batch.length) return;

  const payload = batch.map((item) => item.request);
  fetch("/api/tmdb-details-batch", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ items: payload }),
  })
    .then((res) => res.json().then((body) => ({ ok: res.ok, status: res.status, body })))
    .then(({ ok, status, body }) => {
      if (!ok) throw new Error(body?.error || `HTTP ${status}`);
      const results = Array.isArray(body?.results) ? body.results : [];
      batch.forEach((item, index) => {
        const r = results[index];
        item.resolve(r && r.details ? r.details : null);
      });
    })
    .catch((error) => {
      batch.forEach((item) => item.reject(error));
    });
}

// A batch answers only once its slowest item resolves, so anything a visible
// page is waiting on must not share a batch with background prefetch work.
// Detail views send their single item on its own request instead.
function requestTmdbDetailsNow(request) {
  return fetch("/api/tmdb-details-batch", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ items: [request] }),
  })
    .then((res) => res.json().then((body) => ({ ok: res.ok, status: res.status, body })))
    .then(({ ok, status, body }) => {
      if (!ok) throw new Error(body?.error || `HTTP ${status}`);
      const result = Array.isArray(body?.results) ? body.results[0] : null;
      return result && result.details ? result.details : null;
    });
}

export function normalizeTmdbLookupIds(ids = {}) {
  return {
    imdbId: ids.imdbId || ids.imdb_id || "",
    tvdbId: ids.tvdbId || ids.tvdb_id || "",
  };
}

function cacheResolvedDetails(mediaType, requestedKey, details) {
  if (!details || typeof details !== "object") return;
  const aliases = new Set([requestedKey]);
  if (details.id != null) aliases.add(`${mediaType}|${details.id}||||`);
  const title = details.title || details.name;
  if (title) aliases.add(`${mediaType}||${String(title).toLowerCase()}|||`);
  for (const key of aliases) state.tmdbDetailsCache.set(key, details);
}

// `light: true` is used by grid prefetch: the server skips next-airing and
// artwork enrichment on cold items. Light results are cached under their own
// key so a later full request (detail pages) still fetches complete data;
// full results satisfy light lookups.
export async function fetchTmdbDetails(mediaType, tmdbId, title, ids = {}, { light = false, immediate = false } = {}) {
  const lookupIds = normalizeTmdbLookupIds(ids);
  const baseKey = `${mediaType}|${tmdbId || ""}|${String(title || "").toLowerCase()}|${lookupIds.imdbId.toLowerCase()}|${lookupIds.tvdbId.toLowerCase()}`;
  if (state.tmdbDetailsCache.has(baseKey)) return state.tmdbDetailsCache.get(baseKey);
  const cacheKey = light ? `${baseKey}|light` : baseKey;
  if (light && state.tmdbDetailsCache.has(cacheKey)) return state.tmdbDetailsCache.get(cacheKey);
  if (!state.savedConfig.tmdb?.configured && !tmdbId && !title && !lookupIds.imdbId && !lookupIds.tvdbId) return null;

  const request = {
    mediaType,
    tmdbId: tmdbId || undefined,
    title: title || undefined,
    imdbId: lookupIds.imdbId || undefined,
    tvdbId: lookupIds.tvdbId || undefined,
    light: light || undefined,
  };

  const promise = immediate ? requestTmdbDetailsNow(request) : new Promise((resolve, reject) => {
    _tmdbBatchQueue.push({ request, resolve, reject });
    if (_tmdbBatchQueue.length >= 40) {
      clearTimeout(_tmdbBatchTimer);
      flushTmdbBatch();
    } else if (!_tmdbBatchTimer) {
      _tmdbBatchTimer = setTimeout(flushTmdbBatch, 50);
    }
  });

  state.tmdbDetailsCache.set(cacheKey, promise);
  promise
    .then((val) => {
      if (!val) {
        state.tmdbDetailsCache.delete(cacheKey);
        return;
      }
      state.tmdbDetailsCache.set(cacheKey, val);
      if (!light) cacheResolvedDetails(mediaType, baseKey, val);
    })
    .catch(() => state.tmdbDetailsCache.delete(cacheKey));
  return promise;
}

export async function fetchTmdbSeasonDetails(showId, seasonNumber) {
  // Per-season episode data is TVDB-backed server-side (built-in project key), so
  // this doesn't depend on the user having a personal TMDB key configured.
  // `showId` is a TMDB id, or `tvdb:<id>` for a series that only exists on TVDB.
  if (!showId || seasonNumber == null) return null;
  const cacheKey = `${showId}|${seasonNumber}`;
  if (state.tmdbSeasonCache.has(cacheKey)) return state.tmdbSeasonCache.get(cacheKey);
  const tvdbOnly = String(showId).startsWith("tvdb:");
  const idParam = tvdbOnly
    ? `tvdbId=${encodeURIComponent(String(showId).slice(5))}`
    : `tmdbId=${encodeURIComponent(showId)}`;
  const promise = fetch(`/api/tmdb-season?${idParam}&seasonNumber=${encodeURIComponent(seasonNumber)}`, { headers: authHeaders() })
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      return body;
    });
  state.tmdbSeasonCache.set(cacheKey, promise);
  promise
    .then((val) => {
      if (!val) {
        state.tmdbSeasonCache.delete(cacheKey);
        return;
      }
      state.tmdbSeasonCache.set(cacheKey, val);
    })
    .catch(() => state.tmdbSeasonCache.delete(cacheKey));
  return promise;
}

export async function resolveEpisodeTitleFromTmdb(entry, element) {
  if (!entry || entry.media_type !== "episode" || !entry.season || !entry.episode) return;
  try {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    if (!showTitle || showTitle === "Unknown Show") return;

    // Watch events are allowed to arrive with only a show title and episode
    // coordinates. Requiring a TMDB id here made otherwise valid rows keep the
    // generic "Episode N" label until somebody used Fix Match. Prefer a
    // trusted show-level identity when the explorer already knows one, but let
    // the metadata gateway resolve by title when it does not.
    const knownShow = state.showsRaw.find((show) => (
      (entry.show_tmdb_id && String(show.tmdb_id || "") === String(entry.show_tmdb_id))
      || (entry.show_tvdb_id && String(show.tvdb_id || "") === String(entry.show_tvdb_id))
    )) || ((!entry.show_tmdb_id && !entry.show_tvdb_id)
      ? state.showsRaw.find((show) => slug(show.title) === slug(showTitle))
      : null);
    const showTmdbId = knownShow?.tmdb_id || entry.show_tmdb_id || "";
    const tmdbData = await fetchTmdbDetails("tv", showTmdbId, showTitle, {
      imdbId: knownShow?.imdb_id || entry.show_imdb_id || "",
      tvdbId: knownShow?.tvdb_id || entry.show_tvdb_id || "",
    });
    if (!tmdbData?.id) return;
    const seasonData = await fetchTmdbSeasonDetails(tmdbData.id, entry.season);
    const tmdbEpisode = seasonData?.episodes?.find(
      (episode) => Number(episode.episode_number) === Number(entry.episode)
    );
    if (tmdbEpisode?.name) {
      entry.episode_title = tmdbEpisode.name;
      entry.episodeTitle = tmdbEpisode.name;
      if (element) {
        element.textContent = tmdbEpisode.name;
        element.title = tmdbEpisode.name;
      }
    }
    if (tmdbEpisode?.air_date) {
      entry.airDate = tmdbEpisode.air_date;
      entry.air_date = tmdbEpisode.air_date;
    }
  } catch {
    // TMDB enrichment is best-effort.
  }
}
