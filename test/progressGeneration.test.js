import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-progress-generation-");

const { db, getDataVersion, getProgressVersion, refreshDataVersion } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const tel = await import("../server/src/utils/cacheTelemetry.js");

let ping = 0;
function writeResumePosition() {
  ping += 1;
  db.prepare(`INSERT INTO playback_progress (media_key, title, media_type, source, position_ms, duration_ms, updated_at)
              VALUES (@k, 'Progress Probe', 'movie', 'test', @p, 7200000, @t)
              ON CONFLICT(media_key) DO UPDATE SET position_ms = excluded.position_ms, updated_at = excluded.updated_at`)
    .run({ k: "test:progress:1", p: ping * 1000, t: Date.now() });
}

async function readEverySurface() {
  await repo.getCachedHistory();
  await repo.getCachedMovies();
  await repo.getCachedShows();
  await repo.getWatchStats();
}

// The point of the split. None of these caches reads playback_progress, so a
// resume position cannot change their contents; before the split every one of
// them was thrown away and rebuilt for each ping.
test("a resume-position write rebuilds no history-derived cache", async () => {
  await readEverySurface();
  refreshDataVersion();
  const generationBefore = getDataVersion();

  tel.resetCacheRebuildTelemetry();
  for (let i = 0; i < 3; i += 1) {
    writeResumePosition();
    refreshDataVersion();
    await readEverySurface();
  }

  assert.equal(tel.cacheRebuildTelemetry().totalRebuilds, 0, "no derived cache should rebuild for a resume write");
  assert.equal(getDataVersion(), generationBefore, "the derived-cache generation must not move");
});

// ...but the browser still has to find out, or an open page stops showing
// resume progress advancing.
test("a resume-position write still advances the browser's change contract", async () => {
  refreshDataVersion();
  const before = await repo.getHistoryCacheVersion();
  const progressBefore = getProgressVersion();

  writeResumePosition();
  refreshDataVersion();

  assert.ok(getProgressVersion() > progressBefore, "the progress generation must advance");
  const after = await repo.getHistoryCacheVersion();
  assert.notEqual(after, before, "the client-facing version must change");
  assert.ok(Number.isFinite(Number(after)), "the client parses this with Number(), so it must stay numeric");
  assert.ok(Number(after) > Number(before), "it must move forward, never backwards");
});

// A real watch still has to invalidate everything, or the split has broken the
// thing the caches exist for.
test("a watch-history write still bumps the derived-cache generation", async () => {
  refreshDataVersion();
  const before = getDataVersion();
  const result = await repo.insertWatchRecord({
    title: "Progress Split Probe",
    media_type: "movie",
    watched_at: new Date().toISOString(),
    source: "test",
    tmdb_id: "424242",
  });
  await result.assetPrefetch;
  refreshDataVersion();
  assert.ok(getDataVersion() > before, "a real watch must still invalidate the derived caches");
});
