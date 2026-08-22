import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { buildSyncMatchReport } from "../utils/syncMatchReport.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { runForceSync, runScheduledSync, getActiveTargetsForConfig } from "../scheduled.js";
import { getLogs as getDiagnosticLogs, clearLogs as clearDiagnosticLogs } from "../utils/diagnosticLogger.js";
import { appendSyncHistory, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState, appendRuntimeLog } from "../utils/configStore.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes } from "../utils/jellyfinClient.js";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "../utils/parsers.js";
import { getTargetsForSource, shouldSyncResumeProgress, syncCanonicalPlaystate, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import { watchedPlayedSyncEnabled } from "../utils/syncFlags.js";
import { fetchPosterFromTmdb } from "../utils/tmdbClient.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "../utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, searchTmdb, getCachedTvdbId } from "../utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork, getTvdbSeriesExtended } from "../utils/tvdbGateway.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "../utils/fanartGateway.js";
import { getOmdbRating } from "../utils/omdbGateway.js";
import { outboundGovernorTelemetry } from "../utils/outboundGovernor.js";
import { isVerboseLogging, setVerboseLogging } from "../utils/logVerbose.js";
import capacityRanges from "../capacityRanges.json" with { type: "json" };
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, PUBLIC_DIR } from "../paths.js";
import {
  auditStaleTraktImportRows,
  repairStaleTraktImportRows,
  auditStalePendingWatchRows,
  repairStalePendingWatchRows,
  auditSplitIdentityUnwatches,
  repairSplitIdentityUnwatches,
  auditLikelyFalseUnwatches,
  repairLikelyFalseUnwatches,
  countPlaybackProgressRows,
  countWatchedPlaystateRows,
  watchHistoryQualityCounts,
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
  deleteMovieByWatchId,
  deletePosterCacheByMediaKey,
  backfillUnknownShowTitles,
  clearWatchArtworkUrls,
} from "../utils/dataRepo.js";
import { auditPhantomWatchHistory } from "../utils/phantomWatchAudit.js";
import { repairPhantomWatchBursts } from "../utils/phantomWatchRepair.js";

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

export async function handleBackfillStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "GET") return methodNotAllowed(res);

  try {
    const count = await countMissingPosterTraktRows();
    return sendJson(res, { remaining: count, missing: count });
  } catch (error) {
    console.error("Failed to get backfill status", error);
    return sendJson(res, { error: "Failed to get backfill status" }, 500);
  }
}

export async function handleBackfillTrakt(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "POST") return methodNotAllowed(res);

  try {
    const config = await loadMediaConfig();
    const tmdbApiKey = config.tmdb?.apiKey;
    if (!tmdbApiKey) {
      return sendJson(res, { error: "TMDB API Key is not configured in Settings" }, 400);
    }

    const body = await readJson(req).catch(() => ({}));
    const limit = Math.min(Math.max(Number(body.limit || 50), 1), 100);

    const rows = await listMissingPosterTraktRows(limit);

    if (!rows.length) {
      return sendJson(res, { ok: true, tried: 0, backfilled: 0, msg: "No missing poster rows remaining." });
    }

    let tried = 0;
    let backfilled = 0;

    for (const row of rows) {
      tried++;
      const rowMapped = {
        title: row.title,
        media_type: row.media_type,
        imdb_id: row.imdb_id,
        tmdb_id: row.tmdb_id,
        tvdb_id: row.tvdb_id,
        season: row.season,
        episode: row.episode,
      };

      const posterUrl = await fetchPosterFromTmdb(rowMapped, tmdbApiKey);
      if (posterUrl) {
        await stampWatchPoster(row.id, posterUrl);
        backfilled++;
      } else {
        await stampWatchPoster(row.id, "none");
      }
    }

    if (tried) await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { ok: true, tried, backfilled });
  } catch (error) {
    console.error("Trakt backfill execution failed", error);
    return sendJson(res, { error: "Trakt backfill execution failed" }, 500);
  }
}

