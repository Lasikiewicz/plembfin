import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { runForceSync, runScheduledSync } from "../scheduled.js";
import { getLogs as getDiagnosticLogs, clearLogs as clearDiagnosticLogs } from "../utils/diagnosticLogger.js";
import { appendSyncHistory, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState, appendRuntimeLog } from "../utils/configStore.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes } from "../utils/jellyfinClient.js";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "../utils/parsers.js";
import { getTargetsForSource, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { watchedPlayedSyncEnabled } from "../utils/syncFlags.js";
import { fetchPosterFromTmdb } from "../utils/tmdbClient.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "../utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, searchTmdb, getCachedTvdbId } from "../utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork } from "../utils/tvdbGateway.js";
import { getUpcomingCalendarMonth } from "../utils/upcomingCalendarCache.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "../utils/fanartGateway.js";
import { getOmdbRating } from "../utils/omdbGateway.js";
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, PUBLIC_DIR } from "../paths.js";
import {
  countPlaybackProgressRows,
  countWatchedPlaystateRows,
  deletePlaybackProgress,
  deleteWatchRecord,
  deleteWatchRecordById,
  updateWatchRecord,
  mergeShows,
  getWatchRecordById,
  getWatchRecordByIdLight,
  getWatchRecordByMediaKey,
  getHistoryCacheVersion,
  getWatchStats,
  invalidateHistoryDerivedCaches,
  insertWatchRecord,
  listLibraryItemsForRefresh,
  relatedPosterRows,
  setWatchPosterUrls,
  setWatchBackdropUrl,
  listPlaybackProgressRowsForReplay,
  listWatchedPlaystateRowsForReplay,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  mediaKeyFor,
  progressRowToMedia,
  querySyncJobs,
  queryMovies,
  queryShowDetail,
  queryShows,
  queryWatchHistory,
  queryWatchHistoryPreview,
  requireDb,
  updateWatchPosterUrl,
  updatePlaybackProgressTelemetry,
  updateWatchTelemetry,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
  normalizeWatchRecordForInsert,
  watchRowToMedia,
  getCachedMovies,
  getCachedHistory,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  getPlaystateForMedia,
  countMissingPosterTraktRows,
  listMissingPosterTraktRows,
  stampWatchPoster,
  setWatchMediaType,
  loadWatchKeyGroupsForDedup,
  deleteWatchRecordsByIds,
  deleteMovieByWatchId,
  deletePosterCacheByMediaKey,
  backfillUnknownShowTitles,
  clearWatchArtworkUrls,
} from "../utils/dataRepo.js";

function imagePath(path, params = {}) {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return "";
  try {
    const url = new URL(cleanPath, "https://media.local");
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    return "";
  }
}

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

function posterPathFromMedia(media = {}) {
  if (media.posterUrl) return media.posterUrl;
  if (media.source === "plex" && media.poster?.path) return imagePath(media.poster.path);
  if ((media.source === "emby" || media.source === "jellyfin") && media.poster?.itemId) {
    return imagePath(`/Items/${encodeURIComponent(media.poster.itemId)}/Images/Primary`, { tag: media.poster.tag });
  }
  return "";
}

function configForPosterSource(config = {}, source = "") {
  const key = String(source || "").toLowerCase();
  if (key.includes("plex")) return { ...config.plex, source: "plex" };
  if (key.includes("emby")) return { ...config.emby, source: "emby" };
  if (key.includes("jellyfin")) return { ...config.jellyfin, source: "jellyfin" };
  return {};
}

function configuredPosterUrl(path = "", source = "", config = {}) {
  const raw = String(path || "").trim();
  const server = configForPosterSource(config, source);
  const baseUrl = String(server.baseUrl || server.url || "").trim().replace(/\/+$/, "");
  if (!raw || !baseUrl) return "";

  try {
    const url = new URL(raw, `${baseUrl}/`);
    if (server.source === "plex" && (server.token || server.apiKey)) {
      url.searchParams.set("X-Plex-Token", server.token || server.apiKey);
    }
    if ((server.source === "emby" || server.source === "jellyfin") && (server.apiKey || server.api_key)) {
      url.searchParams.set("api_key", server.apiKey || server.api_key);
    }
    return url.toString();
  } catch (error) {
    return "";
  }
}

