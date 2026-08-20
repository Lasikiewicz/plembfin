import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-dispatch-progress-");

const { reserveDispatchBatch, completeDispatchTracking } = await import("../server/src/utils/syncOrchestrator.js");
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

test("reserveDispatchBatch reports the full total immediately, before any item completes", async () => {
  const before = await loadRuntimeState();
  reserveDispatchBatch(12);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total - (before.backgroundSyncProgress?.total || 0), 12);
  assert.equal(after.backgroundSyncProgress.completed, before.backgroundSyncProgress?.completed || 0);
  for (let i = 0; i < 12; i += 1) completeDispatchTracking();
});

test("completeDispatchTracking advances progress without changing the reserved total", async () => {
  const before = await loadRuntimeState();
  reserveDispatchBatch(5);
  completeDispatchTracking();
  completeDispatchTracking();
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total - before.backgroundSyncProgress.total, 5);
  assert.equal(after.backgroundSyncProgress.completed - before.backgroundSyncProgress.completed, 2);
  for (let i = 0; i < 3; i += 1) completeDispatchTracking();
});

test("reserveDispatchBatch called again mid-burst adds to the existing total instead of resetting it", async () => {
  const before = await loadRuntimeState();
  reserveDispatchBatch(3);
  completeDispatchTracking();
  reserveDispatchBatch(4);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total - before.backgroundSyncProgress.total, 7);
  assert.equal(after.backgroundSyncProgress.completed - before.backgroundSyncProgress.completed, 1);
  for (let i = 0; i < 6; i += 1) completeDispatchTracking();
});

test("reserveDispatchBatch ignores a non-positive size", async () => {
  reserveDispatchBatch(3);
  const before = await loadRuntimeState();
  reserveDispatchBatch(0);
  reserveDispatchBatch(-5);
  const after = await loadRuntimeState();
  assert.equal(after.backgroundSyncProgress.total, before.backgroundSyncProgress.total);
  for (let i = 0; i < 3; i += 1) completeDispatchTracking();
});
