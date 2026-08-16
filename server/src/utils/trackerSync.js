import { loadMediaConfig } from "./configStore.js";
import { invalidateHistoryDerivedCaches, signalHistoryDataChanged } from "./dataRepo.js";
import { createLoopStore } from "./loopStore.js";
import { fetchTraktWatchedSnapshot } from "./traktClient.js";
import { getTrackerConnection, listTrackerItemStates, replaceTrackerSnapshot, updateTrackerConnectionStatus } from "./trackerConnectionRepo.js";
import { withFreshTraktConnection } from "./trackerDispatcher.js";
import { applyUnwatchedTransition, applyWatchedTransition } from "./watchStateTransitions.js";

const OUTBOUND_ECHO_WINDOW_MS = 30 * 60_000;
const TRACKER_TRANSITION_CONCURRENCY = 8;
let pollInFlight = null;

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

async function pollTrakt() {
  const publicConnection = getTrackerConnection("trakt");
  if (!publicConnection || publicConnection.status !== "connected") return { skipped: true, reason: "not-connected", watched: 0, unwatched: 0 };
  const { snapshot } = await readSnapshot();
  const previous = listTrackerItemStates("trakt");
  const previousByKey = new Map(previous.map((item) => [item.mediaKey, item]));
  const currentByKey = new Map(snapshot.map((item) => [item.mediaKey, item]));
  const baseline = publicConnection.baselineComplete;
  const watched = baseline
    ? snapshot.filter((item) => {
      const prior = previousByKey.get(item.mediaKey);
      const newlyWatched = !prior || Number(item.watchedAt || 0) !== Number(prior.remoteWatchedAt || 0);
      return newlyWatched && !isOutboundEcho(prior, "watched");
    })
    : publicConnection.initialSyncMode === "import" ? snapshot : [];
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
  return { skipped: false, baselineEstablished: !baseline, watched: watched.length, unwatched: unwatched.length, remoteItems: snapshot.length };
}

export async function pollConnectedTrackers() {
  if (pollInFlight) return pollInFlight;
  pollInFlight = pollTrakt()
    .catch((error) => {
      updateTrackerConnectionStatus("trakt", { lastPolledAt: Date.now(), lastError: error.message || String(error) });
      throw error;
    })
    .finally(() => { pollInFlight = null; });
  return pollInFlight;
}