function isHttpsUrl(value = "") {
  return /^https:\/\//i.test(String(value || "").trim());
}

function isHttpUrl(value = "") {
  return /^http:\/\//i.test(String(value || "").trim());
}

function isCachedStorageUrl(value = "") {
  const raw = String(value || "").trim();
  // Locally cached artwork is served from /media/posters or /media/backdrops.
  return raw.startsWith("/media/posters/") || raw.startsWith("/media/backdrops/");
}

const inflight = new Map();

async function findLiveSessionPosterRow(mediaKey) {
  if (!mediaKey) return null;
  const [cacheRows, activeRows] = await Promise.all([
    loadLiveTrackingCache({ includeCompleted: false }).catch(() => []),
    listActiveSessions().catch(() => []),
  ]);
  const sessions = [...cacheRows.map(hydrateCachedSession), ...activeRows];
  for (const session of sessions) {
    if (mediaKeyFor(session) !== mediaKey) continue;
    const ids = session.ids || {};
    return {
      id: mediaKey,
      media_key: mediaKey,
      title: session.title,
      media_type: session.mediaType || session.media_type,
      source: session.source,
      imdb_id: ids.imdb || null,
      tmdb_id: ids.tmdb || null,
      tvdb_id: ids.tvdb || null,
      season: session.season ?? null,
      episode: session.episode ?? null,
      poster_url: session.posterUrl || session.poster_url || null,
    };
  }
  return null;
}

