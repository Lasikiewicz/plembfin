import { setEmbyProgress } from "./embyClient.js";
import { setJellyfinProgress } from "./jellyfinClient.js";
import { setPlexProgress } from "./plexClient.js";
import {
  deletePlaybackProgress,
  deleteWatchRecord,
  deleteWatchRecordById,
  findWatchedByAnyMediaKey,
  getPlaystateForMedia,
  getWatchRecordByIdLight,
  getWatchRecordByMediaKey,
  insertWatchRecord,
  mediaKeyFor,
  mediaToWatchRecord,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
} from "./dataRepo.js";
import { getTargetsForSource, syncMediaPlaystate, syncMediaUnplayedPlaystate } from "./syncOrchestrator.js";

export async function applyWatchedTransition(media, config, loopStore) {
  const existing = await getPlaystateForMedia(media).catch(() => null);
  if (existing?.state === "watched") {
    return { inserted: false, alreadyWatched: true, summary: { skipped: true, status: "skipped", details: "Already watched; no change to propagate", targetStates: [] } };
  }
  const record = mediaToWatchRecord({ ...media, syncAction: "watched" }, media.source);
  record.sync_action = "watched";
  const result = await insertWatchRecord(record, { skipInvalidate: true });
  await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
  await deletePlaybackProgress(media).catch(() => null);
  const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
    skipped: false, status: "error", details: `Watched propagation failed: ${error.message || String(error)}`, targetStates: [],
  }));
  await updateWatchTelemetry(result.id, [
    `Origin: ${media.source || "unknown"}`, "Action: Marked Watched", `Media: ${media.title || "unknown"}`,
    `Dispatch status: ${summary.status || "unknown"}`, `Details: ${summary.details || "Watched state processed."}`,
    ...(summary.targetStates || []).map((state) => `Target ${state.target} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`),
  ].join("\n"), { skipInvalidate: true });
  return { inserted: true, id: result.id, alreadyWatched: false, summary };
}

function unwatchedTelemetry(summary, media) {
  return [
    `Origin: ${media.source || "unknown"}`,
    "Action: Marked Unwatched",
    `Media: ${media.title || "unknown"}`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "Unwatched state processed."}`,
    ...(summary.targetStates || []).map((state) => `Target ${state.target} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`),
  ].join("\n");
}

// Applies one explicit inbound/manual unwatched transition. Callers are
// responsible for rejecting provider-user mismatches and outbound echoes before
// reaching this function. Once admitted, the newest user action wins everywhere.
export async function applyUnwatchedTransition(media, config, loopStore, {
  recordId = "",
  includeSourcePlatform = false,
} = {}) {
  const existingWatched = await findWatchedByAnyMediaKey(media).catch(() => null);
  const existingRecord = recordId
    ? await getWatchRecordByIdLight(recordId).catch(() => null)
    : await getWatchRecordByMediaKey(mediaKeyFor(media)).catch(() => null);
  const canonicalState = await getPlaystateForMedia(media).catch(() => null);

  if (!existingWatched && (canonicalState?.state === "unwatched" || existingRecord?.sync_action === "unwatched")) {
    return {
      wasDeleted: false,
      id: existingRecord?.id || "",
      alreadyUnwatched: true,
      summary: { skipped: true, status: "skipped", details: "Already unwatched; no change to propagate", targetStates: [] },
    };
  }

  const supersededId = existingWatched?.id || existingRecord?.id || "";
  let wasDeleted = false;
  if (recordId) {
    wasDeleted = await deleteWatchRecordById(recordId, { skipInvalidate: true }).catch((error) => {
      console.error("Failed to delete watch record by id", error);
      return false;
    });
  }
  const deletedByKey = await deleteWatchRecord(media, { skipInvalidate: true }).catch((error) => {
    console.error("Failed to delete watch record", error);
    return false;
  });
  wasDeleted = wasDeleted || deletedByKey;
  await deletePlaybackProgress(media).catch(() => null);

  const pending = { skipped: false, status: "pending", details: "Unwatched propagation queued", targetStates: [] };
  const unplayedRecord = mediaToWatchRecord({ ...media, syncAction: "unwatched" }, media.source);
  unplayedRecord.sync_action = "unwatched";
  unplayedRecord.sync_dispatch_telemetry = unwatchedTelemetry(pending, media);
  const reusableId = supersededId && !(await getWatchRecordByIdLight(supersededId).catch(() => null)) ? supersededId : "";
  const result = await insertWatchRecord(unplayedRecord, { skipInvalidate: true, id: reusableId });
  await upsertPlaystateForMedia(media, "unwatched", result.record.watched_at, { skipInvalidate: true });

  const syncMedia = includeSourcePlatform ? { ...media, source: "manual" } : media;
  for (const target of getTargetsForSource(syncMedia.source, config)) {
    try {
      if (target === "plex") await setPlexProgress(config.plex, { ...media, positionMs: 0 });
      if (target === "emby") await setEmbyProgress(config.emby, { ...media, positionMs: 0 });
      if (target === "jellyfin") await setJellyfinProgress(config.jellyfin, { ...media, positionMs: 0 });
    } catch (error) {
      console.log(`Resume progress clear on ${target} during unwatch failed (non-fatal)`, error.message);
    }
  }

  const summary = await syncMediaUnplayedPlaystate(syncMedia, config, loopStore).catch((error) => ({
    skipped: false,
    status: "error",
    details: `Unwatched propagation failed: ${error.message || String(error)}`,
    targetStates: [],
  }));
  await updateWatchTelemetry(result.id, unwatchedTelemetry(summary, media), { skipInvalidate: true });
  return { wasDeleted, id: result.id, alreadyUnwatched: false, summary };
}