export async function handleAdminFixHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    const config = await loadMediaConfig().catch(() => ({}));
    const limit = 10;
    let converted = 0;
    let backfilled = 0;
    let retyped = 0;

    // Get recently watched items (we can fetch up to 300 to find ones needing processing)
    const recentRows = (await getCachedHistory()).slice(0, 300);

    const candidates = [];
    for (const data of recentRows) {
      const posterUrl = data.poster_url || "";
      const isOptimized = isCachedStorageUrl(posterUrl);
      const needsRetype = !data.media_type;

      if (!isOptimized || needsRetype) {
        candidates.push({ id: data.id, data });
      }
      if (candidates.length >= limit) break;
    }

    if (candidates.length === 0) {
      return sendJson(res, {
        ok: true,
        retyped: 0,
        converted: 0,
        backfilled: 0,
        note: "All checked history rows already have optimized posters.",
      });
    }

    for (const candidate of candidates) {
      const { id, data } = candidate;
      const row = await getWatchRecordByIdLight(id);
      if (!row) continue;

      const mediaKey = row.media_key || mediaKeyFor(row);

      // 1. If needs retype:
      if (!row.media_type) {
        const isEpisode = /s\d+e\d+/i.test(row.title || "");
        const newType = isEpisode ? "episode" : "movie";
        await setWatchMediaType(id, newType);
        retyped++;
        row.media_type = newType;
      }

      // 2. Fetch/optimize poster:
      const cached = usableCachedPoster(await getPosterCache(mediaKey));
      if (cached?.url) {
        const updated = await updateWatchPosterUrl(id, cached.url);
        if (updated) converted++;
        continue;
      }

      const urlsToTry = [];
      if (row.poster_url && !isCachedStorageUrl(row.poster_url)) {
        if (/^https?:\/\//i.test(row.poster_url)) urlsToTry.push({ url: row.poster_url, source: "stored" });
        const configuredUrl = configuredPosterUrl(row.poster_url, row.source, config);
        if (configuredUrl) urlsToTry.push({ url: configuredUrl, source: "configured" });
      }

      if (String(row.source || "").toLowerCase().includes("plex") && config.plex?.baseUrl && config.plex?.token) {
        const item = await findPlexItem(config.plex, {
          title: row.title,
          type: row.media_type,
          ids: { imdb: row.imdb_id || null, tmdb: row.tmdb_id || null, tvdb: row.tvdb_id || null },
          season: row.season ?? null,
          episode: row.episode ?? null,
        }).catch(() => null);
        const path = row.media_type === "episode"
          ? item?.grandparentThumb || item?.parentThumb || item?.thumb
          : item?.thumb || item?.parentThumb;
        if (path) {
          const configuredUrl = configuredPosterUrl(path, "plex", config);
          if (configuredUrl) urlsToTry.push({ url: configuredUrl, source: "plex" });
        }
      }

      if (config.tmdb?.apiKey && (!row.poster_url || isHttpUrl(row.poster_url) || !/^https?:\/\//i.test(row.poster_url))) {
        const tmdbPoster = await fetchPosterFromTmdb(row, config.tmdb.apiKey).catch(() => null);
        if (tmdbPoster) {
          urlsToTry.push({ url: tmdbPoster, source: "tmdb" });
        }
      }

      const seen = new Set();
      let succeeded = false;
      for (const candidateUrl of urlsToTry) {
        if (!candidateUrl.url || seen.has(candidateUrl.url)) continue;
        seen.add(candidateUrl.url);
        const cachedPoster = await cachePosterFromUrl(mediaKey, candidateUrl.url, candidateUrl.source);
        if (cachedPoster?.url) {
          await updateWatchPosterUrl(id, cachedPoster.url);
          backfilled++;
          succeeded = true;
          break;
        }
      }

      if (!succeeded) {
        await markPosterMissing(mediaKey, "repair", "Failed to resolve poster on repair pass").catch(() => null);
      }
    }

    await invalidateHistoryDerivedCaches().catch(() => null);

    return sendJson(res, {
      ok: true,
      retyped,
      converted,
      backfilled,
      note: `Processed ${candidates.length} candidate rows.`,
    });
  } catch (error) {
    console.error("History repair pass failed", error);
    return sendJson(res, { error: "Repair failed" }, 500);
  }
}

export async function handleMaintenanceStub(req, res, name) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res);
  if (name === "admin-backfill-status") return sendJson(res, { remaining: 0, missing: 0 });
  return sendJson(res, {
    ok: true,
    retyped: 0,
    converted: 0,
    backfilled: 0,
    tried: 0,
    note: "Cloudflare-era maintenance repair jobs are not included.",
  });
}

export async function handlePhantomWatchAudit(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const result = auditPhantomWatchHistory(db);
  return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
}

export async function handlePhantomWatchRepair(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const config = await loadMediaConfig().catch(() => ({}));
    const activeTargets = getActiveTargetsForConfig(config);
    const result = repairPhantomWatchBursts(db, { activeTargets });
    if (result.deleted) await invalidateHistoryDerivedCaches().catch(() => null);
    writeAuditLog("history.phantom_burst_repair", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { deleted: result.deleted, bursts: result.bursts },
    });
    return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Phantom watch repair failed", error);
    return sendJson(res, { error: "Phantom watch repair failed" }, 500);
  }
}

// One-time cleanup for the Trakt play-history import incident (2026-08-19) -
// see the comment on auditStaleTraktImportRows/repairStaleTraktImportRows in
// dataRepo.js. Audit is read-only so it is safe to poll before confirming.
export async function handleStaleTraktImportAudit(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const result = auditStaleTraktImportRows();
  return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
}

export async function handleStaleTraktImportRepair(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const result = repairStaleTraktImportRows();
    writeAuditLog("history.stale_trakt_import_repair", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { repaired: result.repaired },
    });
    return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Stale Trakt import repair failed", error);
    return sendJson(res, { error: "Stale Trakt import repair failed" }, 500);
  }
}

