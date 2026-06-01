import { shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { findPlexItem } from "./utils/plexClient.js";
import { buildCacheRow, fetchLiveSessions, hydrateCachedSession } from "./utils/liveSessions.js";
import { loadMediaConfig, setRuntimeState } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import {
  deleteLiveTrackingCacheRows,
  deletePlaybackProgress,
  deleteWatchRecordById,
  insertWatchRecord,
  loadLiveTrackingCache,
  markLiveTrackingComplete,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  purgeCompletedLiveTrackingCache,
  queryWatchHistory,
  requireDb,
  updatePlaybackProgressTelemetry,
  updateWatchTelemetry,
  upsertLiveTrackingCache,
  upsertPlaybackProgress,
} from "./utils/firestoreRepo.js";

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

async function checkPlexUnwatchedStatus(config, loopStore) {
  if (!config.plex?.baseUrl || !config.plex?.token) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const records = (await queryWatchHistory(null, { limit: 100 })).filter(
    (record) =>
      record.watched_at < threeMinutesAgo &&
      (["plex", "plex_initial_sync"].includes(record.source) || String(record.sync_dispatch_telemetry || "").includes("Target Plex status: success")),
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
          await deleteWatchRecordById(record.id);
          await syncMediaUnplayedPlaystate({ ...media, isValid: true, source: "plex" }, config, loopStore);
        }
      }
    } catch (error) {
      console.error(`Error checking Plex unwatched status for '${record.title}':`, error);
    }
  }
}

async function processCompletedSession(row, config, loopStore) {
  const media = cachedRowToMedia(row);
  if (!media.isValid || Number(media.progress || 0) < 90) return null;

  await markLiveTrackingComplete(requireDb(), row.session_id, Date.now());

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

  const inserted = await insertWatchRecord(requireDb(), watchRecord);
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
  await updateWatchTelemetry(requireDb(), inserted.id, telemetry);
  await deletePlaybackProgress(requireDb(), media).catch((error) => {
    console.error("Failed to clear completed resume progress", { sessionId: row.session_id, error });
  });

  return { ...inserted, telemetry };
}

async function processStoppedSessionProgress(row, config, loopStore) {
  const media = cachedRowToMedia(row);
  if (!shouldSyncResumeProgress(media)) return null;

  const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
  await upsertPlaybackProgress(requireDb(), {
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
  await updatePlaybackProgressTelemetry(requireDb(), progressRecord, telemetry).catch((error) => {
    console.error("Failed to update stopped session resume telemetry", { sessionId: row.session_id, error });
  });

  return { media, telemetry, status: syncSummary.status };
}

export async function runScheduledSync() {
  await setRuntimeState({ lastCronExecution: Date.now() }).catch(() => null);
  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  const hasConfiguredSources = Boolean(config?.plex?.baseUrl && config?.plex?.token) || Boolean(config?.emby?.baseUrl && config?.emby?.apiKey) || Boolean(config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey);

  if (!hasConfiguredSources) {
    console.log("Scheduled live tracking sync skipped; no configured media servers were found.");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }

  await checkPlexUnwatchedStatus(config, loopStore).catch((error) => {
    console.error("Failed to run checkPlexUnwatchedStatus", error);
  });

  const currentSessions = await fetchLiveSessions(config);
  const currentRows = currentSessions.map(buildCacheRow);
  const currentIds = new Set(currentRows.map((row) => row.session_id));
  const cachedRows = await loadLiveTrackingCache(requireDb(), { includeCompleted: true });
  const cachedById = new Map(cachedRows.map((row) => [row.session_id, row]));
  const completions = [];
  const progressUpdates = [];
  const staleIds = [];

  await upsertLiveTrackingCache(requireDb(), currentRows);

  for (const row of cachedRows) {
    if (currentIds.has(row.session_id)) continue;
    if (row.completed_at) continue;

    if (Number(row.last_progress || 0) >= 90) {
      const completion = await processCompletedSession(row, config, loopStore).catch((error) => {
        console.error("Live tracking completion failed", { sessionId: row.session_id, error });
        return null;
      });
      if (completion) completions.push(completion);
      else staleIds.push(row.session_id);
      continue;
    }

    const progressUpdate = await processStoppedSessionProgress(row, config, loopStore).catch((error) => {
      console.error("Live tracking resume progress failed", { sessionId: row.session_id, error });
      return null;
    });
    if (progressUpdate) progressUpdates.push(progressUpdate);
    staleIds.push(row.session_id);
  }

  await deleteLiveTrackingCacheRows(requireDb(), staleIds);
  await purgeCompletedLiveTrackingCache(requireDb());

  if (currentRows.length || completions.length || progressUpdates.length || staleIds.length) {
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }

  return {
    sessions: currentRows.length,
    completions: completions.length,
    progressUpdates: progressUpdates.length,
    removed: staleIds.length,
    cached: cachedById.size,
  };
}
