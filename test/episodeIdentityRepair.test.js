import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-episode-identity-repair-");
const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");

const insertHistoryStmt = db.prepare(`
  INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, season, episode, media_key, show_title, show_title_lower, sync_action, created_at, updated_at)
  VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'emby', @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @media_key, @show_title, @show_title_lower, 'watched', @created_at, @updated_at)
`);
const insertProgressStmt = db.prepare(`
  INSERT INTO playback_progress
    (media_key, title, media_type, source, imdb_id, tmdb_id, tvdb_id, season, episode, position_ms, duration_ms, progress, updated_at)
  VALUES (@media_key, @title, 'episode', @source, @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @position_ms, @duration_ms, @progress, @updated_at)
`);

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function insertHistory({ showTitle, season, episode, ids }) {
  const title = `${showTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  const media = {
    title,
    media_type: "episode",
    season,
    episode,
    imdb_id: ids.imdb_id || null,
    tmdb_id: ids.tmdb_id || null,
    tvdb_id: ids.tvdb_id || null,
  };
  const timestamp = Date.now();
  insertHistoryStmt.run({
    id: `${showTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${season}-${episode}-${media.imdb_id || media.tmdb_id || media.tvdb_id}`,
    title,
    title_lower: title.toLowerCase(),
    watched_at: `2026-08-${String(episode).padStart(2, "0")}T00:00:00.000Z`,
    ...media,
    media_key: repo.mediaKeyFor(media),
    show_title: showTitle,
    show_title_lower: showTitle.toLowerCase(),
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function insertProgress({ title, season, episode, source = "emby", ids, positionMs, updatedAt }) {
  const media = {
    media_type: "episode",
    title,
    season,
    episode,
    source,
    imdb_id: ids.imdb || null,
    tmdb_id: ids.tmdb || null,
    tvdb_id: ids.tvdb || null,
  };
  insertProgressStmt.run({
    media_key: repo.mediaKeyFor(media),
    title,
    source,
    imdb_id: media.imdb_id,
    tmdb_id: media.tmdb_id,
    tvdb_id: media.tvdb_id,
    season,
    episode,
    position_ms: positionMs,
    duration_ms: 1_000_000,
    progress: positionMs / 10_000,
    updated_at: updatedAt,
  });
}

test("scheduled identity repair collapses Ted Lasso episode aliases and future writes stay canonical", { concurrency: false }, async () => {
  for (const episode of [1, 2, 3]) {
    insertHistory({
      showTitle: "Ted Lasso",
      season: 4,
      episode,
      ids: { imdb_id: "tt10986410", tmdb_id: "97546", tvdb_id: "383203" },
    });
  }

  const title = "Ted Lasso - S04E06";
  insertProgress({
    title,
    season: 4,
    episode: 6,
    ids: { imdb: "tt38494472" },
    positionMs: 100_000,
    updatedAt: 100,
  });
  insertProgress({
    title,
    season: 4,
    episode: 6,
    ids: { tvdb: "383203" },
    positionMs: 200_000,
    updatedAt: 200,
  });

  await repo.repairEpisodeSeriesIdentity();

  let rows = db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ?",
  ).all(title);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imdb_id, "tt10986410");
  assert.equal(rows[0].tmdb_id, "97546");
  assert.equal(rows[0].tvdb_id, "383203");
  assert.equal(rows[0].position_ms, 200_000);

  await repo.upsertPlaybackProgress({
    title,
    media_type: "episode",
    source: "emby",
    imdb_id: "tt38494472",
    season: 4,
    episode: 6,
    position_ms: 300_000,
    duration_ms: 1_000_000,
    updated_at: 300,
  });

  rows = db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ?",
  ).all(title);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imdb_id, "tt10986410");
  assert.equal(rows[0].position_ms, 300_000);
  assert.deepEqual(repo.seriesIdsForShowTitle(title), {
    imdb: "tt10986410",
    tmdb: "97546",
    tvdb: "383203",
  });
});

test("repair leaves episode-level progress unresolved when same-title reboots are ambiguous", { concurrency: false }, async () => {
  for (const [tmdb, episodes] of [["4556", [1, 2]], ["295778", [1, 2]]]) {
    for (const episode of episodes) {
      insertHistory({
        showTitle: "Scrubs",
        season: 1,
        episode,
        ids: { tmdb_id: tmdb },
      });
    }
  }

  const title = "Scrubs - S01E01";
  insertProgress({ title, season: 1, episode: 1, ids: { tmdb: "4556" }, positionMs: 100_000, updatedAt: 100 });
  insertProgress({ title, season: 1, episode: 1, ids: { tvdb: "episode-only-id" }, positionMs: 200_000, updatedAt: 200 });
  insertProgress({ title, season: 1, episode: 1, ids: { tmdb: "295778" }, positionMs: 150_000, updatedAt: 150 });

  await repo.repairEpisodeSeriesIdentity();

  const rows = db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ? ORDER BY updated_at",
  ).all(title);
  assert.equal(rows.length, 3);
  assert.ok(rows.some((row) => row.tvdb_id === "episode-only-id"));
  assert.equal(repo.seriesIdsForShowTitle(title), null);
});
