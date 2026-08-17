import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson, readRawText } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { activeSyncOperation, appendSyncHistory, clearSyncOperation, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState, appendRuntimeLog, SYNC_OPERATION_FORCE, SYNC_OPERATION_SCHEDULED } from "../utils/configStore.js";
import { forceSyncStopAction } from "../utils/forceSyncControl.js";
import { getSyncPlanActionsPage, getSyncPlanSummary, confirmSyncPlan } from "../utils/syncPlans.js";
import {
  enqueueBackgroundJob,
  getBackgroundJob,
  getBackgroundJobLogs,
  getLatestBackgroundJob,
  requestBackgroundJobCancellation,
  workerAvailable,
  BACKGROUND_JOB_STALE_MS,
} from "../utils/backgroundJobs.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes, listPlexLibraries } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes, listEmbyLibraries } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes, listJellyfinLibraries } from "../utils/jellyfinClient.js";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "../utils/parsers.js";
import { getTargetsForSource, isRecentOutboundPlayedFlagEcho, isRecentOutboundUnplayedFlagEcho, recordOutboundPlayedMarks, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { canReceiveState } from "../utils/syncRoles.js";
import { watchedPlayedSyncEnabled } from "../utils/syncFlags.js";
import { forceSyncMediaState, normalizeMediaForceSyncRequest } from "../utils/mediaForceSync.js";
import { forceSyncLibraryState, normalizeLibraryForceSyncRequest } from "../utils/libraryForceSync.js";
import { appendMediaForceSyncActivity, createMediaForceSyncActivity, finishMediaForceSyncActivity, getMediaForceSyncActivity, isMediaForceSyncCancellationRequested, requestMediaForceSyncCancellation } from "../utils/mediaForceSyncActivity.js";
import { provenanceTelemetryLines } from "../utils/watchProvenance.js";
import { applyUnwatchedTransition } from "../utils/watchStateTransitions.js";
import { recordWatchAuditEvent, recordWatchAuditEvents } from "../utils/watchAudit.js";
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
  updateWatchSyncRetry,
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
  getCanonicalWatchState,
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

function parseJsonWebhookBody(json) {
  const customPayload = parseCustomWebhook(json);
  if (customPayload.isValid) return customPayload;
  const embyPayload = parseEmbyWebhook(json);
  if (embyPayload.isValid || json?.Event) return embyPayload;
  return parseJellyfinWebhook(json);
}

export async function normalizeWebhook(req) {
  const contentType = req.get("content-type") || "";
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    return parsePlexWebhook(await readFormData(req));
  }
  // A body that claims to be JSON and isn't is a real client error, so let
  // readJson's 400 through rather than quietly treating it as unrecognised.
  if (contentType.includes("application/json")) {
    return parseJsonWebhookBody(await readJson(req));
  }

  // Otherwise judge the body, not the header. Jellyfin's webhook plugin posts
  // valid JSON labelled `text/plain`, so trusting the declared content type
  // silently drops every event it sends - including the mark-played and
  // mark-unplayed events that unwatch propagation depends on.
  let sniffed = null;
  try {
    sniffed = await readJson(req);
  } catch {
    sniffed = null;
  }
  if (sniffed && typeof sniffed === "object" && Object.keys(sniffed).length) {
    return parseJsonWebhookBody(sniffed);
  }

  // The body is not JSON either, so capture enough to identify the sender. A
  // rejected webhook is otherwise anonymous, and "some server keeps posting
  // something" is not a diagnosable report.
  return {
    isValid: false,
    source: "unknown",
    ids: {},
    title: "Unsupported webhook content type",
    rawPayloadDebug: {
      contentType: contentType || "(none)",
      userAgent: req.get("user-agent") || "(none)",
      bodyPreview: readRawText(req),
    },
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
    ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
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

function recordPlaybackEndedAudit(media = {}, { status = "completed", details = "Playback ended." } = {}) {
  const playedAt = Date.parse(String(media.playedAt || media.watched_at || ""));
  recordWatchAuditEvent({
    eventType: "playback_ended",
    timestamp: Number.isFinite(playedAt) ? playedAt : Date.now(),
    action: "playback",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.mediaType,
    title: media.title,
    showTitle: media.showTitle || media.show_title,
    source: media.source,
    sourceEvent: media.event,
    phase: "ended",
    watchProvenance: media.watchProvenance || media.watch_provenance,
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: media.sessionId || media.session_id,
    user: media.user,
    device: media.device || media.deviceName || media.client?.deviceName,
    deviceId: media.deviceId || media.device_id || media.client?.deviceId,
    client: media.clientName || media.client?.client || media.client?.product || media.client?.platform,
    clientVersion: media.clientVersion || media.client?.version,
    status,
    details,
    payload: {
      progress: media.progress,
      offsetMs: media.offsetMs ?? media.positionMs,
      durationMs: media.durationMs,
      playedAt: media.playedAt || media.watched_at || "",
    },
  });
}

async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
  const timestamp = Date.now();
  const targetStates = Array.isArray(summary.targetStates) ? summary.targetStates : [];
  const auditBase = {
    timestamp,
    eventType: action === "progress" ? "sync_dispatch" : "sync_dispatch",
    action,
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    showTitle: media.showTitle || media.show_title,
    source: media.source || "unknown",
    sourceEvent: media.event,
    phase: media.phase,
    watchProvenance: media.watchProvenance || media.watch_provenance,
    ids: media.ids || {},
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: media.sessionId || media.session_id,
    user: media.user,
    device: media.device || media.deviceName || media.client?.deviceName,
    deviceId: media.deviceId || media.device_id || media.client?.deviceId,
    client: media.clientName || media.client?.client || media.client?.product || media.client?.platform,
    clientVersion: media.clientVersion || media.client?.version,
    status: summary.status || "unknown",
    details: summary.details || "",
  };
  recordWatchAuditEvents([
    {
      ...auditBase,
      details: `Outbound ${action} dispatch ${summary.status || "unknown"}: ${summary.details || "No details"}`,
      payload: {
        targetStates,
        loopSkipped: Boolean(summary.skipped),
        rawPayloadDebug: media.rawPayloadDebug || null,
      },
    },
    ...targetStates.map((targetState) => ({
      ...auditBase,
      eventType: "sync_target",
      target: targetState.target,
      status: targetState.status,
      details: targetState.detail || `Target ${targetState.target || "unknown"} reported ${targetState.status}.`,
      itemId: targetState.itemId || targetState.item_id || auditBase.itemId,
      payload: targetState,
    })),
  ]);
  await appendSyncHistory({
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    source: media.source || "unknown",
    status: summary.status || "unknown",
    details: summary.details || "",
    action,
    targetStates,
    rawPayloadDebug: {
      event: media.event || "",
      phase: media.phase || "",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
      provenance: media.watchProvenance || media.watch_provenance || null,
      // Keep whatever the parser worked out about an unrecognised request. For a
      // rejected webhook this is the only record of which server sent it and in
      // what format, and without it the entry is an unattributable dead end.
      ...(media.isValid ? {} : media.rawPayloadDebug || {}),
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
    watchProvenance: record.watch_provenance || null,
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
    watchProvenance: record.watch_provenance || null,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

// Core of "mark unwatched": delete the watched record, write a superseding
// unwatched record, flip the playstate cache, and propagate unplayed to the other
// platforms. Shared by the webhook `unplayed` phase and the manual-unwatch handler.
export async function applyManualUnwatch(media, config, loopStore, recordId = "", { includeSourcePlatform = false } = {}) {
  const result = await applyUnwatchedTransition(media, config, loopStore, { recordId, includeSourcePlatform });
  if (!result.alreadyUnwatched) await recordSyncHistory(media, result.summary, "unwatched");
  return result;
}

// Fans a newly added show or season out to its episodes on the server that
// announced it. Only episodes that server currently reports as unplayed are
// considered, so nothing is re-marked, and each one still has to have a watched
// record in Plembfin before anything is written.
async function applyWatchedStateToNewContainer(media, config, target) {
  let episodes = [];
  try {
    if (target === "jellyfin") {
      const { fetchJellyfinEpisodes } = await import("../utils/jellyfinClient.js");
      episodes = await fetchJellyfinEpisodes(config.jellyfin, media.itemId);
    } else if (target === "emby") {
      const { fetchEmbyEpisodes } = await import("../utils/embyClient.js");
      episodes = await fetchEmbyEpisodes(config.emby, media.itemId);
    } else if (target === "plex") {
      episodes = await fetchPlexSeriesEpisodes(config.plex, media);
    }
  } catch (error) {
    return { applied: false, reason: `Could not read episodes of the new ${media.type}: ${error.message || String(error)}` };
  }

  const pending = episodes.filter((ep) => ep?.UserData?.Played !== true && ep?.viewCount == null);
  let applied = 0;
  for (const ep of pending) {
    const season = ep.ParentIndexNumber ?? ep.parentIndex;
    const episodeNumber = ep.IndexNumber ?? ep.index;
    const showTitle = ep.SeriesName || ep.grandparentTitle || media.title || "Unknown Show";
    const episodeMedia = {
      title: `${showTitle} - S${String(season ?? "?").padStart(2, "0")}E${String(episodeNumber ?? "?").padStart(2, "0")}`,
      show_title: showTitle,
      type: "episode",
      source: target,
      ids: normalizeProviderIds(ep.ProviderIds || {}),
      season,
      episode: episodeNumber,
      itemId: ep.Id || ep.ratingKey,
      isValid: true,
    };
    const result = await applyWatchedStateToNewItem(episodeMedia, config).catch(() => ({ applied: false }));
    if (result.applied) applied += 1;
  }

  return {
    applied: applied > 0,
    status: applied > 0 ? "success" : "skipped",
    reason: `Newly added ${media.type}: ${applied} of ${pending.length} unplayed episode(s) marked watched from existing history.`,
  };
}

// Applies an existing watched record to the single server that just reported
// the item as newly added. Deliberately narrow: it marks played on that one
// server and writes no watch history, so a library scan can never manufacture a
// play. The outbound mark is recorded in the loop ledger, which is what stops
// the resulting played webhook from coming back as a fresh watch or a rewatch.
export async function applyWatchedStateToNewItem(media, loadedConfig = null) {
  const target = String(media.source || "").toLowerCase();
  if (!["plex", "emby", "jellyfin"].includes(target)) {
    return { applied: false, reason: "Unknown source platform" };
  }

  const config = loadedConfig || await loadMediaConfig();
  if (!canReceiveState(config, target, "watched")) {
    return { applied: false, reason: `${platformLabel(target)} is not configured to receive watched state` };
  }

  // Adding a show or a season announces the container, not the episodes. Walk
  // its children so a series you have already watched arrives watched, and
  // apply each one through this same function so every guard below still holds.
  if (media.type === "series" || media.type === "season") {
    return applyWatchedStateToNewContainer(media, config, target);
  }

  // Current playstate is authoritative over historical watch rows. This keeps
  // a delayed library-added event from reviving an older watch after the user
  // explicitly marked the item unwatched.
  const canonicalState = await getCanonicalWatchState(media).catch(() => null);
  if (canonicalState !== "watched") {
    return {
      applied: false,
      reason: canonicalState === "unwatched"
        ? "Current canonical state is unwatched"
        : "No watched record for this item",
    };
  }

  // Keep the matching history row for its original watched timestamp, which is
  // included in the sync telemetry below.
  const existing = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (!existing) {
    return { applied: false, reason: "No watched record for this item" };
  }

  const loopStore = createLoopStore();
  let summary;
  try {
    // Prime the durable echo ledger before the media-server request. Jellyfin
    // can deliver UserDataSaved synchronously while the mark-played request is
    // still in flight; writing only after the request leaves a race where the
    // callback is recorded as a fresh watch.
    await recordOutboundPlayedMarks(media, [target], loopStore).catch(() => null);
    let targetResult = null;
    if (target === "plex") targetResult = await markPlexPlayed(config.plex, media);
    if (target === "emby") targetResult = await markEmbyPlayed(config.emby, media);
    if (target === "jellyfin") targetResult = await markJellyfinPlayed(config.jellyfin, media);
    await recordOutboundPlayedMarks(media, [target], loopStore).catch(() => null);
    summary = {
      skipped: false,
      status: "success",
      details: `Newly added item marked watched on ${platformLabel(target)} from existing history (watched ${existing.watched_at}).`,
      targetStates: [{ target, status: "success", detail: "Marked watched on add", itemId: targetResult?.itemId || "", itemIds: targetResult?.itemIds || undefined, httpStatus: targetResult?.httpStatus || null }],
    };
  } catch (error) {
    summary = {
      skipped: false,
      status: "error",
      details: `Could not mark newly added item watched on ${platformLabel(target)}: ${error.message || String(error)}`,
      targetStates: [{ target, status: "error", detail: error.message || "Mark failed" }],
    };
  }

  await recordSyncHistory(media, summary, "watched").catch(() => null);
  console.log("New item caught up from history", {
    source: target,
    title: media.title,
    status: summary.status,
  });
  return { applied: summary.status === "success", status: summary.status, reason: summary.details };
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

export async function handleSyncLibraries(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const config = await loadMediaConfig();
  const libraries = [];
  const failures = [];
  const jobs = [["plex", config.plex, listPlexLibraries], ["emby", config.emby, listEmbyLibraries], ["jellyfin", config.jellyfin, listJellyfinLibraries]].filter(([, section]) => section && !section.disabled);
  await Promise.all(jobs.map(async ([server, section, list]) => {
    try { libraries.push(...(await list(section)).map((library) => ({ ...library, server }))); }
    catch (error) { failures.push({ server, error: error.message }); }
  }));
  return sendJson(res, { libraries, errors: failures }, 200, { "Cache-Control": "no-store" });
}

export async function handleSyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const history = await getSyncHistory(req.query.limit || 100);
  return sendJson(res, { history }, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

// Explicit detail-page repair. This is intentionally separate from the
// library-wide /api/force-sync route: the latter is a canonical replay and
// must continue to ignore server-only watches, while this user-requested
// title-scoped action is allowed to import watched state for the selected item.
export async function handleMediaForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    const body = await readJson(req);
    const requested = normalizeMediaForceSyncRequest(body);
    const operationId = createMediaForceSyncActivity({
      title: requested.title,
      type: requested.type,
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
    });
    void (async () => {
      try {
        const result = await forceSyncMediaState(requested, {
          config: await loadMediaConfig(),
          isCancelled: () => isMediaForceSyncCancellationRequested(operationId),
          logger: (message) => {
            appendMediaForceSyncActivity(operationId, message, "info");
            console.log(`[Media Force Sync ${operationId}] ${message}`);
          },
        });
        finishMediaForceSyncActivity(operationId, result);
      } catch (error) {
        console.error("Detail-page Force Sync failed", error);
        finishMediaForceSyncActivity(operationId, null, error.message || "Detail-page Force Sync failed");
      }
    })();
    return sendJson(res, { ok: true, operationId, status: "running", ...requested, title: requested.title }, 202, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Detail-page Force Sync failed", error);
    return sendJson(res, { ok: false, error: error.message || "Detail-page Force Sync failed" }, 400);
  }
}

export async function handleMediaForceSyncStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const operationId = String(req.query.id || "").trim();
  if (!operationId) return sendJson(res, { ok: false, error: "id is required" }, 400);
  const activity = getMediaForceSyncActivity(operationId);
  if (!activity) return sendJson(res, { ok: false, error: "Force Sync operation not found" }, 404);
  return sendJson(res, { ok: true, ...activity }, 200, { "Cache-Control": "no-store" });
}

// Settings uses the same Full Sync / Push To / Pull From activity surface as
// the detail page, but its operation is library-wide rather than title-scoped.
export async function handleLibraryForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    const body = await readJson(req);
    const requested = normalizeLibraryForceSyncRequest(body);
    const operationId = createMediaForceSyncActivity({
      title: requested.title,
      type: requested.type,
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
    });
    void (async () => {
      try {
        const result = await forceSyncLibraryState(requested, {
          config: await loadMediaConfig(),
          isCancelled: () => isMediaForceSyncCancellationRequested(operationId),
          logger: (message) => {
            appendMediaForceSyncActivity(operationId, message, "info");
            console.log(`[Library Force Sync ${operationId}] ${message}`);
          },
        });
        finishMediaForceSyncActivity(operationId, result);
      } catch (error) {
        console.error("Library Force Sync failed", error);
        finishMediaForceSyncActivity(operationId, null, error.message || "Library Force Sync failed");
      }
    })();
    return sendJson(res, { ok: true, operationId, status: "running", ...requested }, 202, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Library Force Sync failed", error);
    return sendJson(res, { ok: false, error: error.message || "Library Force Sync failed" }, 400);
  }
}

export async function handleLibraryForceSyncStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const operationId = String(req.query.id || "").trim();
  if (!operationId) return sendJson(res, { ok: false, error: "id is required" }, 400);
  const activity = getMediaForceSyncActivity(operationId);
  if (!activity) return sendJson(res, { ok: false, error: "Force Sync operation not found" }, 404);
  return sendJson(res, { ok: true, ...activity }, 200, { "Cache-Control": "no-store" });
}

export async function handleForceSyncCancellation(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  let body = {};
  try { body = await readJson(req); } catch { body = {}; }
  const operationId = String(body.id || req.query.id || "").trim();
  if (!operationId) return sendJson(res, { ok: false, error: "id is required" }, 400);

  const result = requestMediaForceSyncCancellation(operationId);
  if (!result.found) return sendJson(res, { ok: false, error: "Force Sync operation not found" }, 404);
  return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
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

  // An id can name a row that was superseded since the caller read it, so fall
  // back to the media key: either one supplied alongside the id, or the id
  // itself for callers that only hold a key.
  let record = await getWatchRecordById(id);
  if (!record && body.media_key) {
    record = await getWatchRecordByMediaKey(String(body.media_key));
  }
  if (!record) {
    record = await getWatchRecordByMediaKey(id);
  }
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

  // A manual retry resets the automatic backoff so the scheduled dispatcher
  // picks the record back up even after it exhausted its retry budget.
  await updateWatchSyncRetry(record.id, 0, 0, { skipInvalidate: true });
  await updateWatchTelemetry(record.id, formatDispatchTelemetry(summary, media, action));
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

  if (!workerAvailable()) return sendJson(res, { error: "No background worker is available." }, 503);
  const job = enqueueBackgroundJob("cron_sync", { forceCatchup: true });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("Cron Sync queued...\n");

  let closed = false;
  res.on("close", () => { closed = true; });
  let seen = 0;
  while (!closed) {
    const logs = getBackgroundJobLogs(job.id);
    for (const entry of logs.slice(seen)) res.write(`${entry.message}\n`);
    seen = logs.length;
    const current = getBackgroundJob(job.id);
    if (["succeeded", "failed", "cancelled"].includes(current?.status)) {
      if (!logs.some((entry) => entry.message.startsWith("RESULT:"))) {
        res.write(`RESULT: ${JSON.stringify(current.result || { success: false, error: current.error || current.status })}\n`);
      }
      res.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return;
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

export async function handleForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);

  // GET: poll for current status and log lines stored in runtimeState
  if (req.method === "GET") {
    if (!(await requireAdmin(req, res))) return;
    const job = getLatestBackgroundJob("force_sync");
    if (job) {
      const runtime = await loadRuntimeState();
      return sendJson(res, {
        active: ["queued", "running"].includes(job.status),
        log: getBackgroundJobLogs(job.id).map((entry) => entry.message),
        result: job.result || (job.error ? { success: false, error: job.error } : null),
        startedAt: job.startedAt || job.requestedAt,
        jobId: job.id,
        status: job.status,
        workerAvailable: workerAvailable(),
        operation: activeSyncOperation(runtime),
      });
    }
    const runtime = await loadRuntimeState();
    return sendJson(res, {
      active: runtime.forceSyncActive === true,
      log: Array.isArray(runtime.forceSyncLog) ? runtime.forceSyncLog : [],
      result: runtime.forceSyncResult || null,
      startedAt: runtime.forceSyncStartedAt || null,
      jobId: null,
      status: runtime.forceSyncActive === true ? "running" : "idle",
      workerAvailable: workerAvailable(),
      operation: activeSyncOperation(runtime),
    });
  }

  // POST: fire-and-forget â€” return 202 immediately, run in background
  if (!(await requireAdmin(req, res))) return;

  if (!workerAvailable()) return sendJson(res, { ok: false, error: "No background worker is available." }, 503);
  const body = await readJson(req).catch(() => ({}));
  const planId = String(body.planId || "").trim();
  if (planId) {
    const plan = getSyncPlanSummary(planId);
    if (!plan) return sendJson(res, { ok: false, error: "Plan not found." }, 404);
    if (plan.status !== "confirmed") return sendJson(res, { ok: false, error: `Plan is ${plan.status}; confirm it before execution.` }, 409);
  }
  const runtime = await loadRuntimeState();
  const operation = activeSyncOperation(runtime);
  if (operation) {
    const operationLabel = operation.kind === SYNC_OPERATION_FORCE ? "another Force Sync" : `another sync operation (${operation.kind})`;
    return sendJson(res, {
      ok: false,
      error: `${operationLabel} is already active. Stop/reset it before starting Force Sync.`,
      operation,
    }, 409);
  }
  const existingJob = getLatestBackgroundJob("force_sync");
  if (["queued", "running"].includes(existingJob?.status)) {
    return sendJson(res, { ok: false, error: "Another force sync job is already running." }, 409);
  }
  let queuedJob;
  try {
    queuedJob = enqueueBackgroundJob("force_sync", planId ? { planId } : {});
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return sendJson(res, { ok: false, error: error.message }, 409);
    throw error;
  }
  return sendJson(res, {
    ok: true,
    started: true,
    jobId: queuedJob.id,
    status: queuedJob.status,
    message: "Force Sync queued. Poll GET /api/force-sync for status.",
  }, 202);

}

// Force Sync preview lifecycle. Planning is a read-only background job; the
// durable plan record is intentionally separate from the ordinary force-sync
// job so polling a preview never exposes or mutates the execution lock.
export async function handleForceSyncPlan(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  const path = String(req.path || "");
  const match = path.match(/\/force-sync\/plan\/([^/]+)$/);
  const id = decodeURIComponent(match?.[1] || "");

  if (req.method === "GET" && id) {
    const plan = getSyncPlanSummary(id);
    if (!plan) return sendJson(res, { error: "Plan not found." }, 404);
    const page = getSyncPlanActionsPage(id, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      risk: req.query.risk,
    });
    return sendJson(res, { plan, actions: page }, 200, { "Cache-Control": "no-store" });
  }

  if (req.method === "POST" && id) {
    const result = confirmSyncPlan(id);
    return sendJson(res, result, result.ok ? 200 : 409);
  }

  if (req.method !== "POST" || id) return methodNotAllowed(res);
  if (!workerAvailable()) return sendJson(res, { ok: false, error: "No background worker is available." }, 503);
  const body = await readJson(req).catch(() => ({}));
  try {
    const job = enqueueBackgroundJob("force_sync_plan", { scope: body.scope || {} });
    return sendJson(res, { ok: true, jobId: job.id, status: job.status, message: "Force Sync preview queued." }, 202);
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return sendJson(res, { ok: false, error: error.message }, 409);
    return sendJson(res, { ok: false, error: error.message }, 500);
  }
}



export async function handleStopForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const job = getLatestBackgroundJob("force_sync");
  if (job && ["queued", "running"].includes(job.status)) {
    const updated = requestBackgroundJobCancellation(job.id);
    const runtime = await loadRuntimeState();
    const stale = job.status === "running"
      && Number(job.heartbeatAt || 0) > 0
      && Number(job.heartbeatAt) < Date.now() - BACKGROUND_JOB_STALE_MS;
    if (job.status === "running" && !stale && activeSyncOperation(runtime)?.kind === SYNC_OPERATION_FORCE) {
      await setRuntimeState({ forceSyncCancelRequested: true });
    }
    if (stale) {
      const cleared = await clearSyncOperation({
        kind: SYNC_OPERATION_FORCE,
        values: {
          forceSyncActive: false,
          forceSyncCancelRequested: true,
          forceSyncHeartbeat: Date.now(),
          forceSyncResult: { success: true, aborted: true, cancelled: true, reset: true, reason: "Stale Force Sync was stopped by an administrator." },
        },
      });
      const message = cleared.ok
        ? "Stale Force Sync cancelled and its operation lock was cleared."
        : "The stale Force Sync job was marked cancelled; no matching active lock was found.";
      await appendRuntimeLog("forceSyncLog", [`RESET: ${message}`]).catch(() => null);
      return sendJson(res, { ok: true, active: false, reset: true, jobId: job.id, message });
    }
    return sendJson(res, {
      ok: true,
      active: updated?.status === "running",
      reset: false,
      jobId: job.id,
      message: job.status === "queued" ? "Queued force sync cancelled." : "Cancellation request sent to the running force sync.",
    });
  }

  try {
    const runtime = await loadRuntimeState();
    const operation = activeSyncOperation(runtime);
    const action = forceSyncStopAction({
      workerRunning: false,
      runtimeActive: runtime.forceSyncActive === true || operation?.kind === SYNC_OPERATION_FORCE,
      cancelRequested: runtime.forceSyncCancelRequested === true,
    });

    if (action === "cancel") {
      if (operation?.kind === SYNC_OPERATION_FORCE || runtime.forceSyncActive === true) {
        await setRuntimeState({ forceSyncCancelRequested: true });
      }
      return sendJson(res, { ok: true, active: true, reset: false, message: "Cancellation request sent to the running force sync." });
    }

    const reset = action === "reset";
    const message = reset
      ? "Orphaned force-sync lock cleared. Recent-item repair can run now."
      : "No force sync was active. The sync lock is already clear.";

    if (reset) {
      await appendRuntimeLog("forceSyncLog", [`RESET: ${message}`]).catch(() => null);
      await clearSyncOperation({
        kind: SYNC_OPERATION_FORCE,
        values: {
          forceSyncActive: false,
          forceSyncCancelRequested: false,
          forceSyncHeartbeat: Date.now(),
          forceSyncResult: { success: true, aborted: true, reset: true, reason: message },
        },
      });
    }
    return sendJson(res, { ok: true, active: false, reset, message });
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

  recordWatchAuditEvent({
    eventType: "source_event",
    timestamp: Date.now(),
    action: media.phase === "unplayed" ? "unwatched" : media.phase,
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.mediaType,
    title: media.title,
    source: media.source,
    sourceEvent: media.event,
    phase: media.phase,
    watchProvenance: media.watchProvenance || media.watch_provenance,
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: media.sessionId,
    user: media.user,
    device: media.device,
    deviceId: media.deviceId,
    client: media.client,
    clientVersion: media.clientVersion,
    status: media.isValid ? "received" : "ignored",
    details: media.isValid
      ? `Received ${media.event || "source event"} from ${media.source || "unknown source"}.`
      : `Received source event but did not process it: ${media.phase === "ignored" ? "unsupported event" : "missing required media fields"}.`,
    payload: {
      rawPayloadDebug: media.rawPayloadDebug || null,
      watchProvenance: media.watchProvenance || media.watch_provenance || null,
      request: {
        userAgent: req.get("user-agent") || "",
        remoteAddress: req.ip || req.socket?.remoteAddress || "",
      },
    },
  });

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
  const activeOperation = activeSyncOperation(restoreRuntime);
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) {
    console.log("Webhook ignored: sync operation in progress (suppressing app echo)", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      operation: activeOperation.kind,
    });
    await recordSyncHistory(media, {
      status: "skipped",
      details: `Webhook ignored: ${activeOperation.kind} in progress`,
      targetStates: [],
    }, media.phase || "webhook").catch(() => null);
    return sendJson(res, { ok: true, inserted: false, skipped: true, reason: "Sync operation in progress" });
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

  if (media.phase === "unplayed") {
    const ownUnplayedEcho = await isRecentOutboundUnplayedFlagEcho(media, media.source, loopStore).catch(() => false);
    if (ownUnplayedEcho) {
      console.log("Webhook: skipped outbound unplayed echo", {
        source: media.source,
        title: media.title,
        event: media.event,
      });
      await deleteActiveSession(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, {
        ok: true,
        inserted: false,
        skipped: true,
        reason: "Unplayed callback followed Plembfin outbound mark",
      });
    }
  }

  // A server announcing new content is the moment a watch Plembfin already
  // holds can finally be applied there. Until the file exists, an outbound sync
  // has nothing to mark; this catches the item up without waiting for a manual
  // Force Sync. It never creates history - only an existing watched record is
  // ever applied, and only to the server that just added the item.
  //
  // This runs ahead of the season/series branch below on purpose. That branch
  // reads any non-`unplayed` phase as a play event and would file watches for
  // every episode of a newly added show.
  if (media.phase === "added") {
    const applied = await applyWatchedStateToNewItem(media, config).catch((error) => {
      console.error("New-item watched-state apply failed", error);
      return { applied: false, reason: error.message || "apply failed" };
    });
    return sendJson(res, { ok: true, added: true, inserted: false, ...applied });
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
            watchProvenance: media.watchProvenance || media.watch_provenance
              ? { ...(media.watchProvenance || media.watch_provenance), item_id: ep.Id || (media.watchProvenance || media.watch_provenance).item_id }
              : null,
            isValid: true,
          };
          episodeMedia.posterUrl = posterPathFromMedia(episodeMedia);

          if (media.phase === "unplayed") {
            await deleteActiveSession(episodeMedia).catch(() => null);
            const result = await applyManualUnwatch(episodeMedia, config, loopStore);
            results.push({
              episodeId: ep.Id,
              title: episodeMedia.title,
              success: result.alreadyUnwatched || result.summary.status === "success" || result.summary.status === "partial",
              skipped: Boolean(result.alreadyUnwatched),
            });
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
    recordPlaybackEndedAudit(media, {
      status: "stopped",
      details: "Playback ended before the watched threshold; resume progress was retained when available.",
    });
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
      const { wasDeleted, id, alreadyUnwatched } = await applyManualUnwatch(media, config, loopStore);
      console.log("Webhook: unwatched sync completed", {
        source: media.source,
        title: media.title,
        wasDeleted,
        alreadyUnwatched: Boolean(alreadyUnwatched),
        id,
      });
      if (alreadyUnwatched) {
        return sendJson(res, { ok: true, deleted: false, unplayed: true, inserted: false, id, reason: "Already unwatched; no change to propagate" });
      }
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

    // Re-adding a library item causes Plembfin to mark it watched from its
    // existing history. Jellyfin then emits a played-flag webhook for that
    // write. The item may have no provider IDs and its LastPlayedDate may be
    // stale, so the normal playstate lookup is not sufficient to identify the
    // callback as our own outbound action.
    if (["emby", "jellyfin"].includes(String(media.source || "").toLowerCase())) {
      const ownPlayedEcho = await isRecentOutboundPlayedFlagEcho(media, media.source, loopStore).catch(() => false);
      if (ownPlayedEcho) {
        console.log("Webhook: skipped outbound played echo", {
          source: media.source,
          title: media.title,
          event: media.event,
          reason: "played-flag callback followed Plembfin outbound mark",
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          skipped: true,
          reason: "Played flag callback followed Plembfin outbound mark",
        });
      }
    }

    // A played-flag event says nothing about *when* the play happened and can be
    // delivered hours late, so trust the server's own played timestamp over
    // arrival time. Playback events arrive live and keep the current time.
    if (media.playedFlagOnly && media.playedAt) media.watched_at = media.playedAt;

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
      // Emby and Jellyfin emit a played-flag event whenever anything sets the
      // flag, including plembfin's own outbound sync, and they can deliver it
      // hours after the fact. For an item already held as watched such an event
      // carries no evidence that a new play happened, so it never opens a
      // rewatch - the calendar day it happens to land on is meaningless. Real
      // rewatches arrive as playback events (media.scrobble, playback.stop) and
      // fall through to be recorded below.
      const lastWatchedDay = String(existingPlaystate.watched_at || "").slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const isPlayedFlagEcho = Boolean(media.playedFlagOnly);
      if (isPlayedFlagEcho || !lastWatchedDay || lastWatchedDay === today) {
        console.log("Webhook: skipped watched echo", {
          source: media.source,
          title: media.title,
          event: media.event,
          reason: isPlayedFlagEcho
            ? "played-flag event for an item already marked watched"
            : "already marked watched today",
          playstateUpdatedAt: existingPlaystate.updated_at,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          id: existingPlaystate.id,
          reason: isPlayedFlagEcho
            ? "Played flag event for an item already marked watched"
            : "Already marked watched today",
        });
      }
      console.log("Webhook: recording rewatch on a new day", {
        source: media.source,
        title: media.title,
        lastWatchedDay,
        today,
      });
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

    if (!media.playedFlagOnly) {
      recordPlaybackEndedAudit(media, {
        status: "completed",
        details: "Playback ended after the source reported a completed play.",
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
