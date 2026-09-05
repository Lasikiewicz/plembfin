import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson, readRawText } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, isTerminalLiveSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { activeSyncOperation, appendSyncHistory, clearSyncOperation, isAuthoritativeRestoreActive, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistoryById, getSyncHistoryPage, getSyncActivityGroupsPage, getSyncActivityGroupEvents, updateSyncHistoryStatus, loadRuntimeState, setRuntimeState, appendRuntimeLog, SYNC_OPERATION_FORCE, SYNC_OPERATION_SCHEDULED } from "../utils/configStore.js";
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
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, hidePlexFromContinueWatching, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes, listPlexLibraries } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { pokeLiveSessionPoller } from "../scheduler.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, hideEmbyFromResume, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes, listEmbyLibraries } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, hideJellyfinFromResume, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes, listJellyfinLibraries } from "../utils/jellyfinClient.js";
import { buildPlexMediaFromMetadata, normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexMediaIds, parsePlexWebhook } from "../utils/parsers.js";
import { completeDispatchTracking, finishDispatchTracking, getTargetsForSource, isRecentOutboundPlayedEcho, isRecentOutboundPlayedFlagEcho, isRecentOutboundProgressEcho, isRecentOutboundUnplayedFlagEcho, recordOutboundPlayedMarks, reserveDispatchBatch, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { canReceiveState } from "../utils/syncRoles.js";
import {
  playstateBlocksStoredResumeProgress,
  resumePositionUnchanged,
  resumeProgressAuthorityTimestamp,
  resumeProgressBlockedByPlaystate,
  resumeProgressEventTimestamp,
  resumeWebhookPhaseForPlaystate,
} from "../utils/resumeAuthority.js";
import { watchedPlayedSyncEnabled } from "../utils/syncFlags.js";
import { forceSyncMediaState, normalizeMediaForceSyncRequest } from "../utils/mediaForceSync.js";
import { forceSyncLibraryState, normalizeLibraryForceSyncRequest } from "../utils/libraryForceSync.js";
import { appendMediaForceSyncActivity, createMediaForceSyncActivity, finishMediaForceSyncActivity, getMediaForceSyncActivity, isMediaForceSyncCancellationRequested, requestMediaForceSyncCancellation } from "../utils/mediaForceSyncActivity.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "../utils/watchProvenance.js";
import { releaseDateForItem } from "../utils/watchDates.js";
import { applyUnwatchedTransition } from "../utils/watchStateTransitions.js";
import { recordWatchAuditEvent, recordWatchAuditEvents } from "../utils/watchAudit.js";
import { fetchPosterFromTmdb } from "../utils/tmdbClient.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "../utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, searchTmdb, getCachedTvdbId, queueTmdbMetadataWarmup } from "../utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork } from "../utils/tvdbGateway.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "../utils/fanartGateway.js";
import { getOmdbRating } from "../utils/omdbGateway.js";
import { getCanonicalPosterUrl } from "../utils/mediaArtwork.js";
import { syncUpNextToProviders } from "../utils/upNextProviderSync.js";
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
  showTitleFrom,
  requireDb,
  updateWatchPosterUrl,
  updatePlaybackProgressTelemetry,
  updateWatchSyncRetry,
  updateWatchTelemetry,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
  supersedeUnwatchedTransitionsForRecordSync,
  reassertWatchRecordAuthoritySync,
  normalizeWatchRecordForInsert,
  watchRowToMedia,
  getCachedShows,
  getCachedMovies,
  getCachedHistory,
  getKnownShowIdentityForTitle,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  isDeletedWatchSuppressed,
  getCanonicalWatchState,
  getPlaybackProgressForMedia,
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
  countTraktImportPendingDispatch,
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

