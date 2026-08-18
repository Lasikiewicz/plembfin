import crypto from "node:crypto";
import { fetchWithTimeout } from "./utils/outbound.js";
import { watchedThresholdPercent } from "./utils/tuning.js";
import { lastOutboundPlayedMarkAt, recordOutboundPlayedMarks, recordOutboundUnplayedMarks, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { applyUnwatchedTransition } from "./utils/watchStateTransitions.js";
import { parsePlexGuids } from "./utils/parsers.js";
import { findPlexItem, resolvePlexAccountId } from "./utils/plexClient.js";
import { fetchPlexWithRefresh } from "./utils/plexFetch.js";
import { buildCacheRow, fetchLiveSessions, hydrateCachedSession } from "./utils/liveSessions.js";
import { activeSyncOperation, appendSyncHistory, clearSyncOperation, claimSyncOperation, loadMediaConfig, loadRuntimeState, releaseSyncOperation, setRuntimeState, touchSyncOperation, RESTORE_KIND_BACKUP, RESTORE_KIND_FULL_SYNC, SYNC_OPERATION_FORCE, SYNC_OPERATION_SCHEDULED } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { isCronSyncPaused, loadWatchBackupRuntime } from "./utils/watchHistoryBackups.js";
import { executeForceSyncPlan } from "./utils/forceSyncExecutor.js";
import { isEmbyLikePlayed, watchedAtForEmbyLikeItem, watchedAtForPlexItem } from "./utils/watchDates.js";
import { isVerboseLogging } from "./utils/logVerbose.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "./utils/watchProvenance.js";
import { recordWatchAuditEvent, recordWatchAuditEvents } from "./utils/watchAudit.js";
import { canReceiveState } from "./utils/syncRoles.js";
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
const RECENT_UNWATCH_IMPORT_GUARD_MS = 5 * 60 * 1000;

export function recentUnwatchBlocksLibraryImport(playstate = null, now = Date.now()) {
  return playstate?.state === "unwatched"
    && Number(playstate.updated_at || 0) > 0
    && now - Number(playstate.updated_at) <= RECENT_UNWATCH_IMPORT_GUARD_MS;
}

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
const PLEX_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.PLEX_UNWATCHED_POLL_INTERVAL_MS || 60 * 1000);
let lastPlexUnwatchedPollAt = 0;

// Emby/Jellyfin webhooks natively report unwatch (unlike Plex), so this is a
// backstop for a missed/misconfigured webhook or a server that was offline
// when the change happened, not the primary detection path.
const EMBY_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.EMBY_UNWATCHED_POLL_INTERVAL_MS || 60 * 1000);
let lastEmbyUnwatchedPollAt = 0;
const JELLYFIN_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.JELLYFIN_UNWATCHED_POLL_INTERVAL_MS || 60 * 1000);
let lastJellyfinUnwatchedPollAt = 0;

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
    ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
    ...targetStates.map((targetState) => `Target ${targetState.target} progress status: ${targetState.status}${targetState.detail ? ` - ${targetState.detail}` : ""}`),
  ].join("\n");
}

function cachedRowToMedia(row) {
  const session = hydrateCachedSession(row);
  const client = session.client && typeof session.client === "object" ? session.client : {};
  return {
    ...session,
    type: session.mediaType,
    source: session.source || row.source_platform,
    device: session.device || session.deviceName || client.deviceName || "",
    deviceId: session.deviceId || client.deviceId || "",
    clientName: session.clientName || client.client || client.product || client.platform || "",
    clientVersion: session.clientVersion || client.version || "",
    user: session.user || client.userName || "",
    isValid: Boolean(session.title && (session.mediaType === "movie" || session.mediaType === "episode") && session.source),
  };
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

// Condenses a repeated-skip list into one readable clause, so a run reports
// "skipped 14 item(s) (A, B, C and 11 more)" instead of 14 separate lines.
function summariseTitles(titles, max = 3) {
  const unique = [...new Set(titles.filter(Boolean))];
  if (unique.length <= max) return unique.join(", ");
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

// Delegates to the memoized resolver in plexClient.js so the per-minute
// scheduled sync and playstate operations share one cached /accounts lookup.
async function resolvePlexTargetAccountId(plexConfig, username, logger = console.log) {
  try {
    return await resolvePlexAccountId({ ...plexConfig, username });
  } catch (error) {
    logger(`Plex account mapping failed: ${error.message}`);
    return null;
  }
}

export function plexHistoryItemMatchesConfiguredUser(item = {}, { username = "", accountId = null, accountScoped = false } = {}) {
  if (!username) return true;

  const itemAccountId = plexAccountIdFromItem(item);
  if (itemAccountId != null && accountId != null) {
    return itemAccountId === accountId;
  }

  const itemUsernames = plexUsernamesFromItem(item);
  if (itemUsernames.length) {
    return itemUsernames.includes(username);
  }

  // Plex omits User/Account from library-section results, even when the
  // request is explicitly scoped with accountID. Preserve that request
  // provenance so a valid, server-filtered result is not discarded.
  return accountScoped && accountId != null;
}

async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
  const timestamp = Date.now();
  const targetStates = Array.isArray(summary.targetStates) ? summary.targetStates : [];
  const auditBase = {
    timestamp,
    eventType: "sync_dispatch",
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
      payload: { targetStates, scheduled: true },
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
      sessionId: media.sessionId || media.id || "",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
      provenance: media.watchProvenance || media.watch_provenance || null,
    },
  }).catch((error) => console.error("Failed to append scheduled sync history", error));
}

