import { createLoopStore } from "./utils/loopStore.js";
import { appendSyncHistory, loadMediaConfig } from "./utils/configStore.js";
import { createPlexNotificationListener } from "./utils/plexNotificationListener.js";
import { fetchPlexMetadataItem } from "./utils/plexClient.js";
import { buildPlexMediaFromMetadata } from "./utils/parsers.js";
import { runScheduledSync } from "./scheduled.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { syncMediaPlaystate } from "./utils/syncOrchestrator.js";
import { getTmdbDetails, prewarmTmdbLibrary } from "./utils/tmdbGateway.js";
import { cachedNextAiringFor, mergeNextAiringCacheEntries, nextAiringCacheEntryStale, nextAiringCacheKey, readNextAiringCache } from "./utils/nextAiringCache.js";
import { refreshUpcomingCalendarCache } from "./utils/upcomingCalendarCache.js";
import { runScheduledWatchBackup } from "./utils/watchHistoryBackups.js";
import { runScheduledPlembfinBackup } from "./utils/plembfinBackups.js";
import {
  deletePlaybackProgress,
  findWatchedByAnyMediaKey,
  getCachedShows,
  getPlaystateForMedia,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  mediaToWatchRecord,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
} from "./utils/dataRepo.js";
import { applyManualUnwatch } from "./routes/sync.js";

const NEXT_AIRING_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const UPCOMING_CALENDAR_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const NEXT_AIRING_REFRESH_LIMIT = 40;
let lastNextAiringRefreshAt = 0;
let nextAiringInitialBuildPending = true;
let lastUpcomingCalendarRefreshAt = 0;

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
      // airing calendar — forcing a refetch here would bypass the entire cache
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

// Invoked once per minute by the in-process scheduler in server.js.
export async function runScheduledTick() {
  await runWithTimeBudget("Scheduled sync", () => runScheduledSync(), 50_000);
  await runWithTimeBudget("Scheduled watch-history backup", () => runScheduledWatchBackup(), 30_000);
  await runWithTimeBudget("Scheduled Plembfin backup", () => runScheduledPlembfinBackup(), 30_000);
  await runWithTimeBudget("TMDB prewarm", () => prewarmTmdbLibrary({ limit: 4 }), 30_000);
  if (Date.now() - lastNextAiringRefreshAt > NEXT_AIRING_REFRESH_INTERVAL_MS) {
    lastNextAiringRefreshAt = Date.now();
    const forceAll = nextAiringInitialBuildPending;
    nextAiringInitialBuildPending = false;
    await runWithTimeBudget("Next airing cache refresh", () => refreshNextAiringCache({ forceAll }), 45_000);
  }
  if (Date.now() - lastUpcomingCalendarRefreshAt > UPCOMING_CALENDAR_REFRESH_INTERVAL_MS) {
    lastUpcomingCalendarRefreshAt = Date.now();
    await runWithTimeBudget("Upcoming calendar cache refresh", () => refreshUpcomingCalendarCache(), 50_000);
  }
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

async function handlePlexLibraryItemChange(ratingKey) {
  if (!watchedPlayedSyncEnabled()) return;

  const config = await loadMediaConfig().catch(() => null);
  if (!config?.plex?.baseUrl || !config.plex.token || config.plex.disabled) return;

  const metadata = await fetchPlexMetadataItem(config.plex, ratingKey).catch((error) => {
    console.error(`Plex notification: metadata lookup failed for ratingKey ${ratingKey}: ${error.message}`);
    return null;
  });
  if (!metadata) return;

  // Only movies and episodes carry a watch state we sync.
  const media = buildPlexMediaFromMetadata(metadata);
  if (!media?.isValid || !["movie", "episode"].includes(media.type)) return;

  // Still watched or only partially watched â†’ this isn't an unwatch event.
  const viewCount = Number(metadata.viewCount || 0);
  const viewOffset = Number(metadata.viewOffset || 0);
  if (viewCount > 0) {
    const playstate = await getPlaystateForMedia(media).catch(() => null);
    if (playstate?.state === "watched") {
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }
    if (!playstate) {
      const watched = await findWatchedByAnyMediaKey({ ...media, syncAction: "watched" }).catch(() => null);
      if (watched) return;
    }

    const watchedAtSeconds = Number(metadata.lastViewedAt || metadata.viewedAt || 0);
    const watchedAt = watchedAtSeconds > 0
      ? new Date(watchedAtSeconds * 1000).toISOString()
      : new Date().toISOString();
    const watchRecord = mediaToWatchRecord(media, "plex");
    watchRecord.watched_at = watchedAt;
    watchRecord.sync_action = "watched";
    watchRecord.sync_dispatch_telemetry = "Origin: plex\nDispatch status: pending\nDetails: Plex library watch-state notification received.";

    console.log("Plex notifications: item marked watched, storing and propagating", {
      title: media.title,
      ratingKey,
      type: media.type,
    });

    const result = await insertWatchRecord(watchRecord, { skipInvalidate: true });
    await upsertPlaystateForMedia(media, "watched", watchedAt, { skipInvalidate: true });
    const summary = await syncMediaPlaystate(media, config, createLoopStore()).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Plex watch-state propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    const telemetry = [
      "Origin: plex",
      `Dispatch status: ${summary.status || "unknown"}`,
      `Details: ${summary.details || "Plex library watch-state notification processed."}`,
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
      rawPayloadDebug: { ratingKey, ids: media.ids || {} },
    }).catch(() => null);
    await deletePlaybackProgress(media).catch(() => null);
    await result.assetPrefetch?.catch(() => null);
    await invalidateHistoryDerivedCaches().catch(() => null);
    return;
  }
  if (viewOffset > 0) return;

  // Only propagate if our store currently considers this item watched. This avoids
  // reacting to items we never tracked and short-circuits the echo when an unwatch that
  // originated on Emby/Jellyfin was just propagated *into* Plex (the originating flow has
  // already flipped our playstate to "unwatched").
  const playstate = await getPlaystateForMedia(media).catch(() => null);
  if (playstate?.state === "unwatched") return;
  if (playstate?.state !== "watched") {
    const watched = await findWatchedByAnyMediaKey({ ...media, syncAction: "watched" }).catch(() => null);
    if (!watched) return;
  }

  console.log("Plex notifications: item marked unwatched, propagating to Emby/Jellyfin", {
    title: media.title,
    ratingKey,
    type: media.type,
  });

  const loopStore = createLoopStore();
  try {
    await applyManualUnwatch(media, config, loopStore);
  } catch (error) {
    console.error(`Plex notification unwatch propagation failed for "${media.title}"`, error);
  } finally {
    await invalidateHistoryDerivedCaches().catch(() => null);
  }
}

export function startPlexNotificationListener() {
  if (!plexNotificationListener) {
    plexNotificationListener = createPlexNotificationListener({
      getPlexConfig: async () => {
        const config = await loadMediaConfig().catch(() => null);
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
