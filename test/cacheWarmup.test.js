import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-cache-warmup-");

const repo = await import("../server/src/utils/dataRepo.js");
const cacheTelemetry = await import("../server/src/utils/cacheTelemetry.js");
const { createCacheWarmup, DEFAULT_WARMUP_STEPS } = await import("../server/src/utils/cacheWarmup.js");

const quietLogger = { log() {}, error() {} };

function fakeWarmup({ steps, quietMs = 5_000, maxWaitMs = 60_000 } = {}) {
  const clock = { now: 1_000_000 };
  const data = { version: 1 };
  const calls = [];
  const warmup = createCacheWarmup({
    steps: steps || [
      { name: "a", run: async () => { calls.push(["a", data.version]); } },
      { name: "b", run: async () => { calls.push(["b", data.version]); } },
    ],
    observeVersion: () => data.version,
    currentVersion: () => data.version,
    quietMs,
    maxWaitMs,
    now: () => clock.now,
    logger: quietLogger,
  });
  return { warmup, clock, data, calls };
}

test("warm-up runs once changes are quiet, and not again for the same version", async () => {
  const { warmup, clock, data, calls } = fakeWarmup();
  // First observation of a new version starts the quiet window.
  warmup.poll();
  data.version = 2;
  assert.equal(warmup.poll(), null);
  clock.now += 4_000;
  assert.equal(warmup.poll(), null, "still inside the 5 s quiet window");
  clock.now += 1_000;
  const run = warmup.poll();
  assert.ok(run, "quiet window elapsed");
  const result = await run;
  assert.deepEqual(result.built.map((entry) => entry.name), ["a", "b"]);
  assert.equal(result.abandoned, false);
  assert.deepEqual(calls, [["a", 2], ["b", 2]]);
  clock.now += 10_000;
  assert.equal(warmup.poll(), null, "already warm for this version");
  assert.equal(calls.length, 2);
});

test("continuous changes still warm at the 60 s ceiling", async () => {
  const { warmup, clock, data } = fakeWarmup();
  let run = null;
  let elapsed = 0;
  while (!run && elapsed <= 90_000) {
    data.version += 1;
    clock.now += 2_000;
    elapsed += 2_000;
    run = warmup.poll();
  }
  assert.ok(run, "the ceiling triggers a run even though changes never went quiet");
  // The first poll starts the window, so the run lands one ceiling later.
  assert.equal(elapsed, 62_000);
  const result = await run;
  assert.equal(result.abandoned, false);
});

test("startup warms on the first poll", async () => {
  const { warmup } = fakeWarmup();
  warmup.start();
  try {
    const run = warmup.poll();
    assert.ok(run, "start() treats startup as an already-settled change");
    await run;
  } finally {
    await warmup.stop();
  }
});

test("a second trigger while running joins the same run", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  const { warmup } = fakeWarmup({ steps: [{ name: "slow", run: async () => { starts += 1; await gate; } }] });
  const first = warmup.trigger();
  const second = warmup.trigger();
  assert.equal(first, second);
  assert.equal(warmup.poll(), null, "poll does not start a run while one is in progress");
  release();
  await first;
  assert.equal(starts, 1);
});

test("a version change mid-run abandons the rest of the run", async () => {
  const state = { version: 5 };
  const calls = [];
  const warmup = createCacheWarmup({
    steps: [
      { name: "a", run: async () => { calls.push("a"); state.version += 1; } },
      { name: "b", run: async () => { calls.push("b"); } },
    ],
    observeVersion: () => state.version,
    currentVersion: () => state.version,
    logger: quietLogger,
  });
  const result = await warmup.trigger();
  assert.equal(result.abandoned, true);
  assert.deepEqual(calls, ["a"]);
  assert.equal(warmup.status().warmedVersion, null, "an abandoned run does not mark any version warm");
});

function deferWarmup({ requestAt }) {
  const clock = { ms: 0 };
  const calls = [];
  const warmup = createCacheWarmup({
    steps: [
      { name: "a", run: async () => { calls.push(["a", clock.ms]); requestAt(clock); } },
      { name: "b", run: async () => { calls.push(["b", clock.ms]); } },
    ],
    observeVersion: () => 1,
    currentVersion: () => 1,
    lastRequest: () => clock.lastRequest ?? -Infinity,
    monotonic: () => clock.ms,
    sleep: async (ms) => { clock.ms += ms; },
    requestQuietMs: 50,
    requestDeferMaxMs: 1_000,
    logger: quietLogger,
  });
  return { warmup, calls };
}

