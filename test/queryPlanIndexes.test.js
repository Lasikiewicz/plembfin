import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-query-plan-");

const { db } = await import("../server/src/db.js");

function plan(sql, params = []) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(" | ");
}

// The performance indexes are only worth their write cost if the planner
// actually chooses them. Asserting the plan rather than a timing keeps this
// meaningful on any machine, and fails loudly if a migration is dropped or a
// column is renamed out from under an index.
test("watch history reads use their intended indexes", () => {
  const seasonPlan = plan("SELECT * FROM watch_history WHERE media_type = ? AND season = ? AND episode = ?", ["episode", 1, 1]);
  assert.match(seasonPlan, /idx_watch_history_media_season_episode/, seasonPlan);

  const titlePlan = plan("SELECT * FROM watch_history WHERE media_type = ? AND title_lower = ?", ["movie", "x"]);
  assert.match(titlePlan, /idx_watch_history_media_title_lower/, titlePlan);

  const tmdbPlan = plan("SELECT * FROM watch_history WHERE tmdb_id = ?", ["1"]);
  assert.match(tmdbPlan, /idx_watch_history_tmdb_id/, tmdbPlan);

  const tvdbPlan = plan("SELECT * FROM watch_history WHERE tvdb_id = ?", ["1"]);
  assert.match(tvdbPlan, /idx_watch_history_tvdb_id/, tvdbPlan);

  // The recent-order read must not fall back to a temp b-tree sort.
  const recentPlan = plan("SELECT * FROM watch_history ORDER BY updated_at DESC, created_at DESC LIMIT 50");
  assert.match(recentPlan, /idx_watch_history_updated_created/, recentPlan);
  assert.doesNotMatch(recentPlan, /TEMP B-TREE/i, recentPlan);
});

test("playstate and progress reads use their intended indexes", () => {
  const titlePlan = plan("SELECT * FROM playstate WHERE media_type = ? AND title_lower = ?", ["movie", "x"]);
  assert.match(titlePlan, /idx_playstate_media_title_lower/, titlePlan);

  const tmdbPlan = plan("SELECT * FROM playstate WHERE media_type = ? AND tmdb_id = ?", ["movie", "1"]);
  assert.match(tmdbPlan, /idx_playstate_media_tmdb_id/, tmdbPlan);

  const imdbPlan = plan("SELECT * FROM playstate WHERE media_type = ? AND imdb_id = ?", ["movie", "tt1"]);
  assert.match(imdbPlan, /idx_playstate_media_imdb_id/, imdbPlan);

  const progressPlan = plan("SELECT * FROM playback_progress WHERE tmdb_id = ?", ["1"]);
  assert.match(progressPlan, /idx_playback_progress_tmdb_id/, progressPlan);
});

// The compact columns exist so grid paths can avoid parsing a details document
// that averages 64KB for a TV entry; a lookup by cache id must be a direct hit.
test("the TMDB summary read is a primary key lookup", () => {
  const summaryPlan = plan("SELECT status, poster_path FROM tmdb_metadata_cache WHERE id = ?", ["tv_1"]);
  assert.doesNotMatch(summaryPlan, /SCAN/, summaryPlan);
});
