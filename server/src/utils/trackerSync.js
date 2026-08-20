import { loadMediaConfig } from "./configStore.js";
import {
  findExistingWatch, getCanonicalWatchState, getPlaystateForMedia, insertWatchRecord,
  invalidateHistoryDerivedCaches, mediaKeyFor, mediaToWatchRecord, signalHistoryDataChanged, upsertPlaystateForMedia,
} from "./dataRepo.js";
import { createLoopStore } from "./loopStore.js";
import { fetchTraktPlayHistory, fetchTraktWatchedSnapshot, trackerMediaKey } from "./traktClient.js";
import {
  getTrackerConnection, listTrackerItemStates, listUnrecordedTrackerPlayIds,
  recordTrackerPlay, replaceTrackerSnapshot, updateTrackerConnectionStatus,
} from "./trackerConnectionRepo.js";
import { withFreshTraktConnection } from "./trackerDispatcher.js";
import { applyUnwatchedTransition, applyWatchedTransition } from "./watchStateTransitions.js";
import { reserveDispatchBatch } from "./syncOrchestrator.js";

const OUTBOUND_ECHO_WINDOW_MS = 30 * 60_000;
const TRACKER_TRANSITION_CONCURRENCY = 8;
let pollInFlight = null;
let pollInFlightReconcile = false;

function isOutboundEcho(item, state, now = Date.now()) {
  return item?.lastOutboundState === state && Number(item.lastOutboundAt || 0) > 0 && now - Number(item.lastOutboundAt) <= OUTBOUND_ECHO_WINDOW_MS;
}

// Trakt's watched-progress endpoint occasionally comes back with fewer
// episodes than the previous poll saw for a show, even though nothing was
// actually unwatched on Trakt - a rate-limited or truncated response during
// heavy outbound traffic (e.g. right after a canonical replay makes a burst
// of Trakt API calls for one show) still returns a well-formed array, so the
// malformedShow check in fetchTraktWatchedSnapshot does not catch it.
// Trusting a sudden large drop as "these episodes are now unwatched" would
// cascade a real, destructive unwatch to every connected platform and to
// Plembfin's own history. A large, simultaneous drop within one show is held
// back for one poll cycle instead of propagated immediately; if the same
// episodes are still missing on the next poll it is treated as genuine and
// goes through then. A genuine handful of unwatches (not a whole show at
// once) always propagates immediately, and movies are single-item groups so
// they are never affected by this check.
const SUSPICIOUS_SHOW_DROP_MIN_COUNT = 4;
const SUSPICIOUS_SHOW_DROP_MIN_FRACTION = 0.4;
const pendingSuspiciousUnwatches = new Map(); // mediaKey -> first-detected timestamp

export function showIdentityFromMediaKey(mediaKey = "") {
  const match = /^episode:(.*):s-?\d+e-?\d+$/.exec(mediaKey);
  return match ? match[1] : null;
}

function suspiciousShowDropIds(unwatchedCandidates, previous) {
  const previousCountByShow = new Map();
  for (const item of previous) {
    const showId = showIdentityFromMediaKey(item.mediaKey);
    if (!showId) continue;
    previousCountByShow.set(showId, (previousCountByShow.get(showId) || 0) + 1);
  }
  const droppedCountByShow = new Map();
  for (const item of unwatchedCandidates) {
    const showId = showIdentityFromMediaKey(item.mediaKey);
    if (!showId) continue;
    droppedCountByShow.set(showId, (droppedCountByShow.get(showId) || 0) + 1);
  }
  const suspiciousShowIds = new Set();
  for (const [showId, droppedCount] of droppedCountByShow) {
    const previousCount = previousCountByShow.get(showId) || 0;
    if (droppedCount >= SUSPICIOUS_SHOW_DROP_MIN_COUNT && previousCount > 0 && droppedCount / previousCount >= SUSPICIOUS_SHOW_DROP_MIN_FRACTION) {
      suspiciousShowIds.add(showId);
    }
  }
  return suspiciousShowIds;
}