export function formatDispatchTelemetry(summary, media, action = "watched") {
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

export async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
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
      watchRecordId: media.watchRecordId || media.watch_record_id || media.recordId || media.record_id || null,
      mediaKey: mediaKeyFor(media),
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

export function manualWatchMediaFromRecord(record = {}) {
  return {
    watchRecordId: record.id || record.watchRecordId || record.watch_record_id || undefined,
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
    // Without this, outbound dispatch (traktClient.js syncPayload) falls
    // back to Date.now() for the watched_at it sends to Trakt, so a manual
    // watch with an explicit historical date (e.g. "watched on release day")
    // reached Trakt stamped as watched right now instead.
    watched_at: record.watched_at || undefined,
    posterUrl: record.poster_url || undefined,
    watchProvenance: record.watch_provenance || null,
    providerItems: record.provider_items || record.providerItems || {},
    providerItemId: record.provider_item_id || record.providerItemId || undefined,
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
    watchRecordId: record.id || record.watchRecordId || record.watch_record_id || undefined,
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
    providerItems: record.provider_items || record.providerItems || {},
    providerItemId: record.provider_item_id || record.providerItemId || undefined,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

// Core of "mark unwatched": delete the watched record, write a superseding
// unwatched record, flip the playstate cache, and propagate unplayed to the other
// platforms. Shared by the webhook `unplayed` phase and the manual-unwatch handler.
export async function applyManualUnwatch(media, config, loopStore, recordId = "", { includeSourcePlatform = false, trackDispatch = true, force = false, lane = "sync" } = {}) {
  const result = await applyUnwatchedTransition(media, config, loopStore, {
    recordId,
    includeSourcePlatform,
    trackDispatch,
    force,
    lane,
    allowLocalDuringRestore: includeSourcePlatform,
  });
  // includeSourcePlatform means this is an explicit manual action, not an inbound
  // event from `media.source` - applyUnwatchedTransition dispatches under "manual"
  // for the same reason (see its includeSourcePlatform handling), so the recorded
  // history must say "manual" too rather than echoing the target's original watch
  // provenance (e.g. a record originally captured from Trakt) as if that platform
  // had requested this unwatch.
  const historyMedia = {
    ...media,
    ...(result.id ? { watchRecordId: result.id } : {}),
    ...(includeSourcePlatform ? { source: "manual" } : {}),
  };
  // The force path still dispatches (and returns alreadyUnwatched: true purely
  // to signal "no new watch_history row"), so it needs recording too.
  if (!result.alreadyUnwatched || force) await recordSyncHistory(historyMedia, result.summary, "unwatched");
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

  const pending = episodes.filter((ep) => {
    if (target === "plex") {
      return Object.prototype.hasOwnProperty.call(ep || {}, "viewCount") && Number(ep.viewCount || 0) <= 0;
    }
    return Boolean(ep?.UserData && typeof ep.UserData === "object")
      && ep.UserData.Played !== true
      && Number(ep.UserData.PlayCount || 0) <= 0;
  });
  let applied = 0;
  for (const ep of pending) {
    const season = ep.ParentIndexNumber ?? ep.parentIndex;
    const episodeNumber = ep.IndexNumber ?? ep.index;
    const showTitle = ep.SeriesName || ep.grandparentTitle || media.title || "Unknown Show";
    const itemId = ep.Id || ep.ratingKey;
    const rawIds = target === "plex"
      ? parsePlexMediaIds(ep, "episode")
      : { ...(ep.ProviderIds || {}), ...(ep.SeriesProviderIds || {}) };
    const episodeMedia = {
      title: `${showTitle} - S${String(season ?? "?").padStart(2, "0")}E${String(episodeNumber ?? "?").padStart(2, "0")}`,
      show_title: showTitle,
      showTitle,
      type: "episode",
      source: target,
      ids: target === "plex" ? rawIds : normalizeProviderIds(rawIds),
      season,
      episode: episodeNumber,
      episodeTitle: ep.Name || ep.name || ep.title || null,
      itemId,
      provider_item_id: itemId,
      provider_items: { [target]: itemId ? [String(itemId)] : [] },
      providerItems: { [target]: itemId ? [String(itemId)] : [] },
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

function syncTelemetryLineValue(telemetry = "", label = "") {
  const prefix = `${label}:`;
  const line = String(telemetry || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

function syncTelemetryTargetStates(telemetry = "") {
  return String(telemetry || "")
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(?:target\s+)?(plex|emby|jellyfin|trakt)\s+(?:progress\s+)?status:\s*(.+)$/i))
    .filter(Boolean)
    .map(([, target, result]) => {
      const separator = result.indexOf(" - ");
      const status = (separator < 0 ? result : result.slice(0, separator)).trim().toLowerCase() || "unknown";
      const detail = separator < 0 ? "" : result.slice(separator + 3).trim();
      return { target: target.toLowerCase(), status, ...(detail ? { detail } : {}) };
    });
}

export function queuedWatchRecordToSyncActivity(row = {}) {
  const telemetry = String(row.sync_dispatch_telemetry || "");
  const timestamp = Number(row.updated_at || row.created_at) || Date.parse(String(row.watched_at || "")) || Date.now();
  const status = syncTelemetryLineValue(telemetry, "Dispatch status").toLowerCase() || "queued";
  const details = syncTelemetryLineValue(telemetry, "Details") || "Outbound synchronization queued after the Plembfin history write.";
  const ids = {
    imdb: row.imdb_id || "",
    tmdb: row.tmdb_id || "",
    tvdb: row.tvdb_id || "",
  };
  return {
    id: `queued:${row.id}`,
    timestamp,
    mediaType: row.media_type || "unknown",
    title: row.title || "Unknown media",
    source: row.source || "unknown",
    status,
    details,
    action: row.sync_action || "watched",
    targetStates: syncTelemetryTargetStates(telemetry),
    rawPayloadDebug: {
      event: row.watch_provenance?.event || "",
      phase: row.watch_provenance?.phase || "",
      ids,
      season: row.season ?? null,
      episode: row.episode ?? null,
      provenance: row.watch_provenance || null,
      watchRecordId: row.id != null ? String(row.id) : "",
      mediaKey: row.media_key || "",
    },
    createdAt: Number(row.created_at || 0),
  };
}

function normalizedSyncActivityTitle(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function queuedActivityAlreadyRecorded(row, history = []) {
  const recordId = row.id != null ? String(row.id) : "";
  const title = normalizedSyncActivityTitle(row.title);
  const mediaType = String(row.media_type || "").toLowerCase();
  const action = String(row.sync_action || "watched").toLowerCase();
  const queuedAt = Number(row.updated_at || row.created_at) || Date.parse(String(row.watched_at || "")) || 0;
  return history.some((entry) => {
    const debug = entry.rawPayloadDebug || {};
    if (recordId && String(debug.watchRecordId || debug.watch_record_id || "") === recordId) return true;
    if (mediaType !== String(entry.mediaType || "").toLowerCase()) return false;
    if (action !== String(entry.action || "watched").toLowerCase()) return false;
    if (title !== normalizedSyncActivityTitle(entry.title)) return false;
    const historyAt = Number(entry.timestamp || 0);
    return queuedAt > 0 && historyAt > 0 && Math.abs(historyAt - queuedAt) <= 15 * 60 * 1000;
  });
}

// The actual page-building logic behind GET /api/sync-history (queued
// watch_history rows merged as a prefix ahead of the durable sync_history
// store - see the comment below), factored out so a caller that isn't an
// HTTP request - the "retry all failed" background job's own discovery pass
// - can walk it directly instead of the job calling back into its own HTTP
// server. requestedLimit is not capped here the way the route handler caps
// it for response size; a background caller can ask for a much larger page.
async function getMergedSyncActivityPage({ limit = 100, page = 1, search = "" } = {}) {
  const requestedLimit = Math.max(Math.floor(Number(limit) || 100), 1);
  const requestedPage = Math.max(Math.floor(Number(page) || 1), 1);
  const cleanedSearch = String(search || "").trim().slice(0, 120);
  const [historyHead, queuedRows, searchedHistory] = await Promise.all([
    // Keep the queue de-duplication probe bounded. The durable page query
    // below is the only query whose size is controlled by the requested page.
    getSyncHistoryPage({ limit: 200, offset: 0 }),
    // This endpoint is deliberately fresh: most ingest paths defer their
    // derived-cache invalidation until after outbound dispatch, while the
    // Activity page should show the queue during that dispatch window.
    querySyncJobs({ limit: 500, status: "outstanding", fresh: true }),
    cleanedSearch ? getSyncHistoryPage({ limit: 1, offset: 0, search: cleanedSearch }) : Promise.resolve(null),
  ]);
  const queued = queuedRows
    .filter((row) => !queuedActivityAlreadyRecorded(row, historyHead.history))
    .map(queuedWatchRecordToSyncActivity)
    .filter((entry) => {
      if (!cleanedSearch) return true;
      const source = String(entry.source || "").toLowerCase();
      const sourceLabel = source.startsWith("manual") || source.startsWith("force_sync") || source.startsWith("plembfin") ? "Plembfin" : source;
      const haystack = [
        entry.mediaType,
        entry.title,
        entry.source,
        sourceLabel,
        entry.status,
        entry.details,
        entry.action,
        JSON.stringify(entry.targetStates || []),
        JSON.stringify(entry.rawPayloadDebug || {}),
      ].join(" ").toLowerCase();
      return haystack.includes(cleanedSearch.toLowerCase());
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0) || String(b.id).localeCompare(String(a.id)));

  // Pending queue entries are treated as a short-lived prefix of the feed.
  // This keeps them visible without changing the offsets of the durable rows
  // every time a dispatch finishes. The durable store remains the source for
  // every subsequent page.
  const total = (searchedHistory?.total ?? historyHead.total) + queued.length;
  const totalPages = Math.max(1, Math.ceil(total / requestedLimit));
  const resolvedPage = Math.min(requestedPage, totalPages);
  const pageOffset = (resolvedPage - 1) * requestedLimit;
  const queuedStart = Math.min(pageOffset, queued.length);
  const queuedPage = queued.slice(queuedStart, queuedStart + requestedLimit);
  const storedOffset = Math.max(0, pageOffset - queued.length);
  const storedLimit = Math.max(0, requestedLimit - queuedPage.length);
  const storedPage = storedLimit
    ? await getSyncHistoryPage({ limit: storedLimit, offset: storedOffset, search: cleanedSearch })
    : { history: [] };
  const merged = [...queuedPage, ...storedPage.history];
  const from = total ? pageOffset + 1 : 0;
  const to = total ? Math.min(pageOffset + merged.length, total) : 0;

  // A stable, whole-backlog figure for a large Trakt import's outbound
  // propagation - see countTraktImportPendingDispatch in dataRepo.js for why
  // this exists alongside the live per-burst "Sync - X of Y" indicator.
  const traktDispatchProgress = countTraktImportPendingDispatch();

  return {
    history: merged,
    pagination: {
      page: resolvedPage,
      limit: requestedLimit,
      total,
      totalPages,
      from,
      to,
      hasPrevious: resolvedPage > 1,
      hasNext: resolvedPage < totalPages,
    },
    ...(traktDispatchProgress.pending > 0 ? { traktDispatchProgress } : {}),
  };
}

export async function handleSyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const requestedLimit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const requestedPage = Math.max(Math.floor(Number(req.query.page) || 1), 1);
  const search = String(req.query.search || "").trim().slice(0, 120);
  const body = await getMergedSyncActivityPage({ limit: requestedLimit, page: requestedPage, search });
  return sendJson(res, body, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

// Stable, user-facing view of the audit trail. The legacy /api/sync-history
// endpoint remains event-shaped for retry tooling and compatibility; this
// endpoint groups events before pagination so a busy movie cannot consume a
// page by itself.
export async function handleSyncActivity(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
  const page = Math.max(Math.floor(Number(req.query.page) || 1), 1);
  const search = String(req.query.search || "").trim().slice(0, 120);
  const offset = (page - 1) * limit;
  const result = await getSyncActivityGroupsPage({ limit, offset, search });
  const totalPages = Math.max(1, Math.ceil(result.total / result.limit));
  const resolvedPage = Math.min(page, totalPages);
  // A new event can move a group onto page one between requests. Re-read the
  // requested page when the supplied page was beyond the current end so the
  // response never advertises an empty page that cannot exist.
  const resolved = resolvedPage === page
    ? result
    : await getSyncActivityGroupsPage({ limit, offset: (resolvedPage - 1) * limit, search });
  const from = resolved.total ? (resolvedPage - 1) * limit + 1 : 0;
  const to = resolved.total ? Math.min(from + resolved.groups.length - 1, resolved.total) : 0;
  const traktDispatchProgress = countTraktImportPendingDispatch();
  return sendJson(res, {
    groups: resolved.groups,
    pagination: {
      page: resolvedPage,
      limit: resolved.limit,
      total: resolved.total,
      totalPages,
      from,
      to,
      hasPrevious: resolvedPage > 1,
      hasNext: resolvedPage < totalPages,
    },
    ...(traktDispatchProgress.pending > 0 ? { traktDispatchProgress } : {}),
  }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
}

export async function handleSyncActivityGroup(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const groupKey = String(req.query.key || "").trim();
  if (!groupKey) return sendJson(res, { error: "Activity group key is required" }, 400);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const page = Math.max(Math.floor(Number(req.query.page) || 1), 1);
  const result = await getSyncActivityGroupEvents({ groupKey, limit, offset: (page - 1) * limit });
  if (!result.group) return sendJson(res, { error: "Sync activity group not found" }, 404);
  const totalPages = Math.max(1, Math.ceil(result.total / result.limit));
  const resolvedPage = Math.min(page, totalPages);
  const resolved = resolvedPage === page
    ? result
    : await getSyncActivityGroupEvents({ groupKey, limit, offset: (resolvedPage - 1) * limit });
  return sendJson(res, {
    group: resolved.group,
    events: resolved.events,
    pagination: {
      page: resolvedPage,
      limit: resolved.limit,
      total: resolved.total,
      totalPages,
      from: resolved.total ? (resolvedPage - 1) * limit + 1 : 0,
      to: resolved.total ? Math.min(resolvedPage * limit, resolved.total) : 0,
      hasPrevious: resolvedPage > 1,
      hasNext: resolvedPage < totalPages,
    },
  }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
}

function isRetryableSyncActivityEntry(entry = {}) {
  return retryableSyncActivityTargets(entry).length > 0;
}

// Walks every page of getMergedSyncActivityPage (not just what the HTTP
// route's own response-size cap would allow) collecting every retryable
// entry's id, for the "retry all failed" background job's own discovery
// pass - no HTTP round trip to itself, and no cap on page size since nothing
// here goes back over the wire.
async function listAllRetryableSyncActivityIds() {
  const ids = [];
  const limit = 500;
  let page = 1;
  for (;;) {
    const body = await getMergedSyncActivityPage({ limit, page });
    for (const entry of body.history) {
      if (isRetryableSyncActivityEntry(entry)) ids.push(String(entry.id));
    }
    const totalPages = Math.max(Number(body.pagination?.totalPages) || 1, 1);
    if (!body.history.length || page >= totalPages) break;
    page += 1;
  }
  return ids;
}

function retryableSyncActivityTargets(entry = {}) {
  return [...new Set((entry.targetStates || [])
    .filter((target) => ["error", "failed", "skipped", "not_found"].includes(String(target.status || "").toLowerCase()))
    .map((target) => String(target.target || "").trim().toLowerCase())
    .filter((target) => ["plex", "emby", "jellyfin", "trakt"].includes(target)))];
}

// Recomputes an entry's overall status from its per-target results, the same
// success/partial/error/skipped rules syncOrchestrator.js itself uses - kept
// here in miniature because this is recomputing a MERGED array (original
// targets untouched by a retry, mixed with the retry's own results), not the
// single dispatch summary syncOrchestrator already scores.
function statusFromTargetStates(targetStates = []) {
  if (!targetStates.length) return "skipped";
  const successCount = targetStates.filter((t) => String(t.status || "").toLowerCase() === "success").length;
  const failureCount = targetStates.filter((t) => ["error", "failed"].includes(String(t.status || "").toLowerCase())).length;
  if (successCount === targetStates.length) return "success";
  if (failureCount) return successCount ? "partial" : "error";
  return successCount ? "partial" : "skipped";
}

// Folds a retry's own target-level results back into the entry's original
// target list: a target the retry actually reported on takes its new result;
// a target that was retried (in retriedTargets) but the retry summary never
// mentioned - because there was nothing to dispatch to at all, e.g. "No
// enabled sync destinations" - is downgraded from its old "error" to
// "skipped" rather than left showing a stale error. A target that wasn't
// part of this retry (already succeeding, or a platform outside
// plex/emby/jellyfin/trakt) is carried over unchanged.
function mergeTargetStates(originalTargetStates = [], retrySummaryTargetStates = [], retriedTargets = [], retryDetail = "") {
  const retriedSet = new Set(retriedTargets);
  const byTarget = new Map(retrySummaryTargetStates.map((t) => [String(t.target || "").trim().toLowerCase(), t]));
  return originalTargetStates.map((t) => {
    const key = String(t.target || "").trim().toLowerCase();
    if (byTarget.has(key)) return byTarget.get(key);
    if (retriedSet.has(key)) return { target: key, status: "skipped", detail: retryDetail || "No destination currently configured" };
    return t;
  });
}

async function mediaFromSyncActivity(entry, config) {
  const debug = entry.rawPayloadDebug || {};
  const recordId = debug.watchRecordId || debug.watch_record_id;
  const record = recordId ? await getWatchRecordById(recordId) : null;
  if (record) return mediaFromWatchRecord(record);

  const ratingKey = debug.ratingKey || debug.rating_key;
  if (String(entry.source || "").toLowerCase().startsWith("plex") && ratingKey && config?.plex) {
    const metadata = await fetchPlexMetadataItem(config.plex, ratingKey).catch(() => null);
    if (metadata) return buildPlexMediaFromMetadata(metadata, { phase: String(entry.action || "watched").toLowerCase().startsWith("un") ? "unplayed" : "completed" });
  }

  const ids = debug.ids || debug.media?.ids || {};
  return {
    title: entry.title,
    type: String(entry.mediaType || "").toLowerCase(),
    source: entry.source || "manual",
    ids: {
      imdb: ids.imdb || ids.imdb_id || undefined,
      tmdb: ids.tmdb || ids.tmdb_id || undefined,
      tvdb: ids.tvdb || ids.tvdb_id || undefined,
    },
    season: debug.season ?? debug.media?.season,
    episode: debug.episode ?? debug.media?.episode,
    isValid: Boolean(entry.title && ["movie", "episode"].includes(String(entry.mediaType || "").toLowerCase())),
  };
}

// A "queued:<watch_history id>" activity entry (queuedWatchRecordToSyncActivity
// below) represents a watch that's been recorded locally but has no
// sync_history row of its own yet - that's the whole reason it reads
// "queued" rather than "error"/"partial". There's nothing for
// getSyncHistoryById to find, so retrying one means dispatching the
// underlying watch_history row directly, the same way the original write's
// own deferred dispatch would have, rather than replaying a prior attempt.
// The appended sync_history record's rawPayloadDebug.watchRecordId lets
// queuedActivityAlreadyRecorded (below) recognize this queued entry as
// resolved and stop showing it once the activity list next refreshes.
async function retryQueuedWatchRecord(watchRecordId) {
  const id = String(watchRecordId || "").trim();
  if (!id) throw Object.assign(new Error("Missing watch record id"), { status: 400 });
  const record = await getWatchRecordById(id);
  if (!record) throw Object.assign(new Error("The original watch record for this queued item could not be found"), { status: 404 });

  const config = await loadMediaConfig();
  const media = mediaFromWatchRecord(record);
  media.watched_at = record.watched_at || undefined;
  if (!media?.isValid) throw Object.assign(new Error("The media identity for this watch record could not be resolved"), { status: 422 });

  const originalTargetStates = syncTelemetryTargetStates(record.sync_dispatch_telemetry);
  const retriedTargets = retryableSyncActivityTargets({ targetStates: originalTargetStates });
  const action = String(record.sync_action || "watched").toLowerCase();
  const loopStore = createLoopStore();
  let summary;
  try {
    summary = action === "unwatched" || action === "unplayed"
      ? await syncMediaUnplayedPlaystate(media, config, loopStore, { lane: "interactive" })
      : await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" });
  } catch (error) {
    summary = { skipped: false, status: "error", details: `Retry failed: ${error.message || String(error)}`, targetStates: [] };
  }
  const mergedTargetStates = mergeTargetStates(originalTargetStates, summary.targetStates || [], retriedTargets, summary.details);
  const mergedStatus = statusFromTargetStates(mergedTargetStates);

  // The "queued:<id>" pseudo-entry the Activity list renders for this item is
  // read straight off this row's own telemetry (queuedWatchRecordToSyncActivity
  // below), not from a durable sync_history row - so unless this write happens,
  // the pseudo-entry keeps showing the retry's stale pre-retry outcome no
  // matter how many sync_history rows get appended elsewhere. Rewriting it here
  // is what actually makes the retry visible, independent of whatever durable
  // row also gets appended for the audit trail.
  await updateWatchTelemetry(id, formatDispatchTelemetry({ skipped: mergedStatus === "skipped", status: mergedStatus, details: summary.details, targetStates: mergedTargetStates }, media, action));
  await appendSyncHistory({
    mediaType: media.type,
    title: media.title,
    source: media.source,
    status: mergedStatus,
    details: `Retry of queued watch ${id}: ${summary.details || "Sync retry completed"}`,
    action,
    targetStates: mergedTargetStates,
    rawPayloadDebug: { watchRecordId: id, ids: media.ids || {} },
  });
  return { status: mergedStatus, details: summary.details, targetStates: mergedTargetStates, title: media.title };
}

// Core retry logic for a single sync-activity id - a real sync_history row
// or a "queued:<watch_history id>" pseudo-entry - shared by the interactive
// HTTP endpoint below and the "retry all failed" background job, so there is
// exactly one place that knows how to retry one item. Throws an Error with a
// `.status` for the HTTP wrapper to translate into a response code; the
// background job just logs the message and moves on to the next id.
async function retrySyncActivityEntry(rawId) {
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; retry sync is paused until it completes."), { status: 409 });
  }
  const id = String(rawId == null ? "" : rawId).trim();
  if (!id) throw Object.assign(new Error("Missing required field: id"), { status: 400 });
  if (id.startsWith("queued:")) return retryQueuedWatchRecord(id.slice("queued:".length));

  const entry = await getSyncHistoryById(id);
  if (!entry) throw Object.assign(new Error("Sync activity entry not found"), { status: 404 });
  const targets = retryableSyncActivityTargets(entry);
  if (!targets.length) throw Object.assign(new Error("This sync activity entry has no failed or skipped targets to retry"), { status: 409 });

  const config = await loadMediaConfig();
  const media = await mediaFromSyncActivity(entry, config);
  if (!media?.isValid) throw Object.assign(new Error("The media identity for this activity entry could not be resolved"), { status: 422 });
  const existing = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (existing?.watched_at) media.watched_at = existing.watched_at;
  media.syncTargets = targets;

  const action = String(entry.action || "watched").toLowerCase();
  const loopStore = createLoopStore();
  let summary;
  try {
    summary = action === "unwatched" || action === "unplayed"
      ? await syncMediaUnplayedPlaystate(media, config, loopStore, { lane: "interactive" })
      : await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" });
  } catch (error) {
    summary = { skipped: false, status: "error", details: `Retry failed: ${error.message || String(error)}`, targetStates: [] };
  }
  const mergedTargetStates = mergeTargetStates(entry.targetStates || [], summary.targetStates || [], targets, summary.details);
  const mergedStatus = statusFromTargetStates(mergedTargetStates);
  await updateSyncHistoryStatus(entry.id, {
    status: mergedStatus,
    details: summary.details || entry.details,
    action,
    targetStates: mergedTargetStates,
    rawPayloadDebug: { ...entry.rawPayloadDebug, ids: media.ids || {} },
  });
  return { status: mergedStatus, details: summary.details, targetStates: mergedTargetStates, title: media.title };
}

export async function handleRetrySyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; retry sync is paused until it completes." }, 409);
  }

  const body = await readJson(req);
  try {
    const result = await retrySyncActivityEntry(body.id);
    return sendJson(res, { ok: true, ...result });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

// Runs "retry all failed" to completion as a background job (see
// workerCoordinator.js's executeJob) so it survives the requesting browser
// tab closing, reloading, or navigating away - the same reasoning as
// runTmdbMetadataRefreshJob in maintenance.js. Discovery (which ids are
// retryable right now) happens once at the start; an id that started failing
// or succeeding mid-run because of an earlier retry in this same pass is not
// re-checked.
export async function runRetryAllSyncActivityJob(log, { isCancelled } = {}) {
  const ids = await listAllRetryableSyncActivityIds();
  const total = ids.length;
  log(`Found ${total} failed or skipped item${total === 1 ? "" : "s"} to retry.`);

  let succeeded = 0;
  let stillFailed = 0;
  let skipped = 0;
  let errored = 0;

  for (let i = 0; i < ids.length; i++) {
    if (isAuthoritativeRestoreActive() || (isCancelled && await isCancelled())) {
      return {
        success: true, aborted: true, cancelled: true,
        total, processed: i, succeeded, stillFailed, skipped, errored,
        reason: "Retry all was cancelled.",
      };
    }
    const id = ids[i];
    try {
      const result = await retrySyncActivityEntry(id);
      if (result.status === "success") succeeded += 1;
      else if (result.status === "skipped") skipped += 1;
      else stillFailed += 1;
      log(`[${i + 1}/${total}] ${result.title || id}: ${result.status}${result.details ? ` - ${result.details}` : ""}`);
    } catch (error) {
      errored += 1;
      log(`[${i + 1}/${total}] ${id}: error - ${error.message}`);
    }
  }

  log(`Retry all complete: ${succeeded} succeeded, ${stillFailed} still failed, ${skipped} skipped, ${errored} error${errored === 1 ? "" : "s"}, out of ${total}.`);
  return { success: true, total, processed: total, succeeded, stillFailed, skipped, errored };
}

export async function handleRetryAllSyncActivity(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  // GET: poll for current status and log lines, same shape as /api/force-sync.
  if (req.method === "GET") {
    const job = getLatestBackgroundJob("retry_all_sync_activity");
    if (!job) {
      return sendJson(res, { active: false, log: [], result: null, status: "idle", jobId: null, workerAvailable: workerAvailable() }, 200, { "Cache-Control": "no-store" });
    }
    return sendJson(res, {
      active: ["queued", "running"].includes(job.status),
      log: getBackgroundJobLogs(job.id).map((entry) => entry.message),
      result: job.result || (job.error ? { success: false, error: job.error } : null),
      startedAt: job.startedAt || job.requestedAt,
      jobId: job.id,
      status: job.status,
      workerAvailable: workerAvailable(),
    }, 200, { "Cache-Control": "no-store" });
  }

  // POST: fire-and-forget - return 202 immediately, run in background.
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; retry sync is paused until it completes." }, 409);
  }
  if (!workerAvailable()) return sendJson(res, { ok: false, error: "No background worker is available." }, 503);
  const existingJob = getLatestBackgroundJob("retry_all_sync_activity");
  if (existingJob && ["queued", "running"].includes(existingJob.status)) {
    return sendJson(res, { ok: false, error: "A retry-all run is already in progress.", jobId: existingJob.id }, 409);
  }
  let queuedJob;
  try {
    queuedJob = enqueueBackgroundJob("retry_all_sync_activity", {});
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return sendJson(res, { ok: false, error: error.message }, 409);
    throw error;
  }
  return sendJson(res, {
    ok: true,
    started: true,
    jobId: queuedJob.id,
    status: queuedJob.status,
    message: "Retry all queued. Poll GET /api/sync-history/retry-all for status.",
  }, 202);
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
    if (isAuthoritativeRestoreActive()) {
      return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; Force Sync is paused until it completes." }, 409);
    }
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

// Settings uses the same push/pull activity surface as the detail page, but
// its operation is library-wide rather than title-scoped.
export async function handleLibraryForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    const body = await readJson(req);
    const requested = normalizeLibraryForceSyncRequest(body);
    if (isAuthoritativeRestoreActive()) {
      return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; Force Sync is paused until it completes." }, 409);
    }
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

// Bounded item-level concurrency for bulk manual watch/unwatch dispatch, matching
// the concurrency already used for Force Sync (mediaForceSync.js, libraryForceSync.js).
// Outbound HTTP calls are still throttled per-host by the outbound governor, so this
// only shortens wall-clock time for a large batch - it does not add pressure on
// Plex/Emby/Jellyfin beyond what the governor already allows.
const MANUAL_SYNC_ITEM_CONCURRENCY = 6;

export async function handleManualUnwatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const ids = Array.isArray(body.ids)
    ? body.ids.map((value) => String(value || "").trim()).filter(Boolean)
    : String(body.id || "").trim() ? [String(body.id).trim()] : [];
  if (!ids.length) return sendJson(res, { error: "id or ids is required" }, 400);
  if (ids.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  const results = new Array(ids.length);
  let succeeded = 0;
  let failed = 0;
  let queued = 0;

  const trackingReservation = reserveDispatchBatch(ids.length);
  try {
    await runWithConcurrency(ids, async (id, index) => {
      try {
        const record = await getWatchRecordById(id);
        if (!record) throw new Error("Watch record not found");
        const media = mediaFromWatchRecord(record);
        const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, id, {
          includeSourcePlatform: true,
          trackDispatch: false,
          force: true,
          lane: ids.length === 1 ? "interactive" : "sync",
        });
        succeeded += 1;
        const wasQueued = Boolean(summary.deferred);
        if (wasQueued) queued += 1;
        results[index] = { id, unwatchedId, status: summary.status, queued: wasQueued, targetStates: summary.targetStates || [] };
      } catch (error) {
        failed += 1;
        results[index] = { id, error: error.message || String(error) };
      } finally {
        completeDispatchTracking(trackingReservation);
      }
    }, MANUAL_SYNC_ITEM_CONCURRENCY);
  } finally {
    finishDispatchTracking(trackingReservation);
    await invalidateHistoryDerivedCaches("handleManualUnwatch").catch(() => null);
  }

  if (ids.length === 1) {
    const only = results[0];
    if (only.error) return sendJson(res, { error: "Manual unwatch failed" }, 500);
    return sendJson(res, { ok: true, id: only.unwatchedId, status: only.status, queued: Boolean(only.queued), targetStates: only.targetStates });
  }
  return sendJson(res, { ok: true, succeeded, failed, queued, results });
}

export async function handleManualWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; manual watch-state changes are paused until it completes." }, 409);
  }

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
  const canonicalShowByTitle = new Map();

  for (const [index, rawRecord] of records.entries()) {
    try {
      let pending = {
        ...rawRecord,
        source: rawRecord.source || "manual",
        sync_action: "watched",
        sync_dispatch_telemetry: "Origin: manual\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
      };
      let normalized = normalizeWatchRecordForInsert(pending, "manual");

      // The detail page can know a show's TMDB id while older history rows
      // carry only its TVDB id. A manual episode inserted with just the TMDB
      // id then forms a second same-title identity cluster; once that cluster
      // contains several episodes, the conservative show grouper keeps it
      // separate and the larger legacy cluster hides the user's new watch.
      // Bridge the two known series identities on the authoritative manual
      // row. Existing ids from the request are never replaced.
      if (normalized.record.media_type === "episode") {
        const showTitle = showTitleFrom(normalized.record.title);
        if (showTitle) {
          let canonicalIdentity = canonicalShowByTitle.get(showTitle);
          if (canonicalIdentity === undefined) {
            const [canonicalShow, knownIdentity] = await Promise.all([
              queryShowDetail({ title: showTitle }).catch(() => null),
              getKnownShowIdentityForTitle(showTitle).catch(() => null),
            ]);
            canonicalIdentity = {
              imdb_id: knownIdentity?.imdb_id || canonicalShow?.imdb_id || null,
              tmdb_id: knownIdentity?.tmdb_id || canonicalShow?.tmdb_id || null,
              tvdb_id: knownIdentity?.tvdb_id || canonicalShow?.tvdb_id || null,
            };
            canonicalShowByTitle.set(showTitle, canonicalIdentity);
          }
          if (canonicalIdentity) {
            pending = {
              ...pending,
              imdb_id: normalized.record.imdb_id || canonicalIdentity.imdb_id || undefined,
              tmdb_id: normalized.record.tmdb_id || canonicalIdentity.tmdb_id || undefined,
              tvdb_id: normalized.record.tvdb_id || canonicalIdentity.tvdb_id || undefined,
            };
            normalized = normalizeWatchRecordForInsert(pending, "manual");
          }
        }
      }

      const { data, record } = normalized;
      const existing = await findExistingWatch(data.mediaKey || mediaKeyFor(record), data.watchedAt);
      const media = manualWatchMediaFromRecord({
        ...record,
        provider_items: rawRecord.provider_items || rawRecord.providerItems || {},
        provider_item_id: rawRecord.provider_item_id || rawRecord.providerItemId,
      });

      const exactExistingWatched = existing?.sync_action === "watched";
      const resyncOnly = rawRecord.resync_only === true;
      // A row sent from an unwatched episode's "Mark watched" button is an
      // explicit new canonical transition even when its chosen release date
      // matches an older watch. The show-detail resolver can know that a later
      // unwatch wins while legacy playstate/history aliases disagree about
      // which exact row is current, so trying to infer intent here caused the
      // click to be mistaken for a duplicate. Only records explicitly tagged
      // by the client as resync-only may reuse an existing history row.
      let id = "";
      let storedRecord = existing || record;
      let insertedTransition = false;
      if (exactExistingWatched && resyncOnly) {
        id = existing.id;
        skipped += 1;
      } else {
        // Clear any prior row (e.g. an unwatched placeholder) at this slot before inserting
        // but retain an older watched row for an explicit watched transition.
        // Its new sibling records the transition order while same-event
        // display dedupe keeps the history UI tidy.
        const replaceExisting = existing && !exactExistingWatched;
        if (replaceExisting) await deleteWatchRecordById(existing.id, { skipInvalidate: true }).catch(() => null);
        const insertResult = await insertWatchRecord(record, { skipInvalidate: true, id: replaceExisting ? existing.id : "", watchlistConfig: config });
        id = insertResult.id;
        storedRecord = insertResult.record;
        await insertResult.assetPrefetch?.catch(() => null);
        inserted += 1;
        insertedTransition = true;
      }

      // An explicit manual watch supersedes stale unwatched rows left under
      // any rematched provider-id alias. Resync-only records deliberately do
      // not rewrite history state.
      if (!resyncOnly) supersedeUnwatchedTransitionsForRecordSync({ ...storedRecord, id });

      media.watchRecordId = id;
      media.ids = {
        imdb: storedRecord.imdb_id || undefined,
        tmdb: storedRecord.tmdb_id || undefined,
        tvdb: storedRecord.tvdb_id || undefined,
      };
      await deletePlaybackProgress({
        ...media,
        media_key: rawRecord.media_key || rawRecord.mediaKey || data.mediaKey || undefined,
      }).catch(() => null);
      await upsertPlaystateForMedia(media, "watched", record.watched_at, { skipInvalidate: true });
      syncTasks.push({ media, id, record: { ...storedRecord, id } });

      results.push({ index, id, title: record.title, inserted: insertedTransition, status: "pending", targetStates: [] });
    } catch (error) {
      rejected += 1;
      results.push({ index, rejected: true, error: error.message || String(error) });
    }
  }

  await invalidateHistoryDerivedCaches("handleManualWatch").catch(() => null);

  // Awaited rather than backgrounded: the UI shows a "Syncing..." state and
  // only flips a row to watched once this response comes back, so the client
  // needs the real per-target outcome, not just "a watch record was queued".
  let propagated = 0;
  if (syncTasks.length > 0) {
    const trackingReservation = reserveDispatchBatch(syncTasks.length);
    try {
      await runWithConcurrency(syncTasks, async (task) => {
        try {
          const summary = await syncMediaPlaystate(task.media, config, loopStore, {
            trackDispatch: false,
            lane: records.length === 1 ? "interactive" : "sync",
          }).catch((error) => ({
            skipped: false,
            status: "error",
            details: `Manual watch propagation failed: ${error.message || String(error)}`,
            targetStates: [],
          }));
          if (summary.status === "success" || summary.status === "partial") propagated += 1;

          // Remote watched-state APIs can synchronously echo a temporary
          // unwatch while replacing their existing play (Trakt in
          // particular removes the old history entry before adding the new
          // one).  That echo is newer than the row inserted above and used
          // to win the next /api/show canonical-state read, so the UI said
          // success and immediately rendered "Mark watched" again.  Reassert
          // the explicit Plembfin decision only after every remote call has
          // settled: Plembfin is the authority, and transport side effects
          // must never overrule the user's click.
          const authoritativeRecord = reassertWatchRecordAuthoritySync(task.id) || task.record;
          supersedeUnwatchedTransitionsForRecordSync(authoritativeRecord);
          await upsertPlaystateForMedia(task.media, "watched", task.record.watched_at, { skipInvalidate: true });

          await updateWatchTelemetry(task.id, formatDispatchTelemetry(summary, task.media, "watched"), { skipInvalidate: true });
          await recordSyncHistory(task.media, summary, "watched");
        } catch (error) {
          console.error("Manual watch sync failed:", error);
        } finally {
          completeDispatchTracking(trackingReservation);
        }
      }, MANUAL_SYNC_ITEM_CONCURRENCY);
    } finally {
      finishDispatchTracking(trackingReservation);
    }
    await invalidateHistoryDerivedCaches("handleManualWatch").catch(() => null);
  }

  return sendJson(res, { ok: true, inserted, skipped, rejected, propagated, syncQueued: syncTasks.length, results });
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

      // Playback-progress rows can be title-only episode identities. They do
      // not have the watched-row artwork enrichment used by the History API,
      // so resolve the parent show poster here as well. Keep poster_url tied
      // to the episode/progress row; the dashboard consumes show_poster_url
      // for this card so episode artwork remains independent elsewhere.
      if (row.media_type === "episode") {
        const showTitle = row.show_title || showTitleFrom(row.title);
        const knownIdentity = showTitle
          ? await getKnownShowIdentityForTitle(showTitle).catch(() => ({}))
          : {};
        const showIdentity = {
          media_type: "tv",
          title: showTitle,
          tmdb_id: row.show_tmdb_id || knownIdentity.tmdb_id || "",
          tvdb_id: row.show_tvdb_id || knownIdentity.tvdb_id || "",
          imdb_id: row.show_imdb_id || knownIdentity.imdb_id || "",
        };
        const showPosterUrl = getCanonicalPosterUrl(showIdentity);
        return {
          ...row,
          poster_url: posterUrl,
          show_title: showTitle || row.show_title || null,
          show_poster_url: showPosterUrl || null,
          show_tmdb_id: showIdentity.tmdb_id || null,
          show_tvdb_id: showIdentity.tvdb_id || null,
          show_imdb_id: showIdentity.imdb_id || null,
        };
      }

      return { ...row, poster_url: posterUrl };
    }));

    return sendJson(res, { progress: decoratedRows, total });
  } catch (error) {
    console.error("Failed to list playback progress", error);
    return sendJson(res, { error: "Failed to list playback progress" }, 500);
  }
}

export async function handlePlaybackProgressWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; manual watch-state changes are paused until it completes." }, 409);
  }

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
    const exactExistingWatched = existing?.sync_action === "watched";
    let id = "";
    if (exactExistingWatched) {
      id = existing.id;
    } else {
      if (existing) await deleteWatchRecordById(existing.id, { skipInvalidate: true }).catch(() => null);
      const insertResult = await insertWatchRecord(normalizedRecord, { skipInvalidate: true, id: existing?.id || "", watchlistConfig: config });
      id = insertResult.id;
      await insertResult.assetPrefetch?.catch(() => null);
      media.ids = {
        imdb: insertResult.record.imdb_id || undefined,
        tmdb: insertResult.record.tmdb_id || undefined,
        tvdb: insertResult.record.tvdb_id || undefined,
      };
    }

    media.watchRecordId = id;
    await upsertPlaystateForMedia(media, "watched", record.watched_at, { skipInvalidate: true });

    await deletePlaybackProgress({ ...progressRow, media_key: mediaKey }).catch(() => null);
    await deletePlaybackProgress(media).catch(() => null);

    (async () => {
      try {
        const summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" }).catch((error) => ({
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
        await invalidateHistoryDerivedCaches("handlePlaybackProgressWatch").catch(() => null);
      }
    })().catch((error) => console.error("Background sync loop crashed:", error));

    await invalidateHistoryDerivedCaches("handlePlaybackProgressWatch").catch(() => null);
    return sendJson(res, { ok: true, id });
  } catch (error) {
    console.error("Mark watch from progress failed", error);
    return sendJson(res, { error: "Mark watch from progress failed" }, 500);
  }
}

