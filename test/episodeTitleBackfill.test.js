import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-episode-title-backfill-");
const { db } = await import("../server/src/db.js");
const {
  auditEpisodeTitleGaps,
  backfillEpisodeTitleGaps,
} = await import("../server/src/utils/dataRepo.js");

function insertEpisodeRow({ show_title = "The Expanse", tmdb_id = "63639", season = 2, episode = 5, episode_title = null, watchedAt = null } = {}) {
  return db.prepare(`
    INSERT INTO watch_history
      (id, title, media_type, watched_at, source, tmdb_id, season, episode, show_title, show_title_lower, episode_title)
    VALUES (?, ?, 'episode', ?, 'plex', ?, ?, ?, ?, ?, ?)
  `).run(
    `e${Math.random().toString(36).slice(2)}`,
    `${show_title} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    watchedAt || new Date().toISOString(),
    tmdb_id,
    season,
    episode,
    show_title,
    show_title.toLowerCase(),
    episode_title,
  );
}

test("auditEpisodeTitleGaps reports rows with no real stored episode name", () => {
  insertEpisodeRow({ tmdb_id: "7001", season: 1, episode: 1, episode_title: "Dulcinea" });
  insertEpisodeRow({ tmdb_id: "7001", season: 1, episode: 2, episode_title: null });
  const audit = auditEpisodeTitleGaps({ limit: 100 });
  // Only the null-title row is a gap; the row with the real name is not.
  assert.equal(audit.rows.some((row) => row.episode_title === "Dulcinea"), false);
  assert.equal(audit.rows.some((row) => row.episode === 2 && row.episode_title === null), true);
});

test("backfillEpisodeTitleGaps fills a null title from a sibling watch row holding the real name", async () => {
  insertEpisodeRow({ tmdb_id: "7002", season: 3, episode: 1, episode_title: "Immersion" });
  insertEpisodeRow({ tmdb_id: "7002", season: 3, episode: 1, episode_title: null });
  const result = await backfillEpisodeTitleGaps({ limit: 200, allowFetch: false });
  assert.equal(result.backfilled >= 1, true);

  const row = db.prepare(
    "SELECT episode_title FROM watch_history WHERE tmdb_id = '7002' AND episode_title IS NOT NULL",
  ).get();
  assert.equal(row?.episode_title, "Immersion");
  const stillNull = db.prepare(
    "SELECT COUNT(*) AS c FROM watch_history WHERE tmdb_id = '7002' AND episode_title IS NULL",
  ).get();
  assert.equal(stillNull.c, 0);
});

test("backfillEpisodeTitleGaps leaves rows unresolved when nothing real is stored and fetch is disabled", async () => {
  insertEpisodeRow({ tmdb_id: "7003", season: 5, episode: 2, episode_title: null });
  const before = db.prepare("SELECT episode_title FROM watch_history WHERE tmdb_id = '7003'").get();
  assert.equal(before?.episode_title, null);

  const result = await backfillEpisodeTitleGaps({ limit: 200, allowFetch: false });
  const after = db.prepare("SELECT episode_title FROM watch_history WHERE tmdb_id = '7003'").get();
  // No stored name anywhere and no fetch allowed: the row stays unresolved.
  assert.equal(after?.episode_title, null);
  assert.equal(result.unresolved >= 1, true);
});
