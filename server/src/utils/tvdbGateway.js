import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { fetchWithTimeout } from "./outbound.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";

// Shared TVDB v4 project key — intentionally public: TVDB issues these for
// open-source apps to embed, and rate-limits them upstream. Operators can swap
// in their own via TVDB_PROJECT_KEY (or a personal key in Settings, which takes
// precedence over both) if this one is revoked or exhausted.
const PROJECT_KEY = String(process.env.TVDB_PROJECT_KEY || "").trim() || "94a93e8a-7ab8-4708-b6b7-a9fae1bc6ac2";
const API_ROOT = "https://api4.thetvdb.com/v4";
const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 180 * DAY_MS;
const SEARCH_MISS_TTL_MS = 60 * 60 * 1000;
const ACTIVE_SERIES_TTL_MS = 14 * DAY_MS;
const ARCHIVED_SERIES_TTL_MS = 180 * DAY_MS;
const UPCOMING_SEASON_TTL_MS = 2 * DAY_MS;
const ACTIVE_SEASON_TTL_MS = 7 * DAY_MS;
const ARCHIVED_SEASON_TTL_MS = 180 * DAY_MS;
const TOKEN_LIFETIME_MS = 25 * DAY_MS;
const TVDB_ID_PATTERN = /^\d+$/;
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
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function secretFingerprint(value) {
  return crypto.pbkdf2Sync(String(value), "plembfin-tvdb-token-cache-v1", 100000, 32, "sha256").toString("hex");
}

function canonicalTitle(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fresh(updatedAtMs, ttl) {
  return Boolean(updatedAtMs && Date.now() - updatedAtMs < ttl);
}

function isoDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function daysAgoIso(days) {
  const date = new Date(Date.now() - days * DAY_MS);
  return date.toISOString().slice(0, 10);
}

function seriesCacheTtl(details) {
  const status = String(details?.status?.name || details?.status || "").toLowerCase();
  const nextAired = isoDate(details?.nextAired);
  const today = new Date().toISOString().slice(0, 10);
  if (nextAired && nextAired >= today) return ACTIVE_SERIES_TTL_MS;
  if (/(ended|cancelled|canceled|finale|completed)/.test(status)) return ARCHIVED_SERIES_TTL_MS;
  return ACTIVE_SERIES_TTL_MS;
}

function seasonCacheTtl(details) {
  const episodes = Array.isArray(details?.episodes) ? details.episodes : [];
  if (!episodes.length) return UPCOMING_SEASON_TTL_MS;
  const today = new Date().toISOString().slice(0, 10);
  const airedDates = episodes.map((episode) => isoDate(episode.aired)).filter(Boolean).sort();
  if (airedDates.some((date) => date >= today)) return UPCOMING_SEASON_TTL_MS;
  const lastAired = airedDates[airedDates.length - 1] || "";
  if (lastAired && lastAired < daysAgoIso(30)) return ARCHIVED_SEASON_TTL_MS;
  return ACTIVE_SEASON_TTL_MS;
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
  const keyHash = secretFingerprint(apiKey);
  const runtime = await loadRuntimeState().catch(() => ({}));
  if (!forceRefresh && runtime.tvdbToken && runtime.tvdbTokenKeyHash === keyHash && fresh(runtime.tvdbTokenIssuedAtMs, TOKEN_LIFETIME_MS)) {
    return runtime.tvdbToken;
  }
  await throttle();
  const response = await fetchWithTimeout(`${API_ROOT}/login`, {
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

function normalizeTvdbId(value) {
  const id = String(value || "").trim().replace(/^series-/, "");
  return TVDB_ID_PATTERN.test(id) ? id : "";
}

function tvdbEndpointUrl(endpoint, params = {}) {
  const url = new URL(`${API_ROOT}/`);
  if (endpoint === "search") {
    url.pathname = "/v4/search";
  } else if (endpoint === "artwork-types") {
    url.pathname = "/v4/artwork/types";
  } else if (endpoint?.type === "series-extended") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB series id is required"), { status: 400 });
    url.pathname = `/v4/series/${id}/extended`;
  } else if (endpoint?.type === "series-artworks") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB series id is required"), { status: 400 });
    url.pathname = `/v4/series/${id}/artworks`;
  } else if (endpoint?.type === "season-extended") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB season id is required"), { status: 400 });
    url.pathname = `/v4/seasons/${id}/extended`;
  } else {
    throw Object.assign(new Error("Unsupported TVDB endpoint"), { status: 500 });
  }
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  return url;
}

// After exhausted 429 retries the module cools down: the project key's rate
// pool is shared by every Plembfin install, so once it's exhausted, queueing
// more attempts only burns quota. During the cooldown, callers fail fast and
// fall back to their stale SQLite caches.
let rateLimitCooldownUntil = 0;

async function upstream(endpoint, params = {}, attempt = 0) {
  if (Date.now() < rateLimitCooldownUntil) {
    const error = new Error("TVDB requests are cooling down after repeated 429 responses");
    error.status = 429;
    throw error;
  }
  await throttle();
  const token = await getToken();
  const url = tvdbEndpointUrl(endpoint, params);
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (response.status === 401 && attempt < 1) {
    await getToken({ forceRefresh: true });
    return upstream(endpoint, params, attempt + 1);
  }
  if (response.status === 429) {
    const retryAfterSec = Number(response.headers.get("retry-after"));
    const retryMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 2000 * (attempt + 1);
    if (attempt < 2 && retryMs <= 15_000) {
      await wait(retryMs + Math.floor(Math.random() * 250));
      return upstream(endpoint, params, attempt + 1);
    }
    rateLimitCooldownUntil = Date.now() + Math.max(60_000, Math.min(retryMs, 15 * 60_000));
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
  const cleanedId = normalizeTvdbId(tvdbId);
  if (cleanedId) return cleanedId;

  const cleanedTitle = String(title || "").trim();
  if (!cleanedTitle) return "";

  const cacheKey = `search_${hash(canonicalTitle(cleanedTitle))}`;
  const cached = seriesGetStmt.get(cacheKey);
  if (cached && fresh(cached.updated_at_ms, cached.tvdb_id ? SEARCH_TTL_MS : SEARCH_MISS_TTL_MS)) {
    const details = parseJson(cached.details);
    return details?.tvdb_id ? String(details.tvdb_id) : "";
  }

  try {
    const results = await upstream("search", { query: cleanedTitle, type: "series" });
    const best = Array.isArray(results) ? results[0] : null;
    const resolvedId = best ? normalizeTvdbId(best.tvdb_id || best.id) : "";
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
    tvdb_id: normalizeTvdbId(item.tvdb_id || item.id),
    name: item.name || item.translations?.eng || "Unknown",
    year: item.year || (item.first_air_time || "").slice(0, 4) || "",
    image_url: item.image_url || item.thumbnail || "",
  })).filter((item) => item.tvdb_id);
}