function requestProviderItems(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === "object" ? value : {};
}

function mediaFromProgressRequest(progressRow, body = {}, mediaKey = "") {
  const mediaType = String(body.media_type || body.mediaType || progressRow?.media_type || "").toLowerCase() === "movie"
    ? "movie"
    : "episode";
  const title = String(body.title || progressRow?.title || body.show_title || body.showTitle || "").trim();
  const seasonValue = body.season ?? progressRow?.season;
  const episodeValue = body.episode ?? progressRow?.episode;
  return {
    title,
    showTitle: String(body.show_title || body.showTitle || progressRow?.show_title || "").trim() || undefined,
    type: mediaType,
    source: "manual",
    media_key: mediaKey || progressRow?.media_key || undefined,
    ids: {
      imdb: body.imdb_id || body.imdbId || body.imdb || progressRow?.imdb_id || undefined,
      tmdb: body.tmdb_id || body.tmdbId || body.tmdb || progressRow?.tmdb_id || undefined,
      tvdb: body.tvdb_id || body.tvdbId || body.tvdb || progressRow?.tvdb_id || undefined,
    },
    season: seasonValue == null || seasonValue === "" ? undefined : Number(seasonValue),
    episode: episodeValue == null || episodeValue === "" ? undefined : Number(episodeValue),
    providerItems: requestProviderItems(body.provider_items || body.providerItems),
    providerItemId: body.provider_item_id || body.providerItemId || undefined,
    positionMs: 0,
    offsetMs: 0,
    progress: 0,
    isValid: Boolean(title && ["movie", "episode"].includes(mediaType)),
  };
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
    const media = mediaFromProgressRequest(progressRow, body, mediaKey);
    if (!media.isValid) return sendJson(res, { error: "A valid media item is required" }, 400);

    const config = await loadMediaConfig();
    const loopStore = createLoopStore();

    const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, "", { includeSourcePlatform: true, force: true, lane: "interactive" });
    return sendJson(res, {
      ok: true,
      id: unwatchedId,
      clearedResume: true,
      status: summary.status,
      queued: Boolean(summary.deferred),
      targetStates: summary.targetStates || [],
    });
  } catch (error) {
    console.error("Playback progress unwatch failed", error);
    return sendJson(res, { error: "Playback progress unwatch failed" }, 500);
  } finally {
    await invalidateHistoryDerivedCaches("handlePlaybackProgressUnwatch").catch(() => null);
  }
}