test("a request arriving mid-run goes ahead of the next warm-up step", async () => {
  const { warmup, calls } = deferWarmup({ requestAt: (clock) => { clock.lastRequest = clock.ms; } });
  await warmup.trigger();
  assert.deepEqual(calls, [["a", 0], ["b", 50]], "step b waited until requests were quiet for 50 ms");
});

test("steady requests delay a warm-up step by at most the ceiling", async () => {
  const { warmup, calls } = deferWarmup({ requestAt: (clock) => {
    Object.defineProperty(clock, "lastRequest", { get: () => clock.ms, configurable: true });
  } });
  await warmup.trigger();
  assert.deepEqual(calls, [["a", 0], ["b", 1_000]]);
});

test("yielding show grouping returns exactly what the synchronous grouping returns", async () => {
  for (let show = 1; show <= 6; show += 1) {
    for (let episode = 1; episode <= 3; episode += 1) {
      const inserted = await repo.insertWatchRecord({
        title: `Yield Show ${show} - S01E0${episode} - Part ${episode}`,
        media_type: "episode",
        watched_at: `2026-02-0${episode}T12:00:00.000Z`,
        source: "plex",
        tvdb_id: `yield-show-${show}`,
        season: 1,
        episode,
      });
      await inserted.assetPrefetch;
    }
  }
  await repo.invalidateHistoryDerivedCaches("test", { skipUpNextAutoSync: true });
  const rows = repo.dedupeHistory((await repo.getCachedHistory()).filter((row) => row.media_type === "episode"));
  let otherWorkRan = false;
  const building = repo.groupShowRowsYielding(rows);
  setImmediate(() => { otherWorkRan = true; });
  const yielded = await building;
  assert.ok(otherWorkRan, "the event loop ran other work before the grouping finished");
  assert.ok(yielded.length >= 6);
  assert.deepStrictEqual(yielded, repo.groupShowRows(rows));
});

test("the default steps fill every page cache, matching an on-request build", async () => {
  for (const record of [
    { title: "Warm Movie", media_type: "movie", watched_at: "2026-01-01T12:00:00.000Z", source: "plex", imdb_id: "tt-warm-movie" },
    { title: "Warm Show - S01E01 - Pilot", media_type: "episode", watched_at: "2026-01-02T12:00:00.000Z", source: "emby", tvdb_id: "warm-show", season: 1, episode: 1 },
  ]) {
    const inserted = await repo.insertWatchRecord(record);
    await inserted.assetPrefetch;
  }
  await repo.invalidateHistoryDerivedCaches("test", { skipUpNextAutoSync: true });

  const reads = {
    history: () => repo.getCachedHistory(),
    dashboardPreview: () => repo.queryWatchHistoryPreview({ limit: 120 }),
    historyPage: () => repo.queryWatchHistory({ dedupe: false, limit: 50 }),
    shows: () => repo.queryShows({ limit: 100 }),
    movies: () => repo.queryMovies({ limit: 100 }),
    stats: () => repo.getWatchStats(),
    scheduledShows: () => repo.getCachedShows({ includeScheduledLibraryHistory: true }),
  };
  const readAll = async () => Object.fromEntries(await Promise.all(
    Object.entries(reads).map(async ([name, read]) => [name, structuredClone(await read())]),
  ));

  const warmup = createCacheWarmup({ logger: quietLogger });
  const result = await warmup.trigger();
  assert.equal(result.abandoned, false);
  assert.equal(result.failed, null);
  assert.deepEqual(result.built.map((entry) => entry.name), DEFAULT_WARMUP_STEPS.map((step) => step.name));

  // Every page read after the warm-up is a cache hit: no rebuild is recorded.
  cacheTelemetry.resetCacheRebuildTelemetry();
  const warmed = await readAll();
  assert.equal(cacheTelemetry.cacheRebuildTelemetry().totalRebuilds, 0, "page reads after warm-up rebuilt a cache");

  // And the warmed answers equal what a request would build from cold.
  await repo.invalidateHistoryDerivedCaches("test", { skipUpNextAutoSync: true });
  const onRequest = await readAll();
  for (const name of Object.keys(reads)) {
    assert.deepStrictEqual(warmed[name], onRequest[name], `${name} differs between warm-up and an on-request build`);
  }
});