async function checkPlexUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.plex?.baseUrl || !config.plex?.token) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const plexWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("plex")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target plex status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && plexWasConfirmedWatched(record),
  ).slice(0, 30);

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "plex",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const plexItem = await findPlexItem(config.plex, media);
      if (plexItem) {
        const isWatched = Boolean(plexItem.viewCount && Number(plexItem.viewCount) > 0);
        if (!isWatched) {
          const plexMedia = { ...media, itemId: plexItem.ratingKey || plexItem.key || undefined };
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(plexMedia, "plex", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            console.log("Cron ignored Plex unplayed state after Plembfin's own played mark", { title: record.title });
            continue;
          }

          console.log("Cron detected Plex item marked unwatched; storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(plexMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) await recordSyncHistory(plexMedia, result.summary, "unwatched");
          await invalidateHistoryDerivedCaches().catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Plex unwatched status for '${record.title}':`, error);
    }
  }
}

// Emby/Jellyfin equivalent of checkPlexUnwatchedStatus above. Their webhooks
// natively report unwatch (Plex's cannot), so this only backstops a missed or
// misconfigured webhook, or a change made while the server was unreachable -
// not the primary detection path.
async function checkEmbyUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const embyWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("emby")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target emby status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && embyWasConfirmedWatched(record),
  ).slice(0, 30);
  if (!records.length) return;

  const { findEmbyItems } = await import("./utils/embyClient.js");

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "emby",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const items = await findEmbyItems(config.emby, media);
      const item = items?.[0];
      if (item) {
        const isWatched = isEmbyLikePlayed(item);
        if (!isWatched) {
          const embyMedia = { ...media, itemId: item.Id || undefined };
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(embyMedia, "emby", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            console.log("Cron ignored Emby unplayed state after Plembfin's own played mark", { title: record.title });
            continue;
          }

          console.log("Cron detected Emby item marked unwatched; storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(embyMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) await recordSyncHistory(embyMedia, result.summary, "unwatched");
          await invalidateHistoryDerivedCaches().catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Emby unwatched status for '${record.title}':`, error);
    }
  }
}

