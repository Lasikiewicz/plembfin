import { createLoopStore } from "./utils/loopStore.js";
import { activeSyncOperation, appendSyncHistory, loadMediaConfig, loadRuntimeState, setRuntimeState, SYNC_OPERATION_SCHEDULED } from "./utils/configStore.js";
import { createPlexNotificationListener } from "./utils/plexNotificationListener.js";
import { createPlexAdaptivePoller } from "./utils/plexAdaptivePoller.js";
import { fetchPlexContainerEpisodes, fetchPlexMetadataItem, findPlexItem } from "./utils/plexClient.js";
import { buildPlexMediaFromMetadata } from "./utils/parsers.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "./utils/watchProvenance.js";
import { listActiveSessions } from "./utils/activeSessions.js";
import { runScheduledSync } from "./scheduled.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { watchedThresholdPercent } from "./utils/tuning.js";
import { isRecentOutboundUnplayedFlagEcho, lastOutboundPlayedMarkAt, syncCanonicalPlaystate, syncMediaPlaystate } from "./utils/syncOrchestrator.js";
import { applyUnwatchedTransition } from "./utils/watchStateTransitions.js";
import { shouldRepairRecentPlexUnwatch } from "./utils/plexWatchstate.js";
import { pollConnectedTrackers } from "./utils/trackerSync.js";
import { getTmdbDetails, prewarmTmdbLibrary } from "./utils/tmdbGateway.js";
import { cachedNextAiringFor, mergeNextAiringCacheEntries, nextAiringCacheEntryStale, nextAiringCacheKey, readNextAiringCache } from "./utils/nextAiringCache.js";
import { refreshUpcomingCalendarCache } from "./utils/upcomingCalendarCache.js";
import { runScheduledWatchBackup, runScheduledRemoteWatchBackup } from "./utils/watchHistoryBackups.js";
import { runScheduledPlembfinBackup } from "./utils/plembfinBackups.js";
import { pruneSyncPlans } from "./utils/syncPlans.js";
import {
  deletePlaybackProgress,
  findWatchedByAnyMediaKey,
  getCachedShows,
  getPlaystateForMedia,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  listRecentTrackedWatchRows,
  mediaToWatchRecord,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
  loadLiveTrackingCache,
} from "./utils/dataRepo.js";
import { resolvePlexWatchDate } from "./utils/watchDates.js";

const NEXT_AIRING_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const UPCOMING_CALENDAR_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const NEXT_AIRING_REFRESH_LIMIT = 40;
let lastNextAiringRefreshAt = 0;
let nextAiringInitialBuildPending = true;
let lastUpcomingCalendarRefreshAt = 0;

function playbackTitleKey(value = "") {
  return String(value || "").toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, "").trim();
}

