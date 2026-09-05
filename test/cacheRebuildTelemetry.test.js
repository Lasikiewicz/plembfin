import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-cache-rebuild-telemetry-");

const { recordCacheRebuild, timeCacheRebuild, timeCacheRebuildAsync, cacheRebuildTelemetry, resetCacheRebuildTelemetry } =
  await import("../server/src/utils/cacheTelemetry.js");
const { db, bumpDataVersion, dataVersionTrigger } = await import("../server/src/db.js");
const dataRepo = await import("../server/src/utils/dataRepo.js");

test("a rebuild records its cache, duration and trigger", () => {
  resetCacheRebuildTelemetry();
  recordCacheRebuild("history", { version: 12, trigger: "handleManualWatch", durationMs: 4 });
  recordCacheRebuild("history", { version: 13, trigger: "handleManualWatch", durationMs: 6 });
  recordCacheRebuild("stats", { version: 13, trigger: "runForceSync", durationMs: 100 });

  const telemetry = cacheRebuildTelemetry();
  assert.equal(telemetry.totalRebuilds, 3);
  const history = telemetry.caches.find((entry) => entry.cache === "history");
  assert.equal(history.rebuilds, 2);
  assert.equal(history.totalMs, 10);
  assert.equal(history.maxMs, 6);
  assert.equal(history.meanMs, 5);
  assert.deepEqual(history.byTrigger, [{ trigger: "handleManualWatch", rebuilds: 2, totalMs: 10 }]);
  // The stats rebuild is the expensive one, so it sorts first.
  assert.equal(telemetry.caches[0].cache, "stats");
});

test("counting bumps cannot distinguish an expensive invalidation from a free one, so rebuilds carry the trigger", () => {
  resetCacheRebuildTelemetry();
  recordCacheRebuild("shows", { version: 5, trigger: "handlePlaybackProgressWatch", durationMs: 40 });
  recordCacheRebuild("shows", { version: 6, trigger: "runForceSync", durationMs: 2 });

  const shows = cacheRebuildTelemetry().caches.find((entry) => entry.cache === "shows");
  assert.equal(shows.rebuilds, 2);
  assert.deepEqual(
    shows.byTrigger,
    [
      { trigger: "handlePlaybackProgressWatch", rebuilds: 1, totalMs: 40 },
      { trigger: "runForceSync", rebuilds: 1, totalMs: 2 },
    ],
  );
});

test("the timing wrappers return the build result and count its items", async () => {
  resetCacheRebuildTelemetry();
  const rows = timeCacheRebuild("movies", 3, "test", () => [1, 2, 3]);
  assert.deepEqual(rows, [1, 2, 3]);
  const shows = await timeCacheRebuildAsync("shows", 3, "test", async () => ["a", "b"]);
  assert.deepEqual(shows, ["a", "b"]);

  const recent = cacheRebuildTelemetry().recent;
  assert.equal(recent.length, 2);
  assert.equal(recent[0].items, 3);
  assert.equal(recent[1].items, 2);
});

test("an unlabelled generation change reports as observed rather than guessing", () => {
  const labelled = bumpDataVersion("unit-test-label");
  assert.equal(dataVersionTrigger(labelled), "unit-test-label");
  const unlabelled = bumpDataVersion();
  assert.equal(dataVersionTrigger(unlabelled), "observed");
});

test("reading a derived cache twice at one generation rebuilds it once", async () => {
  resetCacheRebuildTelemetry();
  await dataRepo.getCachedHistory();
  await dataRepo.getCachedHistory();
  const history = cacheRebuildTelemetry().caches.find((entry) => entry.cache === "history");
  assert.equal(history.rebuilds, 1, "the second read must be a cache hit, not a second rebuild");
});

test("an invalidation labelled by its caller reaches the rebuild it causes", async () => {
  await dataRepo.getCachedHistory();
  resetCacheRebuildTelemetry();
  await dataRepo.invalidateHistoryDerivedCaches("unit-test-invalidation");
  await dataRepo.getCachedHistory();
  const history = cacheRebuildTelemetry().caches.find((entry) => entry.cache === "history");
  assert.equal(history.rebuilds, 1);
  assert.equal(history.lastTrigger, "unit-test-invalidation");
});

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
});
