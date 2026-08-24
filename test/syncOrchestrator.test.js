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

test("a dispatch with every destination disabled is skipped, not successful", async () => {
  const kv = { checkAndClaim: () => false, async put() {}, async get() { return null; } };
  const result = await syncMediaPlaystate({
    isValid: true,
    type: "movie",
    source: "manual",
    title: "Arrival",
    ids: { tmdb: "329865" },
  }, {
    plex: { disabled: true },
    emby: { disabled: true },
    jellyfin: { disabled: true },
  }, kv);

  assert.equal(result.status, "skipped");
  assert.equal(result.skipped, true);
  assert.deepEqual(result.targetStates, []);
  assert.match(result.details, /No enabled sync destinations/);
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

test("outbound played marks are keyed per target and per item", async () => {
  const { recordOutboundPlayedMarks, lastOutboundPlayedMarkAt } = await import(
    "../server/src/utils/syncOrchestrator.js"
  );

  // A plain key/value stub: this exercises the ledger's keying, which is what
  // lets a late echo be matched back to our own write. Persistence and TTL are
  // loopStore's concern and are covered by the loop-detection test above.
  const store = new Map();
  const kv = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };

  const media = {
    isValid: true,
    type: "episode",
    season: 5,
    episode: 3,
    source: "plex",
    title: "Trying - S05E03",
    ids: { tvdb: "11768064" },
  };

  assert.equal(await lastOutboundPlayedMarkAt(media, "emby", kv), 0);

  const before = Date.now();
  await recordOutboundPlayedMarks(media, ["emby", "jellyfin"], kv);

  assert.ok(await lastOutboundPlayedMarkAt(media, "emby", kv) >= before, "records when we marked Emby played");
  assert.ok(await lastOutboundPlayedMarkAt(media, "jellyfin", kv) >= before);

  // A target we never wrote to, and a different episode, must not match.
  assert.equal(await lastOutboundPlayedMarkAt(media, "plex", kv), 0);
  assert.equal(await lastOutboundPlayedMarkAt({ ...media, episode: 4 }, "emby", kv), 0);
});

test("played-flag echoes match Jellyfin item ids even when provider ids are absent", async () => {
  const { isRecentOutboundPlayedFlagEcho, recordOutboundPlayedMarks } = await import(
    "../server/src/utils/syncOrchestrator.js"
  );
  const store = new Map();
  const kv = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };

  const outbound = {
    isValid: true,
    type: "episode",
    source: "jellyfin",
    itemId: "jellyfin-item-123",
    season: 1,
    episode: 4,
    title: "Example Show - S01E04",
    ids: { tvdb: "12345" },
  };
  await recordOutboundPlayedMarks(outbound, ["jellyfin"], kv);

  const callback = {
    ...outbound,
    ids: {},
    playedFlagOnly: true,
    playedAt: "2026-05-31T02:53:20.048Z",
  };
  assert.equal(await isRecentOutboundPlayedFlagEcho(callback, "jellyfin", kv, { now: Date.now() + 1_000 }), true);
  assert.equal(await isRecentOutboundPlayedFlagEcho(callback, "jellyfin", kv, { now: Date.now() + 11 * 60 * 1000 }), false);
  assert.equal(await isRecentOutboundPlayedFlagEcho({ ...callback, playedFlagOnly: false }, "jellyfin", kv), false);
  assert.equal(await isRecentOutboundPlayedFlagEcho({ ...callback, itemId: "different-item", title: "Other Show - S01E04" }, "jellyfin", kv), false);
});

test("Plex completed callbacks match Plembfin's own recent outbound played mark", async () => {
  const { isRecentOutboundPlayedEcho, recordOutboundPlayedMarks } = await import(
    "../server/src/utils/syncOrchestrator.js"
  );
  const store = new Map();
  const kv = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };
  const media = {
    isValid: true,
    type: "episode",
    source: "plex",
    title: "G'wed - S02E02",
    showTitle: "G'wed",
    season: 2,
    episode: 2,
    ids: { tmdb: "245412", tvdb: "434702" },
  };
  await recordOutboundPlayedMarks(media, ["plex"], kv);

  assert.equal(await isRecentOutboundPlayedEcho({ ...media, event: "media.scrobble", playedFlagOnly: false }, "plex", kv), true);
  assert.equal(await isRecentOutboundPlayedEcho({ ...media, episode: 3 }, "plex", kv), false);
});

test("unplayed echoes are tracked separately from played marks", async () => {
  const { isRecentOutboundUnplayedFlagEcho, lastOutboundUnplayedMarkAt, recordOutboundUnplayedMarks } = await import(
    "../server/src/utils/syncOrchestrator.js"
  );
  const store = new Map();
  const kv = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };
  const media = { isValid: true, type: "movie", title: "Arrival", itemId: "plex-1", ids: {} };

  assert.equal(await lastOutboundUnplayedMarkAt(media, "plex", kv), 0);
  await recordOutboundUnplayedMarks(media, ["plex"], kv);
  assert.ok(await lastOutboundUnplayedMarkAt(media, "plex", kv) > 0);
  assert.equal(await isRecentOutboundUnplayedFlagEcho({ ...media, itemId: "plex-1" }, "plex", kv, { now: Date.now() + 1_000 }), true);
  assert.equal(await isRecentOutboundUnplayedFlagEcho({ ...media, itemId: "plex-1" }, "plex", kv, { now: Date.now() + 11 * 60 * 1000 }), false);
  assert.equal(await isRecentOutboundUnplayedFlagEcho({ ...media, itemId: "different", title: "Other Movie" }, "plex", kv), false);
});

test("resume updates suppress immediate played=false webhook echoes", async () => {
  const {
    isRecentOutboundProgressEcho,
    lastOutboundProgressMarkAt,
    recordOutboundProgressMarks,
  } = await import("../server/src/utils/syncOrchestrator.js");
  const store = new Map();
  const kv = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };
  const outbound = {
    isValid: true,
    type: "episode",
    source: "plex",
    title: "Ted Lasso - S04E01",
    season: 4,
    episode: 1,
    ids: { tvdb: "11766070" },
  };

  await recordOutboundProgressMarks(outbound, ["emby", "jellyfin"], kv);
  assert.ok(await lastOutboundProgressMarkAt(outbound, "jellyfin", kv) > 0);

  // Jellyfin's UserDataSaved callback can omit provider ids and use a different
  // native item id. The canonical title plus episode coordinates still identify
  // it as the acknowledgement of our progress write.
  const callback = { ...outbound, source: "jellyfin", ids: {}, itemId: "jellyfin-episode-id" };
  assert.equal(await isRecentOutboundProgressEcho(callback, "jellyfin", kv, { now: Date.now() + 1_000 }), true);
  assert.equal(await isRecentOutboundProgressEcho(callback, "jellyfin", kv, { now: Date.now() + 16_000 }), false);
  assert.equal(await isRecentOutboundProgressEcho({ ...callback, episode: 2 }, "jellyfin", kv), false);
  assert.equal(await isRecentOutboundProgressEcho(callback, "plex", kv), false);
});
