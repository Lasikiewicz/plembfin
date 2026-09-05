import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-scheduler-step-timing-");

const { runScheduledTick, schedulerTimingTelemetry } = await import("../server/src/scheduler.js");

test("a tick is recorded even when it returns before running a step", async () => {
  const before = schedulerTimingTelemetry().ticksObserved;
  const result = await runScheduledTick({ isLeader: () => false });
  assert.deepEqual(result, { skipped: true, reason: "lease-lost" });

  const telemetry = schedulerTimingTelemetry();
  assert.equal(telemetry.ticksObserved, before + 1);
  const tick = telemetry.ticks[telemetry.ticks.length - 1];
  assert.equal(tick.skipped, true);
  assert.equal(tick.reason, "lease-lost");
  assert.deepEqual(tick.steps, []);
  assert.ok(Number.isFinite(tick.durationMs));
});

test("the achieved interval is the gap between tick starts, not the nominal cadence", async () => {
  await runScheduledTick({ isLeader: () => false });
  await runScheduledTick({ isLeader: () => false });

  const telemetry = schedulerTimingTelemetry();
  const tick = telemetry.ticks[telemetry.ticks.length - 1];
  assert.ok(Number.isFinite(tick.achievedIntervalMs), "a tick after the first carries an achieved interval");
  assert.ok(tick.achievedIntervalMs < 60_000, "back-to-back ticks report their real gap, not 60s");
  assert.ok(telemetry.achievedIntervalMs);
  assert.ok(Number.isFinite(telemetry.achievedIntervalMs.mean));
});

test("the telemetry snapshot is a copy, so a caller cannot mutate the history", async () => {
  await runScheduledTick({ isLeader: () => false });
  const telemetry = schedulerTimingTelemetry();
  telemetry.ticks[0].durationMs = -1;
  assert.notEqual(schedulerTimingTelemetry().ticks[0].durationMs, -1);
});