const ARTWORK_TYPES_TTL_MS = 30 * DAY_MS;
let artworkTypesPromise = null;
let artworkTypesCachedAt = 0;

// Series artwork type ids aren't stable/documented constants — they're resolved
// dynamically from /artwork/types (cached in-memory) and matched by `name` (not
// `slug` — TVDB's slugs are inconsistently pluralized, e.g. "posters"/"backgrounds"
// vs singular "clearlogo"/"clearart", while `name` is a consistent singular label).
async function getSeriesArtworkTypeIds() {
  if (artworkTypesPromise && fresh(artworkTypesCachedAt, ARTWORK_TYPES_TTL_MS)) return artworkTypesPromise;
  artworkTypesCachedAt = Date.now();
  artworkTypesPromise = upstream("artwork-types", {})
    .then((types) => {
      const byName = {};
      for (const t of Array.isArray(types) ? types : []) {
        if (String(t.recordType || "").toLowerCase() !== "series") continue;
        const name = String(t.name || "").toLowerCase();
        if (name) byName[name] = Number(t.id);
      }
      return byName;
    })
    .catch(() => ({}));
  return artworkTypesPromise;
}

export async function getTvdbSeriesArtwork(tvdbId) {
  const id = normalizeTvdbId(tvdbId);
  if (!id) return { posters: [], logos: [], backdrops: [] };
  const byName = await getSeriesArtworkTypeIds();
  const typeIds = [byName.poster, byName.background, byName.clearlogo].filter((v) => Number.isFinite(v));
  try {
    const data = await upstream({ type: "series-artworks", id }, typeIds.length ? { type: typeIds.join(",") } : {});
    const posters = [], logos = [], backdrops = [];
    for (const art of Array.isArray(data?.artworks) ? data.artworks : []) {
      const url = String(art.image || "");
      if (!url) continue;
      const entry = { url, lang: art.language || "", source: "TVDB" };
      const type = Number(art.type);
      if (type === byName.poster) posters.push(entry);
      else if (type === byName.background) backdrops.push(entry);
      else if (type === byName.clearlogo) logos.push(entry);
    }
    return { posters, logos, backdrops };
  } catch {
    return { posters: [], logos: [], backdrops: [] };
  }
}

