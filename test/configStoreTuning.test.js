import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-config-tuning-test-");

const { loadMediaConfig, saveMediaConfig, validateConfig, mergeIncomingConfig, publicMediaConfig } = await import("../server/src/utils/configStore.js");
const { applyTuningConfig, watchedThresholdPercent, resetTuningForTests } = await import("../server/src/utils/tuning.js");
const { listActiveSessions, upsertActiveSession } = await import("../server/src/utils/activeSessions.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  resetTuningForTests();
  db.close();
});

test("saveMediaConfig persists a tuning override and refreshes the effective getters", async () => {
  await saveMediaConfig({ tuning: { watchedThresholdPercent: 75 } });
  assert.equal(watchedThresholdPercent(), 75);

  const reloaded = await loadMediaConfig();
  assert.equal(reloaded.tuning.watchedThresholdPercent, 75);
  assert.equal(reloaded.tuning.minResumePositionSec, null);
  // loadMediaConfig() itself calls applyTuningConfig(), so the getter reflects
  // the round-tripped value too, not just the value set by saveMediaConfig().
  assert.equal(watchedThresholdPercent(), 75);
});

test("publicMediaConfig reports overridden vs default tuning fields", async () => {
  const config = await loadMediaConfig();
  const pub = publicMediaConfig(config);
  assert.equal(pub.tuning.watchedThresholdPercent.overridden, true);
  assert.equal(pub.tuning.watchedThresholdPercent.value, 75);
  assert.equal(pub.tuning.outboundTimeoutSec.overridden, false);
  assert.equal(pub.tuning.outboundTimeoutSec.value, 10);
  assert.equal(pub.tuning.outboundTimeoutSec.default, 10);
  assert.deepEqual([pub.tuning.outboundTimeoutSec.min, pub.tuning.outboundTimeoutSec.max], [2, 120]);
});

test("validateConfig rejects out-of-range tuning fields", async () => {
  const merged = await mergeIncomingConfig({ tuning: { watchedThresholdPercent: 10 } });
  const errors = validateConfig({ tuning: merged.tuning });
  assert.ok(errors.some((message) => message.includes("tuning.watchedThresholdPercent")));
});

test("validateConfig accepts in-range tuning fields", async () => {
  const merged = await mergeIncomingConfig({ tuning: { outboundTimeoutSec: 30 } });
  const errors = validateConfig({ tuning: merged.tuning });
  assert.deepEqual(errors, []);
});

test("an explicit null override clears back to the default on the next save", async () => {
  await saveMediaConfig({ tuning: { watchedThresholdPercent: null } });
  assert.equal(watchedThresholdPercent(), 90);
  const reloaded = await loadMediaConfig();
  assert.equal(reloaded.tuning.watchedThresholdPercent, null);
});

test("active session TTL honors the configured activeSessionTtlMin", async () => {
  await upsertActiveSession({
    title: "TTL Test Session",
    type: "movie",
    source: "plex",
    progress: 10,
    offsetMs: 1000,
    durationMs: 100_000,
    ids: { tmdb: "999" },
  });
  const row = db.prepare("SELECT id FROM active_sessions WHERE title = ?").get("TTL Test Session");
  assert.ok(row);
  // Backdate the session 90s so it falls outside a 1-minute TTL but inside a
  // 120-minute TTL, without a real 90-second wait.
  db.prepare("UPDATE active_sessions SET updated_at = ? WHERE id = ?").run(Date.now() - 90_000, row.id);

  applyTuningConfig({ activeSessionTtlMin: 120 });
  let sessions = await listActiveSessions();
  assert.ok(sessions.some((session) => session.title === "TTL Test Session"));

  applyTuningConfig({ activeSessionTtlMin: 1 });
  sessions = await listActiveSessions();
  assert.ok(!sessions.some((session) => session.title === "TTL Test Session"));
});
