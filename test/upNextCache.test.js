import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-up-next-cache-");
const { bumpDataVersion, bumpUpNextVersion, getUpNextVersion } = await import("../server/src/db.js");
const { getUpNextCacheSnapshot } = await import("../server/src/utils/upNextCache.js");

test("Up Next rebuilds synchronously when watch history changes", async () => {
  let buildCount = 0;
  const initial = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-a", title: "Alpha" }];
  }, { refresh: true });

  assert.deepEqual(initial.items.map((item) => item.id), ["episode-a"]);
  assert.equal(initial.stale, false);
  assert.ok(initial.builtAt > 0);
  const initialVersion = getUpNextVersion();
  const cacheFile = path.join(dataDir, "up-next-cache.json");
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")).items.map((item) => item.id), ["episode-a"]);

  bumpDataVersion();
  const refreshed = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-b", title: "Beta" }];
  }, { revalidate: true });

  assert.deepEqual(refreshed.items.map((item) => item.id), ["episode-b"]);
  assert.equal(refreshed.stale, false);
  assert.equal(buildCount, 2);
  assert.ok(refreshed.upNextVersion > initialVersion);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")).items.map((item) => item.id), ["episode-b"]);
});

test("Up Next can serve a stale projection while the dashboard rebuilds it", async () => {
  let buildCount = 0;
  await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-stale", title: "Stale" }];
  }, { refresh: true });

  bumpDataVersion();
  let resolveBuild;
  const rebuilding = new Promise((resolve) => { resolveBuild = resolve; });
  const snapshot = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    await rebuilding;
    return [{ id: "episode-fresh", title: "Fresh" }];
  }, { revalidate: true, allowStale: true });

  assert.deepEqual(snapshot.items.map((item) => item.id), ["episode-stale"]);
  assert.equal(snapshot.stale, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(buildCount, 2);
  resolveBuild();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a stale first paint after a history change always queues a rebuild, even inside the throttle window", async () => {
  // The previous test already used the provider-feed revalidate slot. Before
  // the fix a second history-stale first paint inside that ten-minute window
  // queued nothing, so an episode watched elsewhere stayed in the rail.
  let buildCount = 0;
  await getUpNextCacheSnapshot(async () => [{ id: "episode-watched-elsewhere", title: "Watched" }], { refresh: true });

  bumpDataVersion();
  const snapshot = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-after-watch", title: "After" }];
  }, { revalidate: true, allowStale: true });
  assert.equal(snapshot.stale, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(buildCount, 1, "the history-stale snapshot must be followed by a rebuild");

  const followUp = await getUpNextCacheSnapshot(async () => [{ id: "unused", title: "Unused" }], { revalidate: true });
  assert.deepEqual(followUp.items.map((item) => item.id), ["episode-after-watch"]);
  assert.equal(followUp.stale, false);
});

test("Up Next rebuilds synchronously when the queue generation changes", async () => {
  let buildCount = 0;
  await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-c", title: "Gamma" }];
  }, { refresh: true });

  bumpUpNextVersion();
  const refreshed = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-d", title: "Delta" }];
  }, { revalidate: true });

  assert.deepEqual(refreshed.items.map((item) => item.id), ["episode-d"]);
  assert.equal(refreshed.stale, false);
  assert.equal(buildCount, 2);
});

test("reading a legacy cache snapshot collapses identity and title-only episode duplicates", async () => {
  await getUpNextCacheSnapshot(async () => ([
    {
      id: "episode|series:tmdb:6278773|s:1|e:5",
      media_type: "episode",
      title: "Example Show - S01E05",
      show_title: "Example Show",
      show_tmdb_id: "6278773",
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 100,
      duration_ms: 1000,
      progress: 10,
    },
    {
      id: "episode|title:example-show|s:1|e:5",
      media_type: "episode",
      title: "Example Show - S01E05",
      show_title: "Example Show",
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 90,
      duration_ms: 1000,
      progress: 9,
    },
  ]), { refresh: true });

  const snapshot = await getUpNextCacheSnapshot(async () => [], { revalidate: true });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].show_tmdb_id, "6278773");
});
