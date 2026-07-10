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

export async function handleBackfillStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "GET") return methodNotAllowed(res);

  try {
    const count = await countMissingPosterTraktRows();
    return sendJson(res, { remaining: count, missing: count });
  } catch (error) {
    console.error("Failed to get backfill status", error);
    return sendJson(res, { error: "Failed to get backfill status", details: error.message }, 500);
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
    return sendJson(res, { error: "Trakt backfill execution failed", details: error.message }, 500);
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
    return sendJson(res, { error: "Repair failed", details: error.message }, 500);
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

export async function handleDedupHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("Dedup started...\n");

  const log = (msg) => { res.write(`${msg}\n`); console.log(msg); };

  try {
    log("Loading all watchHistory records...");
    const groups = loadWatchKeyGroupsForDedup();
    let scanned = 0;
    for (const docs of groups.values()) scanned += docs.length;
    log(`Loaded ${scanned} total records.`);
    log(`Found ${groups.size} unique media keys.`);

    let deleted = 0;
    let checked = 0;
    const removeIds = [];

    for (const [key, docs] of groups.entries()) {
      if (docs.length <= 1) continue;

      // Sort newest first; keep the first, remove the rest.
      docs.sort((a, b) => (b.watchedAt > a.watchedAt ? 1 : b.watchedAt < a.watchedAt ? -1 : 0));
      const [keep, ...remove] = docs;

      for (const dup of remove) {
        removeIds.push(dup.id);
        deleted++;
      }

      checked++;
      if (checked % 50 === 0) {
        log(`Processed ${checked} duplicate groups, ${deleted} deletions queued so far...`);
      }
    }

    if (removeIds.length) {
      deleteWatchRecordsByIds(removeIds);
      await invalidateHistoryDerivedCaches().catch(() => null);
    }

    const summary = { scanned, uniqueKeys: groups.size, deleted };
    log(`Done! Scanned ${summary.scanned} records, found ${summary.uniqueKeys} unique items, deleted ${summary.deleted} duplicates.`);
    res.write(`RESULT: ${JSON.stringify(summary)}\n`);
    res.end();
  } catch (error) {
    log(`ERROR: Dedup failed: ${error.message}`);
    res.end();
  }
}

export function handlePing(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
  return sendJson(res, { ok: true, ts: Date.now() }, 200, { "Cache-Control": "no-store" });
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
  const data = getDiagnosticLogs({ limit });
  return sendJson(res, data, 200, { "Cache-Control": "no-store" });
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
const REMOTE_CHANGELOG_TTL_MS = 30 * 60 * 1000; // 30 minutes
let remoteChangelogCache = { fetchedAt: 0, data: null };

function readLocalChangelog() {
  try {
    const raw = fs.readFileSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// A forced refresh (dashboard update check) still honors a 5-minute floor so
// routine navigation cannot turn into one GitHub fetch per dashboard load.
const REMOTE_CHANGELOG_FORCE_FLOOR_MS = 5 * 60 * 1000;

async function fetchRemoteChangelog({ force = false } = {}) {
  const now = Date.now();
  const ttl = force ? REMOTE_CHANGELOG_FORCE_FLOOR_MS : REMOTE_CHANGELOG_TTL_MS;
  if (remoteChangelogCache.data && now - remoteChangelogCache.fetchedAt < ttl) {
    return remoteChangelogCache.data;
  }
  const response = await fetchWithTimeout(REMOTE_CHANGELOG_URL, {
    headers: { Accept: "application/json" },
  }, 8000);
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  const data = await response.json();
  remoteChangelogCache = { fetchedAt: now, data };
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

export async function handleChangelog(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);

  const local = readLocalChangelog();
  const currentVersion = local?.version || null;
  const localEntries = Array.isArray(local?.entries) ? local.entries : [];

  let remote = null;
  let remoteError = null;
  try {
    remote = await fetchRemoteChangelog({ force: req.query?.refresh === "1" && Boolean(resolveAdminPrincipal(req)) });
  } catch (error) {
    remoteError = error?.message || "Unable to reach GitHub";
  }

  const remoteAvailable = Boolean(remote && Array.isArray(remote.entries));
  const entries = remoteAvailable ? remote.entries : localEntries;
  const latestVersion = remoteAvailable ? remote.version || currentVersion : currentVersion;

  const newer = currentVersion
    ? entries.filter((entry) => compareSemver(entry.version, currentVersion) > 0)
    : [];

  return sendJson(
    res,
    {
      current: currentVersion,
      latest: latestVersion,
      updateAvailable: newer.length > 0,
      remoteAvailable,
      remoteError,
      newer,
      entries,
    },
    200,
    { "Cache-Control": "no-store" }
  );
}
