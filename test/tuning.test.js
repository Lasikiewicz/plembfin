import test from "node:test";
import assert from "node:assert/strict";

import {
  activeSessionTtlMs,
  applyTuningConfig,
  minResumePositionMs,
  normalizeTuningSection,
  outboundTimeoutMs,
  resetTuningForTests,
  tuningClamps,
  tuningDefaults,
  tuningEnvDefaults,
  watchedThresholdPercent,
} from "../server/src/utils/tuning.js";

const ENV_VARS = ["WATCHED_THRESHOLD_PERCENT", "MIN_RESUME_POSITION_SEC", "ACTIVE_SESSION_TTL_MIN", "OUTBOUND_TIMEOUT_SEC"];

function clearTuningEnv() {
  for (const name of ENV_VARS) delete process.env[name];
}

test.afterEach(() => {
  clearTuningEnv();
  resetTuningForTests();
});

test("defaults equal the previous hardcoded literals when nothing is configured", () => {
  resetTuningForTests();
  assert.equal(watchedThresholdPercent(), 90);
  assert.equal(minResumePositionMs(), 60_000);
  assert.equal(activeSessionTtlMs(), 5 * 60 * 1000);
  assert.equal(outboundTimeoutMs(), 10_000);
});

test("tuningDefaults and tuningClamps expose the hardcoded ranges", () => {
  assert.deepEqual(tuningDefaults(), {
    watchedThresholdPercent: 90,
    minResumePositionSec: 60,
    activeSessionTtlMin: 5,
    outboundTimeoutSec: 10,
  });
  assert.deepEqual(tuningClamps(), {
    watchedThresholdPercent: [50, 100],
    minResumePositionSec: [0, 3600],
    activeSessionTtlMin: [1, 120],
    outboundTimeoutSec: [2, 120],
  });
});

test("normalizeTuningSection treats blank/null/missing fields as null and parses numeric strings", () => {
  assert.deepEqual(
    normalizeTuningSection({
      watchedThresholdPercent: "85",
      minResumePositionSec: "",
      activeSessionTtlMin: null,
      // outboundTimeoutSec omitted entirely
    }),
    {
      watchedThresholdPercent: 85,
      minResumePositionSec: null,
      activeSessionTtlMin: null,
      outboundTimeoutSec: null,
    },
  );
});

test("normalizeTuningSection does not clamp — out-of-range values pass through for validateConfig to reject", () => {
  assert.deepEqual(normalizeTuningSection({ watchedThresholdPercent: 5, outboundTimeoutSec: 999 }), {
    watchedThresholdPercent: 5,
    minResumePositionSec: null,
    activeSessionTtlMin: null,
    outboundTimeoutSec: 999,
  });
});

test("normalizeTuningSection ignores non-numeric strings", () => {
  assert.deepEqual(normalizeTuningSection({ watchedThresholdPercent: "not-a-number" }), {
    watchedThresholdPercent: null,
    minResumePositionSec: null,
    activeSessionTtlMin: null,
    outboundTimeoutSec: null,
  });
});

test("applyTuningConfig overrides only non-null fields and falls back to env/default for the rest", () => {
  applyTuningConfig({ watchedThresholdPercent: 80, minResumePositionSec: null });
  assert.equal(watchedThresholdPercent(), 80);
  assert.equal(minResumePositionMs(), 60_000);
  assert.equal(activeSessionTtlMs(), 5 * 60 * 1000);
  assert.equal(outboundTimeoutMs(), 10_000);
});

test("applyTuningConfig clamps out-of-range stored values as a safety net", () => {
  applyTuningConfig({ outboundTimeoutSec: 999, watchedThresholdPercent: 5 });
  assert.equal(outboundTimeoutMs(), 120_000);
  assert.equal(watchedThresholdPercent(), 50);
});

test("resetTuningForTests restores env/default state after an override", () => {
  applyTuningConfig({ watchedThresholdPercent: 70 });
  assert.equal(watchedThresholdPercent(), 70);
  resetTuningForTests();
  assert.equal(watchedThresholdPercent(), 90);
});

test("env vars set the default (clamped) and applyTuningConfig overrides still win", () => {
  process.env.WATCHED_THRESHOLD_PERCENT = "40"; // below the clamp min of 50
  process.env.OUTBOUND_TIMEOUT_SEC = "30";
  resetTuningForTests();
  assert.equal(watchedThresholdPercent(), 50);
  assert.equal(outboundTimeoutMs(), 30_000);

  applyTuningConfig({ outboundTimeoutSec: 15 });
  assert.equal(outboundTimeoutMs(), 15_000);
  assert.equal(watchedThresholdPercent(), 50);
});

test("tuningEnvDefaults reflects env overrides without requiring applyTuningConfig", () => {
  process.env.ACTIVE_SESSION_TTL_MIN = "15";
  assert.equal(tuningEnvDefaults().activeSessionTtlMin, 15);
});

test("an invalid env value falls back to the hardcoded default", () => {
  process.env.MIN_RESUME_POSITION_SEC = "not-a-number";
  resetTuningForTests();
  assert.equal(minResumePositionMs(), 60_000);
});
