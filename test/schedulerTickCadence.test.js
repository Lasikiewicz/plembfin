import test from "node:test";
import assert from "node:assert/strict";

import { nextTickDelayMs } from "../server/src/workerCoordinator.js";

const TICK_MS = 60_000;

test("a fast tick still waits out the rest of its own period", () => {
  assert.equal(nextTickDelayMs(0, TICK_MS), TICK_MS);
  assert.equal(nextTickDelayMs(2_300, TICK_MS), 57_700);
  assert.equal(nextTickDelayMs(59_999, TICK_MS), 1);
});

test("the period stays constant regardless of how long the tick took", () => {
  // This is the defect finding AH recorded: waiting a full period *after* the
  // tick finished made the real period `TICK_MS + duration`, so a 2.3s tick
  // body produced a 62.3s cadence and a 61s tick body produced 121s.
  for (const duration of [0, 290, 2_300, 9_200, 59_000]) {
    assert.equal(duration + nextTickDelayMs(duration, TICK_MS), TICK_MS);
  }
});

test("an overrunning tick skips the periods it consumed instead of bursting", () => {
  // A 61s tick has overrun one 60s period. The next tick lands on the next
  // boundary, 59s later, rather than firing immediately to catch up.
  assert.equal(nextTickDelayMs(61_000, TICK_MS), 59_000);
  // Two and a half periods consumed: half a period remains.
  assert.equal(nextTickDelayMs(150_000, TICK_MS), 30_000);
});

test("an exact multiple waits a whole period rather than re-entering instantly", () => {
  // Returning 0 here would schedule a same-instant re-entry.
  assert.equal(nextTickDelayMs(TICK_MS, TICK_MS), TICK_MS);
  assert.equal(nextTickDelayMs(TICK_MS * 3, TICK_MS), TICK_MS);
});

test("the delay is always a positive value inside one period", () => {
  for (const duration of [-5, 0, 1, 137, 59_999, 60_000, 60_001, 425_000]) {
    const delay = nextTickDelayMs(duration, TICK_MS);
    assert.ok(delay > 0, `delay for ${duration} should be positive, got ${delay}`);
    assert.ok(delay <= TICK_MS, `delay for ${duration} should not exceed one period, got ${delay}`);
  }
});

test("a non-finite elapsed value is treated as no time spent", () => {
  assert.equal(nextTickDelayMs(Number.NaN, TICK_MS), TICK_MS);
  assert.equal(nextTickDelayMs(undefined, TICK_MS), TICK_MS);
});

test("60 ticks hold their intended wall clock, which is the regression that mattered", () => {
  // Replays the measured provider-backed run: a 2.3s median tick body with a
  // ~60s catch-up pass on every 14th tick (ticks 3, 17, 31, 45 and 59).
  const durationFor = (tick) => (tick % 14 === 3 ? 60_400 : 2_300);
  const overruns = [];
  let wallClock = 0;
  for (let tick = 1; tick <= 59; tick += 1) {
    const duration = durationFor(tick);
    if (duration > TICK_MS) overruns.push(tick);
    wallClock += duration + nextTickDelayMs(duration, TICK_MS);
  }
  assert.deepEqual(overruns, [3, 17, 31, 45, 59]);

  // Every tick that fits inside its period costs exactly one period, and each
  // overrunning tick costs exactly the periods it consumed - one extra here.
  // So the only drift left is the drift the work itself genuinely caused.
  const intendedMs = 59 * TICK_MS;
  assert.equal(wallClock, intendedMs + overruns.length * TICK_MS);

  // The old rule waited a full period *after* each tick finished, so every
  // tick body was added on top of every period. That is the 15.6% shortfall.
  const beforeFix = Array.from({ length: 59 }, (_, index) => durationFor(index + 1))
    .reduce((total, duration) => total + duration + TICK_MS, 0);
  assert.ok(
    beforeFix > wallClock,
    `the previous rule should drift further: ${beforeFix}ms vs ${wallClock}ms`,
  );
});