// General form of the cleanup above - see the comment on
// auditStalePendingWatchRows/repairStalePendingWatchRows in dataRepo.js.
// Catches a watched row left with NULL/empty telemetry or an exhausted retry
// count by any code path that replays canonical state without writing the
// result back onto the row, not just the Trakt importer. Audit is read-only
// so it is safe to poll before confirming.
export async function handleStalePendingWatchAudit(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const result = auditStalePendingWatchRows();
  return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
}

export async function handleStalePendingWatchRepair(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const result = repairStalePendingWatchRows();
    writeAuditLog("history.stale_pending_watch_repair", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { repaired: result.repaired },
    });
    return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Stale pending watch repair failed", error);
    return sendJson(res, { error: "Stale pending watch repair failed" }, 500);
  }
}

// Read-only - see the comment on auditSplitIdentityUnwatches in dataRepo.js.
// Surfaces episodes where a genuine earlier watch appears shadowed by a
// later unwatched row recorded under a different media_key, for manual
// review before the repair endpoint below is used.
export async function handleSplitIdentityUnwatchAudit(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const result = auditSplitIdentityUnwatches();
  return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
}

// Opt-in repair for the candidates the audit above finds - not wired to any
// automatic trigger, only reachable by an admin explicitly calling this
// endpoint. Fixes Plembfin's own database first (repairSplitIdentityUnwatches
// in dataRepo.js), then re-pushes the restored "watched" state out to every
// connected platform for each item, the same canonical-replay path a manual
// watch-date correction already uses (propagateWatchDateRemoval in
// routes/media.js), so the servers that received the false unplayed mark get
// corrected too rather than only Plembfin's own history.
const SPLIT_IDENTITY_UNWATCH_REPAIR_CONCURRENCY = 6;

export async function handleSplitIdentityUnwatchRepair(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const result = await repairSplitIdentityUnwatches();
    const config = await loadMediaConfig();
    const loopStore = createLoopStore();
    const propagationErrors = [];
    await runWithConcurrency(result.media, async (media) => {
      try {
        await syncCanonicalPlaystate(media, config, loopStore, "watched");
      } catch (error) {
        propagationErrors.push({ title: media.title, error: error.message || String(error) });
      }
    }, SPLIT_IDENTITY_UNWATCH_REPAIR_CONCURRENCY);
    writeAuditLog("history.split_identity_unwatch_repair", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { repaired: result.repaired, propagationErrors: propagationErrors.length },
    });
    return sendJson(res, { ok: true, repaired: result.repaired, propagationErrors }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Split identity unwatch repair failed", error);
    return sendJson(res, { error: "Split identity unwatch repair failed" }, 500);
  }
}

// Read-only - see the comment on auditLikelyFalseUnwatches in dataRepo.js.
// Broader than the split-identity audit above: catches an episode where the
// shadowed watched row didn't survive at all, so every remaining row reads
// unwatched. Less certain than the split-identity fingerprint (there is no
// surviving watched row to confirm against), so review real candidates
// before running the repair below.
export async function handleLikelyFalseUnwatchAudit(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const result = auditLikelyFalseUnwatches();
  return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
}

// Opt-in repair for the candidates above - consolidates every stale row for
// the episode into one fresh canonical watched record (repairLikelyFalseUnwatches
// in dataRepo.js) and re-pushes it to every connected platform, same pattern
// as handleSplitIdentityUnwatchRepair above.
const LIKELY_FALSE_UNWATCH_REPAIR_CONCURRENCY = 6;

export async function handleLikelyFalseUnwatchRepair(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const result = await repairLikelyFalseUnwatches();
    const config = await loadMediaConfig();
    const loopStore = createLoopStore();
    const propagationErrors = [];
    await runWithConcurrency(result.media, async (media) => {
      try {
        await syncCanonicalPlaystate(media, config, loopStore, "watched");
      } catch (error) {
        propagationErrors.push({ title: media.title, error: error.message || String(error) });
      }
    }, LIKELY_FALSE_UNWATCH_REPAIR_CONCURRENCY);
    writeAuditLog("history.likely_false_unwatch_repair", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { repaired: result.repaired, propagationErrors: propagationErrors.length },
    });
    return sendJson(res, { ok: true, repaired: result.repaired, propagationErrors }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Likely false unwatch repair failed", error);
    return sendJson(res, { error: "Likely false unwatch repair failed" }, 500);
  }
}

export function handlePing(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
  return sendJson(res, { ok: true, ts: Date.now() }, 200, { "Cache-Control": "no-store" });
}

export async function handleSyncMatchReport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const rows = await getCachedHistory();
  return sendJson(res, { report: buildSyncMatchReport(rows) }, 200, { "Cache-Control": "no-store" });
}

