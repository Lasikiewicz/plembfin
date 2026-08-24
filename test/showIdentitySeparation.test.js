import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-show-identity-");

const repo = await import("../server/src/utils/dataRepo.js");

async function insert(record) {
  const result = await repo.insertWatchRecord(record);
  await result.assetPrefetch;
  return result.id;
}

test("same-title shows stay separate by provider identity in listing, preview, and detail", async () => {
  for (const [tmdbId, firstDate] of [["2996", "2026-08-01"], ["2316", "2026-08-03"]]) {
    for (let episode = 1; episode <= 2; episode += 1) {
      await insert({
        title: `The Office - S01E0${episode} - ${tmdbId}`,
        show_title: "The Office",
        media_type: "episode",
        watched_at: `${firstDate}T0${episode}:00:00.000Z`,
        source: "manual",
        tmdb_id: tmdbId,
        season: 1,
        episode,
      });
    }
  }

  const cachedShows = (await repo.getCachedShows()).filter((show) => show.title === "The Office");
  assert.equal(cachedShows.length, 2);
  assert.deepEqual(new Set(cachedShows.map((show) => show.tmdb_id)), new Set(["2996", "2316"]));
  assert.deepEqual(new Set(cachedShows.map((show) => show.id)), new Set(["tmdb:2996", "tmdb:2316"]));

  const listed = await repo.queryShows({ search: "The Office", limit: 10 });
  assert.equal(listed.length, 2);

  for (const expectedTmdbId of ["2996", "2316"]) {
    const summary = listed.find((show) => show.tmdb_id === expectedTmdbId);
    const detail = await repo.queryShowDetail({ id: summary.id });
    assert.equal(detail.tmdb_id, expectedTmdbId);
    assert.equal(detail.episode_count, 2);
  }

  const preview = await repo.queryWatchHistoryPreview({ limit: 20 });
  const previewTmdbIds = preview
    .filter((row) => row.media_type === "episode" && row.show_title === "The Office")
    .map((row) => row.show_tmdb_id);
  assert.deepEqual(new Set(previewTmdbIds), new Set(["2996", "2316"]));
});
