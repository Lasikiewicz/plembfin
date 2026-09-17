import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-dispatch-progress-");

const { dispatchProgressKey, reserveDispatchBatch, markReservedDispatchStarted, completeDispatchTracking, finishDispatchTracking } = await import("../server/src/utils/syncOrchestrator.js");
const { loadRuntimeState } = await import("../server/src/utils/configStore.js");

// The sidebar "Syncing N of M" indicator (public/app.js renderSyncProgress)
// used to climb one item at a time as bounded-concurrency workers picked up
// new items over the life of a batch, so a large operation (a Trakt
// reconcile, a bulk mark-watched/unwatched) never showed its real total
// until the very last item started - it looked like it would never finish.
// reserveDispatchBatch lets a caller that already knows its batch size
// report the whole total in one call instead.
//
// Assertions use deltas rather than absolute values: dispatchBurstTotal/
// Completed are module-level state that only resets after a 2-second idle
// timer (DISPATCH_PROGRESS_IDLE_MS), which these fast, back-to-back tests
// never wait out - so state legitimately carries across test cases here,
// just as separate real bursts can share one open window in production.

test("dispatch progress uses one identity for the same episode across provider aliases", () => {
  const plex = dispatchProgressKey({
    type: "episode",
    title: "Slow Horses - S04E01",
    season: 4,
    episode: 1,
    ids: { tmdb: "12345" },
  });
  const emby = dispatchProgressKey({
    type: "episode",
    title: "Slow Horses (2022) - S04E01",
    season: 4,
    episode: 1,
    ids: { tvdb: "67890" },
  });

  assert.equal(plex, "episode:slow-horses:s4:e1");
  assert.equal(emby, plex);
  assert.notEqual(emby, dispatchProgressKey({
    type: "episode",
    title: "Slow Horses - S04E02",
    season: 4,
    episode: 2,
  }));
});

test("a keyed batch counts duplicate dispatch rows for one episode once", async () => {
  const before = await loadRuntimeState();
  const media = { type: "episode", title: "Slow Horses - S04E01", season: 4, episode: 1 };
  const key = dispatchProgressKey(media);
  const reservation = reserveDispatchBatch(2, { progressKeys: [key, key] });
  const reserved = await loadRuntimeState();
  assert.equal(reserved.backgroundSyncProgress.total - (before.backgroundSyncProgress?.total || 0), 1);

  completeDispatchTracking(reservation, media);
  const midway = await loadRuntimeState();
  assert.equal(midway.backgroundSyncProgress.completed - (before.backgroundSyncProgress?.completed || 0), 0);

  completeDispatchTracking(reservation, media);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.completed - (before.backgroundSyncProgress?.completed || 0), 1);
});

test("dispatch progress exposes the active media item label", async () => {
  const before = await loadRuntimeState();
  const first = { type: "episode", title: "Clarkson's Farm - S05E06", season: 5, episode: 6 };
  const second = { type: "episode", title: "Slow Horses - S04E01", season: 4, episode: 1 };
  const reservation = reserveDispatchBatch(2, {
    progressKeys: [dispatchProgressKey(first), dispatchProgressKey(second)],
  });

  markReservedDispatchStarted(reservation, first);
  const active = await loadRuntimeState();
  assert.equal(active.backgroundSyncProgress.total - (before.backgroundSyncProgress?.total || 0), 2);
  assert.equal(active.backgroundSyncProgress.currentItemLabel, "Clarkson's Farm S05E06");

  completeDispatchTracking(reservation, first);
  const next = await loadRuntimeState();
  assert.equal(next.backgroundSyncProgress.currentItemLabel || "", "");
  markReservedDispatchStarted(reservation, second);
  const secondActive = await loadRuntimeState();
  assert.equal(secondActive.backgroundSyncProgress.currentItemLabel, "Slow Horses S04E01");

  completeDispatchTracking(reservation, second);
});

test("reserveDispatchBatch reports the full total immediately, before any item completes", async () => {
  const before = await loadRuntimeState();
  const reservation = reserveDispatchBatch(12);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total - (before.backgroundSyncProgress?.total || 0), 12);
  assert.equal(after.backgroundSyncProgress.completed, before.backgroundSyncProgress?.completed || 0);
  assert.equal(after.backgroundSyncProgress.ownerCount, 1);
  const [owner] = Object.values(after.backgroundSyncProgressOwners);
  assert.ok(owner.heartbeatAt > 0);
  for (let i = 0; i < 12; i += 1) completeDispatchTracking(reservation);
});

test("completeDispatchTracking advances progress without changing the reserved total", async () => {
  const before = await loadRuntimeState();
  const reservation = reserveDispatchBatch(5);
  completeDispatchTracking(reservation);
  completeDispatchTracking(reservation);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total - before.backgroundSyncProgress.total, 5);
  assert.equal(after.backgroundSyncProgress.completed - before.backgroundSyncProgress.completed, 2);
  for (let i = 0; i < 3; i += 1) completeDispatchTracking(reservation);
});

test("reserveDispatchBatch called again mid-burst adds to the existing total instead of resetting it", async () => {
  const before = await loadRuntimeState();
  const firstReservation = reserveDispatchBatch(3);
  completeDispatchTracking(firstReservation);
  const secondReservation = reserveDispatchBatch(4);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total - before.backgroundSyncProgress.total, 7);
  assert.equal(after.backgroundSyncProgress.completed - before.backgroundSyncProgress.completed, 1);
  for (let i = 0; i < 2; i += 1) completeDispatchTracking(firstReservation);
  for (let i = 0; i < 4; i += 1) completeDispatchTracking(secondReservation);
});

test("reserveDispatchBatch ignores a non-positive size", async () => {
  const reservation = reserveDispatchBatch(3);
  const before = await loadRuntimeState();
  reserveDispatchBatch(0);
  reserveDispatchBatch(-5);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total, before.backgroundSyncProgress.total);
  for (let i = 0; i < 3; i += 1) completeDispatchTracking(reservation);
});

test("finishing one overlapping reservation settles only that reservation", async () => {
  const before = await loadRuntimeState();
  const first = reserveDispatchBatch(3);
  const second = reserveDispatchBatch(4);
  completeDispatchTracking(first);
  finishDispatchTracking(first);

  const midway = await loadRuntimeState();
  assert.equal(midway.backgroundSyncProgress.total - before.backgroundSyncProgress.total, 7);
  assert.equal(midway.backgroundSyncProgress.completed - before.backgroundSyncProgress.completed, 3);

  for (let i = 0; i < 4; i += 1) completeDispatchTracking(second);
});
