import { loadMediaConfig } from "./configStore.js";
import {
  findExistingWatch, getCanonicalWatchState, getPlaystateForMedia, insertWatchRecord,
  invalidateHistoryDerivedCaches, mediaKeyFor, mediaToWatchRecord, signalHistoryDataChanged, upsertPlaystateForMedia,
} from "./dataRepo.js";
import { createLoopStore } from "./loopStore.js";
import { fetchTraktPlayHistory, fetchTraktWatchedSnapshot } from "./traktClient.js";
import {
  getTrackerConnection, listTrackerItemStates, listUnrecordedTrackerPlayIds,
  recordTrackerPlay, replaceTrackerSnapshot, updateTrackerConnectionStatus,
} from "./trackerConnectionRepo.js";
import { withFreshTraktConnection } from "./trackerDispatcher.js";
import { applyUnwatchedTransition, applyWatchedTransition } from "./watchStateTransitions.js";

const OUTBOUND_ECHO_WINDOW_MS = 30 * 60_000;
const TRACKER_TRANSITION_CONCURRENCY = 8;
let pollInFlight = null;
let pollInFlightReconcile = false;

function isOutboundEcho(item, state, now = Date.now()) {
  return item?.lastOutboundState === state && Number(item.lastOutboundAt || 0) > 0 && now - Number(item.lastOutboundAt) <= OUTBOUND_ECHO_WINDOW_MS;
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
async function importTraktPlayHistory(connection, publicConnection) {
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
    // Trakt's own mediaKey shape (used for tracker_item_state) differs from
    // dataRepo's canonical media_key column format - recompute the canonical
    // one here or findExistingWatch's lookup against watch_history never matches.
    const canonicalMediaKey = mediaKeyFor(entry.media);
    const watchedAtIso = new Date(entry.watchedAt).toISOString();
    const existing = await findExistingWatch(canonicalMediaKey, watchedAtIso).catch(() => null);
    let watchRecordId = existing?.id || "";
    if (!existing) {
      const record = mediaToWatchRecord({ ...entry.media, watched_at: watchedAtIso, syncAction: "watched" }, "trakt_import");
      record.sync_action = "watched";
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
  const unwatched = baseline
    ? previous.filter((item) => !currentByKey.has(item.mediaKey) && !isOutboundEcho(item, "unwatched"))
    : [];

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  await runTransitionBatch(watched, async (item) => {
    const media = { ...item.media, source: "trakt", watched_at: new Date(item.watchedAt || Date.now()).toISOString() };
    await applyWatchedTransition(media, config, loopStore);
    signalHistoryDataChanged();
  });
  await runTransitionBatch(unwatched, async (item) => {
    const media = { ...item.media, source: "trakt", isValid: true };
    await applyUnwatchedTransition(media, config, loopStore);
    signalHistoryDataChanged();
  });

  // Tracker transitions deliberately skip per-item invalidation so a whole
  // show does not rebuild the same derived data dozens of times. Flush once
  // after the batch or the TV detail page can continue showing stale progress.
  if (watched.length || unwatched.length) await invalidateHistoryDerivedCaches();

  replaceTrackerSnapshot("trakt", snapshot);
  updateTrackerConnectionStatus("trakt", { baselineComplete: true, lastPolledAt: Date.now(), lastValidatedAt: Date.now(), lastError: null });

  try {
    await importTraktPlayHistory(connection, publicConnection);
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