function healthBand(value, range = {}) {
  if (range.degraded != null && value > range.degraded) return "degraded";
  if (range.outside != null && value > range.outside) return "outside tested range";
  if (range.elevated != null && value > range.elevated) return "elevated";
  return "normal";
}

export async function handleSyncHealth(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const history = await getCachedHistory();
  const progressRows = await countPlaybackProgressRows();
  const playstateRows = await countWatchedPlaystateRows();
  const report = buildSyncMatchReport(history);
  const quality = watchHistoryQualityCounts();
  const recommendations = [];
  if (history.length > 250000) {
    recommendations.push("Use a smaller Force Sync scope and review a preview before large runs.");
  }
  if (quality.sameEventDuplicateRows) {
    recommendations.push(`${quality.sameEventDuplicateRows} watch row(s) duplicate an existing watch event - run Dedup History to remove them.`);
  }
  if (quality.nullSeasonEpisodeRows) {
    recommendations.push(`${quality.nullSeasonEpisodeRows} episode row(s) have no season number, so they may not match for sync or count toward show progress.`);
  }
  if (quality.opaqueShowTitleRows) {
    recommendations.push(`${quality.opaqueShowTitleRows} row(s) store a provider URI instead of a show title; episode totals cannot be resolved for them.`);
  }
  const health = {
    generatedAt: new Date().toISOString(),
    counts: {
      watchHistoryRows: { value: history.length, status: healthBand(history.length, capacityRanges.watchHistoryRows) },
      playstateRows,
      playbackProgressRows: progressRows,
      databaseBytes: db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true }),
    },
    dataQuality: quality,
    matchFailures: report.platforms,
    outbound: outboundGovernorTelemetry(),
    recommendations,
  };
  return sendJson(res, { health }, 200, { "Cache-Control": "no-store" });
}

export async function handleDiagnosticLogs(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method === "DELETE") {
    if (!(await requireAdmin(req, res))) return;
    clearDiagnosticLogs();
    return sendJson(res, { ok: true }, 200, { "Cache-Control": "no-store" });
  }
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Number(req.query?.limit || 500), 1000);
  const category = req.query?.category || "all";
  // getLogs() has always accepted a level filter, but the query parameter was
  // never read, so ?level=error silently returned everything.
  const requestedLevel = String(req.query?.level || "").toLowerCase();
  const level = ["info", "warn", "error"].includes(requestedLevel) ? requestedLevel : "";
  const data = getDiagnosticLogs({ limit, category, level });
  return sendJson(res, data, 200, { "Cache-Control": "no-store" });
}

// One-off diagnostic for "Plembfin says synced, but the media server doesn't
// show it watched" reports - runs the exact same findPlexItem lookup a real
// dispatch would use for one specific watch record, with verbose GUID/search
// tracing forced on for just this call (regardless of the LOG_VERBOSE env
// var), so the detailed trace lines land in the diagnostic log even when the
// server wasn't started with verbose tracing on. Restores the previous
// verbose setting afterward rather than leaving it flipped on server-wide.
export async function handleDebugPlexMatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);

  const row = await getWatchRecordByIdLight(id);
  if (!row) return sendJson(res, { error: "Watch record not found" }, 404);

  const config = await loadMediaConfig();
  if (!config.plex?.baseUrl || !config.plex?.token) {
    return sendJson(res, { error: "Plex is not configured" }, 400);
  }

  const media = watchRowToMedia(row, "manual");
  const wasVerbose = isVerboseLogging();
  setVerboseLogging(true);
  let item = null;
  let matchError = "";
  try {
    item = await findPlexItem(config.plex, media);
  } catch (error) {
    console.error("Debug Plex match lookup failed", error);
    matchError = "Plex item search failed";
  } finally {
    setVerboseLogging(wasVerbose);
  }

  return sendJson(res, {
    media,
    found: Boolean(item?.ratingKey),
    item: item ? { ratingKey: item.ratingKey, title: item.title, type: item.type, year: item.year, guid: item.guid } : null,
    error: matchError || undefined,
  }, 200, { "Cache-Control": "no-store" });
}


