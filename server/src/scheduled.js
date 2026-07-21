import { fetchWithTimeout } from "./utils/outbound.js";
import { watchedThresholdPercent } from "./utils/tuning.js";
import { shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { parsePlexGuids } from "./utils/parsers.js";
import { findPlexItem, plexAuthHeaders, resolvePlexAccountId } from "./utils/plexClient.js";
import { buildCacheRow, fetchLiveSessions, hydrateCachedSession } from "./utils/liveSessions.js";
import { appendSyncHistory, loadMediaConfig, loadRuntimeState, setRuntimeState } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { isCronSyncPaused, loadWatchBackupRuntime } from "./utils/watchHistoryBackups.js";
import { executeForceSyncPlan } from "./utils/forceSyncExecutor.js";
export { executeForceSyncPlan } from "./utils/forceSyncExecutor.js";
import {
  deleteLiveTrackingCacheRows,
  deletePlaybackProgress,
  deleteWatchRecordById,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  findWatchedByMediaKey,
  getCachedHistory,
  getPlaybackProgressForMedia,
  getPlaystateForMedia,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  listRecentTrackedWatchRows,
  loadLiveTrackingCache,
  markLiveTrackingComplete,
  mediaKeyFor,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  purgeCompletedLiveTrackingCache,
  requireDb,
  updatePlaybackProgressTelemetry,
  updateWatchSyncRetry,
  updateWatchTelemetry,
  upsertLiveTrackingCache,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
} from "./utils/dataRepo.js";

const SCHEDULED_RECENT_WATCH_LIMIT = 50;
const SCHEDULED_RESUME_LIMIT = 50;

function scheduledMediaInScope(config, media) {
  const scope = config?.syncScope || {};
  if (Array.isArray(scope.servers) && scope.servers.length && !scope.servers.includes(String(media.source || "").replace(/_initial_sync$/, ""))) return false;
  if (Array.isArray(scope.mediaTypes) && scope.mediaTypes.length && !scope.mediaTypes.includes(media.type)) return false;
  const watchedAt = new Date(media.watched_at || media.timestamp || 0).getTime();
  if (scope.watchedAfter && (!watchedAt || watchedAt < new Date(scope.watchedAfter).getTime())) return false;
  if (scope.watchedBefore && (!watchedAt || watchedAt > new Date(scope.watchedBefore).getTime())) return false;
  return true;
}

// Fallback cadence for the legacy Plex unwatch poll. Primary detection is the realtime
// notification listener; this poll only backstops events missed while the socket was down.
const PLEX_UNWATCHED_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastPlexUnwatchedPollAt = 0;

// Cadence for background catch-up library syncs (recently watched & continue watching lists).
// These serve as backstops for events missed by webhooks/live session tracking, so they
// do not need to run on every 1-minute tick.
const CATCHUP_SYNC_INTERVAL_MS = Number(process.env.CATCHUP_SYNC_INTERVAL_MS || process.env.CATCHUP_SYNC_INTERVAL || 15 * 60 * 1000);
let lastCatchupSyncAt = 0;

// Automatic re-dispatch backoff for records whose sync targets keep failing.
// Attempt N waits SYNC_RETRY_BACKOFF_MS[N-1] (last entry repeats) before the
// next try; after SYNC_RETRY_MAX_ATTEMPTS the record is left alone until the
// user triggers Retry Sync, which resets the counters. Without this, a single
// offline target would be re-dispatched every minute forever.
const SYNC_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const SYNC_RETRY_MAX_ATTEMPTS = 10;

export function syncRetryDelayMs(retryCount) {
  const index = Math.min(Math.max(Number(retryCount) || 1, 1), SYNC_RETRY_BACKOFF_MS.length) - 1;
  return SYNC_RETRY_BACKOFF_MS[index];
}

export function syncRetryEligible(row = {}, now = Date.now()) {
  if (Number(row.sync_retry_count || 0) >= SYNC_RETRY_MAX_ATTEMPTS) return false;
  return Number(row.sync_next_retry_at || 0) <= now;
}

function buildTelemetry(media, summary) {
  const targetStates = summary?.targetStates || [];
  return [
    `Origin: ${media.source}`,
    `Loop-check: ${summary?.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary?.status || "unknown"}`,
    `Details: ${summary?.details || "No dispatch details returned"}`,
    ...targetStates.map((targetState) => `Target ${targetState.target} status: ${targetState.status}${targetState.detail ? ` - ${targetState.detail}` : ""}`),
  ].join("\n");
}

function buildProgressTelemetry(media, summary) {
  const targetStates = summary?.targetStates || [];
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  return [
    `Origin: ${media.source}`,
    `Resume position: ${Math.round(positionMs / 1000)}s`,
    `Progress: ${Number(media.progress || 0).toFixed(1)}%`,
    `Loop-check: ${summary?.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary?.status || "unknown"}`,
    `Details: ${summary?.details || "No dispatch details returned"}`,
    ...targetStates.map((targetState) => `Target ${targetState.target} progress status: ${targetState.status}${targetState.detail ? ` - ${targetState.detail}` : ""}`),
  ].join("\n");
}

function cachedRowToMedia(row) {
  const session = hydrateCachedSession(row);
  return {
    ...session,
    type: session.mediaType,
    source: session.source || row.source_platform,
    isValid: Boolean(session.title && (session.mediaType === "movie" || session.mediaType === "episode") && session.source),
  };
}

function dateOnlyIso(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
}

function isoDateTime(value = "") {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function embyLikePlayedDate(item = {}) {
  return isoDateTime(
    item.UserData?.LastPlayedDate ||
      item.UserData?.PlayedDate ||
      item.UserData?.DatePlayed ||
      item.LastPlayedDate ||
      item.PlayedDate ||
      item.DatePlayed ||
      item.LastWatchedDate,
  );
}

function isEmbyLikePlayed(item = {}) {
  const value = item.UserData?.Played ?? item.UserData?.IsPlayed ?? item.Played ?? item.IsPlayed;
  return value === true || value === "true" || value === 1 || value === "1";
}

function watchedAtForEmbyLikeItem(item = {}, fallbackTimestamp = Date.now()) {
  const playedAt = embyLikePlayedDate(item);
  if (playedAt) return { watchedAt: playedAt, reason: "played" };

  if (isEmbyLikePlayed(item)) {
    return { watchedAt: new Date(fallbackTimestamp).toISOString(), reason: "poll time" };
  }

  return { watchedAt: "", reason: "" };
}

function releaseDateForItem(item = {}) {
  return dateOnlyIso(
    item.PremiereDate ||
      item.OriginalReleaseDate ||
      item.originallyAvailableAt ||
      (item.ProductionYear ? `${item.ProductionYear}-01-01T00:00:00.000Z` : ""),
  );
}

function releaseDateForPlexItem(item = {}) {
  return dateOnlyIso(
    item.originallyAvailableAt ||
      item.OriginallyAvailableAt ||
      (item.year ? `${item.year}-01-01T00:00:00.000Z` : ""),
  );
}

function ticksToMilliseconds(value) {
  const ticks = Number(value || 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

function millisecondsFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function epochMsFromSeconds(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) : 0;
}

function timestampMsFromDate(value = "") {
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function progressPercent(positionMs = 0, durationMs = 0) {
  if (!durationMs) return 0;
  return Math.max(0, Math.min(100, (Number(positionMs || 0) / Number(durationMs || 1)) * 100));
}

function resumePositionUnchanged(existingProgress = {}, media = {}) {
  const existingPosition = Number(existingProgress.position_ms || 0);
  const incomingPosition = Number(media.positionMs ?? media.offsetMs ?? 0);
  const existingDuration = Number(existingProgress.duration_ms || 0);
  const incomingDuration = Number(media.durationMs || 0);
  const existingPercent = Number(existingProgress.progress || 0);
  const incomingPercent = Number(media.progress || 0);

  return (
    Math.abs(existingPosition - incomingPosition) <= 2000 &&
    (!existingDuration || !incomingDuration || Math.abs(existingDuration - incomingDuration) <= 2000) &&
    Math.abs(existingPercent - incomingPercent) <= 0.25
  );
}

export function mediaFromPlexResumableItem(item = {}) {
  const type = item.type === "episode" ? "episode" : "movie";
  const positionMs = millisecondsFrom(item.viewOffset);
  const durationMs = millisecondsFrom(item.duration);
  const season = item.parentIndex != null ? Number(item.parentIndex) : null;
  const episode = item.index != null ? Number(item.index) : null;
  return {
    title: type === "episode"
      ? `${item.grandparentTitle || item.title || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.title || "Unknown Movie",
    type,
    source: "plex",
    season,
    episode,
    ids: parsePlexGuids(item),
    episodeTitle: type === "episode" ? item.title : null,
    positionMs,
    offsetMs: positionMs,
    durationMs,
    progress: progressPercent(positionMs, durationMs),
    updatedAt: epochMsFromSeconds(item.lastViewedAt || item.viewedAt || item.updatedAt),
    isValid: true,
  };
}

function embyLikeResumeUpdatedAt(item = {}) {
  return timestampMsFromDate(
    item.UserData?.LastPlayedDate ||
      item.UserData?.PlayedDate ||
      item.UserData?.DatePlayed ||
      item.LastPlayedDate ||
      item.PlayedDate ||
      item.DatePlayed ||
      item.DateLastSaved ||
      item.DateCreated,
  );
}

export function mediaFromEmbyLikeResumableItem(item = {}, source = "emby", normalizeProviderIds = (ids) => ids || {}) {
  // Episode provider IDs are often episode-scoped. Cross-server lookup first
  // resolves the series and then selects SxxExx, so retain the series IDs too.
  const ids = normalizeProviderIds(
    item.Type === "Episode"
      ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
      : (item.ProviderIds || {}),
  );
  const type = item.Type === "Episode" ? "episode" : "movie";
  const season = item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null;
  const episode = item.IndexNumber != null ? Number(item.IndexNumber) : null;
  const positionMs = ticksToMilliseconds(item.UserData?.PlaybackPositionTicks || item.PlaybackPositionTicks || item.PositionTicks);
  const durationMs = ticksToMilliseconds(item.RunTimeTicks || item.DurationTicks);
  return {
    title: type === "episode"
      ? `${item.SeriesName || item.ParentName || item.Name || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.Name || item.Title || "Unknown Movie",
    type,
    source,
    season,
    episode,
    ids: {
      imdb: ids.imdb || undefined,
      tmdb: ids.tmdb || undefined,
      tvdb: ids.tvdb || undefined,
    },
    episodeTitle: type === "episode" ? item.Name : null,
    positionMs,
    offsetMs: positionMs,
    durationMs,
    progress: progressPercent(positionMs, durationMs),
    updatedAt: embyLikeResumeUpdatedAt(item),
    isValid: true,
  };
}

function normalizePlexIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function configuredPlexUsername(config = {}) {
  return normalizePlexIdentity(config.plex?.username);
}

function plexAccountIdFromItem(item = {}) {
  const value = item.accountID ?? item.accountId ?? item.account_id ?? item.userID ?? item.userId;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function plexUsernamesFromItem(item = {}) {
  const user = item.User || item.user || {};
  const account = item.Account || item.account || {};
  return [
    item.username,
    item.user,
    item.userName,
    item.account,
    item.accountName,
    item.accountTitle,
    user.title,
    user.name,
    account.title,
    account.name,
  ]
    .map(normalizePlexIdentity)
    .filter(Boolean);
}

// Delegates to the memoized resolver in plexClient.js so the per-minute
// scheduled sync and playstate operations share one cached /accounts lookup.
async function resolvePlexTargetAccountId(baseUrl, token, username, logger = console.log) {
  try {
    return await resolvePlexAccountId({ baseUrl, token, username });
  } catch (error) {
    logger(`Plex account mapping failed: ${error.message}`);
    return null;
  }
}

function plexHistoryItemMatchesConfiguredUser(item = {}, { username = "", accountId = null } = {}) {
  if (!username) return true;

  const itemAccountId = plexAccountIdFromItem(item);
  if (itemAccountId != null && accountId != null) {
    return itemAccountId === accountId;
  }

  const itemUsernames = plexUsernamesFromItem(item);
  if (itemUsernames.length) {
    return itemUsernames.includes(username);
  }

  return false;
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
      sessionId: media.sessionId || media.id || "",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
    },
  }).catch((error) => console.error("Failed to append scheduled sync history", error));
}

async function checkPlexUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.plex?.baseUrl || !config.plex?.token) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const records = (await listRecentTrackedWatchRows({ limit: 100 })).filter(
    (record) =>
      record.watched_at < threeMinutesAgo &&
      // Source originated on Plex, OR a previous sync successfully marked Plex watched.
      // Telemetry is written in two formats ("Target plex status: success" by the cron,
      // "Plex status: success" by the webhook path), so match case-insensitively on the
      // common "plex status: success" suffix rather than a single exact string.
      (["plex", "plex_initial_sync"].includes(record.source) ||
        String(record.sync_dispatch_telemetry || "").toLowerCase().includes("plex status: success")),
  ).slice(0, 30);

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
      };

      const plexItem = await findPlexItem(config.plex, media);
      if (plexItem) {
        const isWatched = Boolean(plexItem.viewCount && Number(plexItem.viewCount) > 0);
        if (!isWatched) {
          console.log("Cron detected Plex item marked unwatched: deleting watch history and syncing", { title: record.title });
          await deleteWatchRecordById(record.id, { skipInvalidate: true });
          const unplayedMedia = { ...media, isValid: true, source: "plex" };
          const unplayedRecord = mediaToWatchRecord({ ...unplayedMedia, syncAction: "unwatched" }, "plex");
          unplayedRecord.sync_action = "unwatched";
          unplayedRecord.sync_dispatch_telemetry = buildTelemetry(unplayedMedia, {
            skipped: false,
            status: "pending",
            details: "Plex unwatched propagation queued",
            targetStates: [],
          });
          const inserted = await insertWatchRecord(unplayedRecord, { skipInvalidate: true });
          await upsertPlaystateForMedia(unplayedMedia, "unwatched", inserted.record.watched_at, { skipInvalidate: true });
          await deletePlaybackProgress(unplayedMedia).catch(() => null);
          const summary = await syncMediaUnplayedPlaystate(unplayedMedia, config, loopStore);
          await updateWatchTelemetry(inserted.id, buildTelemetry(unplayedMedia, summary), { skipInvalidate: true });
          await recordSyncHistory(unplayedMedia, summary, "unwatched");
          await invalidateHistoryDerivedCaches().catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Plex unwatched status for '${record.title}':`, error);
    }
  }
}

async function processCompletedSession(row, config, loopStore) {
  const media = cachedRowToMedia(row);
  if (!media.isValid || Number(media.progress || 0) < watchedThresholdPercent()) return null;

  // After an authoritative restore, drop stale cached sessions whose last update predates the
  // restore â€” they would otherwise post a watch record dated today. Sessions still genuinely
  // active get re-cached with a fresh timestamp each tick, so real playback still completes.
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (lastRestoreAt && Number(row.updated_at || 0) <= lastRestoreAt) {
    return null;
  }

  // Invariant: never re-date an already-watched item to today. If plembfin already has this title
  // marked watched, don't post a fresh Date.now() record from the live tracker.
  const knownPlaystate = await getPlaystateForMedia(media).catch(() => null);
  if (knownPlaystate?.state === "watched") {
    return null;
  }

  await markLiveTrackingComplete(row.session_id, Date.now());

  const watchRecord = mediaToWatchRecord(
    {
      title: media.title,
      type: media.type,
      source: media.source,
      ids: media.ids,
      season: media.season,
      episode: media.episode,
      posterUrl: media.posterUrl,
    },
    media.source,
  );

  const inserted = await insertWatchRecord(watchRecord, { skipInvalidate: true });
  await upsertPlaystateForMedia(media, "watched", inserted.record.watched_at, { skipInvalidate: true });
  let syncSummary;
  try {
    syncSummary = await syncMediaPlaystate(media, config, loopStore);
  } catch (error) {
    console.error("Live tracking sync dispatch failed", { sessionId: row.session_id, error });
    syncSummary = {
      status: "error",
      details: String(error?.message || error || "Outbound sync failed"),
      skipped: false,
      targetStates: [],
    };
  }
  const telemetry = buildTelemetry(media, syncSummary);
  await updateWatchTelemetry(inserted.id, telemetry, { skipInvalidate: true });
  await recordSyncHistory(media, syncSummary, "watched");
  await deletePlaybackProgress(media).catch((error) => {
    console.error("Failed to clear completed resume progress", { sessionId: row.session_id, error });
  });
  await invalidateHistoryDerivedCaches().catch(() => null);

  return { ...inserted, telemetry };
}

async function processStoppedSessionProgress(row, config, loopStore) {
  const media = cachedRowToMedia(row);
  if (!shouldSyncResumeProgress(media)) return null;

  const existingPlaystate = await getPlaystateForMedia(media).catch(() => null);
  if (existingPlaystate?.state === "watched" || existingPlaystate?.state === "unwatched") {
    await deletePlaybackProgress(media).catch(() => null);
    console.log("Live tracking resume skipped because playstate is authoritative", {
      title: media.title,
      source: media.source,
      playstateState: existingPlaystate.state,
      playstateUpdatedAt: existingPlaystate.updated_at,
      liveUpdatedAt: row.updated_at,
    });
    return null;
  }

  const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
  await upsertPlaybackProgress({
    ...progressRecord,
    sync_dispatch_telemetry: buildProgressTelemetry(media, {
      skipped: false,
      status: "pending",
      details: "Resume propagation queued",
      targetStates: [],
    }),
  }).catch((error) => {
    console.error("Failed to store stopped session resume progress", { sessionId: row.session_id, error });
  });

  let syncSummary;
  try {
    syncSummary = await syncMediaProgress(media, config, loopStore);
  } catch (error) {
    console.error("Live tracking resume progress dispatch failed", { sessionId: row.session_id, error });
    syncSummary = {
      status: "error",
      details: String(error?.message || error || "Resume progress sync failed"),
      skipped: false,
      targetStates: [],
    };
  }

  const telemetry = buildProgressTelemetry(media, syncSummary);
  await updatePlaybackProgressTelemetry(progressRecord, telemetry).catch((error) => {
    console.error("Failed to update stopped session resume telemetry", { sessionId: row.session_id, error });
  });
  await recordSyncHistory(media, syncSummary, "progress");

  return { media, telemetry, status: syncSummary.status };
}

async function syncResumableMedia(media, config, loopStore, logger = console.log) {
  if (!shouldSyncResumeProgress(media)) {
    logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (not actionable)`);
    return false;
  }

  const existingPlaystate = await getPlaystateForMedia(media).catch(() => null);
  const resumeUpdatedAt = Number(media.updatedAt || 0);
  const playstateUpdatedAt = Number(existingPlaystate?.updated_at || 0);

  // After an authoritative restore, ignore resume positions whose app-side timestamp predates
  // the restore â€” they are pre-restore state the backup has already superseded.
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (lastRestoreAt && resumeUpdatedAt > 0 && resumeUpdatedAt <= lastRestoreAt) {
    logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (pre-restore resume position)`);
    return false;
  }


  if (existingPlaystate?.state === "unwatched" && (resumeUpdatedAt <= 0 || playstateUpdatedAt >= resumeUpdatedAt)) {
    await deletePlaybackProgress(media).catch(() => null);
    logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (item is unwatched)`);
    return false;
  }

  if (existingPlaystate && (existingPlaystate.state === "watched" || (resumeUpdatedAt > 0 && playstateUpdatedAt >= resumeUpdatedAt))) {
    await deletePlaybackProgress(media).catch(() => null);
    logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (${existingPlaystate.state === "watched" ? "item is watched" : "newer playstate"})`);
    return false;
  }

  const existingProgress = await getPlaybackProgressForMedia(media).catch(() => null);
  const progressUpdatedAt = Number(existingProgress?.updated_at || 0);


  if (existingProgress && resumeUpdatedAt <= 0 && resumePositionUnchanged(existingProgress, media)) {
    logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (unchanged resume progress without timestamp)`);
    return false;
  }

  if (existingProgress && resumeUpdatedAt > 0 && progressUpdatedAt >= resumeUpdatedAt) {
    logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (stale resume progress)`);
    return false;
  }

  const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
  await upsertPlaybackProgress({
    ...progressRecord,
    sync_dispatch_telemetry: buildProgressTelemetry(media, {
      skipped: false,
      status: "pending",
      details: "Resume propagation queued from server continue-watching list",
      targetStates: [],
    }),
  }).catch((error) => {
    logger(`Resume Sync: failed to store progress for ${media.title}: ${error.message}`);
  });

  let summary;
  try {
    summary = await syncMediaProgress(media, config, loopStore);
  } catch (error) {
    summary = {
      status: "error",
      details: `Resume propagation failed: ${error.message || String(error)}`,
      skipped: false,
      targetStates: [],
    };
  }

  await updatePlaybackProgressTelemetry(progressRecord, buildProgressTelemetry(media, summary)).catch(() => null);
  await recordSyncHistory(media, summary, "progress");
  logger(`Resume Sync: ${media.title} from ${media.source} -> ${summary.status}`);
  return summary.status === "success" || summary.status === "partial";
}

async function syncRecentlyResumableFromPlex(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Plex resume library sync is disabled.");
    return 0;
  }
  if (!config.plex?.baseUrl || !config.plex?.token) return 0;

  let syncedCount = 0;
  try {
    const { fetchPlexResumableItems } = await import("./utils/plexClient.js");
    const raw = await fetchPlexResumableItems(config.plex, { limit: SCHEDULED_RESUME_LIMIT });
    logger(`Plex: fetched ${raw.length} resumable library items.`);
    for (const item of raw) {
      if (await syncResumableMedia(mediaFromPlexResumableItem(item), config, loopStore, logger)) syncedCount++;
    }
  } catch (error) {
    logger(`Plex resume sync failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncRecentlyResumableFromEmby(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Emby resume library sync is disabled.");
    return 0;
  }
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return 0;

  let syncedCount = 0;
  try {
    const { fetchEmbyResumableItems } = await import("./utils/embyClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchEmbyResumableItems(config.emby, { limit: SCHEDULED_RESUME_LIMIT });
    logger(`Emby: fetched ${raw.length} resumable library items.`);
    for (const item of raw) {
      if (await syncResumableMedia(mediaFromEmbyLikeResumableItem(item, "emby", normalizeProviderIds), config, loopStore, logger)) syncedCount++;
    }
  } catch (error) {
    logger(`Emby resume sync failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncRecentlyResumableFromJellyfin(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Jellyfin resume library sync is disabled.");
    return 0;
  }
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return 0;

  let syncedCount = 0;
  try {
    const { fetchJellyfinResumableItems } = await import("./utils/jellyfinClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchJellyfinResumableItems(config.jellyfin, { limit: SCHEDULED_RESUME_LIMIT });
    logger(`Jellyfin: fetched ${raw.length} resumable library items.`);
    for (const item of raw) {
      if (await syncResumableMedia(mediaFromEmbyLikeResumableItem(item, "jellyfin", normalizeProviderIds), config, loopStore, logger)) syncedCount++;
    }
  } catch (error) {
    logger(`Jellyfin resume sync failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncRecentlyWatchedFromPlex(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Plex watched library sync is disabled.");
    return 0;
  }
  if (!config.plex?.baseUrl || !config.plex?.token) return 0;

  const baseUrl = config.plex.baseUrl.replace(/\/+$/, "");
  const token = config.plex.token;
  const username = configuredPlexUsername(config);
  let syncedCount = 0;

  const targetAccountId = await resolvePlexTargetAccountId(baseUrl, token, username, logger);
  if (username && targetAccountId == null) {
    logger(`Plex: configured user "${config.plex.username}" was not resolved to an account id; rows without a matching username will be skipped.`);
  }

  try {
    const historyUrl = new URL(`${baseUrl}/status/sessions/history/all`);
    historyUrl.searchParams.set("X-Plex-Container-Start", "0");
    historyUrl.searchParams.set("X-Plex-Container-Size", "20");
    if (targetAccountId != null) {
      historyUrl.searchParams.set("accountID", String(targetAccountId));
    }

    const historyRes = await fetchWithTimeout(historyUrl, { headers: plexAuthHeaders(token) });
    let items = [];
    if (historyRes.ok) {
      const historyData = await historyRes.json();
      items = historyData?.MediaContainer?.Metadata || [];
    } else {
      logger(`Plex history fetch failed: HTTP ${historyRes.status}`);
    }

    let recentlyViewedItems = [];
    try {
      const sectionsUrl = new URL(`${baseUrl}/library/sections`);
      const sectionsRes = await fetchWithTimeout(sectionsUrl, { headers: plexAuthHeaders(token) });
      if (sectionsRes.ok) {
        const sectionsData = await sectionsRes.json();
        const directories = sectionsData?.MediaContainer?.Directory || [];
        // Bound the per-tick sweep: this runs every minute inside a 50s budget,
        // and each section costs a serial round trip to Plex. Very large installs
        // still converge â€” the history endpoint above covers recent activity.
        const MAX_SECTIONS_PER_TICK = 6;
        let sectionsChecked = 0;
        for (const dir of directories) {
          const sectionId = dir.key;
          const type = dir.type;
          if (type !== "movie" && type !== "show") continue;
          if (sectionsChecked >= MAX_SECTIONS_PER_TICK) {
            logger(`Plex sections check capped at ${MAX_SECTIONS_PER_TICK} sections this tick.`);
            break;
          }
          sectionsChecked += 1;

          const sectionAllUrl = new URL(`${baseUrl}/library/sections/${sectionId}/all`);
          sectionAllUrl.searchParams.set("unwatched", "0");
          sectionAllUrl.searchParams.set("sort", "lastViewedAt:desc");
          sectionAllUrl.searchParams.set("X-Plex-Container-Start", "0");
          sectionAllUrl.searchParams.set("X-Plex-Container-Size", "50");
          if (targetAccountId != null) {
            sectionAllUrl.searchParams.set("accountID", String(targetAccountId));
          }
          if (type === "movie") {
            sectionAllUrl.searchParams.set("type", "1");
          } else {
            sectionAllUrl.searchParams.set("type", "4"); // Episode
          }

          const sectionRes = await fetchWithTimeout(sectionAllUrl, { headers: plexAuthHeaders(token) });
          if (sectionRes.ok) {
            const sectionData = await sectionRes.json();
            const metadata = sectionData?.MediaContainer?.Metadata || [];
            recentlyViewedItems.push(...metadata);
          }
        }
      } else {
        logger(`Plex sections fetch failed: HTTP ${sectionsRes.status}`);
      }
    } catch (err) {
      logger(`Plex sections check failed: ${err.message}`);
    }

    // Combine and deduplicate
    const allItems = [...items, ...recentlyViewedItems];
    const seenKeys = new Set();
    const uniqueItems = [];

    for (const item of allItems) {
      if (!plexHistoryItemMatchesConfiguredUser(item, { username, accountId: targetAccountId })) continue;
      if (item.type !== "movie" && item.type !== "episode") continue;

      const watchedAt = item.viewedAt || item.lastViewedAt
        ? new Date(Number(item.viewedAt || item.lastViewedAt) * 1000).toISOString()
        : releaseDateForPlexItem(item);
      if (!watchedAt) {
        logger(`Plex: skipped watched item without played or release date: ${item.title || item.grandparentTitle || "unknown"}`);
        continue;
      }

      const dedupeKey = `${item.ratingKey || item.key}-${watchedAt}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      uniqueItems.push({ item, watchedAt });
    }

    for (const { item, watchedAt } of uniqueItems) {
      const media = {
        title: item.title,
        type: item.type,
        source: "plex",
        isValid: true,
        ids: {},
      };

      const guids = [item.guid, ...(item.Guid || []).map((g) => g.id || g)].filter(Boolean);
      for (const guid of guids) {
        const guidStr = String(guid);
        const value = guidStr.split(/:\/\/|\//).pop();
        if (guidStr.includes("imdb")) media.ids.imdb = value;
        if (guidStr.includes("tmdb") || guidStr.includes("themoviedb")) media.ids.tmdb = value;
        if (guidStr.includes("tvdb") || guidStr.includes("thetvdb")) media.ids.tvdb = value;
      }

      if (item.type === "episode") {
        media.season = Number(item.parentIndex);
        media.episode = Number(item.index);
        media.title = `${item.grandparentTitle} - S${String(media.season ?? "?").padStart(2, "0")}E${String(media.episode ?? "?").padStart(2, "0")}`;
        media.episodeTitle = item.title;
      }

      media.watched_at = watchedAt;
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      const existing = await findWatchedByAnyMediaKey(media);

      if (!existing || playstate?.state !== "watched") {
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(watchedAt).getTime() <= lastRestoreAt) {
          logger(`Plex: skipped pre-restore item (played ${watchedAt}): ${media.title}`);
          continue;
        }
        logger(`Plex: detected new watched item: ${media.title} (watched at ${watchedAt})`);
        const watchRecord = mediaToWatchRecord(media, "plex");
        watchRecord.watched_at = watchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: plex`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Plex library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true });
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: plex`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Plex library history; sync completed.`,
          ...summary.targetStates.map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Plex sync recently watched failed: ${error.message}`);
  }

  if (syncedCount) await invalidateHistoryDerivedCaches().catch(() => null);
  return syncedCount;
}

async function syncRecentlyWatchedFromEmby(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Emby watched library sync is disabled.");
    return 0;
  }
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return 0;
  let syncedCount = 0;
  try {
    const { fetchEmbyWatchedItems } = await import("./utils/embyClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchEmbyWatchedItems(config.emby, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
    const pollTimestamp = Date.now();
    
    for (const item of raw) {
      // For episodes, prefer series-level provider IDs (SeriesProviderIds) so that Plex and
      // other targets can match by series GUID rather than failing on episode-level IDs.
      const rawIds = item.Type === "Episode"
        ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
        : (item.ProviderIds || {});
      const ids = normalizeProviderIds(rawIds);
      const media = {
        title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
        type: item.Type === "Episode" ? "episode" : "movie",
        season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
        episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
        ids: {
          imdb: ids.imdb || undefined,
          tmdb: ids.tmdb || undefined,
          tvdb: ids.tvdb || undefined,
        },
        episodeTitle: item.Type === "Episode" ? item.Name : null,
        source: "emby",
        isValid: true,
      };
      if (!scheduledMediaInScope(config, media)) continue;

      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item, pollTimestamp);

      if (!watchedAt) {
        logger(`Emby: skipped watched item without played or release date: ${media.title}`);
        continue;
      }

      const existing = await findWatchedByAnyMediaKey(media);

      if (!existing) {
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(watchedAt).getTime() <= lastRestoreAt) {
          logger(`Emby: skipped pre-restore item (played ${watchedAt}): ${media.title}`);
          continue;
        }
        logger(`Emby: detected new watched item: ${media.title} (${watchedAtReason} ${watchedAt})`);
        const watchRecord = mediaToWatchRecord(media, "emby");
        watchRecord.watched_at = watchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: emby`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Emby library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true });
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: emby`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Emby library history; sync completed.`,
          ...(summary.targetStates || []).map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Emby sync recently watched failed: ${error.message}`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches().catch(() => null);
  return syncedCount;
}

async function syncRecentlyWatchedFromJellyfin(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Jellyfin watched library sync is disabled.");
    return 0;
  }
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return 0;
  let syncedCount = 0;
  try {
    const { fetchJellyfinWatchedItems } = await import("./utils/jellyfinClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchJellyfinWatchedItems(config.jellyfin, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
    const pollTimestamp = Date.now();
    
    for (const item of raw) {
      // For episodes, prefer series-level provider IDs (SeriesProviderIds) so that Plex and
      // other targets can match by series GUID rather than failing on episode-level IDs.
      const rawIds = item.Type === "Episode"
        ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
        : (item.ProviderIds || {});
      const ids = normalizeProviderIds(rawIds);
      const media = {
        title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
        type: item.Type === "Episode" ? "episode" : "movie",
        season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
        episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
        ids: {
          imdb: ids.imdb || undefined,
          tmdb: ids.tmdb || undefined,
          tvdb: ids.tvdb || undefined,
        },
        episodeTitle: item.Type === "Episode" ? item.Name : null,
        source: "jellyfin",
        isValid: true,
      };
      if (!scheduledMediaInScope(config, media)) continue;

      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item, pollTimestamp);

      if (!watchedAt) {
        logger(`Jellyfin: skipped watched item without played or release date: ${media.title}`);
        continue;
      }

      const existing = await findWatchedByAnyMediaKey(media);

      if (!existing) {
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(watchedAt).getTime() <= lastRestoreAt) {
          logger(`Jellyfin: skipped pre-restore item (played ${watchedAt}): ${media.title}`);
          continue;
        }
        logger(`Jellyfin: detected new watched item: ${media.title} (${watchedAtReason} ${watchedAt})`);
        const watchRecord = mediaToWatchRecord(media, "jellyfin");
        watchRecord.watched_at = watchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: jellyfin`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Jellyfin library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true });
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: jellyfin`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Jellyfin library history; sync completed.`,
          ...(summary.targetStates || []).map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Jellyfin sync recently watched failed: ${error.message}`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches().catch(() => null);
  return syncedCount;
}

function getActiveTargetsForConfig(config) {
  const targets = [];
  if (!config?.plex?.disabled && config?.plex?.baseUrl && config?.plex?.token) targets.push("plex");
  if (!config?.emby?.disabled && config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId) targets.push("emby");
  if (!config?.jellyfin?.disabled && config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId) targets.push("jellyfin");
  return targets;
}

function isTargetSynced(telemetry = "", target = "", source = "") {
  const src = String(source || "").toLowerCase();
  const tgt = String(target || "").toLowerCase();
  if (src === tgt || src.startsWith(`${tgt}_`)) return true;

  const text = String(telemetry || "").toLowerCase();
  if (text.includes("force sync resolved status to success")) return true;

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.includes(`${tgt} status:`) || line.includes(`${tgt} progress status:`)) {
      if (line.includes("success")) return true;
      if (line.includes("loop")) return true;
      // "not found" means the item simply isn't in this platform's library â€” treat as terminal
      // so it doesn't get re-queued every minute forever. Only "error" is retryable.
      if (line.includes("skipped")) return true;
      return false;
    }
  }
  return false;
}

async function syncPendingManualDispatches(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Pending watched dispatch sync is disabled.");
    return 0;
  }
  let syncedCount = 0;
  try {
    const rows = (await getCachedHistory()).slice(0, 200);

    const activeTargets = getActiveTargetsForConfig(config);
    const toRetry = [];
    const now = Date.now();

    for (const row of rows) {
      if (row.sync_action !== "watched") continue;

      const telemetry = row.sync_dispatch_telemetry || "";
      const isPending = telemetry.includes("Dispatch status: pending");

      let needsSync = isPending;
      if (!isPending && activeTargets.length > 0) {
        const allSynced = activeTargets.every((target) =>
          isTargetSynced(telemetry, target, row.source)
        );
        if (!allSynced) {
          needsSync = true;
        }
      }

      if (needsSync && syncRetryEligible(row, now)) {
        toRetry.push(row);
      }
    }

    const maxRetries = 15;
    const batchToRetry = toRetry.slice(0, maxRetries);

    for (const row of batchToRetry) {
      const id = row.id;
      const media = {
        title: row.title,
        type: row.media_type,
        source: row.source,
        isValid: true,
        ids: {
          imdb: row.imdb_id || undefined,
          tmdb: row.tmdb_id || undefined,
          tvdb: row.tvdb_id || undefined,
        },
        season: row.season == null ? undefined : Number(row.season),
        episode: row.episode == null ? undefined : Number(row.episode),
      };

      logger(`Background Queue: retrying/dispatching sync for ${media.title} (${id})...`);
      await upsertPlaystateForMedia(media, "watched", row.watched_at, { skipInvalidate: true });
      const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Outbound sync failed: ${error.message || String(error)}`,
        targetStates: [],
      }));

      const telemetryLines = [
        `Origin: ${media.source}`,
        `Loop-check: Passed`,
        `Dispatch status: ${summary.status}`,
        `Details: Manual watch state propagated; sync completed.`,
        ...(summary.targetStates || []).map(
          (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
        ),
      ];

      const previousRetryCount = Number(row.sync_retry_count || 0);
      const allSyncedNow = activeTargets.length > 0 && activeTargets.every((target) =>
        isTargetSynced(telemetryLines.join("\n"), target, row.source)
      );
      let terminal = false;
      if (allSyncedNow) {
        await updateWatchSyncRetry(id, 0, 0, { skipInvalidate: true });
      } else {
        const nextCount = previousRetryCount + 1;
        terminal = nextCount >= SYNC_RETRY_MAX_ATTEMPTS;
        await updateWatchSyncRetry(id, nextCount, Date.now() + syncRetryDelayMs(nextCount), { skipInvalidate: true });
        if (terminal) {
          telemetryLines.push(`Retry: automatic retries exhausted after ${SYNC_RETRY_MAX_ATTEMPTS} attempts; use Retry Sync to try again.`);
          logger(`Background Queue: giving up on ${media.title} (${id}) after ${SYNC_RETRY_MAX_ATTEMPTS} attempts.`);
        } else {
          telemetryLines.push(`Retry: attempt ${nextCount} of ${SYNC_RETRY_MAX_ATTEMPTS}; next automatic retry in ${Math.round(syncRetryDelayMs(nextCount) / 60_000)}m.`);
        }
      }

      await updateWatchTelemetry(id, telemetryLines.join("\n"), { skipInvalidate: true });
      // Only log a sync_history row when the outcome is new information: the
      // first failed attempt, a success, or giving up. Identical failures on
      // every backoff step would otherwise flood the table.
      if (allSyncedNow || previousRetryCount === 0 || terminal) {
        await recordSyncHistory(media, summary, "watched");
      }
      syncedCount++;
    }
  } catch (error) {
    logger(`Pending Queue dispatcher failed: ${error.message}`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches().catch(() => null);
  return syncedCount;
}

export async function runScheduledSync(logger = console.log, { forceCatchup = false } = {}) {
  if (isCronSyncPaused()) {
    logger("Scheduled Sync: skipped because cron sync is paused (likely due to restore in progress).");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }

  logger("Scheduled Sync: starting background sync workflow...");
  const runtime = await loadRuntimeState();
  
  const FORCE_SYNC_HEARTBEAT_STALE_MS = 3 * 60 * 1000;
  const forceSyncHeartbeat = Number(runtime.forceSyncHeartbeat || runtime.forceSyncStartedAt || 0);
  const isForceSyncStale = !forceSyncHeartbeat || forceSyncHeartbeat < Date.now() - FORCE_SYNC_HEARTBEAT_STALE_MS;

  if (runtime.forceSyncActive === true && isForceSyncStale) {
    logger("Scheduled Sync: force-sync heartbeat is cold (>3m); resetting stale forceSyncActive flag...");
    await setRuntimeState({ forceSyncActive: false, forceSyncCancelRequested: false }).catch(() => null);
    runtime.forceSyncActive = false;
  }

  // Only reset the restore-reconcile flag if the job's heartbeat has gone cold (i.e. the process
  // actually died mid-job). A long-but-alive restore refreshes restoreSyncHeartbeat continuously,
  // so it is NEVER un-blocked here â€” that prevents the cron from running mid-push and re-importing
  // freshly-pushed items as watched-today. (Do NOT use restoreSyncStartedAt: a big push runs far
  // longer than any fixed timeout.)
  const RESTORE_HEARTBEAT_STALE_MS = 3 * 60 * 1000;
  const restoreHeartbeat = Number(runtime.restoreSyncHeartbeat || runtime.restoreSyncStartedAt || 0);
  const isRestoreSyncStale = !restoreHeartbeat || restoreHeartbeat < Date.now() - RESTORE_HEARTBEAT_STALE_MS;
  if (runtime.restoreSyncActive === true && isRestoreSyncStale) {
    logger("Scheduled Sync: restore heartbeat is cold (>3m); resetting stale restoreSyncActive flag...");
    await setRuntimeState({ restoreSyncActive: false }).catch(() => null);
    runtime.restoreSyncActive = false;
  }

  if (runtime.rebuildActive === true || runtime.forceSyncActive === true || runtime.restoreSyncActive === true) {
    logger("Scheduled Sync: skipped because a database rebuild, force sync, or authoritative restore is currently active.");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }
  await setRuntimeState({ lastCronExecution: Date.now() }).catch(() => null);
  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  
  const plexActive = !config?.plex?.disabled && Boolean(config?.plex?.baseUrl && config?.plex?.token);
  const embyActive = !config?.emby?.disabled && Boolean(config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId);
  const jellyfinActive = !config?.jellyfin?.disabled && Boolean(config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId);
  
  const hasConfiguredSources = plexActive || embyActive || jellyfinActive;

  if (!hasConfiguredSources) {
    logger("Scheduled Sync: skipped; no active configured media servers were found.");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }

  // Plex unwatch detection is now primarily event-driven via the notification WebSocket
  // (see startPlexNotificationListener in index.js). This poll is kept as a safety net for
  // events missed while the socket was disconnected, throttled to once every 6 hours
  // (PLEX_UNWATCHED_POLL_INTERVAL_MS) so it never drives detection or re-scans every tick.
  if (plexActive && Date.now() - lastPlexUnwatchedPollAt >= PLEX_UNWATCHED_POLL_INTERVAL_MS) {
    lastPlexUnwatchedPollAt = Date.now();
    logger("Scheduled Sync: checking Plex unwatched status (fallback poll)...");
    await checkPlexUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkPlexUnwatchedStatus failed: ${error.message}`);
    });
  }

  let plexSynced = 0;
  let embySynced = 0;
  let jellyfinSynced = 0;
  let plexResumeSynced = 0;
  let embyResumeSynced = 0;
  let jellyfinResumeSynced = 0;
  let manualSynced = 0;

  const shouldRunCatchup = forceCatchup || !lastCatchupSyncAt || (Date.now() - lastCatchupSyncAt >= CATCHUP_SYNC_INTERVAL_MS);
  if (shouldRunCatchup) {
    lastCatchupSyncAt = Date.now();
    logger(forceCatchup
      ? "Scheduled Sync: running requested recent-item repair..."
      : `Scheduled Sync: running catch-up library checks (interval: ${CATCHUP_SYNC_INTERVAL_MS / 60000}m)...`);

    if (plexActive) {
      try {
        logger("Scheduled Sync: checking Plex recently watched...");
        plexSynced = await syncRecentlyWatchedFromPlex(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Plex sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        logger("Scheduled Sync: checking Emby recently watched...");
        embySynced = await syncRecentlyWatchedFromEmby(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        logger("Scheduled Sync: checking Jellyfin recently watched...");
        jellyfinSynced = await syncRecentlyWatchedFromJellyfin(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Jellyfin sync failed: ${error.message}`);
      }
    }

    if (plexActive) {
      try {
        logger("Scheduled Sync: checking Plex continue watching...");
        plexResumeSynced = await syncRecentlyResumableFromPlex(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Plex resume sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        logger("Scheduled Sync: checking Emby continue watching...");
        embyResumeSynced = await syncRecentlyResumableFromEmby(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby resume sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        logger("Scheduled Sync: checking Jellyfin continue watching...");
        jellyfinResumeSynced = await syncRecentlyResumableFromJellyfin(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Jellyfin resume sync failed: ${error.message}`);
      }
    }
  }

  try {
    manualSynced = await syncPendingManualDispatches(config, loopStore, logger);
  } catch (error) {
    logger(`Scheduled Sync ERROR: Manual queue sync failed: ${error.message}`);
  }

  const currentSessions = await fetchLiveSessions(config);
  const currentRows = currentSessions.map(buildCacheRow);
  const currentIds = new Set(currentRows.map((row) => row.session_id));
  const cachedRows = await loadLiveTrackingCache({ includeCompleted: true });
  const cachedById = new Map(cachedRows.map((row) => [row.session_id, row]));
  const completions = [];
  const progressUpdates = [];
  const staleIds = [];

  if (currentRows.length || cachedRows.length) {
    logger(`Scheduled Sync: live sessions: ${currentRows.length}, cached sessions in tracking: ${cachedRows.length}`);
  }
  await upsertLiveTrackingCache(currentRows);

  for (const row of cachedRows) {
    if (currentIds.has(row.session_id)) continue;
    if (row.completed_at) continue;

    if (Number(row.last_progress || 0) >= watchedThresholdPercent()) {
      logger(`Scheduled Sync: session completed playback: ${row.title} (${row.session_id})`);
      const completion = await processCompletedSession(row, config, loopStore).catch((error) => {
        logger(`Scheduled Sync ERROR: processCompletedSession failed for ${row.title}: ${error.message}`);
        return null;
      });
      if (completion) completions.push(completion);
      else staleIds.push(row.session_id);
      continue;
    }

    logger(`Scheduled Sync: session stopped/paused playback: ${row.title} (${row.session_id})`);
    const progressUpdate = await processStoppedSessionProgress(row, config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: processStoppedSessionProgress failed for ${row.title}: ${error.message}`);
      return null;
    });
    if (progressUpdate) progressUpdates.push(progressUpdate);
    staleIds.push(row.session_id);
  }

  await deleteLiveTrackingCacheRows(staleIds);
  await purgeCompletedLiveTrackingCache();

  const totalSynced = plexSynced + embySynced + jellyfinSynced + plexResumeSynced + embyResumeSynced + jellyfinResumeSynced + manualSynced;
  const hasActivity = totalSynced > 0 || currentRows.length > 0 || completions.length > 0 || progressUpdates.length > 0 || shouldRunCatchup;

  if (currentRows.length || completions.length || progressUpdates.length || staleIds.length || totalSynced > 0) {
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }

  if (hasActivity) {
    logger(`Scheduled Sync complete! Synced Plex: ${plexSynced}, Emby: ${embySynced}, Jellyfin: ${jellyfinSynced}, Resume Plex: ${plexResumeSynced}, Resume Emby: ${embyResumeSynced}, Resume Jellyfin: ${jellyfinResumeSynced}, Manual: ${manualSynced}`);
  }
  return {
    sessions: currentRows.length,
    completions: completions.length,
    progressUpdates: progressUpdates.length,
    removed: staleIds.length,
    cached: cachedById.size,
    plexHistorySynced: plexSynced,
    embyHistorySynced: embySynced,
    jellyfinHistorySynced: jellyfinSynced,
    plexResumeSynced,
    embyResumeSynced,
    jellyfinResumeSynced,
    manualDispatchesSynced: manualSynced,
  };
}

