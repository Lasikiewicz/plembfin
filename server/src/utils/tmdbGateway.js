import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { fetchWithTimeout } from "./outbound.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";
import { cacheBackdropFromUrl, cacheLogoFromUrl, cachePosterFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "./posterCache.js";
import { getFanartMovieArt, getFanartTvArt } from "./fanartGateway.js";
import { resolveTvdbSeriesId, getTvdbSeriesExtended, getTvdbSeasonEpisodes, shapeTvdbSeriesAsTmdb } from "./tvdbGateway.js";

const API_ROOT = "https://api.themoviedb.org/3";
const IMAGE_ROOT = "https://image.tmdb.org/t/p";
const DAY_MS = 24 * 60 * 60 * 1000;
const DETAILS_SCHEMA_VERSION = 9; // bumped: number_of_episodes/number_of_seasons now exclude specials (season 0), which were inflating watched-progress totals
const PERSON_SCHEMA_VERSION = 5;
const SEARCH_TTL_MS = 15 * 60 * 1000;
const MISSING_TTL_MS = DAY_MS;
const PERSON_TTL_MS = 7 * DAY_MS;
const PREWARM_INTERVAL_MS = 15 * 60 * 1000;
const inflight = new Map();
let nextRequestAt = 0;
let throttleTail = Promise.resolve();

// --- SQLite-backed cache helpers ---
const metaGetStmt = db.prepare("SELECT * FROM tmdb_metadata_cache WHERE id = ?");
const metaSetStmt = db.prepare(
  `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
   VALUES (@id, @tmdb_id, @media_type, @title, @details, @schema_version, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tmdb_id=excluded.tmdb_id, media_type=excluded.media_type, title=excluded.title,
     details=excluded.details, schema_version=excluded.schema_version, updated_at_ms=excluded.updated_at_ms`,
);
function metaGet(id) {
  const row = metaGetStmt.get(id);
  if (!row) return null;
  return { tmdbId: row.tmdb_id, mediaType: row.media_type, title: row.title, details: parseJson(row.details), schemaVersion: row.schema_version, updatedAtMs: row.updated_at_ms };
}
function metaSet(id, value) {
  metaSetStmt.run({
    id,
    tmdb_id: value.tmdbId != null ? String(value.tmdbId) : null,
    media_type: value.mediaType || null,
    title: value.title || null,
    details: value.details != null ? toJson(value.details) : null,
    schema_version: value.schemaVersion ?? null,
    updated_at_ms: value.updatedAtMs ?? Date.now(),
  });
}

const searchGetStmt = db.prepare("SELECT * FROM tmdb_search_cache WHERE id = ?");
const searchSetStmt = db.prepare(
  `INSERT INTO tmdb_search_cache (id, query, media_type, page, response, missing, updated_at_ms)
   VALUES (@id, @query, @media_type, @page, @response, @missing, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET query=excluded.query, media_type=excluded.media_type, page=excluded.page,
     response=excluded.response, missing=excluded.missing, updated_at_ms=excluded.updated_at_ms`,
);

const personGetStmt = db.prepare("SELECT * FROM tmdb_person_cache WHERE id = ?");
const personSetStmt = db.prepare(
  `INSERT INTO tmdb_person_cache (id, person_id, details, schema_version, updated_at_ms)
   VALUES (@id, @person_id, @details, @schema_version, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET person_id=excluded.person_id, details=excluded.details,
     schema_version=excluded.schema_version, updated_at_ms=excluded.updated_at_ms`,
);

const recentWatchStmt = db.prepare("SELECT media_type, tmdb_id, title, show_title FROM watch_history ORDER BY watched_at DESC LIMIT 30");

function hash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function canonicalTitle(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleSearchParts(value = "") {
  const title = String(value || "").trim();
  // Match a trailing "(YYYY)" on the already-trimmed string. Anchoring tightly with no
  // leading/trailing \s* avoids the polynomial backtracking CodeQL flagged.
  const match = title.match(/\((\d{4})\)$/);
  if (!match) return { title, year: "" };
  return {
    title: title.slice(0, match.index).trim(),
    year: match[1],
  };
}

function mediaTypeFor(value) {
  return String(value).toLowerCase() === "movie" ? "movie" : "tv";
}

function detailsTtl(details) {
  if (["Returning Series", "In Production", "Post Production", "Planned", "Pilot"].includes(details?.status)) return DAY_MS;
  if (["Ended", "Canceled", "Released"].includes(details?.status)) return 30 * DAY_MS;
  return 7 * DAY_MS;
}

function fresh(data, ttl) {
  return Boolean(data?.updatedAtMs && Date.now() - data.updatedAtMs < ttl);
}

function boundedResults(resource, limit) {
  if (!resource || typeof resource !== "object") return resource;
  return { ...resource, results: Array.isArray(resource.results) ? resource.results.slice(0, limit) : [] };
}

function compactDetails(details = {}) {
  const compact = { ...details };
  if (details.credits) {
    compact.credits = {
      ...details.credits,
      cast: (details.credits.cast || []).slice(0, 60),
      crew: (details.credits.crew || []).slice(0, 60),
    };
  }
  if (details.videos) compact.videos = boundedResults(details.videos, 30);
  if (details.reviews) compact.reviews = boundedResults(details.reviews, 10);
  if (details.similar) compact.similar = boundedResults(details.similar, 24);
  if (details.recommendations) compact.recommendations = boundedResults(details.recommendations, 24);
  if (details.images) {
    compact.images = {
      backdrops: (details.images.backdrops || []).slice(0, 40),
      posters: (details.images.posters || []).slice(0, 40),
      logos: (details.images.logos || []).slice(0, 20),
    };
  }
  return compact;
}

function collapse(key, task) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = Promise.resolve().then(task).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const previous = throttleTail;
  let release;
  throttleTail = new Promise((resolve) => { release = resolve; });
  await previous;
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay) await wait(delay);
  nextRequestAt = Date.now() + 350;
  release();
}

