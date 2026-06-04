import { shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { findPlexItem } from "./utils/plexClient.js";
import { buildCacheRow, fetchLiveSessions, hydrateCachedSession } from "./utils/liveSessions.js";
import { appendSyncHistory, loadMediaConfig, setRuntimeState } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import { db } from "./firebase.js";
import {
  deleteLiveTrackingCacheRows,
  deletePlaybackProgress,
  deleteWatchRecordById,
  insertWatchRecord,
  loadLiveTrackingCache,
  markLiveTrackingComplete,
  mediaKeyFor,
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
          const summary = await syncMediaUnplayedPlaystate({ ...media, isValid: true, source: "plex" }, config, loopStore);
          await recordSyncHistory({ ...media, isValid: true, source: "plex" }, summary, "unwatched");
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
  await recordSyncHistory(media, syncSummary, "watched");
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
  await recordSyncHistory(media, syncSummary, "progress");

  return { media, telemetry, status: syncSummary.status };
}

async function syncRecentlyWatchedFromPlex(config, loopStore) {
  if (!config.plex?.baseUrl || !config.plex?.token) return 0;

  const baseUrl = config.plex.baseUrl.replace(/\/+$/, "");
  const token = config.plex.token;
  const username = config.plex.username || "";
  let syncedCount = 0;

  let targetAccountId = 1;
  if (username && username.toLowerCase() !== "admin" && username.toLowerCase() !== "owner") {
    try {
      const accountsUrl = new URL(`${baseUrl}/accounts`);
      accountsUrl.searchParams.set("X-Plex-Token", token);
      const accountsRes = await fetch(accountsUrl, { headers: { Accept: "application/json" } });
      if (accountsRes.ok) {
        const accountsData = await accountsRes.json();
        const accounts = accountsData?.MediaContainer?.Account || [];
        const matchedAccount = accounts.find(
          (acc) => acc.name && acc.name.toLowerCase() === username.toLowerCase()
        );
        if (matchedAccount) {
          targetAccountId = Number(matchedAccount.id);
        }
      }
    } catch (err) {
      console.error("Failed to map Plex username to account ID", err);
    }
  }

  try {
    const historyUrl = new URL(`${baseUrl}/status/sessions/history/all`);
    historyUrl.searchParams.set("X-Plex-Token", token);
    historyUrl.searchParams.set("X-Plex-Container-Start", "0");
    historyUrl.searchParams.set("X-Plex-Container-Size", "20");

    const historyRes = await fetch(historyUrl, { headers: { Accept: "application/json" } });
    if (!historyRes.ok) {
      console.error("Failed to fetch Plex history in cron", historyRes.status);
      return 0;
    }

    const historyData = await historyRes.json();
    const items = historyData?.MediaContainer?.Metadata || [];

    for (const item of items) {
      if (Number(item.accountID) !== targetAccountId) continue;
      if (item.type !== "movie" && item.type !== "episode") continue;

      const media = {
        title: item.title,
        type: item.type,
        source: "plex",
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
        media.title = `${item.grandparentTitle} - S${String(media.season || "?").padStart(2, "0")}E${String(media.episode || "?").padStart(2, "0")}`;
      }

      const key = mediaKeyFor(media);
      const watchedAt = new Date(Number(item.viewedAt) * 1000).toISOString();

      const existing = await db
        .collection("watchHistory")
        .where("mediaKey", "==", key)
        .where("watchedAt", "==", watchedAt)
        .limit(1)
        .get();

      if (existing.empty) {
        console.log(`Cron detected new Plex watch event in history: ${media.title} watched at ${watchedAt}`);
        const watchRecord = mediaToWatchRecord(media, "plex");
        watchRecord.watched_at = watchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: plex`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Plex library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(requireDb(), watchRecord);
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

        await updateWatchTelemetry(requireDb(), result.id, telemetry);
        await recordSyncHistory(media, summary, "watched");
        syncedCount++;
      }
    }
  } catch (error) {
    console.error("Error in syncRecentlyWatchedFromPlex", error);
  }

  return syncedCount;
}

async function syncPendingManualDispatches(config, loopStore) {
  let syncedCount = 0;
  try {
    const snapshot = await db
      .collection("watchHistory")
      .where("syncAction", "==", "watched")
      .get();
    
    const pendingDocs = snapshot.docs.filter((doc) => {
      const data = doc.data() || {};
      const telemetry = data.syncDispatchTelemetry || "";
      return telemetry.includes("Dispatch status: pending");
    });

    for (const doc of pendingDocs) {
      const data = doc.data();
      const media = {
        title: data.title,
        type: data.mediaType,
        source: data.source,
        ids: {
          imdb: data.ids?.imdb || undefined,
          tmdb: data.ids?.tmdb || undefined,
          tvdb: data.ids?.tvdb || undefined,
        },
        season: data.season == null ? undefined : Number(data.season),
        episode: data.episode == null ? undefined : Number(data.episode),
      };

      console.log(`Cron detected pending manual sync dispatch: ${media.title}`);
      const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Outbound sync failed: ${error.message || String(error)}`,
        targetStates: [],
      }));

      const telemetry = [
        `Origin: ${media.source}`,
        `Loop-check: Passed`,
        `Dispatch status: ${summary.status}`,
        `Details: Manual watch state propagated; sync completed.`,
        ...summary.targetStates.map(
          (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
        ),
      ].join("\n");

      await updateWatchTelemetry(requireDb(), doc.id, telemetry);
      await recordSyncHistory(media, summary, "watched");
      syncedCount++;
    }
  } catch (error) {
    console.error("Error in syncPendingManualDispatches", error);
  }
  return syncedCount;
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

  let plexSynced = 0;
  let manualSynced = 0;
  try {
    plexSynced = await syncRecentlyWatchedFromPlex(config, loopStore);
  } catch (error) {
    console.error("Failed to run syncRecentlyWatchedFromPlex", error);
  }

  try {
    manualSynced = await syncPendingManualDispatches(config, loopStore);
  } catch (error) {
    console.error("Failed to run syncPendingManualDispatches", error);
  }

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

  if (currentRows.length || completions.length || progressUpdates.length || staleIds.length || plexSynced || manualSynced) {
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }

  return {
    sessions: currentRows.length,
    completions: completions.length,
    progressUpdates: progressUpdates.length,
    removed: staleIds.length,
    cached: cachedById.size,
    plexHistorySynced: plexSynced,
    manualDispatchesSynced: manualSynced,
  };
}