function parseLivePayload(row = {}) {
  try {
    const payload = JSON.parse(row.payload_json || "{}");
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function livePlaybackMatchesMedia(row = {}, media = {}) {
  if (String(row.source_platform || row.source || "").toLowerCase() !== "plex") return false;
  const payload = parseLivePayload(row);
  const rowSeason = row.season ?? payload.season;
  const rowEpisode = row.episode ?? payload.episode;
  if (media.season != null && rowSeason != null && Number(media.season) !== Number(rowSeason)) return false;
  if (media.episode != null && rowEpisode != null && Number(media.episode) !== Number(rowEpisode)) return false;
  const title = row.title || payload.title || "";
  return playbackTitleKey(title) === playbackTitleKey(media.title);
}

async function hasRecentPlexThresholdPlayback(media) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const [activeRows, trackedRows] = await Promise.all([
    listActiveSessions().catch(() => []),
    loadLiveTrackingCache({ includeCompleted: true }).catch(() => []),
  ]);

  const activeEvidence = activeRows.some((row) =>
    livePlaybackMatchesMedia({
      source_platform: row.source,
      title: row.title,
      last_progress: row.progress,
      updated_at: row.updatedAt,
      payload_json: JSON.stringify(row),
    }, media)
    && Number(row.progress || 0) >= watchedThresholdPercent()
    && Number(row.updatedAt || 0) >= cutoff,
  );
  if (activeEvidence) return true;

  return trackedRows.some((row) =>
    livePlaybackMatchesMedia(row, media)
    && Number(row.last_progress || 0) >= watchedThresholdPercent()
    && Math.max(Number(row.updated_at || 0), Number(row.completed_at || 0)) >= cutoff,
  );
}

// Plex's library notification stream reports the resulting watched flag, but
// it does not say whether the user watched through the configured threshold or
// clicked "Mark watched". A recent threshold-reaching live session is the
// deciding evidence; without it, a server-supplied lastViewedAt is the time of
// the manual click and must not become the historical watch date.
export function resolvePlexNotificationWatchDate(metadata = {}, { hasPlaybackEvidence = false } = {}) {
  return resolvePlexWatchDate(metadata, { hasPlaybackEvidence });
}

async function refreshNextAiringCache({ limit = NEXT_AIRING_REFRESH_LIMIT, forceAll = false } = {}) {
  const cache = await readNextAiringCache();
  const shows = await getCachedShows();
  const candidates = shows
    .map((show) => {
      const key = nextAiringCacheKey(show.tmdb_id, show.title);
      const cached = cachedNextAiringFor(cache.entries, show.tmdb_id, show.title);
      const status = show.status || cached?.status || "";
      return { ...show, key, cached, status };
    })
    .filter((show) => show.key && show.tmdb_id && (forceAll || nextAiringCacheEntryStale(show.cached, show.status)))
    .sort((a, b) => Number(a.cached?.updatedAt || 0) - Number(b.cached?.updatedAt || 0))
    .slice(0, Math.max(1, Number(limit) || NEXT_AIRING_REFRESH_LIMIT));

  if (!candidates.length) return { checked: 0, written: 0 };
  console.log(`Next airing cache refresh: checking ${candidates.length} show${candidates.length === 1 ? "" : "s"}${forceAll ? " (full build)" : ""}...`);

  const updates = [];
  for (const show of candidates) {
    try {
      // Cache-honest on purpose: the TMDB/TVDB gateways already hold TV details
      // for at most a day (returning series), which is fresh enough for an
      // airing calendar - forcing a refetch here would bypass the entire cache
      // layer for up to 40 shows every 30 minutes. This refresh's own TTLs
      // (nextAiringCacheEntryStale) govern how often shows are rechecked.
      const details = await getTmdbDetails({ mediaType: "tv", tmdbId: show.tmdb_id, title: show.title });
      updates.push({
        key: show.key,
        title: show.title,
        tmdbId: show.tmdb_id,
        nextAiringDate: details?.next_airing_date || details?.next_episode_to_air?.air_date || "",
        status: details?.status || show.status || "",
      });
    } catch (error) {
      console.error(`Failed to refresh next airing for ${show.title}`, error);
      updates.push({
        key: show.key,
        title: show.title,
        tmdbId: show.tmdb_id,
        nextAiringDate: show.cached?.nextAiringDate || "",
        status: show.status || "",
      });
    }
  }

  const result = await mergeNextAiringCacheEntries(updates);
  console.log(`Next airing cache refresh complete: checked ${candidates.length}, wrote ${result.written || 0}.`);
  return { checked: candidates.length, written: result.written || 0 };
}

const scheduledTasksInFlight = new Map();

async function runWithTimeBudget(label, task, timeoutMs) {
  if (scheduledTasksInFlight.has(label)) {
    console.warn(`${label} is still running from a previous tick; skipping this tick.`);
    return;
  }
  let timeout;
  const taskPromise = Promise.resolve()
    .then(task)
    .finally(() => scheduledTasksInFlight.delete(label));
  scheduledTasksInFlight.set(label, taskPromise);
  try {
    await Promise.race([
      taskPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.error(`${label} failed`, error);
  } finally {
    clearTimeout(timeout);
  }
}

// Invoked once per minute by the elected worker coordinator.
export async function runScheduledTick({ isLeader = () => true } = {}) {
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  pruneSyncPlans();
  // A large outstanding backlog (checkUnwatched + recently-watched/resumable
  // polling across all three platforms, then up to 15 manual-dispatch
  // retries) can genuinely take longer than one minute to finish a full
  // pass. runWithTimeBudget's Promise.race does not cancel the underlying
  // task on timeout - it keeps running in the background and still reaches
  // its own cache-invalidation and completion logging - so a tight budget
  // here does not prevent progress, it only manufactures a misleading
  // recurring timeout error and delays when that progress becomes visible
  // (e.g. to /api/sync-jobs, which depends on the invalidation at the end of
  // the run). scheduledTasksInFlight already guards against two overlapping
  // runs, so a generous budget is safe even if a pass runs past one tick.
  await runWithTimeBudget("Scheduled sync", () => runScheduledSync(), 120_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  await runWithTimeBudget("Tracker watched-state poll", () => pollConnectedTrackers(), 45_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  await runWithTimeBudget("Scheduled watch-history backup", () => runScheduledWatchBackup(), 30_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  await runWithTimeBudget("Scheduled remote watch-history backup", () => runScheduledRemoteWatchBackup(), 60_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  await runWithTimeBudget("Scheduled Plembfin backup", () => runScheduledPlembfinBackup(), 30_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  await runWithTimeBudget("TMDB prewarm", () => prewarmTmdbLibrary({ limit: 4 }), 30_000);
  if (Date.now() - lastNextAiringRefreshAt > NEXT_AIRING_REFRESH_INTERVAL_MS) {
    if (!isLeader()) return { skipped: true, reason: "lease-lost" };
    lastNextAiringRefreshAt = Date.now();
    const forceAll = nextAiringInitialBuildPending;
    nextAiringInitialBuildPending = false;
    await runWithTimeBudget("Next airing cache refresh", () => refreshNextAiringCache({ forceAll }), 45_000);
  }
  if (Date.now() - lastUpcomingCalendarRefreshAt > UPCOMING_CALENDAR_REFRESH_INTERVAL_MS) {
    if (!isLeader()) return { skipped: true, reason: "lease-lost" };
    lastUpcomingCalendarRefreshAt = Date.now();
    await runWithTimeBudget("Upcoming calendar cache refresh", () => refreshUpcomingCalendarCache(), 50_000);
  }
  return { skipped: false };
}

// ---------------------------------------------------------------------------
// Plex real-time watch-state detection
//
// Plex never sends a webhook when an item is marked unwatched, so we listen on its
// notification WebSocket. When a movie/episode timeline event arrives, we resolve the
// ratingKey to its current metadata, confirm it actually went to unwatched, and (if we
// previously tracked it as watched) run the same propagation as a manual unwatch â€” which
// fans out to Emby and Jellyfin via the configured ID/title matching.
// ---------------------------------------------------------------------------

let plexNotificationListener = null;

async function handlePlexLibraryItemChange(ratingKey, metadataOverride = null) {
  if (!watchedPlayedSyncEnabled()) return;

  const restoreRuntime = await loadRuntimeState().catch(() => ({}));
  const activeOperation = activeSyncOperation(restoreRuntime);
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) {
    console.log("Plex notifications: ignored library change during sync operation", { ratingKey, operation: activeOperation.kind });
    return;
  }

  const config = await loadMediaConfig().catch(() => null);
  if (!config?.plex?.baseUrl || !config.plex.token || config.plex.disabled) return;

  const metadata = metadataOverride || await fetchPlexMetadataItem(config.plex, ratingKey).catch((error) => {
    console.error(`Plex notification: metadata lookup failed for ratingKey ${ratingKey}: ${error.message}`);
    return null;
  });
  if (!metadata) return;

  if (["show", "season"].includes(String(metadata.type || "").toLowerCase())) {
    const episodes = await fetchPlexContainerEpisodes(config.plex, ratingKey, metadata.type).catch((error) => {
      console.error(`Plex notification: failed to expand ${metadata.type} ratingKey ${ratingKey}: ${error.message}`);
      return [];
    });
    console.log("Plex notifications: expanding bulk TV watch-state change", {
      ratingKey,
      type: metadata.type,
      episodes: episodes.length,
    });
    const concurrency = 6;
    for (let index = 0; index < episodes.length; index += concurrency) {
      const batch = episodes.slice(index, index + concurrency);
      await Promise.allSettled(batch.map((episode) =>
        handlePlexLibraryItemChange(String(episode.ratingKey || ""), episode)
      ));
    }
    return;
  }

  // Only movies and episodes carry a watch state we sync.
  const media = buildPlexMediaFromMetadata(metadata, { phase: Number(metadata.viewCount || 0) > 0 ? "completed" : "unplayed" });
  if (!media?.isValid || !["movie", "episode"].includes(media.type)) return;

  // Still watched or only partially watched â†’ this isn't an unwatch event.
  const viewCount = Number(metadata.viewCount || 0);
  const viewOffset = Number(metadata.viewOffset || 0);
  if (viewCount > 0) {
    const playstate = await getPlaystateForMedia(media).catch(() => null);
    const watchDate = resolvePlexNotificationWatchDate(metadata, {
      hasPlaybackEvidence: await hasRecentPlexThresholdPlayback(media),
    });
    const watchedAt = watchDate.watchedAt;
    if (!watchedAt) {
      console.log("Plex notifications: skipped watched item without a playback timestamp or release date", {
        title: media.title,
        ratingKey,
      });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    media.watched_at = watchedAt;

    media.watchProvenance = buildWatchProvenance(
      { source: "plex", event: "notification.viewstate", phase: "completed", itemId: ratingKey },
      { ingestPath: "plex_notification", sourceTimestamp: watchDate.sourceTimestamp, note: watchDate.note },
    );

    const loopStore = createLoopStore();
    const isNewerWatch = playstate?.watched_at && new Date(watchedAt).getTime() > new Date(playstate.watched_at).getTime() + 10000;

    // Plex stamps lastViewedAt when *we* mark an item played, so every outbound
    // sync makes an already-recorded watch look freshly viewed here. A view time
    // that lines up with our own write is our echo, not a new play. The window
    // is wide enough to absorb clock skew between plembfin and the Plex server
    // while staying shorter than any real playthrough.
    const ownMarkAt = await lastOutboundPlayedMarkAt(media, "plex", loopStore);
    const isOwnMarkEcho =
      ownMarkAt > 0 && Math.abs(new Date(watchedAt).getTime() - ownMarkAt) <= 10 * 60 * 1000;

    if (isOwnMarkEcho || (playstate?.state === "watched" && !isNewerWatch)) {
      if (isOwnMarkEcho) {
        console.log("Plex notifications: ignored view timestamp from our own played mark", {
          title: media.title,
          ratingKey,
          watchedAt,
        });
      }
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    // The playstate check above can miss an already-recorded watch when the
    // stored playstate row sits under a different media_key than this
    // notification resolves to (e.g. one source matched by imdb, another by
    // title fallback) - the exact mismatch behind today's Silo/Trying/Cape
    // Fear phantom watches. findWatchedByAnyMediaKey has the same
    // coordinate/provider-id fallback matching every other ingest path
    // relies on for this; treat a hit there as conclusive too, not just an
    // exact playstate match.
    const existingByAnyKey = await findWatchedByAnyMediaKey(media).catch(() => null);
    if (existingByAnyKey && !isNewerWatch) {
      console.log("Plex notifications: already recorded under a different key; repairing playstate instead of logging a new watch", {
        title: media.title,
        ratingKey,
      });
      await upsertPlaystateForMedia(media, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    const watchRecord = mediaToWatchRecord(media, "plex");
    watchRecord.watched_at = watchedAt;
    watchRecord.sync_action = "watched";
    watchRecord.sync_dispatch_telemetry = [
      "Origin: plex",
      "Dispatch status: pending",
      "Details: Plex library watch-state notification received.",
      ...provenanceTelemetryLines(media.watchProvenance),
    ].join("\n");

    console.log("Plex notifications: item marked watched, storing and propagating", {
      title: media.title,
      ratingKey,
      type: media.type,
    });

    const result = await insertWatchRecord(watchRecord, { skipInvalidate: true });
    await upsertPlaystateForMedia(media, "watched", watchedAt, { skipInvalidate: true });
    const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Plex watch-state propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    const telemetry = [
      "Origin: plex",
      `Dispatch status: ${summary.status || "unknown"}`,
      `Details: ${summary.details || "Plex library watch-state notification processed."}`,
      ...provenanceTelemetryLines(media.watchProvenance),
      ...(summary.targetStates || []).map((state) => `Target ${state.target} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`),
    ].join("\n");
    await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
    await appendSyncHistory({
      mediaType: media.type,
      title: media.title,
      source: "plex",
      status: summary.status,
      details: summary.details,
      action: "watched",
      targetStates: summary.targetStates || [],
      rawPayloadDebug: { ratingKey, ids: media.ids || {}, provenance: media.watchProvenance || null },
    }).catch(() => null);
    await deletePlaybackProgress(media).catch(() => null);
    await result.assetPrefetch?.catch(() => null);
    await invalidateHistoryDerivedCaches().catch(() => null);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return;
  }
  if (viewOffset > 0) {
    // Plex's "Mark Unwatched" clears viewCount but can leave a stale viewOffset
    // behind, so a lingering offset alone doesn't distinguish a genuine unwatch
    // from a fresh in-progress first watch. Only bail when we have no record of
    // this item ever being watched - otherwise treat it as a real unwatch.
    const priorPlaystate = await getPlaystateForMedia(media).catch(() => null);
    if (priorPlaystate?.state !== "watched") return;
    const hasPlaybackEvidence = await hasRecentPlexThresholdPlayback(media);
    if (shouldRepairRecentPlexUnwatch({ playstate: priorPlaystate, viewOffset, hasPlaybackEvidence })) {
      console.log("Plex notifications: held back transient unwatch after threshold playback; restoring watched state", {
        title: media.title,
        ratingKey,
        viewOffset,
      });
      const repairLoopStore = createLoopStore();
      await syncCanonicalPlaystate({ ...media, itemId: ratingKey }, config, repairLoopStore, "watched", {
        includeTrackers: false,
      }).catch((error) => {
        console.error("Plex notifications: failed to restore watched state after transient unwatch", {
          title: media.title,
          ratingKey,
          error,
        });
      });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }
    console.log("Plex notifications: unwatch detected despite lingering viewOffset", {
      title: media.title,
      ratingKey,
      viewOffset,
    });
  }

  const loopStore = createLoopStore();
  if (viewCount === 0) {
    const ownUnplayedEcho = await isRecentOutboundUnplayedFlagEcho({ ...media, itemId: ratingKey }, "plex", loopStore).catch(() => false);
    if (ownUnplayedEcho) {
      console.log("Plex notifications: ignored outbound unplayed echo", { ratingKey, title: media.title });
      return;
    }
  }

  console.log("Plex notifications: item marked unwatched, storing and propagating", {
    title: media.title,
    ratingKey,
    type: media.type,
  });

  try {
    const result = await applyUnwatchedTransition({ ...media, itemId: ratingKey }, config, loopStore);
    if (result.alreadyUnwatched) return;
    const summary = result.summary;
    await appendSyncHistory({
      mediaType: media.type,
      title: media.title,
      source: media.source,
      status: summary.status,
      details: summary.details,
      action: "unwatched",
      targetStates: summary.targetStates || [],
      rawPayloadDebug: { ratingKey, ids: media.ids || {}, provenance: media.watchProvenance || null },
    }).catch(() => null);
  } catch (error) {
    console.error(`Plex notification unwatched-state propagation failed for "${media.title}"`, error);
  } finally {
    await invalidateHistoryDerivedCaches().catch(() => null);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }
}

export function startPlexNotificationListener() {
  if (!plexNotificationListener) {
    plexNotificationListener = createPlexNotificationListener({
      getPlexConfig: async () => {
        const config = await loadMediaConfig();
        return config?.plex || null;
      },
      onLibraryItemChange: handlePlexLibraryItemChange,
      logger: console.log,
    });
  }
  plexNotificationListener.start();
}

export function restartPlexNotificationListener() {
  if (!plexNotificationListener) {
    startPlexNotificationListener();
    return;
  }
  plexNotificationListener.restart();
}

export function stopPlexNotificationListener() {
  plexNotificationListener?.stop();
}

async function checkPlexUnwatchedFast(plexConfig) {
  if (!watchedPlayedSyncEnabled()) return false;
  if (!plexConfig?.baseUrl || !plexConfig?.token || plexConfig.disabled) return false;

  const restoreRuntime = await loadRuntimeState().catch(() => ({}));
  const activeOperation = activeSyncOperation(restoreRuntime);
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) return false;

  const loopStore = createLoopStore();
  const plexWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("plex")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target plex status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 50, includeScheduled: true })).filter(
    (record) => plexWasConfirmedWatched(record),
  ).slice(0, 10);

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

      const plexItem = await findPlexItem(plexConfig, media);
      if (plexItem) {
        const isWatched = Boolean(plexItem.viewCount && Number(plexItem.viewCount) > 0);
        if (!isWatched) {
          const plexMedia = { ...media, itemId: plexItem.ratingKey || plexItem.key || undefined };
          const config = await loadMediaConfig().catch(() => null);
          const priorPlaystate = await getPlaystateForMedia(plexMedia).catch(() => null);
          const hasPlaybackEvidence = await hasRecentPlexThresholdPlayback(plexMedia);
          if (shouldRepairRecentPlexUnwatch({
            playstate: priorPlaystate,
            viewOffset: plexItem.viewOffset,
            hasPlaybackEvidence,
          })) {
            console.log("Plex adaptive poller: held back transient unwatch after threshold playback; restoring watched state", {
              title: record.title,
              ratingKey: plexMedia.itemId,
              viewOffset: Number(plexItem.viewOffset || 0),
            });
            await syncCanonicalPlaystate(plexMedia, config, loopStore, "watched", { includeTrackers: false }).catch((error) => {
              console.error("Plex adaptive poller: failed to restore watched state after transient unwatch", {
                title: record.title,
                ratingKey: plexMedia.itemId,
                error,
              });
            });
            await deletePlaybackProgress(plexMedia).catch(() => null);
            continue;
          }
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(plexMedia, "plex", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            continue;
          }

          console.log("Plex adaptive poller: item marked unwatched, storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(plexMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) {
            await appendSyncHistory({
              mediaType: plexMedia.type,
              title: plexMedia.title,
              source: "plex",
              status: result.summary.status,
              details: result.summary.details,
              action: "unwatched",
              targetStates: result.summary.targetStates || [],
              rawPayloadDebug: { ratingKey: plexMedia.itemId, ids: plexMedia.ids || {} },
            }).catch(() => null);
          }
          await invalidateHistoryDerivedCaches().catch(() => null);
          await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
          return true;
        }
      }
    } catch {
      // quiet on individual lookup failures
    }
  }
  return false;
}

let plexAdaptivePoller = null;

export function startPlexAdaptivePoller() {
  if (!plexAdaptivePoller) {
    plexAdaptivePoller = createPlexAdaptivePoller({
      getPlexConfig: async () => {
        const config = await loadMediaConfig();
        return config?.plex || null;
      },
      onLibraryItemChange: handlePlexLibraryItemChange,
      checkUnwatched: checkPlexUnwatchedFast,
      logger: console.log,
    });
  }
  plexAdaptivePoller.start();
}

export function restartPlexAdaptivePoller() {
  if (!plexAdaptivePoller) {
    startPlexAdaptivePoller();
    return;
  }
  plexAdaptivePoller.restart();
}

export function stopPlexAdaptivePoller() {
  plexAdaptivePoller?.stop();
}

export function pokePlexAdaptivePoller() {
  plexAdaptivePoller?.poke();
}
