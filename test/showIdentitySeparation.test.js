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

// Verified live: one 2001 Scrubs watch folded into the reboot's multi-row
// cluster, and the show row took the 2001 TVDB id beside the reboot's TMDB id.
test("a lone same-title row folded into a cluster does not lend it a TVDB id from another TMDB show", async () => {
  const { db } = await import("../server/src/db.js");
  // The TVDB id is a verified series id, so only the grouping rule keeps it out.
  db.prepare(
    "INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
  ).run("series_80076", "80076", "Folded Show", JSON.stringify({ id: 80076, name: "Folded Show" }), Date.now());
  for (let episode = 1; episode <= 2; episode += 1) {
    await insert({
      title: `Folded Show - S01E0${episode}`,
      show_title: "Folded Show",
      media_type: "episode",
      watched_at: `2026-08-0${episode}T01:00:00.000Z`,
      source: "manual",
      tmdb_id: "80001",
      imdb_id: "tt80001",
      season: 1,
      episode,
    });
  }
  await insert({
    title: "Folded Show - S01E04",
    show_title: "Folded Show",
    media_type: "episode",
    watched_at: "2026-08-05T01:00:00.000Z",
    source: "manual",
    tmdb_id: "80002",
    imdb_id: "tt80002",
    tvdb_id: "80076",
    season: 1,
    episode: 4,
  });

  const shows = (await repo.getCachedShows()).filter((show) => show.title === "Folded Show");
  const reboot = shows.find((show) => show.tmdb_id === "80001");
  assert.ok(reboot);
  assert.notEqual(reboot.tvdb_id, "80076", "the other show's TVDB id must not join the cluster's identity");
});

// Verified live: the 2001 Scrubs show's one watch folded into the reboot's
// cluster, and the Recently Watched preview showed one S01E05 row with one
// show's key and the other show's time.
test("a lone same-title row whose TMDB and TVDB ids both disagree keeps its own show in the preview", async () => {
  for (let episode = 4; episode <= 5; episode += 1) {
    await insert({
      title: `Twin Reboot - S01E0${episode}`,
      show_title: "Twin Reboot",
      media_type: "episode",
      watched_at: `2026-08-0${episode}T01:00:00.000Z`,
      source: "manual",
      imdb_id: "tt81001",
      tmdb_id: "81001",
      tvdb_id: "81101",
      season: 1,
      episode,
    });
  }
  await insert({
    title: "Twin Reboot - S01E05",
    show_title: "Twin Reboot",
    media_type: "episode",
    watched_at: "2026-08-07T01:00:00.000Z",
    source: "manual",
    imdb_id: "tt81002",
    tmdb_id: "81002",
    tvdb_id: "81102",
    season: 1,
    episode: 5,
  });

  const preview = (await repo.queryWatchHistoryPreview({ limit: 50 }))
    .filter((row) => row.show_title === "Twin Reboot" && row.episode === 5);
  assert.equal(preview.length, 2, "each show's S01E05 watch keeps its own row");
  const original = preview.find((row) => row.media_key.includes("tt81002"));
  assert.ok(original);
  assert.notEqual(original.show_imdb_id, "tt81001", "the lone show must not take the reboot's IMDb id");
});

// An Up Next build asks about every show against one shared episode-row
// snapshot, which is indexed once instead of rescanned per show. A reused
// snapshot must find the same rows as a fresh read, including a row that
// matches only by id under different title text.
test("show detail through a reused episode-row snapshot matches a fresh read", async () => {
  for (const [episode, showTitle] of [[1, "Index Probe"], [2, "Index Probe"], [3, "Index Probe Alt Name"]]) {
    await insert({
      title: `${showTitle} - S01E0${episode}`,
      show_title: showTitle,
      media_type: "episode",
      watched_at: `2026-08-1${episode}T01:00:00.000Z`,
      source: "manual",
      tmdb_id: "91001",
      season: 1,
      episode,
    });
  }
  const shared = repo.loadTrackedEpisodeRows();
  const office = await repo.queryShowDetail({ episodeRows: shared, id: "tmdb:2996", title: "The Office", tmdbId: "2996" });
  assert.equal(office.episode_count, 2);
  const viaSnapshot = await repo.queryShowDetail({ episodeRows: shared, title: "Index Probe", tmdbId: "91001" });
  const fresh = await repo.queryShowDetail({ title: "Index Probe", tmdbId: "91001" });
  assert.deepEqual(viaSnapshot, fresh);
  assert.deepEqual(viaSnapshot.episodes.map((row) => row.episode).sort(), [1, 2, 3]);
});