function directUpNextProviderIds(body = {}, provider) {
  const raw = body.provider_items?.[provider] ?? body.providerItems?.[provider];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function resolveUpNextProviderIds(provider, config, media, body) {
  const direct = directUpNextProviderIds(body, provider);
  if (direct.length) return direct;
  if (provider === "plex") {
    const item = await findPlexItem(config.plex, media);
    return item?.ratingKey ? [String(item.ratingKey)] : [];
  }
  if (provider === "emby") {
    const items = await findEmbyItems(config.emby, media);
    return [...new Set((items || []).map((item) => String(item?.Id || "").trim()).filter(Boolean))];
  }
  const items = await findJellyfinItems(config.jellyfin, media);
  return [...new Set((items || []).map((item) => String(item?.Id || "").trim()).filter(Boolean))];
}

async function hideUpNextAcrossProviders(config, media, body) {
  const definitions = [
    { provider: "plex", configured: Boolean(config.plex?.baseUrl && config.plex?.token), hide: (id) => hidePlexFromContinueWatching(config.plex, id) },
    { provider: "emby", configured: Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId), hide: (id) => hideEmbyFromResume(config.emby, id) },
    { provider: "jellyfin", configured: Boolean(config.jellyfin?.baseUrl && (config.jellyfin?.apiKey || config.jellyfin?.token) && config.jellyfin?.userId), hide: (id) => hideJellyfinFromResume(config.jellyfin, id) },
  ].filter((entry) => entry.configured);

  return Promise.all(definitions.map(async ({ provider, hide }) => {
    try {
      const ids = await resolveUpNextProviderIds(provider, config, media, body);
      if (!ids.length) return { target: provider, status: "not_found", details: "No matching provider item was found" };
      const results = await Promise.allSettled(ids.map((id) => hide(id)));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) return { target: provider, status: "failed", details: failed.reason?.message || "Provider removal failed" };
      return { target: provider, status: "fulfilled", details: `Removed from ${provider === "plex" ? "Continue Watching" : "Resume"}` };
    } catch (error) {
      return { target: provider, status: "failed", details: error?.message || "Provider removal failed" };
    }
  }));
}

