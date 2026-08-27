import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-show-merge-history-");
const repo = await import("../server/src/utils/dataRepo.js");

test("show merges are listed and can be undone", async () => {
  const source = await repo.insertWatchRecord({
    title: "Wrong Show - S01E01",
    media_type: "episode",
    watched_at: "2025-01-01T12:00:00.000Z",
    source: "manual",
    season: 1,
    episode: 1,
    tvdb_id: "wrong-show",
  });
  await source.assetPrefetch;

  const merged = await repo.mergeShows("Wrong Show", "Right Show");
  assert.equal(merged.merged, 1);
  assert.deepEqual(repo.listShowMerges({ targetTitle: "Right Show" }).map((item) => item.sourceTitle), ["Wrong Show"]);
  assert.equal((await repo.getWatchRecordById(source.id)).show_title, "Right Show");

  const restored = await repo.unmergeShow(merged.id);
  assert.equal(restored.restored, 1);
  assert.equal((await repo.getWatchRecordById(source.id)).show_title, "Wrong Show");
  assert.equal(repo.listShowMerges({ targetTitle: "Right Show" })[0].active, false);
});