// Paginated bulk refresh of the whole library's TMDB metadata + artwork. Mirrors
// the ingest prefetch (full details cached to tmdbMetadataCache + poster/backdrop
// to Storage) AND stamps the canonical poster back onto every watch record, so
// EXISTING media reaches full parity with newly-added media. Paginated so a large
// library never hits the request timeout; the client loops until hasMore is false.
export async function handleRefreshTmdbMetadata(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 12), 1), 30);

  // TV items are slow (deriveNextAiring fetches multiple seasons). Time-box each
  // page so it always returns promptly; the client just resumes from nextOffset.
  const PAGE_BUDGET_MS = 25000;
  const startedAt = Date.now();

  const items = await listLibraryItemsForRefresh();
  const total = items.length;

  let success = 0;
  let failed = 0;
  let processed = 0;
  const posterUpdates = [];
  const log = [];

  for (let i = offset; i < items.length && processed < limit; i++) {
    if (processed > 0 && Date.now() - startedAt > PAGE_BUDGET_MS) break;
    const item = items[i];
    const label = `${item.mediaType === "movie" ? "Movie" : "Show"}: ${item.title}`;
    try {
      const details = await getTmdbDetails({ mediaType: item.mediaType, tmdbId: item.tmdbId, title: item.title, force: true, forceTvdb: false });
      const posterUrl = details?.cached_poster_url || "";
      if (posterUrl) {
        for (const rec of item.records) {
          if (rec.poster !== posterUrl) posterUpdates.push({ id: rec.id, posterUrl });
        }
      }
      success += 1;
      log.push(`OK - ${label}`);
    } catch (error) {
      failed += 1;
      log.push(`FAILED - ${label} (${error.message || "error"})`);
    }
    processed += 1;
  }

  let postersWritten = 0;
  if (posterUpdates.length) {
    postersWritten = await setWatchPosterUrls(posterUpdates).catch(() => 0);
  }

  const nextOffset = offset + processed;
  const hasMore = nextOffset < total;
  // Invalidate derived caches ONCE, on the final page. Doing it per page forced a
  // full watchHistory re-scan on every subsequent page's list build.
  if (!hasMore) await invalidateHistoryDerivedCaches().catch(() => null);

  return sendJson(res, {
    ok: true,
    total,
    processed,
    nextOffset,
    hasMore,
    success,
    failed,
    postersWritten,
    log,
  });
}

export async function handleRefreshTvdbMetadata(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 8), 1), 20);

  const items = (await listLibraryItemsForRefresh()).filter((item) => item.mediaType === "tv");
  const total = items.length;
  const PAGE_BUDGET_MS = 25000;
  const startedAt = Date.now();

  let success = 0;
  let failed = 0;
  let processed = 0;
  const log = [];

  for (let i = offset; i < items.length && processed < limit; i++) {
    if (processed > 0 && Date.now() - startedAt > PAGE_BUDGET_MS) break;
    const item = items[i];
    const label = `Show: ${item.title}`;
    try {
      let tvdbId = item.tvdbId || "";
      if (!tvdbId) {
        tvdbId = await resolveTvdbSeriesId({ tvdbId: item.tvdbId, title: item.title });
      }
      if (tvdbId) {
        await getTvdbSeriesExtended(tvdbId, { force: true });
        await getTvdbSeriesArtwork(tvdbId).catch(() => null);
        success += 1;
        log.push(`OK - ${label} (TVDB #${tvdbId})`);
      } else {
        failed += 1;
        log.push(`SKIP - ${label} (No TVDB match found)`);
      }
    } catch (error) {
      failed += 1;
      log.push(`FAILED - ${label} (${error.message || "error"})`);
    }
    processed += 1;
  }

  const nextOffset = offset + processed;
  const hasMore = nextOffset < total;

  return sendJson(res, {
    ok: true,
    total,
    processed,
    nextOffset,
    hasMore,
    success,
    failed,
    log,
  });
}

export async function handleRematchTvShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 8), 1), 20);
  const items = (await listLibraryItemsForRefresh()).filter((item) => item.mediaType === "tv");
  const total = items.length;
  const startedAt = Date.now();
  const PAGE_BUDGET_MS = 25000;
  const getRowStmt = db.prepare("SELECT id, tmdb_id, tvdb_id, poster_url, media_key FROM watch_history WHERE id = ?");
  const updateIdsStmt = db.prepare("UPDATE watch_history SET tmdb_id = ?, tvdb_id = ?, updated_at = ? WHERE id = ?");
  const updateIdsPosterStmt = db.prepare("UPDATE watch_history SET tmdb_id = ?, tvdb_id = ?, poster_url = ?, updated_at = ? WHERE id = ?");
  const updateRows = db.transaction((updates) => {
    for (const update of updates) {
      if (update.posterUrl) updateIdsPosterStmt.run(update.tmdbId, update.tvdbId, update.posterUrl, update.updatedAt, update.id);
      else updateIdsStmt.run(update.tmdbId, update.tvdbId, update.updatedAt, update.id);
    }
  });

  let processed = 0;
  let matched = 0;
  let updatedShows = 0;
  let updatedRows = 0;
  let failed = 0;
  const log = [];
  const changedMediaKeys = new Set();

  for (let i = offset; i < items.length && processed < limit; i++) {
    if (processed > 0 && Date.now() - startedAt > PAGE_BUDGET_MS) break;
    const item = items[i];
    processed += 1;

    try {
      const details = await getTmdbDetails({ mediaType: "tv", title: item.title, force: true, forceTvdb: false });
      const tmdbId = details?.id ? String(details.id) : "";
      if (!tmdbId) throw new Error("No TMDB match returned");

      const tvdbId = details?.external_ids?.tvdb_id ? String(details.external_ids.tvdb_id) : "";
      const posterUrl = details?.cached_poster_url || "";
      const updates = [];

      for (const record of item.records || []) {
        const row = getRowStmt.get(String(record.id));
        if (!row) continue;
        const idChanged = String(row.tmdb_id || "") !== tmdbId || String(row.tvdb_id || "") !== tvdbId;
        const posterChanged = Boolean(posterUrl && String(row.poster_url || "") !== posterUrl);
        if (!idChanged && !posterChanged) continue;
        updates.push({ id: row.id, tmdbId, tvdbId, posterUrl: posterChanged ? posterUrl : "", updatedAt: Date.now() });
        if (row.media_key) changedMediaKeys.add(row.media_key);
      }

      if (updates.length) {
        updateRows(updates);
        updatedShows += 1;
        updatedRows += updates.length;
      }

      matched += 1;
      log.push(`${updates.length ? "UPDATED" : "OK"} - ${item.title} -> TMDB ${tmdbId}${tvdbId ? ` / TVDB ${tvdbId}` : ""} (${updates.length} row${updates.length === 1 ? "" : "s"})`);
    } catch (error) {
      failed += 1;
      log.push(`FAILED - ${item.title} (${error.message || "no match"})`);
    }
  }

  for (const mediaKey of changedMediaKeys) {
    await deletePosterCacheByMediaKey(mediaKey).catch(() => null);
  }
  if (updatedRows) await invalidateHistoryDerivedCaches().catch(() => null);

  const nextOffset = offset + processed;
  return sendJson(res, {
    ok: true,
    total,
    processed,
    nextOffset,
    hasMore: nextOffset < total,
    matched,
    updatedShows,
    updatedRows,
    failed,
    log,
  }, 200, { "Cache-Control": "no-store" });
}