export async function getTvdbSeriesExtended(tvdbId, { force = false } = {}) {
  const id = normalizeTvdbId(tvdbId);
  if (!id) return null;
  return collapse(`series:${id}`, async () => {
    const cacheId = `series_${id}`;
    const row = seriesGetStmt.get(cacheId);
    const cached = row ? { details: parseJson(row.details), updatedAtMs: row.updated_at_ms } : null;
    // Require `episodes` in the cached payload so rows cached before the
    // meta switch below (which lacked per-season episode counts) are refetched.
    if (!force && cached?.details && Array.isArray(cached.details.episodes) && fresh(cached.updatedAtMs, seriesCacheTtl(cached.details))) return cached.details;
    try {
      const details = await upstream({ type: "series-extended", id }, { meta: "episodes" });
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
  const id = normalizeTvdbId(tvdbId);
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
    if (cached?.details && fresh(cached.updatedAtMs, seasonCacheTtl(cached.details))) return shapeEpisodes(cached.details);
    try {
      const extended = await getTvdbSeriesExtended(id);
      const season = pickSeasonId(extended, number);
      if (!season?.id) {
        if (cached?.details) return shapeEpisodes(cached.details);
        return { episodes: [] };
      }
      const seasonDetails = await upstream({ type: "season-extended", id: season.id });
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
  // TVDB's actual sourceName values are inconsistent ("TheMovieDB.com", "IMDB", etc.)
  // and undocumented — match by prefix rather than exact string.
  const match = list.find((entry) => sourceNames.some((name) => String(entry.sourceName || "").toLowerCase().startsWith(name.toLowerCase())));
  return match ? String(match.id || "") : "";
}

export function shapeTvdbSeriesAsTmdb(extended) {
  if (!extended) return null;
  const episodeCounts = new Map();
  for (const episode of Array.isArray(extended.episodes) ? extended.episodes : []) {
    const seasonNumber = Number(episode.seasonNumber);
    if (!Number.isFinite(seasonNumber)) continue;
    episodeCounts.set(seasonNumber, (episodeCounts.get(seasonNumber) || 0) + 1);
  }
  const seasons = (Array.isArray(extended.seasons) ? extended.seasons : [])
    .filter((season) => (season.type?.type === "official" || season.type?.name === "Aired Order") && Number(season.number) >= 0)
    // TVDB sometimes carries an empty "Specials" placeholder (season 0) with no
    // episodes attached — unlike a not-yet-aired regular season, an empty Specials
    // entry has nothing to browse, so drop it rather than show a dead accordion row.
    .filter((season) => Number(season.number) > 0 || episodeCounts.has(0))
    .map((season) => ({
      season_number: season.number,
      episode_count: episodeCounts.get(Number(season.number)) ?? null,
      name: season.name || (season.number === 0 ? "Specials" : `Season ${season.number}`),
      poster_path: season.image || null,
    }));

  const tmdbId = bestRemoteId(extended.remoteIds, ["TheMovieDB"]);
  const imdbId = bestRemoteId(extended.remoteIds, ["IMDB"]);
  // Specials (season 0) stay in `seasons` so they're still browsable, but don't
  // count toward the show's episode/season totals used for watched-progress.
  const regularSeasons = seasons.filter((season) => Number(season.season_number) > 0);
  const numberOfEpisodes = regularSeasons.reduce((sum, season) => sum + (Number(season.episode_count) || 0), 0);

  return {
    name: extended.name || "",
    overview: extended.overview || "",
    first_air_date: extended.firstAired || "",
    status: extended.status?.name || "",
    genres: (extended.genres || []).map((genre) => ({ id: genre.id, name: genre.name })),
    networks: extended.originalNetwork ? [{ id: extended.originalNetwork.id, name: extended.originalNetwork.name }] : [],
    seasons,
    number_of_episodes: numberOfEpisodes,
    number_of_seasons: regularSeasons.length,
    tvdb_poster_url: extended.image || null,
    external_ids: {
      tvdb_id: String(extended.id || ""),
      imdb_id: imdbId,
      tmdb_id: tmdbId,
    },
  };
}