// Splits unwatch candidates into ones to propagate now and ones to hold back
// for one more poll. Also clears pending markers for items that reappeared
// in the current snapshot (the transient hiccup resolved itself).
export function partitionSuspiciousUnwatches(unwatchedCandidates, previous, currentByKey) {
  for (const mediaKey of pendingSuspiciousUnwatches.keys()) {
    if (currentByKey.has(mediaKey)) pendingSuspiciousUnwatches.delete(mediaKey);
  }
  const suspiciousShowIds = suspiciousShowDropIds(unwatchedCandidates, previous);
  const unwatched = [];
  const heldBack = [];
  for (const item of unwatchedCandidates) {
    const showId = showIdentityFromMediaKey(item.mediaKey);
    const isSuspicious = showId && suspiciousShowIds.has(showId);
    if (isSuspicious && !pendingSuspiciousUnwatches.has(item.mediaKey)) {
      pendingSuspiciousUnwatches.set(item.mediaKey, Date.now());
      heldBack.push(item);
    } else {
      unwatched.push(item);
      pendingSuspiciousUnwatches.delete(item.mediaKey);
    }
  }
  return { unwatched, heldBack };
}

async function readSnapshot() {
  let connection = await withFreshTraktConnection();
  if (!connection) return { connection: null, snapshot: [] };
  try {
    return { connection, snapshot: await fetchTraktWatchedSnapshot(connection) };
  } catch (error) {
    if (error.status !== 401) throw error;
    connection = await withFreshTraktConnection(true);
    return { connection, snapshot: await fetchTraktWatchedSnapshot(connection) };
  }
}

async function runTransitionBatch(items, handler, concurrency = TRACKER_TRANSITION_CONCURRENCY) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await handler(item);
    }
  });
  await Promise.all(workers);
}