export async function handlePoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const cacheHeaders = { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400" };

  try {
    const rowId = String(req.query.id || "");
    let row = await getWatchRecordByIdLight(rowId);
    if (!row) {
      row = await getWatchRecordByMediaKey(rowId).catch(() => null);
    }
    if (!row) {
      const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(rowId);
      if (progressRow) {
        row = {
          id: progressRow.media_key,
          media_key: progressRow.media_key,
          title: progressRow.title,
          media_type: progressRow.media_type,
          source: progressRow.source,
          imdb_id: progressRow.imdb_id,
          tmdb_id: progressRow.tmdb_id,
          tvdb_id: progressRow.tvdb_id,
          season: progressRow.season,
          episode: progressRow.episode,
          poster_url: null,
        };
      }
    }
    if (!row) {
      row = await findLiveSessionPosterRow(rowId).catch(() => null);
    }
    if (!row) return sendJson(res, { error: "not found" }, 404);

    const fallbackRequested = ["1", "true", "yes"].includes(String(req.query.fallback || "").toLowerCase());
    const config = await loadMediaConfig().catch(() => ({}));
    const mediaKey = row.media_key || mediaKeyFor(row);
    const posterUpdateId = row.id || rowId;

    // Check for fresh cached result first (before deduplication check).
    // However, ignore negative cache for items without poster_url - these should retry TMDB fallback.
    const cached = usableCachedPoster(await getPosterCache(mediaKey));
    if (cached?.url) return sendJson(res, cached, 200, cacheHeaders);
    if (cached?.cached && row.poster_url) return sendJson(res, cached, 200, cacheHeaders);

    // If another request is already processing this mediaKey, wait for it to complete.
    if (inflight.has(mediaKey)) {
      await inflight.get(mediaKey);
      const recheck = usableCachedPoster(await getPosterCache(mediaKey));
      if (recheck?.url || recheck?.cached) return sendJson(res, recheck, 200, cacheHeaders);
      return sendJson(res, { url: null, cached: true, source: "missing" }, 200, cacheHeaders);
    }

    // Mark this mediaKey as inflight and process it.
    // Other concurrent requests will wait for this to complete.
    const processingPromise = (async () => {
      try {
        if (row.poster_url && !fallbackRequested && isCachedStorageUrl(row.poster_url)) {
          return { url: row.poster_url, cached: true, source: "storage" };
        }

        const candidates = [];
        if (row.poster_url && !fallbackRequested) {
          if (/^https?:\/\//i.test(row.poster_url)) candidates.push({ url: row.poster_url, source: "stored" });
          const configuredUrl = configuredPosterUrl(row.poster_url, row.source, config);
          if (configuredUrl) candidates.push({ url: configuredUrl, source: configForPosterSource(config, row.source).source || "configured" });
        }

        if (String(row.source || "").toLowerCase().includes("plex") && config.plex?.baseUrl && config.plex?.token) {
          const item = await findPlexItem(config.plex, {
            title: row.title,
            type: row.media_type,
            ids: { imdb: row.imdb_id || null, tmdb: row.tmdb_id || null, tvdb: row.tvdb_id || null },
            season: row.season ?? null,
            episode: row.episode ?? null,
          }).catch((error) => {
            console.error("Poster Plex lookup failed", { id: row.id, title: row.title, error: error.message || String(error) });
            return null;
          });
          const path = row.media_type === "episode"
            ? item?.grandparentThumb || item?.parentThumb || item?.thumb || item?.grandparentArt || item?.parentArt || item?.art || ""
            : item?.thumb || item?.parentThumb || item?.grandparentThumb || item?.art || item?.parentArt || item?.grandparentArt || "";
          if (path) {
            const configuredUrl = configuredPosterUrl(path, "plex", config);
            if (configuredUrl) candidates.push({ url: configuredUrl, source: "plex" });
          }
        }

        if (config.tmdb?.apiKey && (fallbackRequested || !row.poster_url || isHttpUrl(row.poster_url) || !/^https?:\/\//i.test(row.poster_url))) {
          const tmdbPoster = await fetchPosterFromTmdb(row, config.tmdb.apiKey).catch((error) => {
            console.error("Poster TMDB fallback failed", { id: row.id, title: row.title, error: error.message || String(error) });
            return null;
          });
          if (tmdbPoster) {
            candidates.push({ url: tmdbPoster, source: "tmdb" });
          }
        }

        const seen = new Set();
        for (const candidate of candidates) {
          if (!candidate.url || seen.has(candidate.url)) continue;
          seen.add(candidate.url);

          // If the URL is already a cached storage image, return it directly
          if (isCachedStorageUrl(candidate.url)) {
            await updateWatchPosterUrl(posterUpdateId, candidate.url).catch((error) => {
              console.error("Failed to persist poster URL", { id: row.id, title: row.title, error: error.message || String(error) });
            });
            return { url: candidate.url, cached: true, source: candidate.source };
          }

          const cachedPoster = await cachePosterFromUrl(mediaKey, candidate.url, candidate.source);
          if (cachedPoster?.url) {
            await updateWatchPosterUrl(posterUpdateId, cachedPoster.url).catch((error) => {
              console.error("Failed to persist cached poster URL", { id: row.id, title: row.title, error: error.message || String(error) });
            });
            return cachedPoster;
          }
        }
        await markPosterMissing(mediaKey, "poster", "No usable poster candidate").catch(() => null);
        return { url: null, cached: true, source: "missing" };
      } catch (error) {
        console.error("Poster processing failed", { id: rowId, mediaKey, error: error.message || String(error) });
        return null;
      }
    })();

    inflight.set(mediaKey, processingPromise);
    const result = await processingPromise;
    inflight.delete(mediaKey);

    if (result) {
      return sendJson(res, result, 200, cacheHeaders);
    }

    // If result is null (error occurred), try to return cached result or error response.
    const fallback = usableCachedPoster(await getPosterCache(mediaKey));
    if (fallback?.url || fallback?.cached) {
      return sendJson(res, fallback, 200, cacheHeaders);
    }
    return sendJson(res, { url: null, cached: false, source: "error" }, 200, cacheHeaders);
  } catch (error) {
    inflight.delete(String(req.query.id || ""));
    console.error("Poster lookup failed", { id: String(req.query.id || ""), error: error.message || String(error) });
    return sendJson(res, { url: null, cached: false, source: "error" }, 200, cacheHeaders);
  }
}

// Concurrency limiter for TMDB image downloads to avoid hitting rate limits.
// At most 8 downloads run simultaneously; extras queue until a slot frees.
const TMDB_POSTER_CONCURRENCY = 8;
let _tmdbPosterActive = 0;
const _tmdbPosterQueue = [];
const _tmdbPosterInflight = new Map();

function _acquireTmdbPosterSlot() {
  return new Promise((resolve) => {
    if (_tmdbPosterActive < TMDB_POSTER_CONCURRENCY) {
      _tmdbPosterActive++;
      resolve();
    } else {
      _tmdbPosterQueue.push(resolve);
    }
  });
}

function _releaseTmdbPosterSlot() {
  const next = _tmdbPosterQueue.shift();
  if (next) {
    next();
  } else {
    _tmdbPosterActive--;
  }
}

export async function handleTmdbPoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const posterPath = String(req.query.path || "").trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(posterPath)) {
    return sendJson(res, { error: "Invalid TMDB poster path" }, 400);
  }

  const tmdbId = String(req.query.tmdbId || "").trim();
  const mediaType = String(req.query.mediaType || "movie").toLowerCase() === "tv" ? "tv" : "movie";

  const mediaKey = `tmdb:poster:${posterPath}`;
  const cached = usableCachedPoster(await getPosterCache(mediaKey));
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  if (cached?.cached) return res.redirect(302, "/favicon.svg");

  // Deduplicate concurrent requests for the same path.
  if (_tmdbPosterInflight.has(posterPath)) {
    await _tmdbPosterInflight.get(posterPath);
    const recheck = usableCachedPoster(await getPosterCache(mediaKey));
    if (recheck?.url) {
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      return res.redirect(302, recheck.url);
    }
    return res.redirect(302, "/favicon.svg");
  }

  const remoteUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
  const downloadPromise = (async () => {
    await _acquireTmdbPosterSlot();
    try {
      const tmdbResult = await cachePosterFromUrl(mediaKey, remoteUrl, "tmdb");
      if (tmdbResult) return tmdbResult;
      if (!tmdbId) return null;
      const tvdbId = mediaType === "tv" ? getCachedTvdbId(tmdbId) : "";
      const fanartArt = await (mediaType === "tv"
        ? getFanartTvArt(tvdbId)
        : getFanartMovieArt(tmdbId)).catch(() => null);
      if (fanartArt?.poster) {
        return cachePosterFromUrl(mediaKey, fanartArt.poster, "fanart");
      }
      return null;
    } finally {
      _releaseTmdbPosterSlot();
    }
  })();

  _tmdbPosterInflight.set(posterPath, downloadPromise);
  const stored = await downloadPromise;
  _tmdbPosterInflight.delete(posterPath);

  if (!stored?.url) {
    return res.redirect(302, "/favicon.svg");
  }

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

export async function handleTmdbProfile(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const profilePath = String(req.query.path || "").trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(profilePath)) {
    return sendJson(res, { error: "Invalid TMDB profile path" }, 400);
  }

  const mediaKey = `tmdb:profile:${profilePath}`;
  const cached = usableCachedPoster(await getPosterCache(mediaKey, "profile"));
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  if (cached?.cached) return res.redirect(302, "/favicon.svg");

  const remoteUrl = `https://image.tmdb.org/t/p/original${profilePath}`;
  const stored = await cacheProfileFromUrl(mediaKey, remoteUrl, "tmdb");
  if (!stored?.url) {
    return res.redirect(302, "/favicon.svg");
  }

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

export async function handleTmdbDetails(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const mediaType = String(req.query.mediaType || req.query.type || "").trim().toLowerCase();
  let tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
  const title = String(req.query.title || "").trim();
  const ids = {
    imdbId: String(req.query.imdbId || req.query.imdb_id || req.query.imdb || "").trim(),
    tvdbId: String(req.query.tvdbId || req.query.tvdb_id || req.query.tvdb || "").trim(),
  };

  if (!mediaType || (!tmdbId && !title && !ids.imdbId && !ids.tvdbId)) {
    return sendJson(res, { error: "mediaType and a TMDB ID, title, IMDb ID, or TVDB ID are required" }, 400);
  }

  try {
    const details = await getTmdbDetails({ mediaType, tmdbId, title, ids });
    return sendJson(res, details, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    console.error("Failed handling TMDB details API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB details" }, error.status || 500);
  }
}

export async function handleTmdbDetailsBatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items.slice(0, 240) : [];
  if (!items.length) return sendJson(res, { results: [] });

  // Bounded worker pool: upstream calls are serialized by the gateway throttles
  // anyway, so unbounded Promise.all only inflates the in-flight promise count
  // for a cold batch — 8 workers keeps cache hits fast without that.
  const BATCH_CONCURRENCY = 8;
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      const mediaType = String(item?.mediaType || item?.type || "").trim().toLowerCase();
      const tmdbId = String(item?.tmdbId || item?.id || "").trim();
      const title = String(item?.title || "").trim();
      const ids = {
        imdbId: String(item?.imdbId || item?.imdb_id || item?.imdb || "").trim(),
        tvdbId: String(item?.tvdbId || item?.tvdb_id || item?.tvdb || "").trim(),
      };
      if (!mediaType || (!tmdbId && !title && !ids.imdbId && !ids.tvdbId)) {
        results[index] = { error: "invalid" };
        continue;
      }
      try {
        const details = await getTmdbDetails({ mediaType, tmdbId, title, ids, light: item?.light === true });
        results[index] = { details };
      } catch (error) {
        results[index] = { error: error.message || "failed", status: error.status || 500 };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, worker));

  return sendJson(res, { results }, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
}