async function checkJellyfinUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const jellyfinWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("jellyfin")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target jellyfin status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && jellyfinWasConfirmedWatched(record),
  ).slice(0, 30);
  if (!records.length) return;

  const { findJellyfinItems } = await import("./utils/jellyfinClient.js");

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "jellyfin",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const items = await findJellyfinItems(config.jellyfin, media);
      const item = items?.[0];
      if (item) {
        const isWatched = isEmbyLikePlayed(item);
        if (!isWatched) {
          const jellyfinMedia = { ...media, itemId: item.Id || undefined };
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(jellyfinMedia, "jellyfin", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            console.log("Cron ignored Jellyfin unplayed state after Plembfin's own played mark", { title: record.title });
            continue;
          }

          console.log("Cron detected Jellyfin item marked unwatched; storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(jellyfinMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) await recordSyncHistory(jellyfinMedia, result.summary, "unwatched");
          await invalidateHistoryDerivedCaches().catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Jellyfin unwatched status for '${record.title}':`, error);
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

  // Date the watch from when the session was last seen playing, not from when
  // this tick noticed it disappeared. For a session completing normally the two
  // are within a minute of each other; for one that lingered in the cache
  // (server restart, a tick that could not reach the media server) the last-seen
  // time is the real watch time and the current time would be wrong.
  const lastSeenAt = Number(row.updated_at || 0);
  recordWatchAuditEvent({
    eventType: "playback_ended",
    timestamp: lastSeenAt > 0 ? lastSeenAt : Date.now(),
    action: "playback",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type,
    title: media.title,
    source: media.source,
    sourceEvent: media.event,
    phase: "ended",
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: row.session_id,
    user: media.user,
    device: media.device,
    deviceId: media.deviceId,
    client: media.clientName,
    clientVersion: media.clientVersion,
    status: "completed",
    details: "Live playback session ended after reaching the watched threshold.",
    payload: { progress: media.progress, offsetMs: media.offsetMs, durationMs: media.durationMs },
  });

  const watchRecord = mediaToWatchRecord(
    {
      title: media.title,
      type: media.type,
      source: media.source,
      ids: media.ids,
      season: media.season,
      episode: media.episode,
      posterUrl: media.posterUrl,
      watched_at: lastSeenAt > 0 ? new Date(lastSeenAt).toISOString() : undefined,
      watchProvenance: buildWatchProvenance(
        {
          source: media.source,
          event: media.event || "playback.complete",
          phase: "completed",
          sessionId: row.session_id,
          user: media.user,
          device: media.device,
          deviceId: media.deviceId,
          client: media.clientName,
          clientVersion: media.clientVersion,
        },
        {
          ingestPath: "live_session",
          sourceTimestamp: lastSeenAt > 0 ? new Date(lastSeenAt).toISOString() : "",
        },
      ),
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

  recordWatchAuditEvent({
    eventType: "playback_ended",
    timestamp: Number(row.updated_at || 0) || Date.now(),
    action: "playback",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type,
    title: media.title,
    source: media.source,
    sourceEvent: media.event,
    phase: "ended",
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: row.session_id,
    user: media.user,
    device: media.device,
    deviceId: media.deviceId,
    client: media.clientName,
    clientVersion: media.clientVersion,
    status: "stopped",
    details: "Live playback session ended before the watched threshold; resume progress was retained.",
    payload: { progress: media.progress, offsetMs: media.offsetMs, durationMs: media.durationMs },
  });

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

// Resume progress is re-evaluated on every tick, so an item that is correctly
// skipped repeats the same line every minute indefinitely. Remember the last
// outcome per item and only log when it actually changes.
const lastResumeOutcome = new Map();
const LAST_RESUME_OUTCOME_MAX = 500;

function logResumeSkip(logger, media, outcome) {
  const key = `${media.source}|${media.title}|${media.season ?? ""}|${media.episode ?? ""}`;
  if (lastResumeOutcome.get(key) === outcome) return;
  if (lastResumeOutcome.size >= LAST_RESUME_OUTCOME_MAX) lastResumeOutcome.clear();
  lastResumeOutcome.set(key, outcome);
  logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (${outcome})`);
}

function clearResumeOutcome(media) {
  lastResumeOutcome.delete(`${media.source}|${media.title}|${media.season ?? ""}|${media.episode ?? ""}`);
}

async function syncResumableMedia(media, config, loopStore, logger = console.log) {
  if (!shouldSyncResumeProgress(media)) {
    logResumeSkip(logger, media, "not actionable");
    return false;
  }

  const existingPlaystate = await getPlaystateForMedia(media).catch(() => null);
  const resumeUpdatedAt = Number(media.updatedAt || 0);
  const playstateUpdatedAt = Number(existingPlaystate?.updated_at || 0);

  // After an authoritative restore, ignore resume positions whose app-side timestamp predates
  // the restore â€” they are pre-restore state the backup has already superseded.
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (lastRestoreAt && resumeUpdatedAt > 0 && resumeUpdatedAt <= lastRestoreAt) {
    logResumeSkip(logger, media, "pre-restore resume position");
    return false;
  }


  if (existingPlaystate?.state === "unwatched" && (resumeUpdatedAt <= 0 || playstateUpdatedAt >= resumeUpdatedAt)) {
    await deletePlaybackProgress(media).catch(() => null);
    logResumeSkip(logger, media, "item is unwatched");
    return false;
  }

  if (existingPlaystate && (existingPlaystate.state === "watched" || (resumeUpdatedAt > 0 && playstateUpdatedAt >= resumeUpdatedAt))) {
    await deletePlaybackProgress(media).catch(() => null);
    logResumeSkip(logger, media, existingPlaystate.state === "watched" ? "item is watched" : "newer playstate");
    return false;
  }

  const existingProgress = await getPlaybackProgressForMedia(media).catch(() => null);
  const progressUpdatedAt = Number(existingProgress?.updated_at || 0);


  if (existingProgress && resumeUpdatedAt <= 0 && resumePositionUnchanged(existingProgress, media)) {
    logResumeSkip(logger, media, "unchanged resume progress without timestamp");
    return false;
  }

  if (existingProgress && resumeUpdatedAt > 0 && progressUpdatedAt >= resumeUpdatedAt) {
    logResumeSkip(logger, media, "stale resume progress");
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
  clearResumeOutcome(media);
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
  const username = configuredPlexUsername(config);
  let syncedCount = 0;

  const targetAccountId = await resolvePlexTargetAccountId(config.plex, username, logger);
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

    const historyRes = await fetchPlexWithRefresh(config.plex, historyUrl);
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
      const sectionsRes = await fetchPlexWithRefresh(config.plex, sectionsUrl);
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

          const sectionRes = await fetchPlexWithRefresh(config.plex, sectionAllUrl);
          if (sectionRes.ok) {
            const sectionData = await sectionRes.json();
            const metadata = sectionData?.MediaContainer?.Metadata || [];
            recentlyViewedItems.push(...metadata.map((item) => ({ item, accountScoped: targetAccountId != null, kind: "section" })));
          }
        }
      } else {
        logger(`Plex sections fetch failed: HTTP ${sectionsRes.status}`);
      }
    } catch (err) {
      logger(`Plex sections check failed: ${err.message}`);
    }

    // Combine and deduplicate
    const allItems = [
      ...items.map((item) => ({ item, accountScoped: targetAccountId != null, kind: "history" })),
      ...recentlyViewedItems,
    ];
    const seenKeys = new Set();
    const uniqueItems = [];

    for (const candidate of allItems) {
      const { item, accountScoped, kind } = candidate;
      if (!plexHistoryItemMatchesConfiguredUser(item, { username, accountId: targetAccountId, accountScoped })) continue;
      if (item.type !== "movie" && item.type !== "episode") continue;
      if (kind === "section" && Number(item.viewCount || 0) <= 0) continue;

      const { watchedAt } = watchedAtForPlexItem(item);
      if (!watchedAt) {
        logger(`Plex: skipped watched item without a source view timestamp: ${item.title || item.grandparentTitle || "unknown"}`);
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
      media.watchProvenance = buildWatchProvenance(
        { source: "plex", event: "library_history", phase: "completed", itemId: item.ratingKey, user: username },
        { ingestPath: "plex_scheduled_library_history", sourceTimestamp: watchedAt },
      );
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      if (recentUnwatchBlocksLibraryImport(playstate)) {
        logger(`Plex: ignored stale watched row immediately after unwatch: ${media.title}`);
        continue;
      }
      const existing = await findWatchedByAnyMediaKey(media);

      // Marking an item played on Plex bumps its lastViewedAt, so plembfin's own
      // outbound sync makes an already-recorded watch look freshly viewed on the
      // next poll. Only an item with no watch record at all counts as a new watch
      // here; when the record exists but the playstate has drifted, repair the
      // playstate rather than filing a second watch for the same play.
      if (existing && playstate?.state !== "watched") {
        logger(`Plex: repaired playstate for an already-recorded watch: ${media.title}`);
        await upsertPlaystateForMedia(media, "watched", existing.watched_at, { skipInvalidate: true });
        continue;
      }

      if (!existing) {
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
  const skippedNoPlayedDate = [];
  let skippedApiMarked = 0;
  try {
    const { fetchEmbyWatchedItems } = await import("./utils/embyClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchEmbyWatchedItems(config.emby, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
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

      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item);

      media.watchProvenance = buildWatchProvenance(
        { source: "emby", event: "library_history", phase: "completed", itemId: item.Id, user: config.emby.userId },
        { ingestPath: "emby_scheduled_library_history", sourceTimestamp: watchedAt },
      );

      if (!watchedAt) {
        // "marked without playback" means we (or another tool) set the played
        // flag over the API, so there is nothing to ingest and nothing wrong.
        // Only a genuinely missing date is worth naming.
        if (watchedAtReason === "marked without playback") skippedApiMarked++;
        else skippedNoPlayedDate.push(media.title);
        continue;
      }

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      if (recentUnwatchBlocksLibraryImport(playstate)) {
        logger(`Emby: ignored stale watched row immediately after unwatch: ${media.title}`);
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
  if (skippedNoPlayedDate.length) {
    logger(`Emby: skipped ${skippedNoPlayedDate.length} watched item(s) without a played date (${summariseTitles(skippedNoPlayedDate)}).`);
  }
  if (skippedApiMarked && isVerboseLogging()) {
    logger(`Emby: ignored ${skippedApiMarked} item(s) flagged played without playback (marked over the API, nothing to ingest).`);
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
  const skippedNoPlayedDate = [];
  let skippedApiMarked = 0;
  try {
    const { fetchJellyfinWatchedItems } = await import("./utils/jellyfinClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchJellyfinWatchedItems(config.jellyfin, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
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

      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item);

      media.watchProvenance = buildWatchProvenance(
        { source: "jellyfin", event: "library_history", phase: "completed", itemId: item.Id, user: config.jellyfin.userId },
        { ingestPath: "jellyfin_scheduled_library_history", sourceTimestamp: watchedAt },
      );

      if (!watchedAt) {
        if (watchedAtReason === "marked without playback") skippedApiMarked++;
        else skippedNoPlayedDate.push(media.title);
        continue;
      }

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      if (recentUnwatchBlocksLibraryImport(playstate)) {
        logger(`Jellyfin: ignored stale watched row immediately after unwatch: ${media.title}`);
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
  if (skippedNoPlayedDate.length) {
    logger(`Jellyfin: skipped ${skippedNoPlayedDate.length} watched item(s) without a played date (${summariseTitles(skippedNoPlayedDate)}).`);
  }
  if (skippedApiMarked && isVerboseLogging()) {
    logger(`Jellyfin: ignored ${skippedApiMarked} item(s) flagged played without playback (marked over the API, nothing to ingest).`);
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
    // History is already cached in memory. Inspect the complete canonical set
    // so older imports are repaired too; the outbound batch limit below still
    // keeps each scheduler tick bounded.
    const rows = await getCachedHistory();

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
        watchProvenance: row.watch_provenance || null,
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
        ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
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

async function runScheduledSyncCore(logger = console.log, { forceCatchup = false } = {}) {
  if (isCronSyncPaused()) {
    logger("Scheduled Sync: skipped because cron sync is paused (likely due to restore in progress).");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }

  // Per-phase narration is worth showing when a user explicitly triggered a
  // catch-up run (workerCoordinator passes forceCatchup and surfaces the job
  // log), but on the per-minute background tick it was ~9 lines every minute
  // whether or not anything happened. The end-of-run summary still logs, and
  // is itself suppressed when the run was a complete no-op.
  const trace = forceCatchup || isVerboseLogging() ? logger : () => {};

  trace("Scheduled Sync: starting background sync workflow...");
  const runtime = await loadRuntimeState();
  
  // Stale operation recovery happens before the scheduler claims this lock.
  // Once this wrapper owns the scheduled marker, the core must not clear
  // another operation's state directly.
  // so it is NEVER un-blocked here â€” that prevents the cron from running mid-push and re-importing
  const operation = activeSyncOperation(runtime);
  const blockingOperation = operation && operation.kind !== SYNC_OPERATION_SCHEDULED;
  if (runtime.rebuildActive === true || runtime.forceSyncActive === true || runtime.restoreSyncActive === true || blockingOperation) {
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
  // events missed while the socket was disconnected (and manual changes for which Plex
  // emits no timeline event), checked once a minute with confirmed-watched gating
  // (PLEX_UNWATCHED_POLL_INTERVAL_MS) so it never drives detection or re-scans every tick.
  if (plexActive && Date.now() - lastPlexUnwatchedPollAt >= PLEX_UNWATCHED_POLL_INTERVAL_MS) {
    lastPlexUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Plex unwatched status (fallback poll)...");
    await checkPlexUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkPlexUnwatchedStatus failed: ${error.message}`);
    });
  }

  // Emby/Jellyfin webhooks report unwatch natively, so these are a backstop
  // for a missed webhook - same fallback-poll role as the Plex check above.
  if (embyActive && Date.now() - lastEmbyUnwatchedPollAt >= EMBY_UNWATCHED_POLL_INTERVAL_MS) {
    lastEmbyUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Emby unwatched status (fallback poll)...");
    await checkEmbyUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkEmbyUnwatchedStatus failed: ${error.message}`);
    });
  }

  if (jellyfinActive && Date.now() - lastJellyfinUnwatchedPollAt >= JELLYFIN_UNWATCHED_POLL_INTERVAL_MS) {
    lastJellyfinUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Jellyfin unwatched status (fallback poll)...");
    await checkJellyfinUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkJellyfinUnwatchedStatus failed: ${error.message}`);
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
    if (forceCatchup) logger("Scheduled Sync: running requested recent-item repair...");
    else trace(`Scheduled Sync: running catch-up library checks (interval: ${CATCHUP_SYNC_INTERVAL_MS / 60000}m)...`);

    if (plexActive) {
      try {
        trace("Scheduled Sync: checking Plex recently watched...");
        plexSynced = await syncRecentlyWatchedFromPlex(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Plex sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        trace("Scheduled Sync: checking Emby recently watched...");
        embySynced = await syncRecentlyWatchedFromEmby(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        trace("Scheduled Sync: checking Jellyfin recently watched...");
        jellyfinSynced = await syncRecentlyWatchedFromJellyfin(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Jellyfin sync failed: ${error.message}`);
      }
    }

    if (plexActive) {
      try {
        trace("Scheduled Sync: checking Plex continue watching...");
        plexResumeSynced = await syncRecentlyResumableFromPlex(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Plex resume sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        trace("Scheduled Sync: checking Emby continue watching...");
        embyResumeSynced = await syncRecentlyResumableFromEmby(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby resume sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        trace("Scheduled Sync: checking Jellyfin continue watching...");
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
    trace(`Scheduled Sync: live sessions: ${currentRows.length}, cached sessions in tracking: ${cachedRows.length}`);
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

// Scheduled polling also participates in the shared operation lock. Without
// this boundary a Force Sync could claim the lock while a scheduler tick that
// started a moment earlier was still dispatching a watchstate write.
export async function runScheduledSync(logger = console.log, options = {}) {
  const ownerId = `scheduled:${process.env.PLEMBFIN_INSTANCE_ID || process.pid}:${Date.now()}`;
  const staleBefore = Date.now() - 3 * 60 * 1000;
  let runtime = await loadRuntimeState().catch(() => ({}));
  let existing = activeSyncOperation(runtime);
  if (existing && existing.heartbeat < staleBefore) {
    const staleValues = existing.kind === SYNC_OPERATION_FORCE
      ? {
        forceSyncActive: false,
        forceSyncCancelRequested: true,
        forceSyncHeartbeat: Date.now(),
        forceSyncResult: { success: false, aborted: true, cancelled: true, reset: true, reason: "Stale Force Sync was recovered by the scheduler." },
      }
      : [RESTORE_KIND_FULL_SYNC, RESTORE_KIND_BACKUP, "restore"].includes(existing.kind)
        ? {
          restoreSyncActive: false,
          restoreSyncRunId: "",
          restoreSyncKind: "",
          restoreSyncCancelRequested: true,
          restoreSyncHeartbeat: Date.now(),
          restoreSyncResult: { success: false, aborted: true, cancelled: true, reset: true, reason: "Stale restore was recovered by the scheduler." },
        }
        : { scheduledSyncActive: false, scheduledSyncHeartbeat: Date.now() };
    logger(`Scheduled Sync: clearing stale ${existing.kind} operation marker...`);
    const cleared = await clearSyncOperation({ kind: existing.kind, values: staleValues }).catch(() => ({ ok: false }));
    if (cleared.ok) {
      runtime = await loadRuntimeState().catch(() => ({}));
      existing = activeSyncOperation(runtime);
    }
  }

  const claim = await claimSyncOperation({
    kind: SYNC_OPERATION_SCHEDULED,
    ownerId,
    activeField: "scheduledSyncActive",
    startedAt: Date.now(),
    values: {
      scheduledSyncStartedAt: Date.now(),
      scheduledSyncHeartbeat: Date.now(),
    },
  });
  if (!claim?.ok) {
    logger(`Scheduled Sync: skipped because ${claim?.active?.kind || "another sync operation"} is active.`);
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true, reason: "sync-operation-active" };
  }

  const heartbeat = setInterval(() => {
    touchSyncOperation({
      kind: SYNC_OPERATION_SCHEDULED,
      ownerId,
      values: { scheduledSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }, 30_000);
  heartbeat.unref?.();
  try {
    return await runScheduledSyncCore(logger, options);
  } finally {
    clearInterval(heartbeat);
    await releaseSyncOperation({
      kind: SYNC_OPERATION_SCHEDULED,
      ownerId,
      values: { scheduledSyncActive: false, scheduledSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }
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

export async function runForceSync(logger = console.log, {
  concurrency = 1,
  planId = "",
  operationOwnerId = "",
  isCancelled = async () => false,
} = {}) {
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

  const ownerId = String(operationOwnerId || crypto.randomUUID());
  const startedAt = Date.now();
  logger("Force Sync: claiming the shared sync-operation lock...");
  const claim = await claimSyncOperation({
    kind: SYNC_OPERATION_FORCE,
    ownerId,
    activeField: "forceSyncActive",
    startedAt,
    values: {
      forceSyncRunId: ownerId,
      forceSyncStartedAt: startedAt,
      forceSyncHeartbeat: startedAt,
      forceSyncCancelRequested: false,
      forceSyncResult: null,
    },
  });
  if (!claim?.ok) {
    const active = claim?.active;
    const label = active?.kind === SYNC_OPERATION_FORCE ? "another Force Sync" : `another sync operation (${active?.kind || "unknown"})`;
    logger(`Force Sync ERROR: ${label} is already active.`);
    throw new Error(`${label.charAt(0).toUpperCase()}${label.slice(1)} is already active.`);
  }

  const heartbeatTimer = setInterval(() => {
    touchSyncOperation({
      kind: SYNC_OPERATION_FORCE,
      ownerId,
      values: { forceSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }, 30_000);
  heartbeatTimer.unref?.();

  try {
    logger("Force Sync: loading media configuration...");
    const config = await loadMediaConfig();
    if (planId) {
      return await executeForceSyncPlan(planId, config, logger, { shouldCancel: isCancelled });
    }
    const loopStore = createLoopStore();

  const hasPlex = !config.plex?.disabled && Boolean(config.plex?.baseUrl && config.plex?.token);
  const hasEmby = !config.emby?.disabled && Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId);
  const hasJellyfin = !config.jellyfin?.disabled && Boolean(config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId);

  const configuredServers = [
    hasPlex ? "plex" : "",
    hasEmby ? "emby" : "",
    hasJellyfin ? "jellyfin" : "",
  ].filter(Boolean);
  const watchedTargets = configuredServers.filter((server) => canReceiveState(config, server, "watched"));
  const unwatchedTargets = configuredServers.filter((server) => canReceiveState(config, server, "unwatched"));
  const activeTargets = [...new Set([...watchedTargets, ...unwatchedTargets])];

  if (configuredServers.length === 0) {
    logger("Force Sync: no active media servers are configured or enabled. Aborting.");
    return { success: true, activeTargets, stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 } };
  }

  if (activeTargets.length === 0) {
    logger("Force Sync: all configured servers are source-only or disabled for receiving state; no remote writes are permitted.");
    return { success: true, activeTargets, stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 } };
  }

  logger(`Force Sync: receiving targets resolved: ${activeTargets.join(", ")}`);
  const scanFailures = new Map();

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
          const { watchedAt } = watchedAtForPlexItem(item);
          const media = {
            title: item.title,
            type: item.type,
            season: item.parentIndex != null ? Number(item.parentIndex) : null,
            episode: item.index != null ? Number(item.index) : null,
            imdb: null,
            tmdb: null,
            tvdb: null,
            source: "plex",
            timestamp: watchedAt
              ? new Date(watchedAt)
              : null,
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
        scanFailures.set("plex", err.message || String(err));
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
        logger(`Emby: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item);
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
        scanFailures.set("emby", err.message || String(err));
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
        logger(`Jellyfin: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item);
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
        scanFailures.set("jellyfin", err.message || String(err));
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  const [plexResults, embyResults, jellyfinResults] = await Promise.all(fetchPromises);
  const allWatchedItems = [...plexResults, ...embyResults, ...jellyfinResults];
  logger(`Force Sync: collected ${allWatchedItems.length} total watched items across all platforms.`);
  const healthyWatchedTargets = watchedTargets.filter((target) => !scanFailures.has(target));
  const healthyUnwatchedTargets = unwatchedTargets.filter((target) => !scanFailures.has(target));
  if (scanFailures.size) {
    logger(`Force Sync: ${scanFailures.size} server scan${scanFailures.size === 1 ? "" : "s"} failed; those servers are excluded from all remote writes.`);
  }

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

  // 5. Plembfin history is the canonical set of items to consider. Remote-only
  // watched items are deliberately ignored; a platform cannot manufacture a
  // new canonical watch during Force Sync.
  const allConsideredKeys = new Set(historyMap.keys());
  logger(`Force Sync: resolving Plembfin-canonical watched state for ${allConsideredKeys.size} distinct items...`);

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
    cancelled: true,
    stats: {
      totalWatchedFoundAcrossServers: watchedMap.size,
      addedToHistory: addedToHistoryCount,
      deletedFromHistory: deletedFromHistoryCount,
      propagatedUpdates: propagatedCount,
      processed: processedCount,
      scanErrors: Object.fromEntries(scanFailures),
    }
  });

  const checkEvery = reconciliationConcurrency > 1 ? 20 : 5;
  let cancellationChecks = 0;
  async function shouldAbort() {
    if (abortResult) return true;
    cancellationChecks += 1;
    if (cancellationChecks !== 1 && cancellationChecks % checkEvery !== 0) return false;
    const currentRuntime = await loadRuntimeState();
    const requested = await isCancelled().catch(() => false);
    if (requested || currentRuntime.forceSyncCancelRequested === true) {
      logger("Force Sync: stop request detected. Aborting sync...");
      abortResult = abortSummary();
      return true;
    }
    return false;
  }

  function reportProgress() {
    const reportEvery = Math.max(checkEvery, Math.ceil(consideredKeys.length / 100));
    if (processedCount === 1 || processedCount === consideredKeys.length || processedCount % reportEvery === 0) {
      logger(`Force Sync progress: ${processedCount}/${consideredKeys.length} items.`);
    }
  }

  async function markPlayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexPlayed } = await import("./utils/plexClient.js");
      return markPlexPlayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyPlayed } = await import("./utils/embyClient.js");
      return markEmbyPlayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinPlayed } = await import("./utils/jellyfinClient.js");
      return markJellyfinPlayed(config.jellyfin, mediaObj);
    }
    return null;
  }

  async function markUnplayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexUnplayed } = await import("./utils/plexClient.js");
      return markPlexUnplayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyUnplayed } = await import("./utils/embyClient.js");
      return markEmbyUnplayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinUnplayed } = await import("./utils/jellyfinClient.js");
      return markJellyfinUnplayed(config.jellyfin, mediaObj);
    }
    return null;
  }

  async function processConsideredKey(key) {
    if (await shouldAbort()) return false;

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
    let mediaObj = serverWatchedEntry ? serverWatchedEntry.media : null;

    if (serverWatchedEntry) {
      serverWatchedOn = serverWatchedEntry.group.watchedOn;
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

    if (!mediaObj) return true;

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

      for (const target of healthyWatchedTargets) {
        if (!serverWatchedOn.has(target)) {
          logger(`Propagating: marking played "${mediaObj.title}" on ${target}`);
          try {
            await recordOutboundPlayedMarks(mediaObj, [target], loopStore).catch(() => null);
            const result = await markPlayedTarget(target, mediaObj);
            if (result?.status !== "not_found") {
              const itemIds = Array.isArray(result?.itemIds) && result.itemIds.length
                ? result.itemIds
                : result?.itemId
                  ? [result.itemId]
                  : [];
              if (itemIds.length) {
                await Promise.all(itemIds.map((itemId) => recordOutboundPlayedMarks({ ...mediaObj, itemId }, [target], loopStore).catch(() => null)));
              } else {
                await recordOutboundPlayedMarks(mediaObj, [target], loopStore).catch(() => null);
              }
            }
            if (result?.status !== "not_found") propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark played for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    } else {
      // The unwatched marker is already the canonical Plembfin decision. Do
      // not delete or recreate local history based on a remote discrepancy.
      logger(`Plembfin is canonical for "${mediaObj.title}"; only repairing remote played flags.`);

      for (const target of healthyUnwatchedTargets) {
        if (serverWatchedOn.has(target)) {
          logger(`Propagating: marking unplayed "${mediaObj.title}" on ${target}`);
          try {
            await recordOutboundUnplayedMarks(mediaObj, [target], loopStore).catch(() => null);
            const result = await markUnplayedTarget(target, mediaObj);
            if (result?.status !== "not_found") {
              const itemIds = Array.isArray(result?.itemIds) && result.itemIds.length
                ? result.itemIds
                : result?.itemId
                  ? [result.itemId]
                  : [];
              if (itemIds.length) {
                await Promise.all(itemIds.map((itemId) => recordOutboundUnplayedMarks({ ...mediaObj, itemId }, [target], loopStore).catch(() => null)));
              } else {
                await recordOutboundUnplayedMarks(mediaObj, [target], loopStore).catch(() => null);
              }
            }
            if (result?.status !== "not_found") propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark unwatched for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    }
    return true;
  }

  if (reconciliationConcurrency > 1) {
    await runWithConcurrency(consideredKeys, reconciliationConcurrency, async (key) => {
      const completed = await processConsideredKey(key);
      if (completed) {
        processedCount += 1;
        reportProgress();
      }
    });
  } else {
    for (const key of consideredKeys) {
      const completed = await processConsideredKey(key);
      if (completed) {
        processedCount += 1;
        reportProgress();
      }
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
      propagatedUpdates: propagatedCount,
      processed: processedCount,
      scanErrors: Object.fromEntries(scanFailures),
    }
  };
  } finally {
    clearInterval(heartbeatTimer);
    await invalidateHistoryDerivedCaches().catch(() => null);
    await releaseSyncOperation({
      kind: SYNC_OPERATION_FORCE,
      ownerId,
      values: {
        forceSyncActive: false,
        forceSyncCancelRequested: false,
        forceSyncHeartbeat: Date.now(),
      },
    }).catch(() => null);
  }
}
