import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-episode-title-repair-");
const { db } = await import("../server/src/db.js");
const {
  isPlaceholderEpisodeTitleValue,
  resolvedEpisodeTitleForRecord,
  resolveStoredEpisodeName,
} = await import("../server/src/utils/episodeTitleRepair.js");

function insertEpisodeRow({ show_title = "The Expanse", tmdb_id = "63639", season = 2, episode = 5, episode_title = null } = {}) {
  return db.prepare(`
    INSERT INTO watch_history
      (id, title, media_type, watched_at, source, tmdb_id, season, episode, show_title, show_title_lower, episode_title)
    VALUES (?, ?, 'episode', ?, 'plex', ?, ?, ?, ?, ?, ?)
  `).run(
    `e${Math.random().toString(36).slice(2)}`,
    `${show_title} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    new Date().toISOString(),
    tmdb_id,
    season,
    episode,
    show_title,
    show_title.toLowerCase(),
    episode_title,
  );
}

test("placeholder detector flags null/empty, bare numbers, and Episode N labels", () => {
  assert.equal(isPlaceholderEpisodeTitleValue(null), true);
  assert.equal(isPlaceholderEpisodeTitleValue(""), true);
  assert.equal(isPlaceholderEpisodeTitleValue("   "), true);
  assert.equal(isPlaceholderEpisodeTitleValue("8"), true);
  assert.equal(isPlaceholderEpisodeTitleValue("Episode 8"), true);
  assert.equal(isPlaceholderEpisodeTitleValue("Episode 08"), true);
  // genuine, even if short, titles are not placeholder
  assert.equal(isPlaceholderEpisodeTitleValue("Home"), false);
  assert.equal(isPlaceholderEpisodeTitleValue("The Belters"), false);
});

test("resolvedEpisodeTitleForRecord returns a real incoming title unchanged", () => {
  const result = resolvedEpisodeTitleForRecord({
    media_type: "episode",
    episode_title: "A Real Episode Name",
    season: 1,
    episode: 1,
  });
  assert.equal(result, "A Real Episode Name");
});

test("resolveStoredEpisodeName finds a real title from a sibling watch row", () => {
  insertEpisodeRow({ tmdb_id: "90001", season: 1, episode: 1, episode_title: "Dulcinea" });
  insertEpisodeRow({ tmdb_id: "90001", season: 1, episode: 1, episode_title: null });
  const resolved = resolveStoredEpisodeName({
    tmdb_id: "90001",
    season: 1,
    episode: 1,
    show_title: "The Expanse",
  });
  assert.equal(resolved, "Dulcinea");
});

test("resolveStoredEpisodeName ignores sibling rows that only carry coordinates", () => {
  insertEpisodeRow({ tmdb_id: "90002", season: 2, episode: 3, episode_title: "6" });
  const resolved = resolveStoredEpisodeName({
    tmdb_id: "90002",
    season: 2,
    episode: 3,
    show_title: "The Expanse",
  });
  assert.equal(resolved, null);
});

test("resolveStoredEpisodeName reads a name from cached season metadata by show tvdb id", () => {
  const tvdbId = "209311";
  db.prepare(`
    INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET details = excluded.details
  `).run(
    `${tvdbId}_2`,
    tvdbId,
    2,
    JSON.stringify({ episodes: [{ episode_number: 5, name: "Home" }, { episode_number: 6, name: "Paradigm Shift" }] }),
    Date.now(),
  );

  const resolved = resolveStoredEpisodeName({ tvdb_id: tvdbId, season: 2, episode: 6 });
  assert.equal(resolved, "Paradigm Shift");
});

test("resolvedEpisodeTitleForRecord leaves incoming null when nothing is stored and season has no cached name", () => {
  const result = resolvedEpisodeTitleForRecord({
    media_type: "episode",
    episode_title: null,
    tmdb_id: "12345",
    season: 9,
    episode: 40,
    show_title: "A Show Nobody Cached",
  });
  assert.equal(result, null);
});
