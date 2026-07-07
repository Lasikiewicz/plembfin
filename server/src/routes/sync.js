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
  getCachedShows,
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

import { shouldSkipPostRestoreCompletedWebhook } from "./backups.js";

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

async function normalizeWebhook(req) {
  const contentType = req.get("content-type") || "";
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    return parsePlexWebhook(await readFormData(req));
  }
  if (contentType.includes("application/json")) {
    const json = await readJson(req);
    const customPayload = parseCustomWebhook(json);
    if (customPayload.isValid) return customPayload;
    const embyPayload = parseEmbyWebhook(json);
    if (embyPayload.isValid || json?.Event) return embyPayload;
    return parseJellyfinWebhook(json);
  }
  return {
    isValid: false,
    source: "unknown",
    ids: {},
    title: "Unsupported webhook content type",
    rawPayloadDebug: { contentType },
  };
}

function formatDispatchTelemetry(summary, media, action = "watched") {
  const actionLabel = action === "unwatched" || action === "unplayed" ? "Marked Unwatched" : "Marked Watched";
  const lines = [
    `Origin: ${media.source || "unknown"}`,
    `Action: ${actionLabel}`,
    `Media: ${media.title || "unknown"}`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
  ];
  for (const state of summary.targetStates || []) {
    lines.push(`${platformLabel(state.target)} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`);
  }
  return lines.join("\n");
}

function formatProgressTelemetry(summary, media) {
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  const lines = [
    `Origin: ${media.source || "unknown"}`,
    `Media: ${media.title || "unknown"}`,
    `Resume position: ${Math.round(positionMs / 1000)}s`,
    `Progress: ${Number(media.progress || 0).toFixed(1)}%`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
  ];
  for (const state of summary.targetStates || []) {
    lines.push(`${platformLabel(state.target)} progress status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`);
  }
  return lines.join("\n");
}

async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
  await appendSyncHistory({
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    source: media.source || "unknown",
    status: summary.status || "unknown",
    details: summary.details || "",
    action,
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: media.event || "",
      phase: media.phase || "",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
    },
  }).catch((error) => console.error("Failed to append sync history", error));
}

