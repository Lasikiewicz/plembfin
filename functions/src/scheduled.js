import { shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { findPlexItem } from "./utils/plexClient.js";
import { buildCacheRow, fetchLiveSessions, hydrateCachedSession } from "./utils/liveSessions.js";
import { appendSyncHistory, loadMediaConfig, loadRuntimeState, setRuntimeState } from "./utils/configStore.js";
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

async function syncRecentlyWatchedFromPlex(config, loopStore, logger = console.log) {
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
      logger(`Plex account mapping failed: ${err.message}`);
    }
  }

  try {
    const historyUrl = new URL(`${baseUrl}/status/sessions/history/all`);
    historyUrl.searchParams.set("X-Plex-Token", token);
    historyUrl.searchParams.set("X-Plex-Container-Start", "0");
    historyUrl.searchParams.set("X-Plex-Container-Size", "20");

    const historyRes = await fetch(historyUrl, { headers: { Accept: "application/json" } });
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
      sectionsUrl.searchParams.set("X-Plex-Token", token);
      const sectionsRes = await fetch(sectionsUrl, { headers: { Accept: "application/json" } });
      if (sectionsRes.ok) {
        const sectionsData = await sectionsRes.json();
        const directories = sectionsData?.MediaContainer?.Directory || [];
        for (const dir of directories) {
          const sectionId = dir.key;
          const type = dir.type;
          if (type !== "movie" && type !== "show") continue;

          const sectionAllUrl = new URL(`${baseUrl}/library/sections/${sectionId}/all`);
          sectionAllUrl.searchParams.set("X-Plex-Token", token);
          sectionAllUrl.searchParams.set("sort", "viewedAt:desc");
          sectionAllUrl.searchParams.set("X-Plex-Container-Start", "0");
          sectionAllUrl.searchParams.set("X-Plex-Container-Size", "20");
          if (type === "movie") {
            sectionAllUrl.searchParams.set("type", "1");
          } else {
            sectionAllUrl.searchParams.set("type", "4"); // Episode
          }

          const sectionRes = await fetch(sectionAllUrl, { headers: { Accept: "application/json" } });
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
      if (item.accountID && Number(item.accountID) !== targetAccountId) continue;
      if (item.type !== "movie" && item.type !== "episode") continue;

      const viewedAtTime = item.viewedAt || item.lastViewedAt;
      if (!viewedAtTime) continue;

      const dedupeKey = `${item.ratingKey || item.key}-${viewedAtTime}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      uniqueItems.push({ item, viewedAtTime });
    }

    for (const { item, viewedAtTime } of uniqueItems) {
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
        media.title = `${item.grandparentTitle} - S${String(media.season || "?").padStart(2, "0")}E${String(media.episode || "?").padStart(2, "0")}`;
      }

      const key = mediaKeyFor(media);
      const watchedAt = new Date(Number(viewedAtTime) * 1000).toISOString();

      const existing = await db
        .collection("watchHistory")
        .where("mediaKey", "==", key)
        .where("watchedAt", "==", watchedAt)
        .limit(1)
        .get();

      if (existing.empty) {
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
    logger(`Plex sync recently watched failed: ${error.message}`);
  }

  return syncedCount;
}

async function syncRecentlyWatchedFromEmby(config, loopStore, logger = console.log) {
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return 0;
  let syncedCount = 0;
  try {
    const { fetchEmbyWatchedItems } = await import("./utils/embyClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchEmbyWatchedItems(config.emby);
    
    for (const item of raw) {
      const ids = normalizeProviderIds(item.ProviderIds);
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
        source: "emby",
        isValid: true,
      };

      const key = mediaKeyFor(media);
      const hasLastPlayed = Boolean(item.UserData?.LastPlayedDate);
      // For items without a precise timestamp use a stable synthetic date (midnight UTC)
      // so repeated cron runs produce the same watchedAt and the dedup query succeeds.
      const watchedAt = hasLastPlayed
        ? new Date(item.UserData.LastPlayedDate).toISOString()
        : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();

      // Always dedup by mediaKey; add watchedAt filter only when we have a precise timestamp.
      let query = db.collection("watchHistory").where("mediaKey", "==", key);
      if (hasLastPlayed) {
        query = query.where("watchedAt", "==", watchedAt);
      }

      const existing = await query.limit(1).get();

      if (existing.empty) {
        logger(`Emby: detected new watched item: ${media.title} (played date: ${hasLastPlayed ? watchedAt : "manually marked"})`);
        const watchRecord = mediaToWatchRecord(media, "emby");
        watchRecord.watched_at = watchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: emby`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Emby library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(requireDb(), watchRecord);
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

        await updateWatchTelemetry(requireDb(), result.id, telemetry);
        await recordSyncHistory(media, summary, "watched");
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Emby sync recently watched failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncRecentlyWatchedFromJellyfin(config, loopStore, logger = console.log) {
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return 0;
  let syncedCount = 0;
  try {
    const { fetchJellyfinWatchedItems } = await import("./utils/jellyfinClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchJellyfinWatchedItems(config.jellyfin);
    
    for (const item of raw) {
      const ids = normalizeProviderIds(item.ProviderIds);
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
        source: "jellyfin",
        isValid: true,
      };

      const key = mediaKeyFor(media);
      const hasLastPlayed = Boolean(item.UserData?.LastPlayedDate);
      // For items without a precise timestamp use a stable synthetic date (midnight UTC)
      // so repeated cron runs produce the same watchedAt and the dedup query succeeds.
      const watchedAt = hasLastPlayed
        ? new Date(item.UserData.LastPlayedDate).toISOString()
        : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();

      // Always dedup by mediaKey; add watchedAt filter only when we have a precise timestamp.
      let query = db.collection("watchHistory").where("mediaKey", "==", key);
      if (hasLastPlayed) {
        query = query.where("watchedAt", "==", watchedAt);
      }

      const existing = await query.limit(1).get();

      if (existing.empty) {
        logger(`Jellyfin: detected new watched item: ${media.title} (played date: ${hasLastPlayed ? watchedAt : "manually marked"})`);
        const watchRecord = mediaToWatchRecord(media, "jellyfin");
        watchRecord.watched_at = watchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: jellyfin`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Jellyfin library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(requireDb(), watchRecord);
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

        await updateWatchTelemetry(requireDb(), result.id, telemetry);
        await recordSyncHistory(media, summary, "watched");
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Jellyfin sync recently watched failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncPendingManualDispatches(config, loopStore, logger = console.log) {
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
        isValid: true,
        ids: {
          imdb: data.ids?.imdb || undefined,
          tmdb: data.ids?.tmdb || undefined,
          tvdb: data.ids?.tvdb || undefined,
        },
        season: data.season == null ? undefined : Number(data.season),
        episode: data.episode == null ? undefined : Number(data.episode),
      };

      logger(`Pending Queue: dispatching sync for ${media.title}...`);
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
        ...(summary.targetStates || []).map(
          (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
        ),
      ].join("\n");

      await updateWatchTelemetry(requireDb(), doc.id, telemetry);
      await recordSyncHistory(media, summary, "watched");
      syncedCount++;
    }
  } catch (error) {
    logger(`Pending Queue dispatcher failed: ${error.message}`);
  }
  return syncedCount;
}

export async function runScheduledSync(logger = console.log) {
  logger("Scheduled Sync: starting background sync workflow...");
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

  if (plexActive) {
    logger("Scheduled Sync: checking Plex unwatched status...");
    await checkPlexUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkPlexUnwatchedStatus failed: ${error.message}`);
    });
  }

  let plexSynced = 0;
  let embySynced = 0;
  let jellyfinSynced = 0;
  let manualSynced = 0;

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

  try {
    logger("Scheduled Sync: processing pending manual dispatches...");
    manualSynced = await syncPendingManualDispatches(config, loopStore, logger);
  } catch (error) {
    logger(`Scheduled Sync ERROR: Manual queue sync failed: ${error.message}`);
  }

  logger("Scheduled Sync: scanning active sessions for live tracking...");
  const currentSessions = await fetchLiveSessions(config);
  const currentRows = currentSessions.map(buildCacheRow);
  const currentIds = new Set(currentRows.map((row) => row.session_id));
  const cachedRows = await loadLiveTrackingCache(requireDb(), { includeCompleted: true });
  const cachedById = new Map(cachedRows.map((row) => [row.session_id, row]));
  const completions = [];
  const progressUpdates = [];
  const staleIds = [];

  logger(`Scheduled Sync: live sessions: ${currentRows.length}, cached sessions in tracking: ${cachedRows.length}`);
  await upsertLiveTrackingCache(requireDb(), currentRows);

  for (const row of cachedRows) {
    if (currentIds.has(row.session_id)) continue;
    if (row.completed_at) continue;

    if (Number(row.last_progress || 0) >= 90) {
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

  await deleteLiveTrackingCacheRows(requireDb(), staleIds);
  await purgeCompletedLiveTrackingCache(requireDb());

  if (currentRows.length || completions.length || progressUpdates.length || staleIds.length || plexSynced || embySynced || jellyfinSynced || manualSynced) {
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }

  logger(`Scheduled Sync complete! Synced Plex: ${plexSynced}, Emby: ${embySynced}, Jellyfin: ${jellyfinSynced}, Manual: ${manualSynced}`);
  return {
    sessions: currentRows.length,
    completions: completions.length,
    progressUpdates: progressUpdates.length,
    removed: staleIds.length,
    cached: cachedById.size,
    plexHistorySynced: plexSynced,
    embyHistorySynced: embySynced,
    jellyfinHistorySynced: jellyfinSynced,
    manualDispatchesSynced: manualSynced,
  };
}

export async function runForceSync(logger = console.log) {
  logger("Force Sync: checking if another sync job is already running...");
  const runtime = await loadRuntimeState();
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

  if (runtime.forceSyncActive === true && runtime.forceSyncStartedAt && runtime.forceSyncStartedAt > tenMinutesAgo) {
    logger("Force Sync ERROR: Another force sync job is already running.");
    throw new Error("Another force sync job is already running.");
  }

  await setRuntimeState({ forceSyncActive: true, forceSyncStartedAt: Date.now(), forceSyncCancelRequested: false });

  try {
    logger("Force Sync: loading media configuration...");
    const config = await loadMediaConfig();
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
            timestamp: item.lastViewedAt ? new Date(Number(item.lastViewedAt) * 1000) : null,
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
            media.title = `${item.grandparentTitle} - S${String(media.season || "?").padStart(2, "0")}E${String(media.episode || "?").padStart(2, "0")}`;
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
        logger(`Emby: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            source: "emby",
            timestamp: item.UserData?.LastPlayedDate ? new Date(item.UserData.LastPlayedDate) : null,
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
        logger(`Jellyfin: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            source: "jellyfin",
            timestamp: item.UserData?.LastPlayedDate ? new Date(item.UserData.LastPlayedDate) : null,
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
  logger("Firestore: loading Plembfin watchHistory records...");
  const watchHistorySnapshot = await db.collection("watchHistory").get();
  const historyMap = new Map();
  for (const doc of watchHistorySnapshot.docs) {
    const data = doc.data();
    const mKey = data.mediaKey;
    if (!historyMap.has(mKey)) historyMap.set(mKey, []);
    historyMap.get(mKey).push({
      id: doc.id,
      ref: doc.ref,
      syncAction: data.syncAction || "watched",
      watchedAt: data.watchedAt || data.watched_at || new Date().toISOString()
    });
  }
  for (const [mKey, records] of historyMap.entries()) {
    records.sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
  }
  logger(`Firestore: loaded ${watchHistorySnapshot.size} historical sync records.`);

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
      }
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

  let loopIndex = 0;
  for (const key of allConsideredKeys) {
    loopIndex++;
    if (loopIndex % 5 === 0) {
      const currentRuntime = await loadRuntimeState();
      if (currentRuntime.forceSyncCancelRequested === true) {
        logger("Force Sync: stop request detected in Firestore. Aborting sync...");
        return {
          success: true,
          activeTargets,
          aborted: true,
          stats: {
            totalWatchedFoundAcrossServers: watchedMap.size,
            addedToHistory: addedToHistoryCount,
            deletedFromHistory: deletedFromHistoryCount,
            propagatedUpdates: propagatedCount
          }
        };
      }
    }

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
      const docData = watchHistorySnapshot.docs.find(d => d.id === lastHistoryRecord.id)?.data() || {};
      mediaObj = {
        title: docData.title,
        type: docData.mediaType,
        season: docData.season != null ? Number(docData.season) : null,
        episode: docData.episode != null ? Number(docData.episode) : null,
        ids: {
          imdb: docData.ids?.imdb || undefined,
          tmdb: docData.ids?.tmdb || undefined,
          tvdb: docData.ids?.tvdb || undefined
        }
      };
    }

    if (!mediaObj) continue;

    if (newestState === "watched") {
      const inHistory = historyRecords.some(r => r.syncAction === "watched");
      if (!inHistory) {
        logger(`Firestore: adding watched record for "${mediaObj.title}"`);
        const watchRecord = mediaToWatchRecord(mediaObj, [...serverWatchedOn][0] || "force_sync");
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: force_sync`,
          `Loop-check: Passed`,
          `Dispatch status: success`,
          `Details: Force Sync resolved status to watched. Newest timestamp: ${new Date(newestTime).toISOString()}`,
          ...activeTargets.map(t => `Target ${t.charAt(0).toUpperCase() + t.slice(1)} status: success`)
        ].join("\n");
        if (newestTime > 0) watchRecord.watched_at = new Date(newestTime).toISOString();
        await insertWatchRecord(requireDb(), watchRecord);
        addedToHistoryCount++;
      } else if (lastHistoryRecord && lastHistoryRecord.syncAction === "unwatched") {
        logger(`Firestore: deleting outdated unwatched record for "${mediaObj.title}"`);
        const unwatchedDocs = historyRecords.filter(r => r.syncAction === "unwatched");
        for (const docRec of unwatchedDocs) {
          await docRec.ref.delete();
        }
      }

      for (const target of activeTargets) {
        if (!serverWatchedOn.has(target)) {
          logger(`Propagating: marking played "${mediaObj.title}" on ${target}`);
          try {
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
            propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark played for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    } else {
      const hasWatchedRecord = historyRecords.some(r => r.syncAction === "watched");
      if (hasWatchedRecord) {
        logger(`Firestore: deleting watched records and marking unwatched for "${mediaObj.title}"`);
        for (const docRec of historyRecords) {
          await docRec.ref.delete();
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
        await insertWatchRecord(requireDb(), unwatchedRecord);
      }

      for (const target of activeTargets) {
        if (serverWatchedOn.has(target)) {
          logger(`Propagating: marking unplayed "${mediaObj.title}" on ${target}`);
          try {
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
            propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark unwatched for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    }
  }

  logger("Firestore: invalidating database watch history caches...");
  const { invalidateHistoryDerivedCaches } = await import("./utils/firestoreRepo.js");
  await invalidateHistoryDerivedCaches().catch(() => null);

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
    await setRuntimeState({ forceSyncActive: false, forceSyncCancelRequested: false }).catch(() => null);
  }
}

