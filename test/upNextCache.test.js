import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-up-next-cache-");
const { bumpDataVersion, getUpNextVersion } = await import("../server/src/db.js");
const { getUpNextCacheSnapshot } = await import("../server/src/utils/upNextCache.js");

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for Up Next cache rebuild");
}

test("Up Next serves a durable snapshot while stale data rebuilds in the background", async () => {
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
  let resolveRebuild;
  let rebuildStarted;
  const started = new Promise((resolve) => { rebuildStarted = resolve; });
  const rebuild = new Promise((resolve) => { resolveRebuild = resolve; });
  const stale = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    rebuildStarted();
    return rebuild;
  }, { revalidate: true });

  assert.deepEqual(stale.items.map((item) => item.id), ["episode-a"]);
  assert.equal(stale.stale, true);
  await started;
  assert.equal(buildCount, 2);

  resolveRebuild([{ id: "episode-b", title: "Beta" }]);
  await waitFor(async () => JSON.parse(await fs.readFile(cacheFile, "utf8")).items[0]?.id === "episode-b");

  const refreshed = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "unexpected" }];
  }, { revalidate: true });
  assert.deepEqual(refreshed.items.map((item) => item.id), ["episode-b"]);
  assert.equal(refreshed.stale, false);
  assert.ok(refreshed.upNextVersion > initialVersion);
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

  bumpDataVersion();
  const snapshot = await getUpNextCacheSnapshot(async () => [], { revalidate: true });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].show_tmdb_id, "6278773");
});