// Up Next removal combines Plembfin's canonical progress clear with each
// connected server's native Continue Watching / Resume dismissal.
export async function handleUpNextRemove(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const mediaKey = String(body.media_key || body.id || "").trim();
  try {
    const config = await loadMediaConfig();
    const progressRow = mediaKey ? db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey) : null;
    const media = mediaFromProgressRequest(progressRow, body, mediaKey);
    if (!media.isValid) return sendJson(res, { error: "A valid media item is required" }, 400);
    const loopStore = createLoopStore();
    const providerDismissals = await hideUpNextAcrossProviders(config, media, body);
    const { id: unwatchedId, summary } = await applyManualUnwatch(
      media,
      config,
      loopStore,
      "",
      { includeSourcePlatform: true, force: true, lane: "interactive" },
    );

    return sendJson(res, {
      ok: true,
      id: unwatchedId,
      clearedResume: true,
      status: summary.status,
      queued: Boolean(summary.deferred),
      targetStates: summary.targetStates || [],
      providerDismissals,
    });
  } catch (error) {
    console.error("Up Next clear failed", error);
    return sendJson(res, { error: "Up Next clear failed" }, 500);
  } finally {
    await invalidateHistoryDerivedCaches("handleUpNextRemove").catch(() => null);
  }
}

