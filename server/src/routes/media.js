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

export async function handleHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const id = String(req.query.id || "");
  if (id) return sendJson(res, { row: await getWatchRecordById(id) });

  const statsMode = String(req.query.stats || "").toLowerCase();
  if (statsMode === "only") {
    return sendJson(res, { stats: await getWatchStats(requireDb()) });
  }

  const previewMode = String(req.query.preview || "").toLowerCase();
  if (["1", "true", "dashboard"].includes(previewMode)) {
    const [history, historyVersion] = await Promise.all([
      queryWatchHistoryPreview({ limit: req.query.limit || 120 }),
      getHistoryCacheVersion(),
    ]);
    return sendJson(res, { history, historyVersion }, 200, { "Cache-Control": "private, max-age=30, stale-while-revalidate=120", Vary: "Authorization" });
  }

  const dedupe = !["0", "false", "no"].includes(String(req.query.dedupe || "").toLowerCase());
  const includeStats = !["0", "false", "no"].includes(statsMode);
  const requestedLimit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const historyPromise = queryWatchHistory({ search: req.query.search || "", mediaType: req.query.mediaType || "", limit: requestedLimit + 1, offset: req.query.offset || 0, dedupe });
  const historyVersionPromise = getHistoryCacheVersion();

  if (!includeStats) {
    const [historyRows, historyVersion] = await Promise.all([historyPromise, historyVersionPromise]);
    const hasMore = historyRows.length > requestedLimit;
    return sendJson(res, { history: historyRows.slice(0, requestedLimit), hasMore, historyVersion });
  }

  const [historyRows, stats, historyVersion] = await Promise.all([
    historyPromise,
    getWatchStats(requireDb()),
    historyVersionPromise,
  ]);
  const hasMore = historyRows.length > requestedLimit;
  return sendJson(res, { history: historyRows.slice(0, requestedLimit), hasMore, stats, historyVersion });
}

export async function handleClearMissingTelemetry(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const db = requireDb();
    const clearStmt = db.prepare(`
      UPDATE watch_history
      SET sync_dispatch_telemetry = 'Dispatch Status: success'
      WHERE sync_dispatch_telemetry IS NULL OR sync_dispatch_telemetry = ''
    `);
    const result = clearStmt.run();
    await invalidateHistoryDerivedCaches();
    return sendJson(res, { cleared: result.changes });
  } catch (err) {
    console.error("[clearMissingTelemetry] Error:", err);
    return sendJson(res, { error: "Failed to clear telemetry" }, 500);
  }
}

