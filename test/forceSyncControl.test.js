import test from "node:test";
import assert from "node:assert/strict";

import { forceSyncStopAction } from "../server/src/utils/forceSyncControl.js";

test("forceSyncStopAction cancels an in-process worker", () => {
  assert.equal(forceSyncStopAction({ workerRunning: true, runtimeActive: true }), "cancel");
});

test("forceSyncStopAction resets a persisted lock after restart", () => {
  assert.equal(forceSyncStopAction({ workerRunning: false, runtimeActive: true }), "reset");
  assert.equal(forceSyncStopAction({ workerRunning: false, cancelRequested: true }), "reset");
});

test("forceSyncStopAction is idle when no worker or lock exists", () => {
  assert.equal(forceSyncStopAction(), "idle");
});