// Imports every individual Trakt play (rewatches included) as its own
// watch_history row. This runs alongside the existing "current watched
// state" diff above rather than replacing it: that diff still owns
// playstate/unwatch detection/outbound propagation for the latest play,
// while this only backfills additional plays it doesn't already know about
// (via tracker_play_history) and nudges playstate's timestamp forward when
// a newer rewatch is found. It never propagates to sync targets itself -
// these are historical facts, not new events for Plex/Emby/Jellyfin to act on.
async function importTraktPlayHistory(connection, publicConnection, previousOutboundByKey) {
  const watermarkMs = publicConnection.baselineComplete ? Number(publicConnection.historySyncedAt || 0) : 0;
  // A minute of overlap tolerates clock skew; tracker_play_history dedup
  // means re-seeing already-imported plays here is a harmless no-op.
  const startAt = watermarkMs > 0 ? new Date(watermarkMs - 60_000).toISOString() : undefined;
  const entries = await fetchTraktPlayHistory(connection, { startAt });
  if (!entries.length) return;

  const pendingIds = listUnrecordedTrackerPlayIds("trakt", entries.map((entry) => entry.historyId));
  // Advance past every entry this fetch saw, not just the newly-inserted
  // ones, or an already-imported entry would keep it re-fetching the same
  // window forever instead of narrowing to genuinely new plays next time.
  let latestWatchedAt = entries.reduce((max, entry) => Math.max(max, entry.watchedAt), watermarkMs);
  const touchedKeys = new Map();

  for (const entry of entries.filter((entry) => pendingIds.has(entry.historyId)).sort((a, b) => a.watchedAt - b.watchedAt)) {
    const watchedAtIso = new Date(entry.watchedAt).toISOString();

    // A play that looks like it just happened, right after Plembfin itself
    // last pushed a "watched" mark for this item to Trakt, is almost
    // certainly an echo of that push rather than a genuine new play - e.g. a
    // canonical replay (manual mark-watched, a watched-date correction) whose
    // pushed date was wrong for any reason. Importing it as history would
    // create a second local watch alongside the correct one. Uses Trakt's
    // own mediaKey shape here (not dataRepo's mediaKeyFor below) because
    // that's what recordTrackerOutbound in trackerDispatcher.js keys by.
    // Reads from the previous-snapshot map captured in pollTrakt before
    // replaceTrackerSnapshot() ran, rather than querying tracker_item_state
    // fresh here - replaceTrackerSnapshot rebuilds that table from the
    // just-fetched watched snapshot, and a just-pushed item that hasn't
    // shown up there yet would otherwise have its outbound-echo state wiped
    // out from under this check before it ever ran.
    const outboundState = previousOutboundByKey.get(trackerMediaKey(entry.media));
    if (
      outboundState?.lastOutboundState === "watched"
      && Number(outboundState.lastOutboundAt || 0) > 0
      && Math.abs(entry.watchedAt - Number(outboundState.lastOutboundAt)) <= OUTBOUND_ECHO_WINDOW_MS
    ) {
      recordTrackerPlay("trakt", { historyId: entry.historyId, mediaKey: trackerMediaKey(entry.media), watchedAt: watchedAtIso, watchRecordId: "" });
      continue;
    }

    // Trakt's own mediaKey shape (used for tracker_item_state) differs from
    // dataRepo's canonical media_key column format - recompute the canonical
    // one here or findExistingWatch's lookup against watch_history never matches.
    const canonicalMediaKey = mediaKeyFor(entry.media);
    const existing = await findExistingWatch(canonicalMediaKey, watchedAtIso).catch(() => null);
    let watchRecordId = existing?.id || "";
    if (!existing) {
      const record = mediaToWatchRecord({ ...entry.media, watched_at: watchedAtIso, syncAction: "watched" }, "trakt_import");
      record.sync_action = "watched";
      // Without telemetry that looks "done", the scheduler's manual-dispatch
      // retry sweep (server/src/scheduled.js syncPendingManualDispatches)
      // treats any watched row as needing outbound propagation and re-fires
      // it - including back out to Trakt, which (before the source-echo fix
      // in trackerDispatcher.js) created a new Trakt play every poll for
      // every backfilled play. Mark these as already-settled so nothing ever
      // re-dispatches them to Plex/Emby/Jellyfin or Trakt.
      record.sync_dispatch_telemetry = [
        "Origin: trakt_import",
        "Loop-check: Skipped propagation",
        "Dispatch status: skipped",
        "Details: Historical play imported from Trakt history; current watch state is tracked separately and was not re-propagated.",
        "Target plex status: skipped - Historical import; not re-propagated",
        "Target emby status: skipped - Historical import; not re-propagated",
        "Target jellyfin status: skipped - Historical import; not re-propagated",
      ].join("\n");
      const result = await insertWatchRecord(record, { skipInvalidate: true });
      watchRecordId = result.id;
    }
    recordTrackerPlay("trakt", { historyId: entry.historyId, mediaKey: canonicalMediaKey, watchedAt: watchedAtIso, watchRecordId });
    const previous = touchedKeys.get(canonicalMediaKey);
    if (!previous || entry.watchedAt > previous.watchedAtMs) {
      touchedKeys.set(canonicalMediaKey, { media: entry.media, watchedAtMs: entry.watchedAt, watchedAtIso });
    }
  }

  // Nudge playstate's timestamp forward for a newer rewatch that the
  // already-watched short-circuit above skips inserting a fresh row for -
  // never flips unwatched->watched and never regresses an existing timestamp.
  for (const [, info] of touchedKeys) {
    const state = await getPlaystateForMedia(info.media).catch(() => null);
    if (state?.state === "watched" && Number(Date.parse(state.watched_at || "")) < info.watchedAtMs) {
      await upsertPlaystateForMedia(info.media, "watched", info.watchedAtIso, { skipInvalidate: true });
    }
  }

  if (touchedKeys.size) await invalidateHistoryDerivedCaches();
  updateTrackerConnectionStatus("trakt", { historySyncedAt: latestWatchedAt });
}

export function selectTraktWatchedTransitions({ snapshot = [], previous = [], baseline = false, initialSyncMode = "baseline", reconcileKeys = new Set() } = {}) {
  const previousByKey = new Map(previous.map((item) => [item.mediaKey, item]));
  return baseline
    ? snapshot.filter((item) => {
      const prior = previousByKey.get(item.mediaKey);
      const newlyWatched = !prior || Number(item.watchedAt || 0) !== Number(prior.remoteWatchedAt || 0);
      return (newlyWatched || reconcileKeys.has(item.mediaKey)) && !isOutboundEcho(prior, "watched");
    })
    : initialSyncMode === "import" ? snapshot : [];
}

