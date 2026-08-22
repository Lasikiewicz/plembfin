import { setEmbyProgress } from "./embyClient.js";
import { setJellyfinProgress } from "./jellyfinClient.js";
import { setPlexProgress } from "./plexClient.js";
import { db } from "../db.js";
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
import { completeDispatchTracking, getTargetsForSource, syncMediaPlaystate, syncMediaUnplayedPlaystate } from "./syncOrchestrator.js";

// Cross-platform mass-false-unwatch circuit breaker. applyUnwatchedTransition
// below is the single choke point every *automatic* (non-manual) unwatch path
// already funnels through - Plex/Emby/Jellyfin webhooks, the Plex real-time
// notification listener and adaptive poller, the Emby/Jellyfin unwatched-
// fallback polls, and the Trakt poller. Any one of those source servers having
// its own bad moment (a library rescan, a metadata refresh, a database
// hiccup, a rate-limited/truncated API response) can make it report a burst
// of items as suddenly unplayed that were never genuinely unwatched - and
// each one individually looks like a normal single unwatch, so nothing
// distinguishes it from real activity until you look at the volume. Real
// incident (2026-08-21): a ~7-minute window, 264+ episodes across dozens of
// completely unrelated shows, all sourced from one Jellyfin poll/webhook
// burst - each one propagated to Plex and Emby before anyone noticed.
//
// This is deliberately coarser than the per-show/per-batch guard Trakt's own
// poller already has (partitionSuspiciousUnwatches in trackerSync.js, which
// only trips when *one show* loses a large share of its episodes at once):
// it catches the case that guard misses, a burst spread thin across many
// different shows/movies rather than concentrated in one. It is backed by
// the shared loop_keys table (not in-memory) so it works correctly across
// a split web/worker deployment, where webhooks and scheduled polls can land
// on different processes.
//
// Manual/explicit sources (a user marking something unwatched in Plembfin
// itself, Force Sync, Set Plembfin as Source of Truth, Trakt import) are
// never subject to this - a person is allowed to unwatch as much as they
// want in one sitting; only automatic, inbound-from-a-server decisions are
// rate-limited.
const AUTOMATIC_UNWATCH_SOURCES = new Set(["plex", "emby", "jellyfin", "trakt"]);
const AUTOMATIC_UNWATCH_BURST_WINDOW_MS = 5 * 60 * 1000;
const AUTOMATIC_UNWATCH_BURST_THRESHOLD = 15;
const AUTOMATIC_UNWATCH_BURST_KEY_PREFIX = "auto-unwatch-burst:";

const countRecentAutomaticUnwatchesStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM loop_keys WHERE key LIKE ? AND expire_at > ?",
);
const recordAutomaticUnwatchStmt = db.prepare(
  "INSERT INTO loop_keys (id, key, value, created_at, expire_at) VALUES (@id, @key, @value, @created_at, @expire_at)",
);

function isAutomaticUnwatchSource(source) {
  return AUTOMATIC_UNWATCH_SOURCES.has(String(source || "").toLowerCase());
}

// Returns true (and does not record anything) when this automatic unwatch
// should be held back as part of a suspected mass false-unwatch burst.
function automaticUnwatchBurstDetected(media) {
  if (!isAutomaticUnwatchSource(media?.source)) return false;
  const now = Date.now();
  const recentCount = countRecentAutomaticUnwatchesStmt.get(`${AUTOMATIC_UNWATCH_BURST_KEY_PREFIX}%`, now).c;
  if (recentCount >= AUTOMATIC_UNWATCH_BURST_THRESHOLD) {
    console.error(
      `applyUnwatchedTransition: held back automatic unwatch for "${media.title || "unknown title"}" ` +
      `(source: ${media.source}) - ${recentCount} automatic unwatches already recorded in the last ` +
      `${Math.round(AUTOMATIC_UNWATCH_BURST_WINDOW_MS / 60000)}m, which looks like a mass false-unwatch ` +
      `burst rather than genuine activity. Not propagating; check the source server and re-verify manually ` +
      `if this item really was unwatched.`,
    );
    return true;
  }
  recordAutomaticUnwatchStmt.run({
    id: crypto.randomUUID(),
    key: `${AUTOMATIC_UNWATCH_BURST_KEY_PREFIX}${media.source}:${media.title || ""}`,
    value: String(now),
    created_at: now,
    expire_at: now + AUTOMATIC_UNWATCH_BURST_WINDOW_MS,
  });
  return false;
}