export async function handleMovies(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const movies = await queryMovies({ search: req.query.search || "", sort: req.query.sort || "title_asc", limit: req.query.limit || 100, offset: req.query.offset || 0 });
  return sendJson(res, { movies }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

// Permanently delete a library item (all its plays + playstate + progress).
// Destructive and irreversible â€” the client must send confirm: "DELETE".
export async function handleDeleteMedia(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);
  if (String(body.confirm || "") !== "DELETE") {
    return sendJson(res, { error: "Confirmation required" }, 400);
  }

  try {
    const result = await deleteMovieByWatchId(id);
    if (!result.found) return sendJson(res, { error: "Media item not found" }, 404);
    writeAuditLog("media.deleted", { ip: req.ip || req.socket?.remoteAddress, detail: { id, title: result.title } });
    return sendJson(res, { ok: true, deleted: result.deleted, title: result.title }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Failed to delete media item", error);
    return sendJson(res, { error: error.message || "Failed to delete media item" }, 500);
  }
}

export async function handleShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const shows = await queryShows({
    search: req.query.search || "",
    sort: req.query.sort || "title_asc",
    limit: req.query.limit || 6,
    offset: req.query.offset || 0,
    hideWatched: req.query.hideWatched === "true",
    hideEnded: req.query.hideEnded === "true",
  });
  return sendJson(res, { shows }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

export async function handleShow(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const id = String(req.query.id || "").trim();
  const title = String(req.query.title || "").trim();
  if (!id && !title) return sendJson(res, { error: "id or title is required" }, 400);
  const show = await queryShowDetail({ id, title });
  if (!show) return sendJson(res, { error: "not found" }, 404);
  return sendJson(res, { show }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

function configuredRestoreTargets(config = {}) {
  const targets = [];
  if (!config.plex?.disabled && config.plex?.baseUrl && config.plex?.token) targets.push("plex");
  if (!config.emby?.disabled && config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId) targets.push("emby");
  if (!config.jellyfin?.disabled && config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId) targets.push("jellyfin");
  return targets;
}

function emptyRestoreSummary(targets = []) {
  const summary = {};
  for (const target of targets) {
    summary[target] = { success: 0, skipped: 0, notFound: 0, error: 0 };
  }
  return summary;
}

function restoreClientFor(target, phase, config, media) {
  if (phase === "progress") {
    if (target === "plex") return () => setPlexProgress(config.plex, media);
    if (target === "emby") return () => setEmbyProgress(config.emby, media);
    if (target === "jellyfin") return () => setJellyfinProgress(config.jellyfin, media);
  }
  if (target === "plex") return () => markPlexPlayed(config.plex, media);
  if (target === "emby") return () => markEmbyPlayed(config.emby, media);
  if (target === "jellyfin") return () => markJellyfinPlayed(config.jellyfin, media);
  throw new Error(`Unknown restore target: ${target}`);
}

function applyRestoreResult(summary, target, result) {
  if (!summary[target]) summary[target] = { success: 0, skipped: 0, notFound: 0, error: 0 };
  if (result?.status === "not_found") {
    summary[target].notFound += 1;
  } else if (result?.status === "skipped") {
    summary[target].skipped += 1;
  } else {
    summary[target].success += 1;
  }
}

export async function handleFullSyncWatchstates(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const phase = String(body.phase || "watched") === "progress" ? "progress" : "watched";
  if (phase === "watched" && !watchedPlayedSyncEnabled()) {
    return sendJson(res, {
      ok: true,
      skipped: true,
      phase,
      processed: 0,
      hasMore: false,
      note: "Watched/played syncing is disabled.",
    });
  }
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 25), 1), 100);
  const config = await loadMediaConfig();
  const targets = configuredRestoreTargets(config);
  const summary = emptyRestoreSummary(targets);
  const errors = [];

  if (!targets.length) {
    return sendJson(res, { ok: true, phase, offset, limit, processed: 0, nextOffset: offset, hasMore: false, targets, summary, errors, note: "No configured restore targets." });
  }

  const total = phase === "progress" ? await countPlaybackProgressRows() : await countWatchedPlaystateRows();
  const rows = phase === "progress"
    ? await listPlaybackProgressRowsForReplay({ limit, offset })
    : await listWatchedPlaystateRowsForReplay({ limit, offset });

  for (const row of rows) {
    for (const target of targets) {
      const media = phase === "progress" ? progressRowToMedia(row, target) : watchRowToMedia(row, target);
      if (!media.isValid) {
        summary[target].skipped += 1;
        continue;
      }
      try {
        const result = await restoreClientFor(target, phase, config, media)();
        applyRestoreResult(summary, target, result);
      } catch (error) {
        summary[target].error += 1;
        errors.push({
          target,
          rowId: row.id || row.media_key || "",
          title: row.title || "",
          detail: error?.message || String(error),
        });
      }
    }
  }

  const nextOffset = offset + rows.length;
  return sendJson(res, {
    ok: true,
    phase,
    offset,
    limit,
    total,
    processed: rows.length,
    nextOffset,
    hasMore: nextOffset < total,
    targets,
    summary,
    errors,
    note: total ? "" : "No Plembfin archive rows are available to restore.",
  });
}

function resolveCustomPosterFetchUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (value.startsWith("/api/tmdb-poster")) {
    try {
      const proxied = new URL(value, "http://localhost");
      const posterPath = proxied.searchParams.get("path") || "";
      return posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : "";
    } catch {
      return "";
    }
  }
  return value;
}

export async function handleUpdateWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "PATCH" && req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);

  const fields = {};
  if (body.watched_at !== undefined) fields.watched_at = body.watched_at;
  if (body.poster_url !== undefined) fields.poster_url = body.poster_url;
  if (body.logo_url !== undefined) fields.logo_url = body.logo_url;
  if (body.backdrop_url !== undefined) fields.backdrop_url = body.backdrop_url;
  if (body.tmdb_id !== undefined) fields.tmdb_id = body.tmdb_id;
  if (body.tvdb_id !== undefined) fields.tvdb_id = body.tvdb_id;
  if (body.title !== undefined) fields.title = body.title;
  if (body.youtube_url !== undefined) fields.youtube_url = body.youtube_url;

  // Captured before the update runs â€” needed below to invalidate the cache row
  // keyed by the *previous* tmdb_id when tvdb_id changes (Fix Match rematch).
  const preUpdateRow = body.tvdb_id !== undefined ? await getWatchRecordByIdLight(id).catch(() => null) : null;

  const result = await updateWatchRecord(id, fields);
  if (!result.ok) return sendJson(res, { error: result.error }, 400);

  // If a custom poster was chosen, make it authoritative across the site. The
  // poster pipeline serves /api/poster from the poster cache (keyed by
  // media_key) before it ever looks at a row's poster_url, so simply stamping
  // one row leaves the dashboard showing the old cached image. Cache the chosen
  // image and propagate it to every related record (other plays of the same
  // movie, or every episode of the same show) so each one resolves to it.
  let customPosterUrl;
  let customPosterIds;
  let customBackdropUrl;
  const chosenPoster = String(body.poster_url ?? "").trim();
  const chosenPosterFetchUrl = resolveCustomPosterFetchUrl(chosenPoster);
  if (chosenPosterFetchUrl) {
    const editedRow = await getWatchRecordByIdLight(id).catch(() => null);
    const editedKey = editedRow?.media_key || (editedRow ? mediaKeyFor(editedRow) : null);
    if (editedKey) {
      const cached = await cachePosterFromUrl(editedKey, chosenPosterFetchUrl, "custom").catch(() => null);
      if (cached?.url) {
        // The storage path is derived from media_key, so re-saving a poster
        // overwrites the same file at the same URL â€” browsers and the client
        // poster cache would keep serving the previous image. Append a version
        // token so each change yields a fresh URL that busts those caches.
        const versionedUrl = `${cached.url}${cached.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
        customPosterUrl = versionedUrl;
        const related = relatedPosterRows(id);
        const seenKeys = new Set([editedKey]);
        for (const row of related) {
          if (row.media_key && !seenKeys.has(row.media_key)) {
            seenKeys.add(row.media_key);
            // Cheap upsert for an already-cached storage URL (no re-download).
            await cachePosterFromUrl(row.media_key, cached.url, "custom").catch(() => null);
          }
        }
        await setWatchPosterUrls(related.map((row) => ({ id: row.id, posterUrl: versionedUrl }))).catch(() => null);
        await invalidateHistoryDerivedCaches().catch(() => null);
        customPosterIds = related.map((row) => row.id);
      }
    }
  }

  const chosenBackdrop = String(body.backdrop_url ?? "").trim();
  const chosenBackdropFetchUrl = resolveCustomPosterFetchUrl(chosenBackdrop);
  if (chosenBackdropFetchUrl) {
    const editedRow = await getWatchRecordByIdLight(id).catch(() => null);
    const editedKey = editedRow?.media_key || (editedRow ? mediaKeyFor(editedRow) : null);
    if (editedKey) {
      const cached = await cacheBackdropFromUrl(editedKey, chosenBackdropFetchUrl, "custom").catch(() => null);
      if (cached?.url) {
        customBackdropUrl = `${cached.url}${cached.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
        await setWatchBackdropUrl(id, customBackdropUrl).catch(() => null);
      }
    }
  }

  // If TMDB ID changed, clear any cached TMDB data for this record
  if (body.tmdb_id !== undefined) {
    const row = await getWatchRecordByIdLight(id).catch(() => null);
    if (row) {
      const mediaType = row.media_type === "movie" ? "movie" : "tv";
      const docKey = `${mediaType}_${body.tmdb_id}`;
      if (body.tmdb_id) {
        db.prepare("DELETE FROM tmdb_metadata_cache WHERE id = ?").run(docKey);
      }
      // Clear the poster cache so it re-fetches with the new TMDB ID.
      const mediaKey = row.media_key;
      if (mediaKey) {
        await deletePosterCacheByMediaKey(mediaKey).catch(() => null);
      }
      // The record's own poster_url/backdrop_url survive a rematch untouched, and
      // /api/poster serves a stored storage URL directly without consulting the
      // (now-cleared) poster cache â€” so the old show/movie's artwork would keep
      // being served forever unless this request is itself uploading new artwork.
      if (body.poster_url === undefined && body.backdrop_url === undefined) {
        await clearWatchArtworkUrls(id).catch(() => null);
      }
    }
  }

  // If TVDB ID changed (Fix Match rematch), the old cached tv_{tmdbId} details row
  // for this record's *previous* tmdb_id still points at the wrong show â€” force it
  // stale so the next detail fetch re-resolves via the new tvdb_id instead of
  // serving mismatched cached data until the TTL happens to expire.
  if (body.tvdb_id !== undefined && preUpdateRow) {
    if (preUpdateRow.tmdb_id) {
      db.prepare("DELETE FROM tmdb_metadata_cache WHERE id = ?").run(`tv_${preUpdateRow.tmdb_id}`);
    }
    if (body.tvdb_id) {
      db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(`series_${body.tvdb_id}`);
    }
    if (preUpdateRow.media_key) {
      await deletePosterCacheByMediaKey(preUpdateRow.media_key).catch(() => null);
    }
  }

  return sendJson(res, { ok: true, poster_url: customPosterUrl, backdrop_url: customBackdropUrl, updated_ids: customPosterIds });
}

export async function handleMergeShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const sourceTitle = String(body.source_title || "").trim();
  const targetTitle = String(body.target_title || "").trim();
  if (!sourceTitle || !targetTitle) return sendJson(res, { error: "source_title and target_title are required" }, 400);

  try {
    const result = await mergeShows(sourceTitle, targetTitle);
    return sendJson(res, { ok: true, merged: result.merged });
  } catch (err) {
    return sendJson(res, { error: err.message }, 400);
  }
}