async function pollTrakt({ reconcile = false } = {}) {
  const publicConnection = getTrackerConnection("trakt");
  if (!publicConnection || publicConnection.status !== "connected") return { skipped: true, reason: "not-connected", watched: 0, unwatched: 0 };
  const { connection, snapshot } = await readSnapshot();
  const previous = listTrackerItemStates("trakt");
  const previousByKey = new Map(previous.map((item) => [item.mediaKey, item]));
  const currentByKey = new Map(snapshot.map((item) => [item.mediaKey, item]));
  const baseline = publicConnection.baselineComplete;
  const reconcileKeys = new Set();
  if (baseline && reconcile) {
    await runTransitionBatch(snapshot, async (item) => {
      const state = await getCanonicalWatchState(item.media).catch(() => null);
      if (state !== "watched") reconcileKeys.add(item.mediaKey);
    });
  }
  const watched = selectTraktWatchedTransitions({
    snapshot,
    previous,
    baseline,
    initialSyncMode: publicConnection.initialSyncMode,
    reconcileKeys,
  });
  // A "watched" mark just pushed to Trakt does not always show up in the
  // very next watched-snapshot fetch - Trakt's API can lag behind its own
  // write for several seconds. Without this guard, that stale snapshot looks
  // identical to a genuine remote unwatch (the item is simply missing), so a
  // poll landing in that window would delete the watch it just created.
  // isOutboundEcho(item, "unwatched") only catches the item echoing back the
  // same state we just pushed; a missing item after a recent "watched" push
  // needs its own guard here.
  const unwatchedCandidates = baseline
    ? previous.filter((item) => !currentByKey.has(item.mediaKey) && !isOutboundEcho(item, "unwatched") && !isOutboundEcho(item, "watched"))
    : [];
  const { unwatched, heldBack } = partitionSuspiciousUnwatches(unwatchedCandidates, previous, currentByKey);
  if (heldBack.length) {
    console.error(`[trackerSync] Held back ${heldBack.length} suspiciously large Trakt unwatch(es) from propagating - will re-check on the next poll instead of trusting a possibly incomplete response.`);
  }

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  // Reserve the whole known batch size on the sidebar sync-progress indicator
  // up front, instead of letting it climb one item at a time as the bounded-
  // concurrency workers below pick up new items over the life of the batch -
  // see reserveDispatchBatch in syncOrchestrator.js.
  reserveDispatchBatch(watched.length + unwatched.length);
  await runTransitionBatch(watched, async (item) => {
    const media = { ...item.media, source: "trakt", watched_at: new Date(item.watchedAt || Date.now()).toISOString() };
    await applyWatchedTransition(media, config, loopStore, { trackDispatch: false });
    signalHistoryDataChanged();
  });
  await runTransitionBatch(unwatched, async (item) => {
    const media = { ...item.media, source: "trakt", isValid: true };
    await applyUnwatchedTransition(media, config, loopStore, { trackDispatch: false });
    signalHistoryDataChanged();
  });

  // Tracker transitions deliberately skip per-item invalidation so a whole
  // show does not rebuild the same derived data dozens of times. Flush once
  // after the batch or the TV detail page can continue showing stale progress.
  if (watched.length || unwatched.length) await invalidateHistoryDerivedCaches();

  // Held-back items must stay recorded as watched in tracker_item_state (not
  // wiped out by the fresh snapshot) or the next poll would lose the "still
  // missing?" comparison point and never be able to confirm or clear them.
  const heldBackAsSnapshotItems = heldBack.map((item) => ({ mediaKey: item.mediaKey, media: item.media, watchedAt: item.remoteWatchedAt }));
  replaceTrackerSnapshot("trakt", [...snapshot, ...heldBackAsSnapshotItems]);
  updateTrackerConnectionStatus("trakt", { baselineComplete: true, lastPolledAt: Date.now(), lastValidatedAt: Date.now(), lastError: null });

  try {
    await importTraktPlayHistory(connection, publicConnection, previousByKey);
  } catch (error) {
    console.error("[trackerSync] Trakt play-history import failed (non-fatal)", error);
  }

  return { skipped: false, baselineEstablished: !baseline, watched: watched.length, unwatched: unwatched.length, remoteItems: snapshot.length };
}

export async function pollConnectedTrackers(options = {}) {
  const reconcile = Boolean(options.reconcile);
  if (pollInFlight) {
    if (!reconcile || pollInFlightReconcile) return pollInFlight;
    await pollInFlight.catch(() => null);
    return pollConnectedTrackers(options);
  }
  pollInFlightReconcile = reconcile;
  pollInFlight = pollTrakt(options)
    .catch((error) => {
      updateTrackerConnectionStatus("trakt", { lastPolledAt: Date.now(), lastError: error.message || String(error) });
      throw error;
    })
    .finally(() => {
      pollInFlight = null;
      pollInFlightReconcile = false;
    });
  return pollInFlight;
}
