import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-worker-startup-scan-");
// Timing constants are read when workerCoordinator.js is imported.
process.env.PLEMBFIN_TEST_MODE = "1";
process.env.PLEMBFIN_TEST_FIRST_TICK_MS = "50";
process.env.PLEMBFIN_TEST_LEASE_ACQUIRE_MS = "5000";
process.env.PLEMBFIN_TEST_LEASE_RENEW_MS = "5000";
process.env.PLEMBFIN_PAUSE_SCHEDULED_WORKER = "1";

const { createWorkerCoordinator } = await import("../server/src/workerCoordinator.js");
const { loadRuntimeState } = await import("../server/src/utils/configStore.js");
const { stopPlexNotificationListener, stopPlexAdaptivePoller, stopLiveSessionPoller } = await import("../server/src/scheduler.js");

const coordinatorSource = fs.readFileSync(path.resolve(import.meta.dirname, "../server/src/workerCoordinator.js"), "utf8");

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("the startup scan stays active until the deferred backfills have run", async () => {
  const coordinator = createWorkerCoordinator({ holderId: "startup-scan-test", role: "all" });
  try {
    await coordinator.start();
    await delay(20);
    // Backfills are deferred past the first tick, so the scan must still be
    // reported as running; clearing it here would show "complete" before any
    // scanning happened.
    assert.equal((await loadRuntimeState()).startupScanActive, true);

    const deadline = Date.now() + 5_000;
    let runtime = await loadRuntimeState();
    while (runtime.startupScanActive === true && Date.now() < deadline) {
      await delay(50);
      runtime = await loadRuntimeState();
    }
    assert.equal(runtime.startupScanActive, false);
    assert.ok(Number(runtime.startupScanCompletedAt) > 0);
  } finally {
    await coordinator.stop();
    stopPlexNotificationListener();
    stopPlexAdaptivePoller();
    stopLiveSessionPoller();
  }
});

test("deferred provider pollers and backfills are bound to the leadership term that scheduled them", () => {
  assert.match(coordinatorSource, /const stillCurrentLeader = \(\) => !stopped && lease\?\.generation === generation && isLeader\(\);/);
  const pollers = coordinatorSource.match(/const startProviderPollers = \(\) => \{[\s\S]*?\n {6}\};/)?.[0] || "";
  assert.match(pollers, /if \(!stillCurrentLeader\(\)\) return;/);
});
