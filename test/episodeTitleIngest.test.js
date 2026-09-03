import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-episode-title-ingest-");
const { db } = await import("../server/src/db.js");
const { normalizeWatchRecord } = await import("../server/src/utils/dataRepo.js");

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

test("ingest keeps a genuine reported episode name", () => {
  const normalized = normalizeWatchRecord({
    media_type: "episode",
    title: "The Expanse - S02E05 - Home",
    tmdb_id: "5001",
    season: 2,
    episode: 5,
    episode_title: "Home",
    source: "plex",
  });
  assert.equal(normalized.episode_title, "Home");
});

test("ingest replaces a bare-coordinate episode_title with a stored real name when present", () => {
  // An earlier watch of the same show/episode already carried the real name.
  insertEpisodeRow({ tmdb_id: "5002", season: 1, episode: 1, episode_title: "Dulcinea" });
  const normalized = normalizeWatchRecord({
    media_type: "episode",
    title: "The Expanse - S01E01",
    tmdb_id: "5002",
    season: 1,
    episode: 1,
    episode_title: "8",
    source: "plex",
  });
  // normalizeWatchRecord coerces empty to null, so numeric stays null only if
  // truly empty; here the stored name should win over the coordinate.
  assert.equal(normalized.episode_title, "Dulcinea");
});

test("ingest drops a bare-coordinate episode_title to null when no real name is stored anywhere", () => {
  insertEpisodeRow({ tmdb_id: "5003", season: 3, episode: 9, episode_title: null });
  const normalized = normalizeWatchRecord({
    media_type: "episode",
    title: "The Expanse - S03E09",
    tmdb_id: "5003",
    season: 3,
    episode: 9,
    episode_title: "9",
    source: "plex",
  });
  assert.equal(normalized.episode_title, null);
});

test("ingest drops a synthesized 'Episode 08' placeholder when a real stored name exists", () => {
  insertEpisodeRow({ tmdb_id: "5004", season: 4, episode: 8, episode_title: "Winnipesaukee" });
  const normalized = normalizeWatchRecord({
    media_type: "episode",
    title: "The Expanse - S04E08",
    tmdb_id: "5004",
    season: 4,
    episode: 8,
    episode_title: "Episode 08",
    source: "emby",
  });
  assert.equal(normalized.episode_title, "Winnipesaukee");
});
