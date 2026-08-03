import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-season-date-update-");

const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");

async function insertEpisode(title, season, episode, watchedAt) {
  const result = await repo.insertWatchRecord({
    title,
    media_type: "episode",
    season,
    episode,
    show_title: "Release Date Show",
    watched_at: watchedAt,
    source: "plex",
    tmdb_id: "release-date-show",
  });
  await result.assetPrefetch;
  return result.id;
}

test("bulk season date updates stamp only the selected rows", async () => {
  const firstId = await insertEpisode("Release Date Show - S03E01", 3, 1, "2026-07-20T12:00:00.000Z");
  const secondId = await insertEpisode("Release Date Show - S03E02", 3, 2, "2026-07-20T12:00:00.000Z");

  const result = await repo.updateWatchDates([
    { id: firstId, watched_at: "2026-06-08T12:00:00.000Z" },
    { id: secondId, watched_at: "2026-06-15T12:00:00.000Z" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.updated_ids, [firstId, secondId]);
  assert.deepEqual(
    db.prepare("SELECT id, watched_at FROM watch_history WHERE id IN (?, ?) ORDER BY episode").all(firstId, secondId),
    [
      { id: firstId, watched_at: "2026-06-08T12:00:00.000Z" },
      { id: secondId, watched_at: "2026-06-15T12:00:00.000Z" },
    ],
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 2, "date editing must never add rows");
});

test("history exposes real rewatches but hides same-event echoes", async () => {
  const first = await insertEpisode("Release Date Show - S03E03", 3, 3, "2026-06-22T12:00:00.000Z");
  const echo = await repo.insertWatchRecord({
    title: "Release Date Show - S03E03",
    media_type: "episode",
    season: 3,
    episode: 3,
    show_title: "Release Date Show",
    watched_at: "2026-06-22T12:03:00.000Z",
    source: "emby",
    tmdb_id: "release-date-show",
  });
  await echo.assetPrefetch;
  const rewatch = await insertEpisode("Release Date Show - S03E03", 3, 3, "2026-06-29T12:00:00.000Z");

  const show = await repo.queryShowDetail({ title: "Release Date Show" });
  const episode = show.episodes.find((row) => Number(row.season) === 3 && Number(row.episode) === 3);
  assert.ok(episode);
  assert.equal(episode.id, rewatch, "the newest real watch remains the representative row");
  assert.deepEqual(episode.playHistory.map((row) => row.id), [first, rewatch]);
  assert.equal(episode.playHistory.length, 2, "the echo is not shown as a third watch");

  const [summary] = await repo.queryShows({ search: "Release Date Show", limit: 10 });
  assert.equal(summary.total_watches, 4, "show totals count retained actual watches");
  assert.equal(summary.rewatched_episode_count, 1, "only the genuinely replayed episode is marked as rewatched");

  const preview = await repo.queryWatchHistoryPreview({ limit: 20 });
  const previewEpisode = preview.find((row) => Number(row.season) === 3 && Number(row.episode) === 3);
  assert.equal(previewEpisode.watch_count, 2, "dashboard preview carries the retained actual-watch count");
  assert.equal(repo.countRewatchedItems(), 1, "health rewatch count excludes the same-event echo");
});
