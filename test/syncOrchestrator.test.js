import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getTargetsForSource,
  shouldSyncResumeProgress,
  syncMediaPlaystate,
} from "../server/src/utils/syncOrchestrator.js";
import { applyTuningConfig, resetTuningForTests } from "../server/src/utils/tuning.js";

test("getTargetsForSource routes to every other enabled platform", () => {
  assert.deepEqual(getTargetsForSource("plex"), ["emby", "jellyfin"]);
  assert.deepEqual(getTargetsForSource("emby", { plex: { disabled: true } }), ["jellyfin"]);
  assert.deepEqual(getTargetsForSource("manual", { jellyfin: { disabled: true } }), ["plex", "emby"]);
  assert.deepEqual(getTargetsForSource("unknown_source"), ["plex", "emby", "jellyfin"]);
  assert.deepEqual(getTargetsForSource("plex_custom"), ["emby", "jellyfin"]);
});

test("shouldSyncResumeProgress enforces actionability boundaries", () => {
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 59_999, progress: 20 }), false);
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 60_000, progress: 89.9 }), true);
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 60_000, progress: 90 }), false);
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "series", offsetMs: 60_000, progress: 20 }), false);
  assert.equal(shouldSyncResumeProgress({ isValid: false, type: "movie", offsetMs: 60_000, progress: 20 }), false);
});

test("shouldSyncResumeProgress honors changed tuning for both boundaries", (t) => {
  t.after(() => resetTuningForTests());

  applyTuningConfig({ minResumePositionSec: 30, watchedThresholdPercent: 70 });
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 29_999, progress: 20 }), false);
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 30_000, progress: 69.9 }), true);
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 30_000, progress: 70 }), false);

  resetTuningForTests();
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 29_999, progress: 20 }), false);
  assert.equal(shouldSyncResumeProgress({ isValid: true, type: "movie", offsetMs: 60_000, progress: 20 }), true);
});

test("loop store checkAndClaim detects a recently claimed source echo", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-loop-test-"));
  process.env.DATA_DIR = dataDir;
  try {
    const { createLoopStore } = await import(`../server/src/utils/loopStore.js?test=${Date.now()}`);
    const kv = createLoopStore();
    const media = {
      isValid: true,
      type: "movie",
      source: "plex",
      title: "Arrival",
      ids: { tmdb: "329865" },
    };
    const sourceEchoKey = "loop:movie:none:none:tmdb:329865:target:plex";
    kv.checkAndClaim([], [sourceEchoKey], 60, 15_000);

    const result = await syncMediaPlaystate(media, {}, kv);

    assert.equal(result.skipped, true);
    assert.equal(result.status, "skipped");
    assert.match(result.details, /Echo loop caught/);
  } finally {
    const { db } = await import("../server/src/db.js");
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