async function runWithConcurrency(items, concurrency, handler) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await handler(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

export async function runForceSync(logger = console.log, { lockAlreadyClaimed = false, concurrency = 1, planId = "" } = {}) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Force Sync skipped because watched/played syncing is disabled.");
    return {
      success: true,
      skipped: true,
      reason: "Watched/played syncing is disabled.",
      activeTargets: [],
      stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 },
    };
  }

  if (!lockAlreadyClaimed) {
    logger("Force Sync: checking if another sync job is already running...");
    const runtime = await loadRuntimeState();
    const FORCE_SYNC_HEARTBEAT_STALE_MS = 3 * 60 * 1000;
    const heartbeat = Number(runtime.forceSyncHeartbeat || runtime.forceSyncStartedAt || 0);
    const stale = !heartbeat || heartbeat < Date.now() - FORCE_SYNC_HEARTBEAT_STALE_MS;

    if (runtime.forceSyncActive === true && !stale) {
      logger("Force Sync ERROR: Another force sync job is already running.");
      throw new Error("Another force sync job is already running.");
    }

    await setRuntimeState({ forceSyncActive: true, forceSyncStartedAt: Date.now(), forceSyncHeartbeat: Date.now(), forceSyncCancelRequested: false });
  }

  const heartbeatTimer = setInterval(() => {
    setRuntimeState({ forceSyncHeartbeat: Date.now() }).catch(() => null);
  }, 30_000);
  heartbeatTimer.unref?.();

  try {
    logger("Force Sync: loading media configuration...");
    const config = await loadMediaConfig();
    if (planId) {
      return await executeForceSyncPlan(planId, config, logger);
    }
    const loopStore = createLoopStore();

  const hasPlex = !config.plex?.disabled && Boolean(config.plex?.baseUrl && config.plex?.token);
  const hasEmby = !config.emby?.disabled && Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId);
  const hasJellyfin = !config.jellyfin?.disabled && Boolean(config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId);

  const activeTargets = [];
  if (hasPlex) activeTargets.push("plex");
  if (hasEmby) activeTargets.push("emby");
  if (hasJellyfin) activeTargets.push("jellyfin");

  if (activeTargets.length === 0) {
    logger("Force Sync: no active media servers are configured or enabled. Aborting.");
    return { success: true, activeTargets, stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 } };
  }

  logger(`Force Sync: active media targets resolved: ${activeTargets.join(", ")}`);

  // 1. Fetch watched items in parallel
  logger("Force Sync: querying watched libraries from servers...");
  const fetchPromises = [];
  if (hasPlex) {
    fetchPromises.push(
      (async () => {
        logger("Plex: scanning library sections...");
        const { fetchPlexWatchedItems } = await import("./utils/plexClient.js");
        const raw = await fetchPlexWatchedItems(config.plex);
        logger(`Plex: fetched ${raw.length} watched library items.`);
        return raw.map((item) => {
          const media = {
            title: item.title,
            type: item.type,
            season: item.parentIndex != null ? Number(item.parentIndex) : null,
            episode: item.index != null ? Number(item.index) : null,
            imdb: null,
            tmdb: null,
            tvdb: null,
            source: "plex",
            timestamp: item.lastViewedAt
              ? new Date(Number(item.lastViewedAt) * 1000)
              : releaseDateForPlexItem(item) ? new Date(releaseDateForPlexItem(item)) : null,
          };
          const guids = [item.guid, ...(item.Guid || []).map((g) => g.id || g)].filter(Boolean);
          for (const guid of guids) {
            const guidStr = String(guid);
            const value = guidStr.split(/:\/\/|\//).pop();
            if (guidStr.includes("imdb")) media.imdb = value;
            if (guidStr.includes("tmdb") || guidStr.includes("themoviedb")) media.tmdb = value;
            if (guidStr.includes("tvdb") || guidStr.includes("thetvdb")) media.tvdb = value;
          }
          if (item.type === "episode") {
            media.title = `${item.grandparentTitle} - S${String(media.season ?? "?").padStart(2, "0")}E${String(media.episode ?? "?").padStart(2, "0")}`;
            media.episodeTitle = item.title;
          }
          return media;
        });
      })().catch((err) => {
        logger(`Plex ERROR: failed to fetch watched items: ${err.message}`);
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  if (hasEmby) {
    fetchPromises.push(
      (async () => {
        logger("Emby: querying played items...");
        const { fetchEmbyWatchedItems } = await import("./utils/embyClient.js");
        const { normalizeProviderIds } = await import("./utils/parsers.js");
        const raw = await fetchEmbyWatchedItems(config.emby);
        const pollTimestamp = Date.now();
        logger(`Emby: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item, pollTimestamp);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            episodeTitle: item.Type === "Episode" ? item.Name : null,
            source: "emby",
            timestamp: watchedAt ? new Date(watchedAt) : null,
          };
        });
      })().catch((err) => {
        logger(`Emby ERROR: failed to fetch watched items: ${err.message}`);
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  if (hasJellyfin) {
    fetchPromises.push(
      (async () => {
        logger("Jellyfin: querying played items...");
        const { fetchJellyfinWatchedItems } = await import("./utils/jellyfinClient.js");
        const { normalizeProviderIds } = await import("./utils/parsers.js");
        const raw = await fetchJellyfinWatchedItems(config.jellyfin);
        const pollTimestamp = Date.now();
        logger(`Jellyfin: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item, pollTimestamp);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            episodeTitle: item.Type === "Episode" ? item.Name : null,
            source: "jellyfin",
            timestamp: watchedAt ? new Date(watchedAt) : null,
          };
        });
      })().catch((err) => {
        logger(`Jellyfin ERROR: failed to fetch watched items: ${err.message}`);
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  const [plexResults, embyResults, jellyfinResults] = await Promise.all(fetchPromises);
  const allWatchedItems = [...plexResults, ...embyResults, ...jellyfinResults];
  logger(`Force Sync: collected ${allWatchedItems.length} total watched items across all platforms.`);

  // 2. Fetch Plembfin watchHistory to resolve conflicts
  logger("Database: loading Plembfin watchHistory records...");
  const allWatchRows = await getCachedHistory();
  const rowById = new Map();
  const historyMap = new Map();
  for (const row of allWatchRows) {
    rowById.set(row.id, row);
    const mKey = row.media_key;
    if (!historyMap.has(mKey)) historyMap.set(mKey, []);
    historyMap.get(mKey).push({
      id: row.id,
      syncAction: row.sync_action || "watched",
      watchedAt: row.watched_at || new Date().toISOString()
    });
  }
  for (const [mKey, records] of historyMap.entries()) {
    records.sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
  }
  logger(`Database: loaded ${allWatchRows.length} historical sync records.`);

  function findLooseMatch(media, groups) {
    for (const group of groups) {
      if (media.type !== group.type) continue;
      if (media.imdb && group.imdb && media.imdb === group.imdb) return group;
      if (media.tmdb && group.tmdb && media.tmdb === group.tmdb) return group;
      if (media.tvdb && group.tvdb && media.tvdb === group.tvdb) return group;
      
      const cleanTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (media.type === "episode") {
        const getShowName = (t) => t.split(" - ")[0].trim();
        const mediaShow = getShowName(media.title);
        const groupShow = getShowName(group.title);
        if (cleanTitle(mediaShow) === cleanTitle(groupShow) && 
            Number(media.season) === Number(group.season) && 
            Number(media.episode) === Number(group.episode)) {
          return group;
        }
      } else {
        if (cleanTitle(media.title) === cleanTitle(group.title)) {
          return group;
        }
      }
    }
    return null;
  }

  // 3. Group watched items loose-matched
  logger("Force Sync: grouping and matching items across servers...");
  const groups = [];
  for (const media of allWatchedItems) {
    const group = findLooseMatch(media, groups);
    if (group) {
      group.watchedOn.add(media.source);
      if (media.timestamp && (!group.timestamp || media.timestamp > group.timestamp)) {
        group.timestamp = media.timestamp;
      }
      if (!group.imdb && media.imdb) group.imdb = media.imdb;
      if (!group.tmdb && media.tmdb) group.tmdb = media.tmdb;
      if (!group.tvdb && media.tvdb) group.tvdb = media.tvdb;
      if (!group.episodeTitle && media.episodeTitle) group.episodeTitle = media.episodeTitle;
    } else {
      groups.push({
        title: media.title,
        type: media.type,
        season: media.season,
        episode: media.episode,
        imdb: media.imdb,
        tmdb: media.tmdb,
        tvdb: media.tvdb,
        timestamp: media.timestamp,
        episodeTitle: media.episodeTitle || null,
        watchedOn: new Set([media.source])
      });
    }
  }

  // 4. Compute canonical media keys and watched state entries
  const watchedMap = new Map();
  for (const group of groups) {
    const mediaObj = {
      title: group.title,
      type: group.type,
      season: group.season,
      episode: group.episode,
      ids: {
        imdb: group.imdb || undefined,
        tmdb: group.tmdb || undefined,
        tvdb: group.tvdb || undefined
      },
      episodeTitle: group.episodeTitle || undefined
    };
    const key = mediaKeyFor(mediaObj);
    watchedMap.set(key, { media: mediaObj, group });
  }

  // 5. Build union of all items to consider
  const allConsideredKeys = new Set([...watchedMap.keys(), ...historyMap.keys()]);
  logger(`Force Sync: resolving watched state for ${allConsideredKeys.size} distinct items...`);

  let propagatedCount = 0;
  let addedToHistoryCount = 0;
  let deletedFromHistoryCount = 0;

  // Ceiling of 8: force sync fires mark-played/unplayed calls at the user's own
  // media servers, and a home NAS handles a burst of 64 concurrent writes badly
  // (cascading timeouts that then feed the retry queue).
  const reconciliationConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, 8));
  if (reconciliationConcurrency > 1) {
    logger(`Force Sync: local concurrency enabled (${reconciliationConcurrency} workers).`);
  }

  let processedCount = 0;
  let abortResult = null;
  const consideredKeys = [...allConsideredKeys];

  const abortSummary = () => ({
    success: true,
    activeTargets,
    aborted: true,
    stats: {
      totalWatchedFoundAcrossServers: watchedMap.size,
      addedToHistory: addedToHistoryCount,
      deletedFromHistory: deletedFromHistoryCount,
      propagatedUpdates: propagatedCount
    }
  });

  async function shouldAbort() {
    if (abortResult) return true;
    processedCount += 1;
    const checkEvery = reconciliationConcurrency > 1 ? 20 : 5;
    const reportEvery = Math.max(checkEvery, Math.ceil(consideredKeys.length / 100));
    if (processedCount === 1 || processedCount === consideredKeys.length || processedCount % reportEvery === 0) {
      logger(`Force Sync progress: ${processedCount}/${consideredKeys.length} items.`);
    }
    if (processedCount % checkEvery !== 0) return false;
    const currentRuntime = await loadRuntimeState();
    if (currentRuntime.forceSyncCancelRequested === true) {
      logger("Force Sync: stop request detected. Aborting sync...");
      abortResult = abortSummary();
      return true;
    }
    return false;
  }

  async function markPlayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexPlayed } = await import("./utils/plexClient.js");
      await markPlexPlayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyPlayed } = await import("./utils/embyClient.js");
      await markEmbyPlayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinPlayed } = await import("./utils/jellyfinClient.js");
      await markJellyfinPlayed(config.jellyfin, mediaObj);
    }
  }

  async function markUnplayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexUnplayed } = await import("./utils/plexClient.js");
      await markPlexUnplayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyUnplayed } = await import("./utils/embyClient.js");
      await markEmbyUnplayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinUnplayed } = await import("./utils/jellyfinClient.js");
      await markJellyfinUnplayed(config.jellyfin, mediaObj);
    }
  }

  async function processConsideredKey(key) {
    if (await shouldAbort()) return;

    const serverWatchedEntry = watchedMap.get(key);
    const historyRecords = historyMap.get(key) || [];
    const lastHistoryRecord = historyRecords[0];

    let newestState = "unwatched";
    let newestTime = 0;

    if (lastHistoryRecord) {
      newestState = lastHistoryRecord.syncAction === "unwatched" ? "unwatched" : "watched";
      newestTime = new Date(lastHistoryRecord.watchedAt).getTime();
    }

    let serverWatchedOn = new Set();
    let serverWatchedTime = 0;
    let mediaObj = serverWatchedEntry ? serverWatchedEntry.media : null;

    if (serverWatchedEntry) {
      serverWatchedOn = serverWatchedEntry.group.watchedOn;
      serverWatchedTime = serverWatchedEntry.group.timestamp ? new Date(serverWatchedEntry.group.timestamp).getTime() : 0;
      if (serverWatchedTime > newestTime) {
        newestTime = serverWatchedTime;
        newestState = "watched";
      }
    }

    if (!mediaObj && lastHistoryRecord) {
      const docData = rowById.get(lastHistoryRecord.id) || {};
      mediaObj = {
        title: docData.title,
        type: docData.media_type,
        season: docData.season != null ? Number(docData.season) : null,
        episode: docData.episode != null ? Number(docData.episode) : null,
        ids: {
          imdb: docData.imdb_id || undefined,
          tmdb: docData.tmdb_id || undefined,
          tvdb: docData.tvdb_id || undefined
        }
      };
    }

    if (!mediaObj) return;

    if (newestState === "watched") {
      const inHistory = historyRecords.some(r => r.syncAction === "watched");
      if (!inHistory) {
        logger(`Skipping server-only watched state for "${mediaObj.title}" because no Plembfin history row exists.`);
      } else if (lastHistoryRecord && lastHistoryRecord.syncAction === "unwatched") {
        logger(`Deleting outdated unwatched record for "${mediaObj.title}"`);
        const unwatchedDocs = historyRecords.filter(r => r.syncAction === "unwatched");
        for (const docRec of unwatchedDocs) {
          await deleteWatchRecordById(docRec.id, { skipInvalidate: true });
        }
      }

      for (const target of activeTargets) {
        if (!serverWatchedOn.has(target)) {
          logger(`Propagating: marking played "${mediaObj.title}" on ${target}`);
          try {
            await markPlayedTarget(target, mediaObj);
            propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark played for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    } else {
      const hasWatchedRecord = historyRecords.some(r => r.syncAction === "watched");
      if (hasWatchedRecord) {
        logger(`Deleting watched records and marking unwatched for "${mediaObj.title}"`);
        for (const docRec of historyRecords) {
          await deleteWatchRecordById(docRec.id, { skipInvalidate: true });
          deletedFromHistoryCount++;
        }
        const unwatchedRecord = mediaToWatchRecord(mediaObj, "force_sync");
        unwatchedRecord.sync_action = "unwatched";
        unwatchedRecord.sync_dispatch_telemetry = [
          `Origin: force_sync`,
          `Loop-check: Passed`,
          `Dispatch status: success`,
          `Details: Force Sync resolved status to unwatched. Newest timestamp: ${new Date(newestTime).toISOString()}`,
          ...activeTargets.map(t => `Target ${t.charAt(0).toUpperCase() + t.slice(1)} status: success`)
        ].join("\n");
        if (newestTime > 0) unwatchedRecord.watched_at = new Date(newestTime).toISOString();
        const inserted = await insertWatchRecord(unwatchedRecord, { skipInvalidate: true });
        await upsertPlaystateForMedia({ ...mediaObj, source: "force_sync", isValid: true }, "unwatched", inserted.record.watched_at, { skipInvalidate: true });
      }

      for (const target of activeTargets) {
        if (serverWatchedOn.has(target)) {
          logger(`Propagating: marking unplayed "${mediaObj.title}" on ${target}`);
          try {
            await markUnplayedTarget(target, mediaObj);
            propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark unwatched for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    }
  }

  if (reconciliationConcurrency > 1) {
    await runWithConcurrency(consideredKeys, reconciliationConcurrency, processConsideredKey);
  } else {
    for (const key of consideredKeys) {
      await processConsideredKey(key);
      if (abortResult) break;
    }
  }

  if (abortResult) return abortResult;

  logger("Force Sync: process complete.");
  return {
    success: true,
    activeTargets,
    stats: {
      totalWatchedFoundAcrossServers: watchedMap.size,
      addedToHistory: addedToHistoryCount,
      deletedFromHistory: deletedFromHistoryCount,
      propagatedUpdates: propagatedCount
    }
  };
  } finally {
    clearInterval(heartbeatTimer);
    await invalidateHistoryDerivedCaches().catch(() => null);
    await setRuntimeState({ forceSyncActive: false, forceSyncCancelRequested: false, forceSyncHeartbeat: Date.now() }).catch(() => null);
  }
}
