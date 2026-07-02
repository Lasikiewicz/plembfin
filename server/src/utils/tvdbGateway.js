import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";

const PROJECT_KEY = "94a93e8a-7ab8-4708-b6b7-a9fae1bc6ac2";
const API_ROOT = "https://api4.thetvdb.com/v4";
const DAY_MS = 24 * 60 * 60 * 1000;
const SERIES_TTL_MS = 3 * DAY_MS;
const SEASON_TTL_MS = DAY_MS;
const TOKEN_LIFETIME_MS = 25 * DAY_MS;
const inflight = new Map();
let nextRequestAt = 0;
let throttleTail = Promise.resolve();

const seriesGetStmt = db.prepare("SELECT * FROM tvdb_metadata_cache WHERE id = ?");
const seriesSetStmt = db.prepare(
  `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
   VALUES (@id, @tvdb_id, @title, @details, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tvdb_id=excluded.tvdb_id, title=excluded.title,
     details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
);

const seasonGetStmt = db.prepare("SELECT * FROM tvdb_season_cache WHERE id = ?");
const seasonSetStmt = db.prepare(
  `INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
   VALUES (@id, @tvdb_id, @season_number, @details, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tvdb_id=excluded.tvdb_id, season_number=excluded.season_number,
     details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
);

function hash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function canonicalTitle(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fresh(updatedAtMs, ttl) {
  return Boolean(updatedAtMs && Date.now() - updatedAtMs < ttl);
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

async function effectiveApiKey() {
  const config = await loadMediaConfig();
  return String(config.tvdb?.apiKey || "").trim() || PROJECT_KEY;
}

async function getToken({ forceRefresh = false } = {}) {
  const apiKey = await effectiveApiKey();
  const keyHash = hash(apiKey);
  const runtime = await loadRuntimeState().catch(() => ({}));
  if (!forceRefresh && runtime.tvdbToken && runtime.tvdbTokenKeyHash === keyHash && fresh(runtime.tvdbTokenIssuedAtMs, TOKEN_LIFETIME_MS)) {
    return runtime.tvdbToken;
  }
  await throttle();
  const response = await fetch(`${API_ROOT}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apikey: apiKey }),
  });
  if (!response.ok) {
    const error = new Error(`TVDB login failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  const token = body?.data?.token;
  if (!token) {
    const error = new Error("TVDB login did not return a token");
    error.status = 502;
    throw error;
  }
  await setRuntimeState({ tvdbToken: token, tvdbTokenKeyHash: keyHash, tvdbTokenIssuedAtMs: Date.now() });
  return token;
}

async function upstream(path, params = {}, attempt = 0) {
  await throttle();
  const token = await getToken();
  const url = new URL(`${API_ROOT}/${String(path).replace(/^\/+/, "")}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  const response = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (response.status === 401 && attempt < 1) {
    await getToken({ forceRefresh: true });
    return upstream(path, params, attempt + 1);
  }
  if (response.status === 429 && attempt < 2) {
    await wait(1000 + Math.floor(Math.random() * 250));
    return upstream(path, params, attempt + 1);
  }
  if (!response.ok) {
    const error = new Error(`TVDB request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  return body?.data;
}

export async function resolveTvdbSeriesId({ tvdbId = "", title = "" } = {}) {
  const cleanedId = String(tvdbId || "").trim();
  if (cleanedId) return cleanedId;

  const cleanedTitle = String(title || "").trim();
  if (!cleanedTitle) return "";

  const cacheKey = `search_${hash(canonicalTitle(cleanedTitle))}`;
  const cached = seriesGetStmt.get(cacheKey);
  if (cached && fresh(cached.updated_at_ms, SERIES_TTL_MS)) {
    const details = parseJson(cached.details);
    return details?.tvdb_id ? String(details.tvdb_id) : "";
  }

  try {
    const results = await upstream("search", { query: cleanedTitle, type: "series" });
    const best = Array.isArray(results) ? results[0] : null;
    const resolvedId = best ? String(best.tvdb_id || best.id || "").replace(/^series-/, "") : "";
    seriesSetStmt.run({ id: cacheKey, tvdb_id: resolvedId, title: cleanedTitle, details: toJson({ tvdb_id: resolvedId }), updated_at_ms: Date.now() });
    return resolvedId;
  } catch {
    return "";
  }
}

export async function searchTvdbSeriesList(query) {
  const cleaned = String(query || "").trim();
  if (!cleaned) return [];
  const results = await upstream("search", { query: cleaned, type: "series" });
  return (Array.isArray(results) ? results : []).slice(0, 10).map((item) => ({
    tvdb_id: String(item.tvdb_id || item.id || "").replace(/^series-/, ""),
    name: item.name || item.translations?.eng || "Unknown",
    year: item.year || (item.first_air_time || "").slice(0, 4) || "",
    image_url: item.image_url || item.thumbnail || "",
  })).filter((item) => item.tvdb_id);
}

export async function getTvdbSeriesExtended(tvdbId, { force = false } = {}) {
  const id = String(tvdbId || "").trim();
  if (!id) return null;
  return collapse(`series:${id}`, async () => {
    const cacheId = `series_${id}`;
    const row = seriesGetStmt.get(cacheId);
    const cached = row ? { details: parseJson(row.details), updatedAtMs: row.updated_at_ms } : null;
    if (!force && cached?.details && fresh(cached.updatedAtMs, SERIES_TTL_MS)) return cached.details;
    try {
      const details = await upstream(`series/${id}/extended`, { meta: "translations" });
      seriesSetStmt.run({ id: cacheId, tvdb_id: id, title: details?.name || "", details: toJson(details), updated_at_ms: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return cached.details;
      throw error;
    }
  });
}

function pickSeasonId(extended, seasonNumber) {
  const seasons = Array.isArray(extended?.seasons) ? extended.seasons : [];
  const number = Number(seasonNumber);
  const official = seasons.find((season) => Number(season.number) === number && (season.type?.type === "official" || season.type?.name === "Aired Order"));
  return official || seasons.find((season) => Number(season.number) === number) || null;
}

export async function getTvdbSeasonEpisodes({ tvdbId, seasonNumber }) {
  const id = String(tvdbId || "").trim();
  const number = Number(seasonNumber);
  if (!id || !Number.isInteger(number) || number < 0) {
    const error = new Error("tvdbId and a valid seasonNumber are required");
    error.status = 400;
    throw error;
  }
  return collapse(`season:${id}:${number}`, async () => {
    const cacheId = `${id}_${number}`;
    const row = seasonGetStmt.get(cacheId);
    const cached = row ? { details: parseJson(row.details), updatedAtMs: row.updated_at_ms } : null;
    if (cached?.details && fresh(cached.updatedAtMs, SEASON_TTL_MS)) return shapeEpisodes(cached.details);
    try {
      const extended = await getTvdbSeriesExtended(id);
      const season = pickSeasonId(extended, number);
      if (!season?.id) {
        if (cached?.details) return shapeEpisodes(cached.details);
        return { episodes: [] };
      }
      const seasonDetails = await upstream(`seasons/${season.id}/extended`);
      seasonSetStmt.run({ id: cacheId, tvdb_id: id, season_number: number, details: toJson(seasonDetails), updated_at_ms: Date.now() });
      return shapeEpisodes(seasonDetails);
    } catch (error) {
      if (cached?.details) return shapeEpisodes(cached.details);
      throw error;
    }
  });
}

function shapeEpisodes(seasonDetails) {
  const episodes = Array.isArray(seasonDetails?.episodes) ? seasonDetails.episodes : [];
  return {
    episodes: episodes.map((episode) => ({
      episode_number: episode.number,
      name: episode.name || "",
      overview: episode.overview || "",
      air_date: episode.aired || "",
      still_path: episode.image || "",
      runtime: episode.runtime ?? null,
    })),
  };
}

function bestRemoteId(remoteIds, sourceNames) {
  const list = Array.isArray(remoteIds) ? remoteIds : [];
  const match = list.find((entry) => sourceNames.includes(entry.sourceName));
  return match ? String(match.id || "") : "";
}

export function shapeTvdbSeriesAsTmdb(extended) {
  if (!extended) return null;
  const seasons = (Array.isArray(extended.seasons) ? extended.seasons : [])
    .filter((season) => (season.type?.type === "official" || season.type?.name === "Aired Order") && Number(season.number) >= 0)
    .map((season) => ({
      season_number: season.number,
      episode_count: null,
      name: season.name || (season.number === 0 ? "Specials" : `Season ${season.number}`),
      poster_path: season.image || null,
    }));

  const tmdbId = bestRemoteId(extended.remoteIds, ["TheMovieDB"]);
  const imdbId = bestRemoteId(extended.remoteIds, ["IMDB"]);

  return {
    name: extended.name || "",
    overview: extended.overview || "",
    first_air_date: extended.firstAired || "",
    status: extended.status?.name || "",
    genres: (extended.genres || []).map((genre) => ({ id: genre.id, name: genre.name })),
    networks: extended.originalNetwork ? [{ id: extended.originalNetwork.id, name: extended.originalNetwork.name }] : [],
    seasons,
    tvdb_poster_url: extended.image || null,
    external_ids: {
      tvdb_id: String(extended.id || ""),
      imdb_id: imdbId,
      tmdb_id: tmdbId,
    },
  };
}
