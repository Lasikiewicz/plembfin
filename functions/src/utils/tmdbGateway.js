import crypto from "node:crypto";
import { db, FieldValue } from "../firebase.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, getPosterCache, usableCachedPoster } from "./posterCache.js";

const API_ROOT = "https://api.themoviedb.org/3";
const IMAGE_ROOT = "https://image.tmdb.org/t/p";
const DAY_MS = 24 * 60 * 60 * 1000;
const DETAILS_SCHEMA_VERSION = 3;
const PERSON_SCHEMA_VERSION = 2;
const SEARCH_TTL_MS = 15 * 60 * 1000;
const MISSING_TTL_MS = DAY_MS;
const PERSON_TTL_MS = 7 * DAY_MS;
const PREWARM_INTERVAL_MS = 15 * 60 * 1000;
const inflight = new Map();
let nextRequestAt = 0;
let throttleTail = Promise.resolve();

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

async function resolveTmdbId(mediaType, tmdbId, title) {
  if (tmdbId) return String(tmdbId);
  const type = mediaTypeFor(mediaType);
  const titleKey = `title_${type}_${hash(canonicalTitle(title))}`;
  const ref = db.collection("tmdbMetadataCache").doc(titleKey);
  const cached = await ref.get();
  if (cached.exists && cached.data()?.tmdbId) return String(cached.data().tmdbId);
  const result = await upstream(`search/${type}`, { query: title, page: 1, include_adult: false });
  const resolved = String(result.results?.[0]?.id || "");
  if (resolved) {
    await ref.set({ tmdbId: resolved, title, mediaType: type, updatedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
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

export async function getTmdbDetails({ mediaType, tmdbId = "", title = "" }) {
  const type = mediaTypeFor(mediaType);
  const resolvedId = await resolveTmdbId(type, tmdbId, title);
  if (!resolvedId) {
    const error = new Error("Could not resolve TMDB ID");
    error.status = 404;
    throw error;
  }
  const key = `details:${type}:${resolvedId}`;
  return collapse(key, async () => {
    const ref = db.collection("tmdbMetadataCache").doc(`${type}_${resolvedId}`);
    const snapshot = await ref.get();
    const cached = snapshot.exists ? snapshot.data() : null;
    if (cached && cached.schemaVersion >= DETAILS_SCHEMA_VERSION && fresh(cached, detailsTtl(cached.details))) return cached.details;
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
      await ref.set({ tmdbId: resolvedId, mediaType: type, details, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
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
    const ref = db.collection("tmdbSearchCache").doc(cacheKey);
    const snapshot = await ref.get();
    const cached = snapshot.exists ? snapshot.data() : null;
    const ttl = cached?.missing ? MISSING_TTL_MS : SEARCH_TTL_MS;
    if (cached && fresh(cached, ttl)) return cached.response;
    try {
      const response = await upstream(`search/${type}`, { query, page: safePage, include_adult: false });
      const cleaned = { ...response, results: (response.results || []).filter((item) => ["movie", "tv"].includes(item.media_type || type)) };
      await ref.set({ query, mediaType: type, page: safePage, response: cleaned, missing: !cleaned.results.length, updatedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
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
    const ref = db.collection("tmdbSeasonCache").doc(`${id}_${number}`);
    const snapshot = await ref.get();
    const cached = snapshot.exists ? snapshot.data() : null;
    if (cached && fresh(cached, seasonTtl({ status: showStatus || cached.showStatus }))) return cached.details;
    try {
      const details = await upstream(`tv/${id}/season/${number}`, { append_to_response: "credits,videos,images" });
      await ref.set({ tmdbId: id, seasonNumber: number, showStatus, details, updatedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
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
    const ref = db.collection("tmdbPersonCache").doc(`person_${id}`);
    const snapshot = await ref.get();
    const cached = snapshot.exists ? snapshot.data() : null;
    if (cached && cached.schemaVersion >= PERSON_SCHEMA_VERSION && fresh(cached, PERSON_TTL_MS)) return cached.details;
    try {
      const fetched = await upstream(`person/${id}`, { append_to_response: "combined_credits,images,tagged_images" });
      const details = {
        ...fetched,
        combined_credits: {
          ...(fetched.combined_credits || {}),
          cast: (fetched.combined_credits?.cast || []).slice(0, 120),
          crew: (fetched.combined_credits?.crew || []).slice(0, 80),
        },
        images: { profiles: (fetched.images?.profiles || []).slice(0, 60) },
        tagged_images: boundedResults(fetched.tagged_images, 80) || { results: [] },
      };
      await ref.set({ personId: id, details, schemaVersion: PERSON_SCHEMA_VERSION, updatedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
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
  const snapshot = await db.collection("watchHistory").orderBy("watchedAt", "desc").limit(30).get().catch(() => null);
  if (!snapshot) return { skipped: true };
  const items = [];
  const seen = new Set();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const mediaType = data.mediaType === "movie" ? "movie" : data.mediaType === "episode" ? "tv" : "";
    const tmdbId = String(data.tmdbId || data.tmdb_id || "");
    const title = mediaType === "tv" ? data.showTitle || data.show_title : data.title;
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