// The poster picker hands us app-relative proxy URLs (/api/tmdb-poster?path=...)
// alongside absolute and already-cached /media/ storage URLs. cachePosterFromUrl
// needs an absolute URL (or a /media/ path), so resolve the proxy form back to
// its upstream TMDB image URL before caching.

export async function handleCacheStats(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const dirs = [
    { key: "posters", dir: POSTERS_DIR },
    { key: "backdrops", dir: BACKDROPS_DIR },
    { key: "profiles", dir: PROFILES_DIR },
  ];
  const disk = {};
  for (const { key, dir } of dirs) {
    let count = 0;
    let size = 0;
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        try {
          const stat = await fs.promises.stat(nodePath.join(dir, file));
          if (stat.isFile()) { size += stat.size; count++; }
        } catch {}
      }
    } catch {}
    disk[key] = { count, size };
  }

  const dbRows = db.prepare(
    "SELECT variant, COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as size FROM poster_cache WHERE status = 'cached' GROUP BY variant"
  ).all();
  const dbByVariant = Object.fromEntries(dbRows.map((r) => [r.variant, { count: r.count, size: r.size }]));

  return sendJson(res, { disk, db: dbByVariant });
}

export async function handleClearCache(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const type = body?.type || "all";

  const typeMap = {
    posters: { dir: POSTERS_DIR, variants: ["poster", "logo"] },
    backdrops: { dir: BACKDROPS_DIR, variants: ["backdrop"] },
    profiles: { dir: PROFILES_DIR, variants: ["profile"] },
  };
  const targets = type === "all" ? Object.values(typeMap) : typeMap[type] ? [typeMap[type]] : [];

  let deleted = 0;
  let freed = 0;
  for (const { dir } of targets) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const filePath = nodePath.join(dir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) { freed += stat.size; await fs.promises.unlink(filePath); deleted++; }
        } catch {}
      }
    } catch {}
  }

  if (type === "all") {
    db.prepare("DELETE FROM poster_cache").run();
  } else {
    for (const variant of (typeMap[type]?.variants || [])) {
      db.prepare("DELETE FROM poster_cache WHERE variant = ?").run(variant);
    }
  }

  return sendJson(res, { ok: true, deleted, freed });
}

// ---------------------------------------------------------------------------
// Changelog
//
// Each build ships with a bundled changelog.json (served at /changelog.json) that
// records the version this instance was built from. A running instance also polls
// the changelog.json published on GitHub so the Settings â†’ Changelog screen can
// show the user their current version alongside any newer releases. The browser
// can't reach GitHub directly (CSP connect-src 'self'), so we proxy + cache it here.
// ---------------------------------------------------------------------------

const REMOTE_CHANGELOG_URL =
  "https://raw.githubusercontent.com/Lasikiewicz/plembfin/main/changelog.json";
const REMOTE_CHANGELOG_TTL_MS = 60 * 1000; // 1 minute default TTL
let remoteChangelogCache = { fetchedAt: 0, data: null };