function platformLabel(value) {
  const text = String(value || "unknown");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizedIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function looksLikeServerUserId(value = "") {
  const text = normalizedIdentity(value);
  return /^[0-9a-f-]{16,}$/i.test(text) || /^[a-z0-9_-]{20,}$/i.test(text);
}

function shouldIgnoreWebhookUser(mediaUser = "", configuredUser = "", { strictName = false } = {}) {
  const incoming = normalizedIdentity(mediaUser);
  const configured = normalizedIdentity(configuredUser);
  if (!configured || !incoming) return false;
  if (incoming === configured) return false;
  if (strictName) return true;
  return looksLikeServerUserId(incoming);
}

function manualWatchMediaFromRecord(record = {}) {
  return {
    title: record.title,
    type: record.media_type,
    source: "manual",
    ids: {
      imdb: record.imdb_id || undefined,
      tmdb: record.tmdb_id || undefined,
      tvdb: record.tvdb_id || undefined,
    },
    season: record.season == null ? undefined : Number(record.season),
    episode: record.episode == null ? undefined : Number(record.episode),
    posterUrl: record.poster_url || undefined,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

function showTitleFromProgressTitle(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

async function enrichProgressWatchRecordWithTmdb(record = {}, body = {}) {
  const mediaType = record.media_type === "episode" ? "tv" : record.media_type;
  if (!["movie", "tv"].includes(mediaType)) return record;

  const ids = {
    imdbId: body.imdb_id || body.imdbId || body.imdb || record.imdb_id,
    tvdbId: body.tvdb_id || body.tvdbId || body.tvdb || record.tvdb_id,
  };
  const title = mediaType === "tv" ? showTitleFromProgressTitle(record.title) : record.title;
  const tmdbId = body.tmdb_id || body.tmdbId || body.tmdb || record.tmdb_id;

  if (tmdbId && record.tmdb_id) return record;

  try {
    const details = await getTmdbDetails({ mediaType, tmdbId, title, ids });
    if (details?.id && !record.tmdb_id) record.tmdb_id = String(details.id);
    const externalIds = details?.external_ids || {};
    if (!record.imdb_id && externalIds.imdb_id) record.imdb_id = externalIds.imdb_id;
    if (!record.tvdb_id && externalIds.tvdb_id) record.tvdb_id = String(externalIds.tvdb_id);
  } catch (error) {
    console.warn("Progress watch TMDB enrichment skipped", {
      title: record.title,
      mediaType: record.media_type,
      reason: error.message || String(error),
    });
  }

  return record;
}

function mediaFromWatchRecord(record) {
  return {
    title: record.title,
    type: record.media_type,
    source: record.source || "manual",
    ids: {
      imdb: record.imdb_id || undefined,
      tmdb: record.tmdb_id || undefined,
      tvdb: record.tvdb_id || undefined,
    },
    season: record.season == null ? undefined : Number(record.season),
    episode: record.episode == null ? undefined : Number(record.episode),
    posterUrl: record.poster_url || undefined,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

// Core of "mark unwatched": delete the watched record, write a superseding
// unwatched record, flip the playstate cache, and propagate unplayed to the other
// platforms. Shared by the webhook `unplayed` phase and the manual-unwatch handler.
export async function applyManualUnwatch(media, config, loopStore, recordId = "", { includeSourcePlatform = false } = {}) {
  let wasDeleted = false;
  if (recordId) {
    wasDeleted = await deleteWatchRecordById(recordId, { skipInvalidate: true }).catch((error) => {
      console.error("Failed to delete watch record by id", error);
      return false;
    });
  }
  const wasDeletedByMediaKey = await deleteWatchRecord(media, { skipInvalidate: true }).catch((error) => {
    console.error("Failed to delete watch record", error);
    return false;
  });
  wasDeleted = wasDeleted || wasDeletedByMediaKey;
  await deletePlaybackProgress(media).catch(() => null);

  const pendingSummary = { skipped: false, status: "pending", details: "Unwatched propagation queued", targetStates: [] };
  const unplayedRecord = mediaToWatchRecord({ ...media, syncAction: "unwatched" }, media.source);
  unplayedRecord.sync_action = "unwatched";
  unplayedRecord.sync_dispatch_telemetry = formatDispatchTelemetry(pendingSummary, media, "unwatched");
  const result = await insertWatchRecord(unplayedRecord, { skipInvalidate: true });
  await upsertPlaystateForMedia(media, "unwatched", result.record.watched_at, { skipInvalidate: true });

  // Clear resume progress on all target platforms to prevent re-import on next sync
  // Use direct platform calls since shouldSyncResumeProgress blocks position 0
  const syncMedia = includeSourcePlatform ? { ...media, source: "manual" } : media;
  const targets = getTargetsForSource(syncMedia.source, config);
  for (const target of targets) {
    try {
      if (target === "plex") await setPlexProgress(config.plex, { ...media, positionMs: 0 });
      if (target === "emby") await setEmbyProgress(config.emby, { ...media, positionMs: 0 });
      if (target === "jellyfin") await setJellyfinProgress(config.jellyfin, { ...media, positionMs: 0 });
    } catch (error) {
      console.log(`Resume progress clear on ${target} during unwatch failed (non-fatal)`, error.message);
    }
  }

  const summary = await syncMediaUnplayedPlaystate(syncMedia, config, loopStore).catch((error) => ({
    skipped: false,
    status: "error",
    details: `Unwatched propagation failed: ${error.message || String(error)}`,
    targetStates: [],
  }));
  await updateWatchTelemetry(result.id, formatDispatchTelemetry(summary, media, "unwatched"), { skipInvalidate: true });
  await recordSyncHistory(media, summary, "unwatched");
  return { wasDeleted, id: result.id, summary };
}

export async function handleSyncJobs(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const jobs = await querySyncJobs({
    limit: req.query.limit || 100,
    offset: req.query.offset || 0,
    status: req.query.status || "outstanding",
  });
  return sendJson(res, { jobs }, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

export async function handleSyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const history = await getSyncHistory(req.query.limit || 100);
  return sendJson(res, { history }, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

export async function handleManualUnwatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);

  const record = await getWatchRecordById(id);
  if (!record) return sendJson(res, { error: "Watch record not found" }, 404);

  const media = mediaFromWatchRecord(record);
  const config = await loadMediaConfig();
  const loopStore = createLoopStore();

  try {
    const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, id, { includeSourcePlatform: true });
    return sendJson(res, { ok: true, id: unwatchedId, status: summary.status, targetStates: summary.targetStates || [] });
  } catch (error) {
    console.error("Manual unwatch failed", error);
    return sendJson(res, { error: "Manual unwatch failed", details: error.message }, 500);
  } finally {
    await invalidateHistoryDerivedCaches().catch(() => null);
  }
}

export async function handleManualWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const records = Array.isArray(body) ? body : body.records;
  if (!Array.isArray(records)) return sendJson(res, { error: "Expected an array of records" }, 400);
  if (records.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  const results = [];
  const syncTasks = [];
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;

  for (const [index, rawRecord] of records.entries()) {
    try {
      const pending = {
        ...rawRecord,
        source: rawRecord.source || "manual",
        sync_action: "watched",
        sync_dispatch_telemetry: "Origin: manual\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
      };
      const { data, record } = normalizeWatchRecordForInsert(pending, "manual");
      const existing = await findExistingWatch(data.mediaKey || mediaKeyFor(record), data.watchedAt);

      const media = manualWatchMediaFromRecord(record);
      let id = "";
      if (!existing) {
        const insertResult = await insertWatchRecord(record, { skipInvalidate: true });
        id = insertResult.id;
        await insertResult.assetPrefetch?.catch(() => null);
        inserted += 1;
      } else {
        id = existing.id;
        skipped += 1;
      }

      await upsertPlaystateForMedia(media, "watched", record.watched_at, { skipInvalidate: true });
      syncTasks.push({ media, id, record });

      results.push({ index, id, title: record.title, inserted: !existing, status: "pending", targetStates: [] });
    } catch (error) {
      rejected += 1;
      results.push({ index, rejected: true, error: error.message || String(error) });
    }
  }

  await invalidateHistoryDerivedCaches().catch(() => null);

  // Sync in the background to prevent client timeouts
  if (syncTasks.length > 0) {
    (async () => {
      for (const task of syncTasks) {
        try {
          const summary = await syncMediaPlaystate(task.media, config, loopStore).catch((error) => ({
            skipped: false,
            status: "error",
            details: `Manual watch propagation failed: ${error.message || String(error)}`,
            targetStates: [],
          }));

          await updateWatchTelemetry(task.id, formatDispatchTelemetry(summary, task.media, "watched"), { skipInvalidate: true });
          await recordSyncHistory(task.media, summary, "watched");
        } catch (error) {
          console.error("Background manual watch sync failed:", error);
        }
      }
      await invalidateHistoryDerivedCaches().catch(() => null);
    })().catch((error) => console.error("Background manual watch sync loop crashed:", error));
  }

  return sendJson(res, { ok: true, inserted, skipped, rejected, propagated: 0, syncQueued: syncTasks.length, results });
}

export async function handlePlaybackProgressList(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const rows = await listPlaybackProgressRowsForReplay({ limit, offset });
    const total = await countPlaybackProgressRows();

    const decoratedRows = await Promise.all(rows.map(async (row) => {
      const mediaKey = row.media_key;
      let posterUrl = null;
      try {
        const cached = await getPosterCache(mediaKey);
        if (cached && (cached.url || cached.cached)) {
          posterUrl = cached.url || "/favicon.svg";
        }
      } catch (err) {
        // ignore
      }
      return { ...row, poster_url: posterUrl };
    }));

    return sendJson(res, { progress: decoratedRows, total });
  } catch (error) {
    console.error("Failed to list playback progress", error);
    return sendJson(res, { error: "Failed to list playback progress", details: error.message }, 500);
  }
}

export async function handlePlaybackProgressWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const mediaKey = String(body.media_key || "").trim();
  if (!mediaKey) return sendJson(res, { error: "media_key is required" }, 400);

  try {
    const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
    if (!progressRow) return sendJson(res, { error: "Playback progress item not found" }, 404);

    const config = await loadMediaConfig();
    const loopStore = createLoopStore();

    const record = {
      title: progressRow.title,
      media_type: progressRow.media_type,
      source: progressRow.source || "manual",
      imdb_id: body.imdb_id || body.imdbId || body.imdb || progressRow.imdb_id || null,
      tmdb_id: body.tmdb_id || body.tmdbId || body.tmdb || progressRow.tmdb_id || null,
      tvdb_id: body.tvdb_id || body.tvdbId || body.tvdb || progressRow.tvdb_id || null,
      season: progressRow.season ?? null,
      episode: progressRow.episode ?? null,
      watched_at: body.watched_at || Date.now(),
      sync_action: "watched",
      sync_dispatch_telemetry: "Origin: progress_resolve\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
    };
    await enrichProgressWatchRecordWithTmdb(record, body);

    const { data, record: normalizedRecord } = normalizeWatchRecordForInsert(record, "manual");
    const existing = await findExistingWatch(data.mediaKey || mediaKeyFor(normalizedRecord), data.watchedAt);

    const media = manualWatchMediaFromRecord(normalizedRecord);
    let id = "";
    if (!existing) {
      const insertResult = await insertWatchRecord(normalizedRecord, { skipInvalidate: true });
      id = insertResult.id;
      await insertResult.assetPrefetch?.catch(() => null);
    } else {
      id = existing.id;
    }

    await upsertPlaystateForMedia(media, "watched", record.watched_at, { skipInvalidate: true });

    await deletePlaybackProgress({ ...progressRow, media_key: mediaKey }).catch(() => null);
    await deletePlaybackProgress(media).catch(() => null);

    (async () => {
      try {
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Watch propagation failed: ${error.message || String(error)}`,
          targetStates: [],
        }));
        await updateWatchTelemetry(id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
      } catch (err) {
        console.error("Background sync for progress watch failed:", err);
      } finally {
        await invalidateHistoryDerivedCaches().catch(() => null);
      }
    })().catch((error) => console.error("Background sync loop crashed:", error));

    await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { ok: true, id });
  } catch (error) {
    console.error("Mark watch from progress failed", error);
    return sendJson(res, { error: "Mark watch from progress failed", details: error.message }, 500);
  }
}

export async function handlePlaybackProgressUnwatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const mediaKey = String(body.media_key || "").trim();
  if (!mediaKey) return sendJson(res, { error: "media_key is required" }, 400);

  try {
    const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
    if (!progressRow) return sendJson(res, { error: "Playback progress item not found" }, 404);

    const media = {
      title: progressRow.title,
      type: progressRow.media_type,
      source: progressRow.source || "manual",
      ids: {
        imdb: progressRow.imdb_id || undefined,
        tmdb: progressRow.tmdb_id || undefined,
        tvdb: progressRow.tvdb_id || undefined,
      },
      season: progressRow.season == null ? undefined : Number(progressRow.season),
      episode: progressRow.episode == null ? undefined : Number(progressRow.episode),
      isValid: Boolean(progressRow.title && ["movie", "episode"].includes(progressRow.media_type)),
    };

    const config = await loadMediaConfig();
    const loopStore = createLoopStore();

    const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, "", { includeSourcePlatform: true });
    return sendJson(res, { ok: true, id: unwatchedId, status: summary.status, targetStates: summary.targetStates || [] });
  } catch (error) {
    console.error("Playback progress unwatch failed", error);
    return sendJson(res, { error: "Playback progress unwatch failed", details: error.message }, 500);
  } finally {
    await invalidateHistoryDerivedCaches().catch(() => null);
  }
}

export async function handleRetrySync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = body.id;
  if (!id) return sendJson(res, { error: "Missing required field: id" }, 400);

  const record = await getWatchRecordById(id);
  if (!record) return sendJson(res, { error: "Watch record not found" }, 404);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();

  const media = mediaFromWatchRecord(record);

  const action = record.sync_action || "watched";
  let summary;
  try {
    if (action === "unwatched" || action === "unplayed") {
      summary = await syncMediaUnplayedPlaystate(media, config, loopStore);
    } else {
      summary = await syncMediaPlaystate(media, config, loopStore);
    }
  } catch (error) {
    console.error("Retry sync failed", error);
    summary = {
      skipped: false,
      status: "error",
      details: `Retry sync failed: ${error.message || String(error)}`,
      targetStates: [],
    };
  }

  await updateWatchTelemetry(id, formatDispatchTelemetry(summary, media, action));
  await recordSyncHistory(media, summary, action);

  return sendJson(res, { ok: true, status: summary.status, targetStates: summary.targetStates || [] });
}

export async function handleNowPlaying(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const [cacheRows, activeRows, runtime] = await Promise.all([
    loadLiveTrackingCache({ includeCompleted: false }).catch(() => []),
    listActiveSessions().catch(() => []),
    loadRuntimeState(),
  ]);

  const withMediaKey = (session = {}) => {
    const mediaKey = session.media_key || session.mediaKey || mediaKeyFor(session);
    return { ...session, media_key: mediaKey, mediaKey };
  };

  const sessions = cacheRows.map(hydrateCachedSession).filter((session) => !session.completedAt).map(withMediaKey);
  const merged = [...sessions];
  for (const active of activeRows) {
    const isDuplicate = merged.some(
      (s) =>
        s.source === active.source &&
        s.title.toLowerCase().trim() === active.title.toLowerCase().trim() &&
        (s.season == null ? null : Number(s.season)) === (active.season == null ? null : Number(active.season)) &&
        (s.episode == null ? null : Number(s.episode)) === (active.episode == null ? null : Number(active.episode))
    );
    if (!isDuplicate) {
      merged.push(withMediaKey({
        sessionId: active.key,
        source: active.source,
        title: active.title,
        mediaType: active.mediaType,
        progress: active.progress,
        offsetMs: active.offsetMs || 0,
        durationMs: active.durationMs || 0,
        season: active.season,
        episode: active.episode,
        posterUrl: active.posterUrl,
        ids: active.ids,
        client: active.client,
        updatedAt: active.updatedAt,
        completedAt: null,
      }));
    }
  }
  merged.sort((a, b) => b.updatedAt - a.updatedAt);

  return sendJson(res, merged, 200, runtime.nowPlayingRefresh ? { "X-Now-Playing-Refresh": String(runtime.nowPlayingRefresh) } : {});
}

export async function handleActiveSessions(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  return sendJson(res, { sessions: await listActiveSessions() });
}

export async function handleCronSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("Cron Sync started...\n");

  const logger = (msg) => {
    res.write(`${msg}\n`);
    console.log(msg);
  };

  try {
    const result = await runScheduledSync(logger);
    await setRuntimeState({ lastCronResult: { ok: true, result, finishedAt: Date.now() } }).catch(() => null);
    res.write(`RESULT: ${JSON.stringify(result)}\n`);
    res.end();
  } catch (error) {
    logger(`ERROR: Cron Sync failed: ${error.message}`);
    await setRuntimeState({ lastCronResult: { ok: false, error: error.message, finishedAt: Date.now() } }).catch(() => null);
    res.write(`RESULT: ${JSON.stringify({ success: false, error: error.message })}\n`);
    res.end();
  }
}

export async function handleCronSyncStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const runtime = await loadRuntimeState();
  return sendJson(res, {
    lastCron: runtime.lastCronExecution || null,
    lastResult: runtime.lastCronResult || null,
  }, 200, { "Cache-Control": "no-store" });
}

let forceSyncRunning = false;

export async function handleForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);

  // GET: poll for current status and log lines stored in runtimeState
  if (req.method === "GET") {
    if (!(await requireAdmin(req, res))) return;
    const runtime = await loadRuntimeState();
    return sendJson(res, {
      active: runtime.forceSyncActive === true,
      log: Array.isArray(runtime.forceSyncLog) ? runtime.forceSyncLog : [],
      result: runtime.forceSyncResult || null,
      startedAt: runtime.forceSyncStartedAt || null,
    });
  }

  // POST: fire-and-forget â€” return 202 immediately, run in background
  if (!(await requireAdmin(req, res))) return;

  const runtime = await loadRuntimeState();
  const FORCE_SYNC_HEARTBEAT_STALE_MS = 3 * 60 * 1000;
  const heartbeat = Number(runtime.forceSyncHeartbeat || runtime.forceSyncStartedAt || 0);
  const stale = !heartbeat || heartbeat < Date.now() - FORCE_SYNC_HEARTBEAT_STALE_MS;
  if (forceSyncRunning || (runtime.forceSyncActive === true && !stale)) {
    return sendJson(res, { ok: false, error: "Another force sync job is already running." }, 409);
  }
  if (runtime.forceSyncActive === true && stale) {
    await setRuntimeState({ forceSyncActive: false, forceSyncCancelRequested: false }).catch(() => null);
  }

  // Clear the previous log and mark as active before returning
  await setRuntimeState({
    forceSyncLog: ["Force Sync started..."],
    forceSyncResult: null,
    forceSyncActive: true,
    forceSyncStartedAt: Date.now(),
    forceSyncHeartbeat: Date.now(),
    forceSyncCancelRequested: false,
  });
  forceSyncRunning = true;

  // Batch log writes: collect lines in memory, flush every 3s.
  const logBuffer = [];
  let flushTimer = null;

  const flushLog = async () => {
    if (!logBuffer.length) return;
    const batch = logBuffer.splice(0, logBuffer.length);
    await appendRuntimeLog("forceSyncLog", batch).catch(() => null);
  };

  const logLine = (msg) => {
    console.log(msg);
    logBuffer.push(msg);
    if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        await flushLog();
      }, 3000);
    }
  };

  // Kick off in background â€” HTTP response returned below without awaiting this
  Promise.resolve().then(async () => {
    const heartbeatTimer = setInterval(() => {
      setRuntimeState({ forceSyncHeartbeat: Date.now() }).catch(() => null);
    }, 30_000);
    heartbeatTimer.unref?.();
    try {
      const result = await runForceSync(logLine, { lockAlreadyClaimed: true });
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushLog(); // flush any remaining lines
      await appendRuntimeLog("forceSyncLog", [`RESULT: ${JSON.stringify(result)}`]).catch(() => null);
      await setRuntimeState({
        forceSyncActive: false,
        forceSyncResult: result,
        forceSyncHeartbeat: Date.now(),
      }).catch(() => null);
    } catch (error) {
      const msg = `ERROR: Force Sync failed: ${error.message}`;
      console.error(msg);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushLog();
      await appendRuntimeLog("forceSyncLog", [msg]).catch(() => null);
      await setRuntimeState({
        forceSyncActive: false,
        forceSyncResult: { success: false, error: error.message },
        forceSyncHeartbeat: Date.now(),
      }).catch(() => null);
    } finally {
      clearInterval(heartbeatTimer);
      forceSyncRunning = false;
    }
  });

  return sendJson(res, { ok: true, started: true, message: "Force Sync started. Poll GET /api/force-sync for status." }, 202);
}



export async function handleStopForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    await setRuntimeState({ forceSyncCancelRequested: true });
    return sendJson(res, { ok: true, message: "Cancellation request received." });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message }, 500);
  }
}




export async function handleWebhook(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  const headerToken = String(req.get("x-plembfin-webhook-secret") || "").trim();
  const authToken = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const queryToken = String(req.query?.token || "").trim();
  if (![headerToken, authToken, queryToken].some((token) => verifyWebhookToken(token))) {
    return sendJson(res, { error: "Unauthorized" }, 401);
  }

  let media;
  try {
    media = await normalizeWebhook(req);
    console.log("Webhook received", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      type: media.type,
      isValid: media.isValid,
      ids: media.ids,
    });
  } catch (error) {
    console.error("Webhook body parsing failed", error);
    return sendJson(res, { error: "Invalid webhook body", details: error.message }, 400);
  }

  await setRuntimeState({
    lastWebhookReceived: {
      timestamp: Date.now(),
      source: media.source || "unknown",
      title: media.title || "unknown",
      event: media.event || "unknown",
      phase: media.phase || "unknown",
      isValid: Boolean(media.isValid),
    },
  }).catch(() => null);

  if (!media.isValid) {
    console.log("Webhook skipped: invalid media", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      reason: media.phase === "ignored" ? "unsupported event" : "missing required media fields",
    });
    await recordSyncHistory(media, {
      status: "skipped",
      details: `Webhook ignored: ${media.phase === "ignored" ? "unsupported event" : "missing required media fields"}`,
      targetStates: [],
    }, media.phase || "webhook").catch(() => null);
    return sendJson(res, {
      ok: true,
      inserted: false,
      skipped: true,
      reason: "Unsupported event or missing provider IDs",
    });
  }

  // While an authoritative restore is pushing fresh state to the apps, ignore inbound
  // webhooks â€” they are the apps echoing our own marks back and would re-record as
  // watched-today. Real user plays resume the moment the restore job finishes.
  const restoreRuntime = await loadRuntimeState();
  if (restoreRuntime.restoreSyncActive === true) {
    console.log("Webhook ignored: authoritative restore in progress (suppressing app echo)", {
      source: media.source,
      title: media.title,
      phase: media.phase,
    });
    await recordSyncHistory(media, {
      status: "skipped",
      details: "Webhook ignored: authoritative restore in progress",
      targetStates: [],
    }, media.phase || "webhook").catch(() => null);
    return sendJson(res, { ok: true, inserted: false, skipped: true, reason: "Authoritative restore in progress" });
  }

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  media.posterUrl = posterPathFromMedia(media);

  if (config) {
    if (config[media.source]?.disabled) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because source platform is disabled",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "Source platform is disabled" });
    }
    if (media.source === "plex" && shouldIgnoreWebhookUser(media.user, config.plex?.username, { strictName: true })) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Plex user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "emby" && shouldIgnoreWebhookUser(media.user, config.emby?.userId)) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Emby user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "jellyfin" && shouldIgnoreWebhookUser(media.user, config.jellyfin?.userId)) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Jellyfin user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
  }

  if (media.type === "season" || media.type === "series") {
    console.log(`Processing ${media.type} webhook sync from ${media.source}`, {
      title: media.title,
      itemId: media.itemId,
      phase: media.phase,
    });

    let episodes = [];
    try {
      if (media.source === "jellyfin") {
        const { fetchJellyfinEpisodes } = await import("../utils/jellyfinClient.js");
        episodes = await fetchJellyfinEpisodes(config.jellyfin, media.itemId);
      } else if (media.source === "emby") {
        const { fetchEmbyEpisodes } = await import("../utils/embyClient.js");
        episodes = await fetchEmbyEpisodes(config.emby, media.itemId);
      }
    } catch (error) {
      console.error("Failed to fetch child episodes for %s %s", media.type, media.itemId, error);
      return sendJson(res, { error: `Failed to fetch episodes for ${media.type}`, details: error.message }, 500);
    }

    console.log("Found %d episodes under %s %s", episodes.length, media.type, media.itemId);

    const results = [];
    const targetPlayed = media.phase === "completed";

    const filteredEpisodes = episodes.filter((ep) => {
      const isPlayed = ep.UserData?.Played === true;
      return targetPlayed ? isPlayed : !isPlayed;
    });

    console.log(`Syncing ${filteredEpisodes.length} episodes with target played state: ${targetPlayed}`);

    await Promise.all(
      filteredEpisodes.map(async (ep) => {
        try {
          const episodeMedia = {
            title: `${ep.SeriesName || media.title || "Unknown Show"} - S${String(ep.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(ep.IndexNumber ?? "?").padStart(2, "0")}`,
            type: "episode",
            source: media.source,
            ids: normalizeProviderIds(ep.ProviderIds),
            season: ep.ParentIndexNumber,
            episode: ep.IndexNumber,
            event: media.event,
            phase: media.phase,
            user: media.user,
            isValid: true,
          };
          episodeMedia.posterUrl = posterPathFromMedia(episodeMedia);

          if (media.phase === "unplayed") {
            await deleteActiveSession(episodeMedia).catch(() => null);
            const wasDeleted = await deleteWatchRecord(episodeMedia, { skipInvalidate: true }).catch((error) => {
              console.error("Failed to delete watch record", error);
              return false;
            });
            await deletePlaybackProgress(episodeMedia).catch(() => null);

            // Clear resume progress on target platforms to prevent re-import on next sync
            // Use direct platform calls since shouldSyncResumeProgress blocks position 0
            const episodeTargets = getTargetsForSource(episodeMedia.source, config);
            for (const target of episodeTargets) {
              try {
                if (target === "plex") await setPlexProgress(config.plex, { ...episodeMedia, positionMs: 0 });
                if (target === "emby") await setEmbyProgress(config.emby, { ...episodeMedia, positionMs: 0 });
                if (target === "jellyfin") await setJellyfinProgress(config.jellyfin, { ...episodeMedia, positionMs: 0 });
              } catch (error) {
                console.log(`Resume progress clear on ${target} during webhook unwatch failed (non-fatal)`, error.message);
              }
            }

            const pendingSummary = { skipped: false, status: "pending", details: "Unwatched propagation queued", targetStates: [] };
            const unplayedRecord = mediaToWatchRecord({ ...episodeMedia, syncAction: "unwatched" }, episodeMedia.source);
            unplayedRecord.sync_action = "unwatched";
            unplayedRecord.sync_dispatch_telemetry = formatDispatchTelemetry(pendingSummary, episodeMedia, "unwatched");
            const dbResult = await insertWatchRecord(unplayedRecord, { skipInvalidate: true });
            await upsertPlaystateForMedia(episodeMedia, "unwatched", dbResult.record.watched_at, { skipInvalidate: true });
            const summary = await syncMediaUnplayedPlaystate(episodeMedia, config, loopStore).catch((error) => ({
              skipped: false,
              status: "error",
              details: `Unwatched propagation failed: ${error.message || String(error)}`,
              targetStates: [],
            }));
            await updateWatchTelemetry(dbResult.id, formatDispatchTelemetry(summary, episodeMedia, "unwatched"), { skipInvalidate: true });
            await recordSyncHistory(episodeMedia, summary, "unwatched");
            results.push({ episodeId: ep.Id, title: episodeMedia.title, success: summary.status === "success" || summary.status === "partial" });
          } else {
            await deleteActiveSession(episodeMedia).catch(() => null);
            const existingPlaystate = await getPlaystateForMedia(episodeMedia).catch(() => null);
            if (existingPlaystate?.state === "watched") {
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Already marked watched" });
              return;
            }
            if (await shouldSkipPostRestoreCompletedWebhook(episodeMedia)) {
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Post-restore completed webhook without active playback evidence" });
              return;
            }
            const watchRecord = mediaToWatchRecord(episodeMedia, episodeMedia.source);
            watchRecord.sync_action = "watched";
            watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, episodeMedia, "watched");
            const dbResult = await insertWatchRecord(watchRecord, { skipInvalidate: true });
            await upsertPlaystateForMedia(episodeMedia, "watched", dbResult.record.watched_at, { skipInvalidate: true });
            const summary = await syncMediaPlaystate(episodeMedia, config, loopStore).catch((error) => ({
              skipped: false,
              status: "error",
              details: `Propagation failed: ${error.message || String(error)}`,
              targetStates: [],
            }));
            await updateWatchTelemetry(dbResult.id, formatDispatchTelemetry(summary, episodeMedia, "watched"), { skipInvalidate: true });
            await recordSyncHistory(episodeMedia, summary, "watched");
            await deletePlaybackProgress(episodeMedia).catch(() => null);
            await dbResult.assetPrefetch?.catch(() => null);
            results.push({ episodeId: ep.Id, title: episodeMedia.title, success: summary.status === "success" || summary.status === "partial" });
          }
        } catch (err) {
          console.error(`Failed to sync episode ${ep.Id} / ${ep.Name}`, err);
          results.push({ episodeId: ep.Id, success: false, error: err.message });
        }
      })
    );

    await invalidateHistoryDerivedCaches().catch(() => null);

    return sendJson(res, {
      ok: true,
      batch: true,
      total: filteredEpisodes.length,
      results,
    });
  }

  if (media.phase === "active") {
    await upsertActiveSession(media);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return sendJson(res, { ok: true, active: true, inserted: false, propagated: false, title: media.title, source: media.source });
  }

  if (media.phase === "ended") {
    await deleteActiveSession(media);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    let progressSummary = { skipped: true, status: "skipped", details: "Resume progress is not actionable", targetStates: [] };
    if (shouldSyncResumeProgress(media)) {
      const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
      await upsertPlaybackProgress({
        ...progressRecord,
        sync_dispatch_telemetry: formatProgressTelemetry({ skipped: false, status: "pending", details: "Resume propagation queued", targetStates: [] }, media),
      }).catch((error) => console.error("Failed to store resume progress", error));
      progressSummary = await syncMediaProgress(media, config, loopStore).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Resume propagation failed: ${error.message || String(error)}`,
        targetStates: [],
      }));
      await updatePlaybackProgressTelemetry(progressRecord, formatProgressTelemetry(progressSummary, media)).catch(() => null);
      await recordSyncHistory(media, progressSummary, "progress");
    }
    return sendJson(res, {
      ok: true,
      active: false,
      inserted: false,
      propagated: progressSummary.status === "success" || progressSummary.status === "partial",
      reason: "Playback ended below watched threshold",
      resumeProgress: { status: progressSummary.status, details: progressSummary.details },
    });
  }

  if (media.phase === "unplayed") {
    try {
      console.log("Webhook: marking as unwatched", {
        source: media.source,
        title: media.title,
        type: media.type,
      });
      await deleteActiveSession(media);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      const { wasDeleted, id } = await applyManualUnwatch(media, config, loopStore);
      console.log("Webhook: unwatched sync completed", {
        source: media.source,
        title: media.title,
        wasDeleted,
        id,
      });
      return sendJson(res, { ok: true, deleted: wasDeleted, unplayed: true, inserted: true, id, ...(wasDeleted ? {} : { reason: "No previous watched record found to delete" }) });
    } finally {
      await invalidateHistoryDerivedCaches().catch(() => null);
    }
  }

  try {
    console.log("Webhook: marking as watched", {
      source: media.source,
      title: media.title,
      type: media.type,
      progress: media.progress,
      positionMs: media.positionMs,
    });
    await deleteActiveSession(media);

    // Check if a recent watch record already exists (e.g., from full sync)
    // to avoid creating duplicates. Look for records watched in the last hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const existingRecord = await getWatchRecordByMediaKey(mediaKeyFor(media), oneHourAgo).catch(() => null);
    if (existingRecord) {
      console.log("Webhook: skipped duplicate watch record", {
        source: media.source,
        title: media.title,
        existingWatchedAt: existingRecord.watched_at,
      });
      return sendJson(res, { ok: true, inserted: false, id: existingRecord.id, reason: "Watch record already exists from recent full sync" });
    }

    const existingPlaystate = await getPlaystateForMedia(media).catch(() => null);
    if (existingPlaystate?.state === "watched") {
      console.log("Webhook: skipped watched echo because playstate is already watched", {
        source: media.source,
        title: media.title,
        playstateUpdatedAt: existingPlaystate.updated_at,
      });
      await deletePlaybackProgress(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, { ok: true, inserted: false, id: existingPlaystate.id, reason: "Already marked watched" });
    }

    if (await shouldSkipPostRestoreCompletedWebhook(media)) {
      console.log("Webhook: skipped post-restore completed event without active playback evidence", {
        source: media.source,
        title: media.title,
        type: media.type,
      });
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, {
        ok: true,
        inserted: false,
        skipped: true,
        reason: "Post-restore completed webhook without active playback evidence",
      });
    }

    const watchRecord = mediaToWatchRecord(media, media.source);
    watchRecord.sync_action = "watched";
    watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, media, "watched");
    const result = await insertWatchRecord(watchRecord, { skipInvalidate: true });
    console.log("Webhook: inserted watch record", {
      source: media.source,
      title: media.title,
      recordId: result.id,
      watchedAt: result.record.watched_at,
    });
    await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    console.log("Webhook: sync result", {
      source: media.source,
      title: media.title,
      status: summary.status,
      details: summary.details,
      targetStates: summary.targetStates,
    });
    await updateWatchTelemetry(result.id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
    await recordSyncHistory(media, summary, "watched");
    await deletePlaybackProgress(media).catch(() => null);
    // Ensure TMDB metadata + artwork finish caching before the instance freezes,
    // so the detail page is instant on first click. Overlaps with the sync above.
    await result.assetPrefetch?.catch(() => null);
    await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { ok: true, inserted: true, id: result.id, record: result.record });
  } catch (error) {
    console.error("Webhook insert failed", error);
    await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { error: "Webhook insert failed", details: error.message }, 500);
  }
}
