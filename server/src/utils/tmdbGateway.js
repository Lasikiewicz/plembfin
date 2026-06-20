import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, getPosterCache, usableCachedPoster } from "./posterCache.js";

const API_ROOT = "https://api.themoviedb.org/3";
const IMAGE_ROOT = "https://image.tmdb.org/t/p";
const DAY_MS = 24 * 60 * 60 * 1000;
const DETAILS_SCHEMA_VERSION = 4;
const PERSON_SCHEMA_VERSION = 5;
const SEARCH_TTL_MS = 15 * 60 * 1000;
const MISSING_TTL_MS = DAY_MS;
const PERSON_TTL_MS = 7 * DAY_MS;
const PREWARM_INTERVAL_MS = 15 * 60 * 1000;
const inflight = new Map();
let nextRequestAt = 0;
let throttleTail = Promise.resolve();

// --- SQLite-backed cache helpers (replace Firestore tmdb*Cache collections) ---
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

const seasonGetStmt = db.prepare("SELECT * FROM tmdb_season_cache WHERE id = ?");
const seasonSetStmt = db.prepare(
  `INSERT INTO tmdb_season_cache (id, tmdb_id, season_number, show_status, details, updated_at_ms)
   VALUES (@id, @tmdb_id, @season_number, @show_status, @details, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tmdb_id=excluded.tmdb_id, season_number=excluded.season_number,
     show_status=excluded.show_status, details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
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

function mediaTypeFor(value) {
  return String(value).toLowerCase() === "movie" ? "movie" : "tv";
}

function detailsTtl(details) {
  if (["Returning Series", "In Production", "Post Production", "Planned", "Pilot"].includes(details?.status)) return DAY_MS;
  if (["Ended", "Canceled", "Released"].includes(details?.status)) return 30 * DAY_MS;
  return 7 * DAY_MS;
}

function seasonTtl(details) {
  return ["Ended", "Canceled"].includes(details?.status) ? 30 * DAY_MS : DAY_MS;
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
  const response = await fetch(url, { headers: { Accept: "application/json" } });
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

async function cacheCanonicalArtwork(mediaType, tmdbId, details) {
  const mediaKey = `tmdb:${mediaType}:${tmdbId}`;
  const [posterCache, backdropCache] = await Promise.all([
    getPosterCache(mediaKey, "poster"),
    getPosterCache(mediaKey, "backdrop"),
  ]);
  const posterState = usableCachedPoster(posterCache);
  const backdropState = usableCachedPoster(backdropCache);
  let poster = posterState?.url || null;
  let backdrop = backdropState?.url || null;
  const jobs = [];
  if (!posterState && details.poster_path) {
    jobs.push(cachePosterFromUrl(mediaKey, `${IMAGE_ROOT}/w500${details.poster_path}`, "tmdb").then((value) => { poster = value?.url || poster; }));
  }
  if (!backdropState && details.backdrop_path) {
    jobs.push(cacheBackdropFromUrl(mediaKey, `${IMAGE_ROOT}/original${details.backdrop_path}`, "tmdb").then((value) => { backdrop = value?.url || backdrop; }));
  }
  await Promise.all(jobs);
  return { cached_poster_url: poster, cached_backdrop_url: backdrop };
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

async function resolveTmdbId(mediaType, tmdbId, title, ids = {}) {
  if (tmdbId) return String(tmdbId);
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

  const normalizedTitle = canonicalTitle(title);
  if (!normalizedTitle) return "";
  const titleKey = `title_${type}_${hash(normalizedTitle)}`;
  const cached = metaGet(titleKey);
  if (cached?.tmdbId) return String(cached.tmdbId);
  const result = await upstream(`search/${type}`, { query: title, page: 1, include_adult: false });
  const resolved = String(result.results?.[0]?.id || "");
  if (resolved) {
    metaSet(titleKey, { tmdbId: resolved, title, mediaType: type, updatedAtMs: Date.now() });
  }
  return resolved;
}

async function deriveNextAiring(details, tmdbId) {
  const today = new Date().toISOString().slice(0, 10);
  const direct = details.next_episode_to_air?.air_date;
  if (direct && direct >= today) return direct;
  const candidates = new Set();
  const lastSeason = details.last_episode_to_air?.season_number;
  if (Number.isInteger(lastSeason)) { candidates.add(lastSeason); candidates.add(lastSeason + 1); }
  const maxSeason = Math.max(0, ...(details.seasons || []).map((season) => Number(season.season_number) || 0));
  if (maxSeason) candidates.add(maxSeason);
  for (const seasonNumber of [...candidates].filter((value) => value > 0).sort((a, b) => a - b)) {
    const season = await getTmdbSeason({ tmdbId, seasonNumber, showStatus: details.status }).catch(() => null);
    const dates = (season?.episodes || []).map((episode) => episode.air_date).filter((date) => date && date >= today).sort();
    if (dates[0]) return dates[0];
  }
  return null;
}

export async function getTmdbDetails({ mediaType, tmdbId = "", title = "", ids = {}, force = false }) {
  const type = mediaTypeFor(mediaType);
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
      const fetched = compactDetails(await upstream(`${type}/${resolvedId}`, {
        append_to_response: "credits,videos,reviews,similar,recommendations,watch/providers,keywords,external_ids,release_dates,content_ratings,images",
      }));
      const details = { ...(cached?.details || {}), ...fetched };
      if (type === "tv") {
        const nextAiring = await deriveNextAiring(details, resolvedId);
        if (nextAiring) details.next_airing_date = nextAiring;
        else delete details.next_airing_date;
      }
      Object.assign(details, await cacheCanonicalArtwork(type, resolvedId, details));
      metaSet(cacheId, { tmdbId: resolvedId, mediaType: type, details, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() });
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

export async function getTmdbSeason({ tmdbId, seasonNumber, showStatus = "" }) {
  const id = String(tmdbId || "");
  const number = Number(seasonNumber);
  if (!id || !Number.isInteger(number) || number < 0) {
    const error = new Error("tmdbId and a valid seasonNumber are required");
    error.status = 400;
    throw error;
  }
  return collapse(`season:${id}:${number}`, async () => {
    const row = seasonGetStmt.get(`${id}_${number}`);
    const cached = row ? { details: parseJson(row.details), showStatus: row.show_status, updatedAtMs: row.updated_at_ms } : null;
    if (cached?.details && fresh(cached, seasonTtl({ status: showStatus || cached.showStatus }))) return cached.details;
    try {
      const details = await upstream(`tv/${id}/season/${number}`, { append_to_response: "credits,videos,images" });
      seasonSetStmt.run({ id: `${id}_${number}`, tmdb_id: id, season_number: number, show_status: showStatus, details: toJson(details), updated_at_ms: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return { ...cached.details, cache_stale: true };
      throw error;
    }
  });
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

export async function getTmdbPosterUrl({ mediaType, tmdbId = "", title = "" }) {
  const details = await getTmdbDetails({ mediaType, tmdbId, title });
  return details.cached_poster_url || (details.poster_path ? `${IMAGE_ROOT}/w500${details.poster_path}` : null);
}