export async function applyWatchedTransition(media, config, loopStore, { trackDispatch = true } = {}) {
  const existing = await getPlaystateForMedia(media).catch(() => null);
  if (existing?.state === "watched") {
    // A pre-reserved batch slot (trackDispatch: false) skips syncMediaPlaystate
    // entirely on this path, so nothing would otherwise mark it complete.
    if (!trackDispatch) completeDispatchTracking();
    return { inserted: false, alreadyWatched: true, summary: { skipped: true, status: "skipped", details: "Already watched; no change to propagate", targetStates: [] } };
  }
  // getPlaystateForMedia can still miss an already-recorded watch stored
  // under a media_key from a different source (e.g. a Trakt-sourced entry
  // keyed by imdb vs a media-server entry keyed by title fallback for the
  // same episode) - findWatchedByAnyMediaKey has the broader coordinate/
  // provider-id fallback matching every other ingest path relies on for
  // this; a hit there is conclusive too, not just an exact playstate match.
  const existingByAnyKey = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (existingByAnyKey) {
    await upsertPlaystateForMedia(media, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
    if (!trackDispatch) completeDispatchTracking();
    return { inserted: false, alreadyWatched: true, summary: { skipped: true, status: "skipped", details: "Already recorded under a different media key; no change to propagate", targetStates: [] } };
  }
  const record = mediaToWatchRecord({ ...media, syncAction: "watched" }, media.source);
  record.sync_action = "watched";
  const result = await insertWatchRecord(record, { skipInvalidate: true });
  await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
  await deletePlaybackProgress(media).catch(() => null);
  const summary = await syncMediaPlaystate(media, config, loopStore, { trackDispatch }).catch((error) => ({
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
//
// `force` skips the "already unwatched, nothing to propagate" short-circuit
// below and always dispatches to every target instead. Automated/inbound
// callers (webhooks, the scheduler, tracker sync) must leave it off - the
// short-circuit is their loop protection, since an echo of their own prior
// unwatch would otherwise re-dispatch forever. It exists for explicit manual
// unwatch actions, where plembfin's own canonical state can already say
// "unwatched" while a media server has silently drifted back to watched (e.g.
// after a library rescan) - the user clicking "Mark unwatched" again should
// still force a live re-push rather than silently no-op.
export async function applyUnwatchedTransition(media, config, loopStore, {
  recordId = "",
  includeSourcePlatform = false,
  trackDispatch = true,
  force = false,
} = {}) {
  const existingWatched = await findWatchedByAnyMediaKey(media).catch(() => null);
  const existingRecord = recordId
    ? await getWatchRecordByIdLight(recordId).catch(() => null)
    : await getWatchRecordByMediaKey(mediaKeyFor(media)).catch(() => null);
  const canonicalState = await getPlaystateForMedia(media).catch(() => null);
  const alreadyUnwatchedLocally = !existingWatched && (canonicalState?.state === "unwatched" || existingRecord?.sync_action === "unwatched");

  if (alreadyUnwatchedLocally && force) {
    // Nothing to insert/delete - plembfin already has this as unwatched - but
    // still clear progress and push "unplayed" live to every connected target.
    await deletePlaybackProgress(media).catch(() => null);
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
    const summary = await syncMediaUnplayedPlaystate(syncMedia, config, loopStore, { trackDispatch }).catch((error) => ({
      skipped: false, status: "error", details: `Unwatched propagation failed: ${error.message || String(error)}`, targetStates: [],
    }));
    if (existingRecord?.id) {
      await updateWatchTelemetry(existingRecord.id, unwatchedTelemetry(summary, media), { skipInvalidate: true }).catch(() => null);
    }
    return { wasDeleted: false, id: existingRecord?.id || "", alreadyUnwatched: true, summary };
  }

  if (alreadyUnwatchedLocally) {
    // Canonical state is already unwatched, but a partial-progress row can still
    // exist (e.g. a re-watch in progress after an earlier unwatch) - always clear
    // it so "Clear Progress" removes the item from the Part Watched list.
    await deletePlaybackProgress(media).catch(() => null);
    // See the matching comment in applyWatchedTransition - this path never
    // reaches syncMediaUnplayedPlaystate, so a pre-reserved slot needs its
    // own completion signal here.
    if (!trackDispatch) completeDispatchTracking();
    return {
      wasDeleted: false,
      id: existingRecord?.id || "",
      alreadyUnwatched: true,
      summary: { skipped: true, status: "skipped", details: "Already unwatched; no change to propagate", targetStates: [] },
    };
  }

  if (automaticUnwatchBurstDetected(media)) {
    return {
      wasDeleted: false,
      id: existingRecord?.id || "",
      alreadyUnwatched: false,
      heldBackSuspiciousBurst: true,
      summary: { skipped: true, status: "skipped", details: "Held back: looks like a mass false-unwatch burst (see server logs).", targetStates: [] },
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

  const summary = await syncMediaUnplayedPlaystate(syncMedia, config, loopStore, { trackDispatch }).catch((error) => ({
    skipped: false,
    status: "error",
    details: `Unwatched propagation failed: ${error.message || String(error)}`,
    targetStates: [],
  }));
  await updateWatchTelemetry(result.id, unwatchedTelemetry(summary, media), { skipInvalidate: true });
  return { wasDeleted, id: result.id, alreadyUnwatched: false, summary };
}