// Reconcile the current visible Plembfin Up Next snapshot with the native
// provider feeds. The browser sends only the cards it is currently showing;
// that matters because local Up Next dismissals are intentionally kept in the
// browser until the provider confirms the removal.
export async function handleUpNextSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  if (!Array.isArray(body.items)) return sendJson(res, { error: "Up Next items are required" }, 400);

  try {
    const config = await loadMediaConfig();
    const summary = await syncUpNextToProviders({
      desiredItems: body.items.slice(0, 100),
      config,
    });
    return sendJson(res, summary);
  } catch (error) {
    console.error("Up Next provider sync failed", error);
    return sendJson(res, { error: "Up Next provider sync failed" }, 500);
  } finally {
    await invalidateHistoryDerivedCaches("handleUpNextSync").catch(() => null);
  }
}

export async function handleRetrySync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; retry sync is paused until it completes." }, 409);
  }

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
      summary = await syncMediaUnplayedPlaystate(media, config, loopStore, { lane: "interactive" });
    } else {
      summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" });
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

// If nobody has requested Now Playing in a while, the underlying poller may be sitting
// on its slow idle interval (or waiting out a normal active-interval wait) with data
// that's a beat stale. Poking it here means the first request after a page opens - or a
// backgrounded tab becomes visible again - kicks off a fresh poll immediately instead of
// waiting for the poller's own timer; the response below still serves current cache data
// right away, so this never adds latency to the request itself.
let lastNowPlayingViewerAt = 0;
const NOW_PLAYING_VIEWER_GAP_MS = 20_000;

export async function handleNowPlaying(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const now = Date.now();
  if (now - lastNowPlayingViewerAt > NOW_PLAYING_VIEWER_GAP_MS) {
    pokeLiveSessionPoller();
  }
  lastNowPlayingViewerAt = now;

  const [cacheRows, activeRows, runtime] = await Promise.all([
    loadLiveTrackingCache({ includeCompleted: false }).catch(() => []),
    listActiveSessions().catch(() => []),
    loadRuntimeState(),
  ]);

  const withMediaKey = (session = {}) => {
    const mediaKey = session.media_key || session.mediaKey || mediaKeyFor(session);
    return { ...session, media_key: mediaKey, mediaKey };
  };

  const sessions = cacheRows
    .map(hydrateCachedSession)
    .filter((session) => !session.completedAt && !isTerminalLiveSession(session))
    .map(withMediaKey);
  const merged = [...sessions];
  for (const active of activeRows) {
    if (isTerminalLiveSession(active)) continue;
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
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; scheduled sync is paused until it completes." }, 409);
  }

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
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; Force Sync is paused until it completes." }, 409);
  }

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
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; Force Sync planning is paused until it completes." }, 409);
  }
  if (!workerAvailable()) return sendJson(res, { ok: false, error: "No background worker is available." }, 503);
  const body = await readJson(req).catch(() => ({}));
  try {
    const job = enqueueBackgroundJob("force_sync_plan", { scope: body.scope || {} });
    return sendJson(res, { ok: true, jobId: job.id, status: job.status, message: "Force Sync preview queued." }, 202);
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return sendJson(res, { ok: false, error: error.message }, 409);
    console.error("Force Sync preview enqueue failed", error);
    return sendJson(res, { ok: false, error: "Force Sync preview failed" }, 500);
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
    console.error("Force sync stop failed", error);
    return sendJson(res, { ok: false, error: "Force sync stop failed" }, 500);
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
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, {
      ok: true,
      inserted: false,
      skipped: true,
      reason: "Authoritative watch-history restore is active; inbound watch events are paused until it completes.",
    }, 202);
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

  const embyLikeUserDataState = (
    ["emby", "jellyfin"].includes(String(media.source || "").toLowerCase())
    && ["ended", "unplayed"].includes(media.phase)
    && media.playedFlagOnly === true
  );
  if (
    embyLikeUserDataState
  ) {
    // An outbound progress acknowledgement can arrive after a completed
    // webhook has already made the item watched. Suppress that known echo
    // before consulting the newer canonical state, or the stale Played=false
    // payload would be reinterpreted as a fresh watched -> unwatched action.
    const ownProgressEcho = await isRecentOutboundProgressEcho(media, media.source, loopStore).catch(() => false);
    if (ownProgressEcho) {
      console.log("Webhook: skipped callback caused by outbound resume update", {
        source: media.source,
        title: media.title,
        event: media.event,
        phase: media.phase,
      });
      await deleteActiveSession(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, {
        ok: true,
        inserted: false,
        skipped: true,
        reason: "Callback followed Plembfin outbound resume update",
      });
    }
  }

  if (embyLikeUserDataState && media.phase === "ended") {
    const currentPlaystate = await getPlaystateForMedia(media).catch(() => null);
    media.phase = resumeWebhookPhaseForPlaystate(media, currentPlaystate);
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
    const isMovie = media.type === "movie";
    const isEpisode = media.type === "episode";
    // Season notifications often carry a season-level id and a label such as
    // "Season 1", neither of which is a safe show identity. Episode/series
    // notifications and movies have enough context; the scheduler/provider
    // backstop will discover a season-only event later.
    if (isMovie || isEpisode || media.type === "series") {
      try {
        queueTmdbMetadataWarmup([{
          mediaType: isMovie ? "movie" : "tv",
          // Episode notifications can carry an episode-level TMDB id. Let the
          // TVDB/show identity resolve the parent series instead of trusting that
          // leaf id as a series cache key.
          tmdbId: isMovie ? media.ids?.tmdb || "" : media.type === "series" ? media.ids?.tmdb || "" : "",
          title: isEpisode ? showTitleFrom(media.title) : media.title,
          ids: {
            imdbId: media.ids?.imdb || "",
            tvdbId: media.ids?.tvdb || "",
          },
          verifyTvdbTitle: !isMovie,
        }], { reason: "library-added-webhook" });
      } catch (error) {
        // Metadata is an enrichment side effect. Do not reject a valid library
        // webhook or skip its watched-state handling when the cache is busy.
        console.warn(`Library-added metadata warm-up queue failed: ${error?.message || error}`);
      }
    }
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
      return sendJson(res, { error: `Failed to fetch episodes for ${media.type}` }, 500);
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
            playedFlagOnly: Boolean(media.playedFlagOnly),
            releaseDate: media.playedFlagOnly ? releaseDateForItem(ep) : "",
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
            // getPlaystateForMedia can still miss an already-recorded watch
            // stored under a media_key from a different source - see the
            // matching comment on the main webhook handler above.
            const existingByAnyKey = await findWatchedByAnyMediaKey(episodeMedia).catch(() => null);
            if (existingByAnyKey) {
              await upsertPlaystateForMedia(episodeMedia, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Already recorded under a different media key" });
              return;
            }
            if (await shouldSkipPostRestoreCompletedWebhook(episodeMedia)) {
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Post-restore completed webhook without active playback evidence" });
              return;
            }
            const watchRecord = mediaToWatchRecord(episodeMedia, episodeMedia.source);
            watchRecord.sync_action = "watched";
            watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, episodeMedia, "watched");
            const dbResult = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
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

    await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);

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
      const [existingPlaystate, existingProgress] = await Promise.all([
        getPlaystateForMedia(media).catch(() => null),
        getPlaybackProgressForMedia(media).catch(() => null),
      ]);
      const incomingUpdatedAt = resumeProgressEventTimestamp(media, Date.now());
      const progressUpdatedAt = resumeProgressAuthorityTimestamp(existingProgress, {
        ...media,
        updatedAt: incomingUpdatedAt,
      });
      const playstateBlockReason = resumeProgressBlockedByPlaystate(existingPlaystate, progressUpdatedAt);
      const unchangedWithoutTimestamp = Boolean(
        existingProgress
        && incomingUpdatedAt <= 0
        && resumePositionUnchanged(existingProgress, media),
      );
      const staleDatedCandidate = Boolean(
        existingProgress
        && incomingUpdatedAt > 0
        && Number(existingProgress.updated_at || 0) >= incomingUpdatedAt,
      );
      const missingAuthority = incomingUpdatedAt <= 0;

      if (playstateBlockReason) {
        if (playstateBlocksStoredResumeProgress(existingPlaystate, existingProgress)) {
          await deletePlaybackProgress(media).catch(() => null);
        }
        progressSummary = {
          skipped: true,
          status: "skipped",
          details: `Resume progress ignored because ${playstateBlockReason}`,
          targetStates: [],
        };
      } else if (unchangedWithoutTimestamp || staleDatedCandidate || missingAuthority) {
        progressSummary = {
          skipped: true,
          status: "skipped",
          details: unchangedWithoutTimestamp
            ? "Resume progress acknowledgement was unchanged and had no source timestamp"
            : staleDatedCandidate
              ? "Resume progress acknowledgement was older than Plembfin's stored position"
              : "Resume progress callback had no authoritative source timestamp",
          targetStates: [],
        };
      } else {
        // Use one authority timestamp for persistence and every outbound write.
        // Direct stop events without a source date use their receipt time;
        // delayed generic UserData callbacks never receive fresh authority.
        media.updatedAt = progressUpdatedAt;
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
      await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);
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
    if (["plex", "emby", "jellyfin"].includes(String(media.source || "").toLowerCase())) {
      const source = String(media.source || "").toLowerCase();
      // Plex reports Plembfin's own mark-played API call as a completed
      // scrobble rather than a flag-only event. Detect that persisted outbound
      // marker before inserting history; the downstream loop detector is too
      // late because the deleted provider date has already been recreated by
      // then. Emby/Jellyfin retain the stricter flag-only check so genuine
      // completed playback remains a rewatch.
      const echoCheck = source === "plex" ? isRecentOutboundPlayedEcho : isRecentOutboundPlayedFlagEcho;
      const ownPlayedEcho = await echoCheck(media, media.source, loopStore).catch(() => false);
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

    // A played-flag event says that the source's watched bit changed, not that
    // playback crossed the configured threshold. Servers commonly update
    // LastPlayedDate to the moment of a manual "Mark watched" click, so that
    // value must not become the historical watch date. Use the real release
    // day for flag-only events; never fall through to mediaToWatchRecord's
    // current-time default when the source has no release date.
    if (media.playedFlagOnly) {
      if (!media.releaseDate) {
        console.log("Webhook: skipped manual played flag without a release date", {
          source: media.source,
          title: media.title,
          event: media.event,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          skipped: true,
          reason: "Manual played flag had no release date to use as its historical watch date",
        });
      }
      media.watched_at = media.releaseDate;
      const existingProvenance = media.watchProvenance || media.watch_provenance || {};
      media.watchProvenance = buildWatchProvenance(
        { ...media, playedAt: "" },
        {
          ingestPath: existingProvenance.ingest_path || `${media.source || "source"}_webhook`,
          sourceTimestamp: "",
          note: existingProvenance.note || "The source reported a manual played flag without playback evidence; the release date was used as the watch date.",
        },
      );

      if (isDeletedWatchSuppressed(media, media.watched_at)) {
        console.log("Webhook: skipped a provider watch date explicitly deleted in Plembfin", {
          source: media.source,
          title: media.title,
          event: media.event,
          itemId: media.itemId,
          watchedAt: media.watched_at,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          skipped: true,
          reason: "Provider watch date was explicitly deleted in Plembfin",
        });
      }

      // A viewstate/played-flag notification contains no playback evidence.
      // If Plembfin already has any watched history for this real item, the
      // notification is only acknowledging a played bit (often our own
      // canonical replay after the user deleted a newer provider date). The
      // ordinary recent-record check below intentionally looks at a one-hour
      // watch window and therefore cannot catch an older retained watch date.
      // Use the full identity-aware history lookup before persistence so the
      // removed provider date cannot be recreated from its release date.
      const existingWatchedHistory = await findWatchedByAnyMediaKey(media).catch(() => null);
      if (existingWatchedHistory) {
        console.log("Webhook: skipped played flag for an item already present in watched history", {
          source: media.source,
          title: media.title,
          event: media.event,
          existingWatchId: existingWatchedHistory.id,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          id: existingWatchedHistory.id,
          reason: "Played flag event for an item already present in watched history",
        });
      }
    }

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

    let isRewatchOnNewDay = false;
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
      isRewatchOnNewDay = true;
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

    // getWatchRecordByMediaKey and getPlaystateForMedia above both key off
    // this notification's own computed media_key/playstate lookup, which can
    // still miss an already-recorded watch stored under a different key from
    // another source (e.g. one keyed by imdb, another by title fallback) -
    // the exact mismatch behind the Silo/Trying/Cape Fear phantom watches.
    // findWatchedByAnyMediaKey has the broader coordinate/provider-id
    // fallback matching every other ingest path relies on for this; treat a
    // hit there as conclusive too instead of only trusting the exact checks.
    // Skip this when the block above already approved a rewatch on a new day:
    // findWatchedByAnyMediaKey's first candidate is this notification's own
    // media_key, so it re-finds the very record that "watched on <old day>"
    // was compared against, and would otherwise repair playstate back to that
    // stale date instead of recording tonight's real rewatch.
    const existingByAnyKey = isRewatchOnNewDay ? null : await findWatchedByAnyMediaKey(media).catch(() => null);
    if (existingByAnyKey) {
      console.log("Webhook: already recorded under a different key; repairing playstate instead of logging a new watch", {
        source: media.source,
        title: media.title,
        existingWatchedAt: existingByAnyKey.watched_at,
      });
      await upsertPlaystateForMedia(media, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
      await deletePlaybackProgress(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, { ok: true, inserted: false, id: existingByAnyKey.id, reason: "Watch record already exists under a different media key" });
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
    const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
    // Resolve a movie's provider ids before its first outbound dispatch. The
    // prefetch still runs in the background for episodes and for callers that
    // do not need the result synchronously, but a movie with no identity must
    // give Trakt the same complete metadata that is persisted on the row.
    if (media.type === "movie") await result.assetPrefetch?.catch(() => null);
    media.watchRecordId = result.id;
    media.ids = {
      imdb: result.record.imdb_id || undefined,
      tmdb: result.record.tmdb_id || undefined,
      tvdb: result.record.tvdb_id || undefined,
    };
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
    await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);
    return sendJson(res, { ok: true, inserted: true, id: result.id, record: result.record });
  } catch (error) {
    console.error("Webhook insert failed", error);
    await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);
    return sendJson(res, { error: "Webhook insert failed" }, 500);
  }
}