function readLocalChangelog() {
  try {
    const raw = fs.readFileSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Bundled only on the develop channel build; see docker-publish-develop.yml and
// scripts/update-develop-changelog.js. Tracks a standalone rolling develop
// build counter, deliberately independent of alpha's or main's version - it
// never borrows a parent version string, so it can never appear to regress
// relative to a branch it was promoted from.
function readLocalDevelopChangelog() {
  try {
    const raw = fs.readFileSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.develop.json"), "utf8");
    const data = JSON.parse(raw);
    return {
      build: Number(data.build) || 0,
      entries: Array.isArray(data.entries) ? data.entries : [],
    };
  } catch {
    return null;
  }
}

export function describePendingDevelopBuild(localDevelopBuild, remoteDevelop) {
  const remoteBuild = Number(remoteDevelop?.build) || 0;
  const remoteEntries = Array.isArray(remoteDevelop?.entries) ? remoteDevelop.entries : [];
  const newerBuildAvailable = remoteBuild > localDevelopBuild.build;
  const pendingEntries = newerBuildAvailable
    ? remoteEntries.filter((entry) => Number(entry.build) > localDevelopBuild.build)
    : [];
  return { latestBuild: remoteBuild, newerBuildAvailable, pendingEntries };
}

// Bundled only on the alpha channel build; see docker-publish-alpha.yml and
// scripts/update-alpha-changelog.js. Tracks a rolling build counter and
// per-push changelog entries that reset on the next "Merge alpha with main",
// independent of changelog.json's real semver.
function readLocalAlphaChangelog() {
  try {
    const raw = fs.readFileSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.alpha.json"), "utf8");
    const data = JSON.parse(raw);
    return {
      build: Number(data.build) || 0,
      baseVersion: data.baseVersion || null,
      entries: Array.isArray(data.entries) ? data.entries : [],
    };
  } catch {
    return null;
  }
}

// What "Newer alpha build available" should actually show: the entries for
// builds not yet pulled locally, read straight from GitHub's copy of
// changelog.alpha.json - not the locally-installed build's own history,
// which never contains commits from a build that hasn't been pulled yet. A
// changed baseVersion means alpha reset (a "Merge alpha with main" landed
// remotely) and this instance hasn't seen any of the new base's builds yet,
// so every remote entry is pending; otherwise only builds past the
// locally-installed one are. Exported standalone (pure, no I/O) so this can
// be tested without mocking the filesystem or network.
export function describePendingAlphaBuild(localAlphaBuild, remoteAlpha) {
  const remoteBuild = Number(remoteAlpha?.build) || 0;
  const remoteBaseVersion = remoteAlpha?.baseVersion || localAlphaBuild.baseVersion;
  const remoteEntries = Array.isArray(remoteAlpha?.entries) ? remoteAlpha.entries : [];
  const newerBuildAvailable = remoteBaseVersion !== localAlphaBuild.baseVersion || remoteBuild > localAlphaBuild.build;
  const pendingEntries = newerBuildAvailable
    ? remoteEntries.filter((entry) => remoteBaseVersion !== localAlphaBuild.baseVersion || Number(entry.build) > localAlphaBuild.build)
    : [];
  return { latestBuild: remoteBuild, newerBuildAvailable, pendingEntries };
}

async function fetchRemoteChangelog({ force = false } = {}) {
  const now = Date.now();
  if (!force && remoteChangelogCache.data && now - remoteChangelogCache.fetchedAt < REMOTE_CHANGELOG_TTL_MS) {
    return remoteChangelogCache.data;
  }
  const url = `${REMOTE_CHANGELOG_URL}?_t=${now}`;
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache" },
  }, 8000);
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  const data = await response.json();
  remoteChangelogCache = { fetchedAt: now, data };
  return data;
}

const REMOTE_DEVELOP_CHANGELOG_URL =
  "https://raw.githubusercontent.com/Lasikiewicz/plembfin/develop/changelog.develop.json";
const REMOTE_DEVELOP_CHANGELOG_TTL_MS = 60 * 1000;
let remoteDevelopChangelogCache = { fetchedAt: 0, data: null };

async function fetchRemoteDevelopChangelog({ force = false } = {}) {
  const now = Date.now();
  if (!force && remoteDevelopChangelogCache.data && now - remoteDevelopChangelogCache.fetchedAt < REMOTE_DEVELOP_CHANGELOG_TTL_MS) {
    return remoteDevelopChangelogCache.data;
  }
  const url = `${REMOTE_DEVELOP_CHANGELOG_URL}?_t=${now}`;
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache" },
  }, 8000);
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  const data = await response.json();
  remoteDevelopChangelogCache = { fetchedAt: now, data };
  return data;
}

// Mirrors fetchRemoteChangelog above, but against the alpha branch's own
// changelog.alpha.json, so a running alpha build can tell "a newer alpha
// build has been published" apart from "a new release exists" - the running
// image's bundled build number only reflects what it was built from.
const REMOTE_ALPHA_CHANGELOG_URL =
  "https://raw.githubusercontent.com/Lasikiewicz/plembfin/alpha/changelog.alpha.json";