export async function handleTmdbSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const result = await searchTmdb({ query, page: req.query.page, mediaType: req.query.mediaType || req.query.type || "multi" });
    return sendJson(res, result, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=900", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTvdbSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const results = await searchTvdbSeriesList(query);
    return sendJson(res, { results }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=900", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleMediaSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const localLimit = Math.min(Math.max(Number(req.query.limit || req.query.localLimit || 50), 1), 250);
    const [movies, shows, discovery] = await Promise.all([
      queryMovies({ search: query, limit: localLimit }),
      queryShows({ search: query, limit: localLimit }),
      searchTmdb({ query, page: req.query.page, mediaType: req.query.mediaType || "multi" }),
    ]);
    return sendJson(res, { local: { movies, shows }, discovery }, 200, {
      "Cache-Control": "private, max-age=60, stale-while-revalidate=900",
      Vary: "Authorization",
    });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTmdbSeason(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const details = await getTmdbSeason({ tmdbId: req.query.tmdbId || req.query.id, seasonNumber: req.query.seasonNumber || req.query.season });
    return sendJson(res, details, 200, { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTmdbImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const details = await getTmdbImages({
      mediaType: req.query.mediaType || req.query.type,
      tmdbId: req.query.tmdbId || req.query.id,
      title: req.query.title,
      ids: { tvdbId: req.query.tvdbId || req.query.tvdb_id },
    });
    return sendJson(res, details);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTvdbImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const title = String(req.query.title || "").trim();
    let tvdbId = String(req.query.tvdbId || req.query.tvdb_id || "").trim();
    if (!tvdbId) tvdbId = await resolveTvdbSeriesId({ title }).catch(() => "");
    if (!tvdbId) {
      const tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
      if (tmdbId) tvdbId = getCachedTvdbId(tmdbId);
    }
    if (!tvdbId) return sendJson(res, { posters: [], logos: [], backdrops: [] });
    const result = await getTvdbSeriesArtwork(tvdbId);
    return sendJson(res, result);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleFanartImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const mediaType = req.query.mediaType || req.query.type;
    const tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
    const tvdbIdParam = String(req.query.tvdbId || req.query.tvdb_id || "").trim();
    let result = null;
    if (mediaType === "movie") {
      result = await getAllFanartMovieImages(tmdbId);
    } else {
      const tvdbIds = [];
      const addTvdbId = (value) => {
        const id = String(value || "").trim();
        if (id && !tvdbIds.includes(id)) tvdbIds.push(id);
      };

      addTvdbId(tvdbIdParam);
      addTvdbId(getCachedTvdbId(tmdbId));
      if (tmdbId) {
        const details = await getTmdbDetails({ mediaType: "tv", tmdbId }).catch(() => null);
        addTvdbId(details?.external_ids?.tvdb_id);
      }

      for (const tvdbId of tvdbIds) {
        const candidate = await getAllFanartTvImages(tvdbId);
        const hasImages = Boolean(candidate?.posters?.length || candidate?.logos?.length || candidate?.backdrops?.length);
        if (hasImages) {
          result = candidate;
          break;
        }
        if (!result) result = candidate;
      }
    }
    return sendJson(res, result || { posters: [], logos: [], backdrops: [] });
  } catch (error) {
    return sendJson(res, { error: error.message }, 500);
  }
}

export async function handleTmdbPerson(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const personId = String(req.query.id || "").trim();
  if (!personId) {
    return sendJson(res, { error: "Person ID is required" }, 400);
  }

  try {
    const personData = await getTmdbPerson(personId);
    
    // Deep clone the credits cast so we can enrich them without mutating the cached details
    const responseData = {
      ...personData,
      combined_credits: personData.combined_credits ? {
        ...personData.combined_credits,
        cast: (personData.combined_credits.cast || []).map(credit => ({ ...credit }))
      } : personData.combined_credits
    };

    if (responseData.combined_credits && Array.isArray(responseData.combined_credits.cast)) {
      const cast = responseData.combined_credits.cast;
      const creditTmdbIds = [];
      const creditTitles = [];
      for (const credit of cast) {
        if (credit.id) creditTmdbIds.push(String(credit.id));
        const title = credit.title || credit.name;
        if (title) creditTitles.push(title.toLowerCase());
      }

      if (creditTmdbIds.length > 0) {
        const dbInstance = requireDb();
        const placeholdersTmdb = creditTmdbIds.map(() => "?").join(",");
        const placeholdersTitle = creditTitles.map(() => "?").join(",");
        
        // Fetch all matching rows from watch_history
        const query = `
          SELECT id, tmdb_id, title, media_type, season, episode, show_title, title_lower, show_title_lower, source
          FROM watch_history
          WHERE (tmdb_id IS NOT NULL AND tmdb_id IN (${placeholdersTmdb}))
             OR (title_lower IN (${placeholdersTitle}))
             OR (show_title_lower IN (${placeholdersTitle}))
        `;
        const params = [...creditTmdbIds, ...creditTitles, ...creditTitles];
        const rows = dbInstance.prepare(query).all(params);

        // Sources that mean the item is physically on a connected media server.
        const isMediaServerSource = (src) => {
          const s = String(src || "").toLowerCase();
          return s.startsWith("plex") || s.startsWith("emby") || s.startsWith("jellyfin") || s.startsWith("webhook");
        };

        // Group rows by tmdb_id and show_title_lower for easy lookup
        const rowsByTmdbId = new Map();
        const rowsByTitleLower = new Map();
        
        for (const row of rows) {
          if (row.tmdb_id) {
            const key = String(row.tmdb_id);
            if (!rowsByTmdbId.has(key)) rowsByTmdbId.set(key, []);
            rowsByTmdbId.get(key).push(row);
          }
          if (row.title_lower) {
            const key = row.title_lower;
            if (!rowsByTitleLower.has(key)) rowsByTitleLower.set(key, []);
            rowsByTitleLower.get(key).push(row);
          }
          if (row.show_title_lower) {
            const key = row.show_title_lower;
            if (!rowsByTitleLower.has(key)) rowsByTitleLower.set(key, []);
            rowsByTitleLower.get(key).push(row);
          }
        }

        // Helper to slugify title
        const slug = (str) => String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

        // Map over each credit to check watched status
        for (const credit of cast) {
          const tmdbIdStr = String(credit.id);
          const titleLower = (credit.title || credit.name || "").toLowerCase();
          
          let matchingRows = [];
          if (rowsByTmdbId.has(tmdbIdStr)) {
            matchingRows = rowsByTmdbId.get(tmdbIdStr);
          } else if (rowsByTitleLower.has(titleLower)) {
            matchingRows = rowsByTitleLower.get(titleLower);
          }

          if (matchingRows.length > 0) {
            // "In Library" = physically on a connected media server (Plex/Emby/Jellyfin).
            // Manually-watched or imported items are tracked but not "in library".
            const serverRows = matchingRows.filter(r => isMediaServerSource(r.source));
            
            if (credit.media_type === "tv") {
              const tvRows = matchingRows.filter(r => r.media_type === "episode");
              if (tvRows.length > 0) {
                // Count unique episodes
                const watchedKeys = new Set(tvRows.map(r => `${r.season}_${r.episode}`));
                credit.watched_count = watchedKeys.size;
                const representative = tvRows[0];
                const showTitle = representative.show_title || representative.title || credit.name || credit.title;
                credit.show_title = showTitle;
                credit.library_key = slug(showTitle);
                credit.library_id = representative.id;
                // Only mark in_library if there's a media-server source row
                const serverTvRows = serverRows.filter(r => r.media_type === "episode");
                credit.in_library = serverTvRows.length > 0;
                credit.in_watch_history = true;
              }
            } else {
              const movieRows = matchingRows.filter(r => r.media_type === "movie");
              if (movieRows.length > 0) {
                credit.library_id = movieRows[0].id;
                const serverMovieRows = serverRows.filter(r => r.media_type === "movie");
                credit.in_library = serverMovieRows.length > 0;
                credit.in_watch_history = true;
              }
            }
          }
        }
      }
    }

    return sendJson(res, responseData, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    console.error("Failed handling TMDB person API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB person details" }, error.status || 500);
  }
}

// Ultra-cheap, no-auth endpoint that returns immediately â€” client calls this on
// page load so the server is warm by the time the user clicks into anything.

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("?")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com") return u.searchParams.get("v") || null;
  } catch { /* invalid URL */ }
  return null;
}

// Trailer metadata is immutable per video id, so responses are cached 30 days.
// A cached oEmbed-only entry is refetched once a Data API key appears, so the
// richer fields (description, duration) fill in without waiting out the TTL.
const YOUTUBE_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const youtubeMetaGetStmt = db.prepare("SELECT data, updated_at_ms FROM youtube_meta_cache WHERE id = ?");
const youtubeMetaSetStmt = db.prepare(
  `INSERT INTO youtube_meta_cache (id, data, updated_at_ms) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at_ms=excluded.updated_at_ms`,
);

export async function handleYoutubeMeta(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const url = String(req.query.url || "").trim();
  if (!url) return sendJson(res, { error: "url is required" }, 400);

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return sendJson(res, { error: "Could not extract YouTube video ID from URL" }, 400);

  const cachedRow = youtubeMetaGetStmt.get(videoId);
  if (cachedRow && Date.now() - Number(cachedRow.updated_at_ms || 0) < YOUTUBE_META_TTL_MS) {
    const cached = parseJson(cachedRow.data);
    const config = await loadMediaConfig();
    const wantsApiFields = Boolean(config.youtube?.apiKey);
    if (cached && (!wantsApiFields || cached.publishedAt || cached.description)) {
      return sendJson(res, cached);
    }
  }

  // oEmbed is free, no API key required
  let title = "";
  let channelName = "";
  try {
    const oembedRes = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {}, 8000);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      title = oembed.title || "";
      channelName = oembed.author_name || "";
    }
  } catch { /* non-fatal */ }

  // Optional: YouTube Data API for description, duration, publishedAt
  let description = "";
  let publishedAt = "";
  let duration = "";
  const config = await loadMediaConfig();
  const ytApiKey = config.youtube?.apiKey;
  if (ytApiKey) {
    try {
      const apiRes = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}`, { headers: { "X-goog-api-key": ytApiKey } }, 8000);
      if (apiRes.ok) {
        const apiData = await apiRes.json();
        const item = apiData.items?.[0];
        if (item) {
          title = title || item.snippet?.title || "";
          channelName = channelName || item.snippet?.channelTitle || "";
          description = item.snippet?.description || "";
          publishedAt = item.snippet?.publishedAt || "";
          duration = item.contentDetails?.duration || "";
        }
      }
    } catch { /* non-fatal */ }
  }

  // Thumbnail URLs from highest to lowest quality
  const thumbnails = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  ];

  const payload = { videoId, title, channelName, description, publishedAt, duration, thumbnails };
  // Only cache when at least the oEmbed call answered — an all-empty payload
  // usually means a transient failure, not an empty video.
  if (title || channelName) {
    youtubeMetaSetStmt.run(videoId, toJson(payload), Date.now());
  }
  return sendJson(res, payload);
}

export async function handleOmdbRating(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const imdbId = String(req.query.imdbId || "").trim();
  if (!imdbId) return sendJson(res, { error: "imdbId is required" }, 400);

  const config = await loadMediaConfig();
  if (!config.omdb?.apiKey) return sendJson(res, { error: "OMDb API key not configured" }, 503);

  try {
    const rating = await getOmdbRating(imdbId, config.omdb.apiKey);
    return sendJson(res, rating || {});
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }
}

// --- Upcoming episodes calendar ---------------------------------------------
export async function handleUpcoming(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const requested = String(req.query.month || "").trim();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : new Date().toISOString().slice(0, 7);
    const payload = await getUpcomingCalendarMonth(month);
    return sendJson(res, payload);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}