async function apiKey() {
  const config = await loadMediaConfig();
  if (!config.tmdb?.apiKey) {
    const error = new Error("TMDB API key is not configured");
    error.status = 400;
    throw error;
  }
  return config.tmdb.apiKey;
}

async function upstream(path, params = {}, attempt = 0) {
  await throttle();
  const key = await apiKey();
  const url = new URL(`${API_ROOT}/${String(path).replace(/^\/+/, "")}`);
  url.searchParams.set("api_key", key);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (response.status === 429 && attempt < 2) {
    const retryAfter = Math.max(1, Number(response.headers.get("retry-after") || 1));
    await wait(retryAfter * 1000 + Math.floor(Math.random() * 250));
    return upstream(path, params, attempt + 1);
  }
  if (!response.ok) {
    const error = new Error(`TMDB request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchTmdbRaw(type, id) {
  return compactDetails(await upstream(`${type}/${id}`, {
    append_to_response: "credits,videos,reviews,similar,recommendations,watch/providers,keywords,external_ids,release_dates,content_ratings,images",
  }));
}

async function cacheCanonicalArtwork(mediaType, tmdbId, details) {
  const mediaKey = `tmdb:${mediaType}:${tmdbId}`;
  const [posterCache, backdropCache, logoCache] = await Promise.all([
    getPosterCache(mediaKey, "poster"),
    getPosterCache(mediaKey, "backdrop"),
    getPosterCache(mediaKey, "logo"),
  ]);
  const posterState = usableCachedPoster(posterCache);
  const backdropState = usableCachedPoster(backdropCache);
  const logoState = usableCachedPoster(logoCache);
  let poster = posterState?.url || null;
  let backdrop = backdropState?.url || null;
  let logo = logoState?.url || null;

  const hasTmdbLogos = (details.images?.logos || []).length > 0;

  const tmdbJobs = [];
  if (!posterState && details.tvdb_poster_url) {
    tmdbJobs.push(cachePosterFromUrl(mediaKey, details.tvdb_poster_url, "tvdb").then((v) => { poster = v?.url || poster; }));
  } else if (!posterState && details.poster_path) {
    tmdbJobs.push(cachePosterFromUrl(mediaKey, `${IMAGE_ROOT}/w500${details.poster_path}`, "tmdb").then((v) => { poster = v?.url || poster; }));
  }
  if (!backdropState && details.backdrop_path) {
    tmdbJobs.push(cacheBackdropFromUrl(mediaKey, `${IMAGE_ROOT}/original${details.backdrop_path}`, "tmdb").then((v) => { backdrop = v?.url || backdrop; }));
  }

  await Promise.all(tmdbJobs);

  const needsFanart = !poster || !backdrop || (!logo && !hasTmdbLogos && !logoState);
  if (needsFanart) {
    const tvdbId = String(details.external_ids?.tvdb_id || "");
    const fanartArt = await (mediaType === "movie" ? getFanartMovieArt(tmdbId) : getFanartTvArt(tvdbId)).catch(() => null);
    if (!fanartArt) {
      if (!logo && !hasTmdbLogos && !logoState) {
        await markPosterMissing(mediaKey, "fanart", "No fanart data", "logo");
      }
      return {
        cached_poster_url: poster,
        cached_backdrop_url: backdrop,
        ...(logo ? { cached_logo_url: logo } : {}),
      };
    }
    const fanartJobs = [];
    if (!poster && fanartArt.poster) {
      fanartJobs.push(cachePosterFromUrl(mediaKey, fanartArt.poster, "fanart").then((v) => { poster = v?.url || poster; }));
    }
    if (!backdrop && fanartArt.backdrop) {
      fanartJobs.push(cacheBackdropFromUrl(mediaKey, fanartArt.backdrop, "fanart").then((v) => { backdrop = v?.url || backdrop; }));
    }
    if (!logo && !hasTmdbLogos && fanartArt.logo) {
      fanartJobs.push(cacheLogoFromUrl(mediaKey, fanartArt.logo, "fanart").then((v) => { logo = v?.url || logo; }));
    }
    await Promise.all(fanartJobs);
    if (!logo && !hasTmdbLogos && !fanartArt.logo) {
      await markPosterMissing(mediaKey, "fanart", "No logo on fanart.tv", "logo");
    }
  }

  return {
    cached_poster_url: poster,
    cached_backdrop_url: backdrop,
    ...(logo ? { cached_logo_url: logo } : {}),
  };
}

async function resolveTmdbExternalId(type, source, externalId) {
  const cleaned = String(externalId || "").trim();
  if (!cleaned) return "";
  const key = `external_${type}_${source}_${hash(cleaned.toLowerCase())}`;
  const cached = metaGet(key);
  if (cached?.tmdbId) return String(cached.tmdbId);

  try {
    const result = await upstream(`find/${encodeURIComponent(cleaned)}`, { external_source: source });
    const list = type === "movie" ? result.movie_results : result.tv_results;
    const resolved = String(list?.[0]?.id || "");
    if (resolved) {
      metaSet(key, { tmdbId: resolved, mediaType: type, title: cleaned, updatedAtMs: Date.now() });
    }
    return resolved;
  } catch {
    return "";
  }
}

async function resolveTmdbId(mediaType, tmdbId, title, ids = {}, { ignoreTmdbId = false } = {}) {
  if (tmdbId && !ignoreTmdbId) return String(tmdbId);
  const type = mediaTypeFor(mediaType);
  const imdbId = String(ids.imdbId || ids.imdb_id || ids.imdb || "").trim();
  const tvdbId = String(ids.tvdbId || ids.tvdb_id || ids.tvdb || "").trim();

  if (imdbId) {
    const resolved = await resolveTmdbExternalId(type, "imdb_id", imdbId);
    if (resolved) return resolved;
  }
  if (type === "tv" && tvdbId) {
    const resolved = await resolveTmdbExternalId(type, "tvdb_id", tvdbId);
    if (resolved) return resolved;
  }

  const searchParts = titleSearchParts(title);
  const searchTitle = searchParts.title || title;
  const normalizedTitle = canonicalTitle(searchTitle);
  if (!normalizedTitle) return "";
  const titleKey = `title_${type}_${hash(`${normalizedTitle}|${searchParts.year || ""}`)}`;
  const cached = metaGet(titleKey);
  if (cached?.tmdbId) return String(cached.tmdbId);
  const searchParams = { query: searchTitle, page: 1, include_adult: false };
  if (searchParts.year) {
    if (type === "tv") searchParams.first_air_date_year = searchParts.year;
    else searchParams.primary_release_year = searchParts.year;
  }
  const result = await upstream(`search/${type}`, searchParams);
  const resolved = String(result.results?.[0]?.id || "");
  if (resolved) {
    metaSet(titleKey, { tmdbId: resolved, title: searchTitle, mediaType: type, updatedAtMs: Date.now() });
  }
  return resolved;
}

async function deriveNextAiring(details, tvdbId) {
  const today = new Date().toISOString().slice(0, 10);
  const maxSeason = Math.max(0, ...(details.seasons || []).map((season) => Number(season.season_number) || 0));
  const candidates = new Set([maxSeason, maxSeason + 1].filter((value) => value > 0));
  let earliest = null;
  for (const seasonNumber of [...candidates].sort((a, b) => a - b)) {
    const season = await getTvdbSeasonEpisodes({ tvdbId, seasonNumber }).catch(() => null);
    const dates = (season?.episodes || []).map((episode) => episode.air_date).filter((date) => date && date >= today).sort();
    if (dates[0] && (!earliest || dates[0] < earliest)) earliest = dates[0];
  }
  return earliest;
}

export async function getTmdbDetails({ mediaType, tmdbId = "", title = "", ids = {}, force = false, forceTvdb = force }) {
  const type = mediaTypeFor(mediaType);
  if (type === "tv") return getTvShowDetails({ tmdbId, title, ids, force, forceTvdb });
  return getMovieDetails({ tmdbId, title, ids, force });
}

async function getMovieDetails({ tmdbId = "", title = "", ids = {}, force = false }) {
  const type = "movie";
  const resolvedId = await resolveTmdbId(type, tmdbId, title, ids);
  if (!resolvedId) {
    const error = new Error("Could not resolve TMDB ID");
    error.status = 404;
    throw error;
  }
  const key = `details:${type}:${resolvedId}:${force ? "force" : "cached"}`;
  return collapse(key, async () => {
    const cacheId = `${type}_${resolvedId}`;
    const cached = metaGet(cacheId);
    if (!force && cached?.details && cached.schemaVersion >= DETAILS_SCHEMA_VERSION && fresh(cached, detailsTtl(cached.details))) return cached.details;
    try {
      const fetched = await fetchTmdbRaw(type, resolvedId);
      const details = { ...(cached?.details || {}), ...fetched };
      Object.assign(details, await cacheCanonicalArtwork(type, resolvedId, details));
      metaSet(cacheId, { tmdbId: resolvedId, mediaType: type, details, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return { ...cached.details, cache_stale: true };
      if (error.status === 404 && (title || ids.imdbId || ids.imdb_id || ids.imdb)) {
        const fallbackId = await resolveTmdbId(type, "", title, ids, { ignoreTmdbId: true }).catch(() => "");
        if (fallbackId && String(fallbackId) !== String(resolvedId)) {
          return getMovieDetails({ tmdbId: fallbackId, title, ids, force });
        }
      }
      throw error;
    }
  });
}

// TV shows: TVDB supplies the structural data (name, overview, air dates,
// artwork, seasons/episodes — the accurate episode ordering this feature
// exists for). TMDB is merged in only for what TVDB doesn't have (cast,
// trailers, reviews, similar/recommendations, watch providers) and to keep
// `id` = TMDB id, since Seerr requests and `/tvshow/tmdb/:id` routing are
// TMDB-keyed throughout the rest of the app.
async function getTvShowDetails({ tmdbId = "", title = "", ids = {}, force = false, forceTvdb = force }) {
  let tvdbId = String(ids.tvdbId || ids.tvdb_id || ids.tvdb || "").trim();
  if (!tvdbId) tvdbId = await resolveTvdbSeriesId({ title });
  if (!tvdbId && tmdbId) {
    const fallback = await fetchTmdbRaw("tv", tmdbId).catch(() => null);
    tvdbId = String(fallback?.external_ids?.tvdb_id || "");
  }
  if (!tvdbId) {
    const error = new Error("Could not resolve TVDB ID");
    error.status = 404;
    throw error;
  }

  const key = `tv-details:${tvdbId}:${force ? "force" : "cached"}`;
  return collapse(key, async () => {
    // The caller's tmdbId may be empty (e.g. Fix Match clears it to force re-resolution
    // via the new tvdbId), so the cache row actually written might live under a
    // different key than this initial guess — re-derived below once resolvedTmdbId
    // is known, so lookups by the resolved tmdbId (getTmdbSeason, etc.) can find it.
    const initialCacheId = tmdbId ? `tv_${tmdbId}` : `tv_tvdb_${tvdbId}`;
    const cached = metaGet(initialCacheId);
    if (!force && cached?.details && cached.schemaVersion >= DETAILS_SCHEMA_VERSION && fresh(cached, detailsTtl(cached.details))) return cached.details;
    try {
      const extended = await getTvdbSeriesExtended(tvdbId, { force: forceTvdb });
      const shaped = shapeTvdbSeriesAsTmdb(extended);
      const resolvedTmdbId = String(tmdbId || shaped.external_ids.tmdb_id || "");
      const cacheId = resolvedTmdbId ? `tv_${resolvedTmdbId}` : `tv_tvdb_${tvdbId}`;
      if (!force && cacheId !== initialCacheId) {
        const resolvedCached = metaGet(cacheId);
        if (resolvedCached?.details && resolvedCached.schemaVersion >= DETAILS_SCHEMA_VERSION && fresh(resolvedCached, detailsTtl(resolvedCached.details))) return resolvedCached.details;
      }

      let extras = {};
      if (resolvedTmdbId) {
        const raw = await fetchTmdbRaw("tv", resolvedTmdbId).catch(() => null);
        if (raw) {
          extras = {
            credits: raw.credits,
            videos: raw.videos,
            reviews: raw.reviews,
            similar: raw.similar,
            recommendations: raw.recommendations,
            "watch/providers": raw["watch/providers"],
            content_ratings: raw.content_ratings,
            keywords: raw.keywords,
            vote_average: raw.vote_average,
            episode_run_time: raw.episode_run_time,
            original_language: raw.original_language,
            images: raw.images,
            poster_path: raw.poster_path,
            backdrop_path: raw.backdrop_path,
          };
        }
      }

      const details = {
        ...shaped,
        ...extras,
        id: resolvedTmdbId || undefined,
        external_ids: { ...shaped.external_ids, tmdb_id: resolvedTmdbId },
      };

      const nextAiring = await deriveNextAiring(details, tvdbId);
      if (nextAiring) details.next_airing_date = nextAiring;
      else delete details.next_airing_date;

      Object.assign(details, await cacheCanonicalArtwork("tv", resolvedTmdbId || `tvdb-${tvdbId}`, details));
      metaSet(cacheId, { tmdbId: resolvedTmdbId, mediaType: "tv", details, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return { ...cached.details, cache_stale: true };
      throw error;
    }
  });
}

export async function searchTmdb({ query, page = 1, mediaType = "multi" }) {
  const type = ["movie", "tv"].includes(mediaType) ? mediaType : "multi";
  const safePage = Math.min(Math.max(Number(page) || 1, 1), 500);
  const cacheKey = hash(`${type}|${canonicalTitle(query)}|${safePage}`);
  return collapse(`search:${cacheKey}`, async () => {
    const row = searchGetStmt.get(cacheKey);
    const cached = row ? { response: parseJson(row.response), missing: Boolean(row.missing), updatedAtMs: row.updated_at_ms } : null;
    const ttl = cached?.missing ? MISSING_TTL_MS : SEARCH_TTL_MS;
    if (cached && fresh(cached, ttl)) return cached.response;
    try {
      const response = await upstream(`search/${type}`, { query, page: safePage, include_adult: false });
      const cleaned = { ...response, results: (response.results || []).filter((item) => ["movie", "tv", "person"].includes(item.media_type || type)) };
      searchSetStmt.run({ id: cacheKey, query, media_type: type, page: safePage, response: toJson(cleaned), missing: cleaned.results.length ? 0 : 1, updated_at_ms: Date.now() });
      return cleaned;
    } catch (error) {
      if (cached?.response) return { ...cached.response, cache_stale: true };
      throw error;
    }
  });
}

// Seasons only exist for TV, so this is entirely TVDB-backed now — it resolves
// the TVDB ID off the show details already cached under tv_{tmdbId} (getTmdbDetails
// always runs first in every caller's flow) and fetches episodes from TVDB.
export async function getTmdbSeason({ tmdbId, seasonNumber }) {
  const id = String(tmdbId || "");
  const number = Number(seasonNumber);
  if (!id || !Number.isInteger(number) || number < 0) {
    const error = new Error("tmdbId and a valid seasonNumber are required");
    error.status = 400;
    throw error;
  }
  const cached = metaGet(`tv_${id}`);
  const tvdbId = String(cached?.details?.external_ids?.tvdb_id || "");
  if (!tvdbId) {
    const error = new Error("TVDB ID not resolved for this show yet");
    error.status = 404;
    throw error;
  }
  return getTvdbSeasonEpisodes({ tvdbId, seasonNumber: number });
}

export async function getTmdbPerson(personId) {
  const id = String(personId || "");
  return collapse(`person:${id}`, async () => {
    const row = personGetStmt.get(`person_${id}`);
    const cached = row ? { details: parseJson(row.details), schemaVersion: row.schema_version, updatedAtMs: row.updated_at_ms } : null;
    if (cached?.details && cached.schemaVersion >= PERSON_SCHEMA_VERSION && fresh(cached, PERSON_TTL_MS)) return cached.details;
    try {
      const fetched = await upstream(`person/${id}`, { append_to_response: "combined_credits,images,tagged_images,external_ids" });
      const details = {
        ...fetched,
        combined_credits: {
          ...(fetched.combined_credits || {}),
          cast: fetched.combined_credits?.cast || [],
          crew: fetched.combined_credits?.crew || [],
        },
        images: { profiles: (fetched.images?.profiles || []).slice(0, 200) },
        tagged_images: boundedResults(fetched.tagged_images, 250) || { results: [] },
      };
      personSetStmt.run({ id: `person_${id}`, person_id: id, details: toJson(details), schema_version: PERSON_SCHEMA_VERSION, updated_at_ms: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return { ...cached.details, cache_stale: true };
      throw error;
    }
  });
}

export async function getTmdbImages({ mediaType, tmdbId }) {
  const details = await getTmdbDetails({ mediaType, tmdbId });
  return details.images || { backdrops: [], posters: [], logos: [] };
}

export async function prewarmTmdbLibrary({ limit = 4 } = {}) {
  const runtime = await loadRuntimeState().catch(() => ({}));
  if (runtime.lastTmdbPrewarmAt && Date.now() - Number(runtime.lastTmdbPrewarmAt) < PREWARM_INTERVAL_MS) return { skipped: true };
  const rows = recentWatchStmt.all();
  const items = [];
  const seen = new Set();
  for (const data of rows) {
    const mediaType = data.media_type === "movie" ? "movie" : data.media_type === "episode" ? "tv" : "";
    const tmdbId = String(data.tmdb_id || "");
    const title = mediaType === "tv" ? data.show_title || data.title : data.title;
    const key = `${mediaType}:${tmdbId || canonicalTitle(title)}`;
    if (!mediaType || seen.has(key)) continue;
    seen.add(key);
    items.push({ mediaType, tmdbId, title });
    if (items.length >= limit) break;
  }
  for (const item of items) await getTmdbDetails(item).catch(() => null);
  await setRuntimeState({ lastTmdbPrewarmAt: Date.now() });
  return { warmed: items.length };
}

export function getCachedTvdbId(tmdbId) {
  if (!tmdbId) return "";
  const row = metaGetStmt.get(`tv_${tmdbId}`);
  if (!row?.details) return "";
  const details = parseJson(row.details);
  return String(details?.external_ids?.tvdb_id || "");
}

export async function getTmdbPosterUrl({ mediaType, tmdbId = "", title = "" }) {
  const details = await getTmdbDetails({ mediaType, tmdbId, title });
  return details.cached_poster_url || (details.poster_path ? `${IMAGE_ROOT}/w500${details.poster_path}` : null);
}