const REMOTE_ALPHA_CHANGELOG_TTL_MS = 60 * 1000;
let remoteAlphaChangelogCache = { fetchedAt: 0, data: null };

async function fetchRemoteAlphaChangelog({ force = false } = {}) {
  const now = Date.now();
  if (!force && remoteAlphaChangelogCache.data && now - remoteAlphaChangelogCache.fetchedAt < REMOTE_ALPHA_CHANGELOG_TTL_MS) {
    return remoteAlphaChangelogCache.data;
  }
  const url = `${REMOTE_ALPHA_CHANGELOG_URL}?_t=${now}`;
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache" },
  }, 8000);
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  const data = await response.json();
  remoteAlphaChangelogCache = { fetchedAt: now, data };
  return data;
}

function parseSemver(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function mergeChangelogEntries(localEntries = [], remoteEntries = []) {
  const map = new Map();
  const entryKey = (e) => e.commit || `${e.version || ""}|${e.message || ""}`;

  for (const entry of localEntries) {
    if (entry && (entry.version || entry.message)) {
      map.set(entryKey(entry), entry);
    }
  }

  for (const entry of remoteEntries) {
    if (!entry || (!entry.version && !entry.message)) continue;
    const key = entryKey(entry);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, entry);
    } else {
      map.set(key, {
        ...existing,
        ...entry,
        details: Array.isArray(entry.details) && entry.details.length ? entry.details : existing.details,
      });
    }
  }

  const merged = Array.from(map.values());
  merged.sort((a, b) => {
    const semverCmp = compareSemver(a.version, b.version);
    if (semverCmp !== 0) return -semverCmp;
    const dateA = new Date(a.date || 0).getTime();
    const dateB = new Date(b.date || 0).getTime();
    return dateB - dateA;
  });

  return merged;
}

export async function handleChangelog(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);

  const local = readLocalChangelog();
  const currentVersion = local?.version || null;
  const localEntries = Array.isArray(local?.entries) ? local.entries : [];

  let remote = null;
  let remoteError = null;
  const isForceRefresh = req.query?.refresh === "1" && Boolean(resolveAdminPrincipal(req));

  try {
    remote = await fetchRemoteChangelog({ force: isForceRefresh });
  } catch (error) {
    remoteError = error?.message || "Unable to reach GitHub";
  }

  const remoteAvailable = Boolean(remote && Array.isArray(remote.entries));
  const remoteEntries = remoteAvailable ? remote.entries : [];

  const entries = mergeChangelogEntries(localEntries, remoteEntries);

  let latestVersion = currentVersion;
  if (remoteAvailable && remote?.version && compareSemver(remote.version, latestVersion) > 0) {
    latestVersion = remote.version;
  }
  if (entries.length && entries[0].version && compareSemver(entries[0].version, latestVersion) > 0) {
    latestVersion = entries[0].version;
  }

  const newer = currentVersion
    ? entries.filter((entry) => compareSemver(entry.version, currentVersion) > 0)
    : [];

  const hasDevelopFile = fs.existsSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.develop.json"));
  const hasAlphaFile = fs.existsSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.alpha.json"));

  let channel = "release";
  const envChannel = String(process.env.BUILD_CHANNEL || "").toLowerCase().trim();
  if (envChannel === "release" || envChannel === "latest" || envChannel === "stable" || envChannel === "main") {
    channel = "release";
  } else if (envChannel === "alpha") {
    channel = "alpha";
  } else if (envChannel === "develop") {
    channel = "develop";
  } else if (hasAlphaFile && !fs.existsSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.json"))) {
    channel = "alpha";
  } else if (hasDevelopFile && !fs.existsSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.json"))) {
    channel = "develop";
  } else {
    channel = "release";
  }

  let developBuild = channel === "develop" ? readLocalDevelopChangelog() : null;
  if (developBuild) {
    try {
      const remoteDevelop = await fetchRemoteDevelopChangelog({ force: isForceRefresh });
      developBuild = { ...developBuild, ...describePendingDevelopBuild(developBuild, remoteDevelop) };
    } catch {
      // GitHub unreachable - developBuild stays the local-only snapshot, no update signal.
    }
  }

  let alphaBuild = (channel === "alpha" || channel === "develop") ? readLocalAlphaChangelog() : null;
  if (alphaBuild && channel === "alpha") {
    try {
      const remoteAlpha = await fetchRemoteAlphaChangelog({ force: isForceRefresh });
      alphaBuild = { ...alphaBuild, ...describePendingAlphaBuild(alphaBuild, remoteAlpha) };
    } catch {
      // GitHub unreachable - alphaBuild stays the local-only snapshot, no update signal.
    }
  }

  return sendJson(
    res,
    {
      current: currentVersion,
      channel,
      developBuild,
      alphaBuild,
      latest: latestVersion,
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
      remoteAvailable,
      remoteError,
      newer,
      entries,
    },
    200,
    { "Cache-Control": "no-store" }
  );
}
