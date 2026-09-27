import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-scheduler-step-timing-");

const { runScheduledTick, runWithTimeBudget, schedulerStepDidWork, schedulerTimingTelemetry } = await import("../server/src/scheduler.js");

async function captureConsole(run) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines.push([level, args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ")]);
  }
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("scheduler work detection honors explicit provider result contracts", () => {
  assert.equal(schedulerStepDidWork({ didWork: true, jellyfinNextUpFetched: 24 }), true);
  assert.equal(schedulerStepDidWork({ didWork: false, results: [{ snapshot: "not_due" }] }), false);
  assert.equal(schedulerStepDidWork({ skipped: true, reason: "not-due" }), false);
});

test("a step that outlasts its budget is logged as still running, not failed, and its finish is logged", async () => {
  const lines = await captureConsole(async () => {
    await runWithTimeBudget("Slow budget step", () => sleep(60), 10);
    await sleep(100);
  });
  assert.ok(lines.some(([level, text]) => level === "warn" && text.includes("Slow budget step is still running after 10ms")));
  assert.ok(lines.some(([level, text]) => level === "log" && text.includes("Slow budget step finished in the background")));
  assert.ok(!lines.some(([, text]) => text.includes("failed")), JSON.stringify(lines));
});

test("a step that fails after outlasting its budget still logs the failure", async () => {
  const lines = await captureConsole(async () => {
    await runWithTimeBudget("Late failing step", () => sleep(40).then(() => { throw new Error("disk full"); }), 10);
    await sleep(80);
  });
  assert.ok(lines.some(([level, text]) => level === "error" && text.includes("Late failing step failed") && text.includes("disk full")), JSON.stringify(lines));
});

test("a step that fails within its budget is logged as failed", async () => {
  const lines = await captureConsole(async () => {
    await runWithTimeBudget("Quick failing step", () => { throw new Error("bad config"); }, 1000);
  });
  assert.ok(lines.some(([level, text]) => level === "error" && text.includes("Quick failing step failed") && text.includes("bad config")));
  assert.ok(!lines.some(([, text]) => text.includes("still running")));
});

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
