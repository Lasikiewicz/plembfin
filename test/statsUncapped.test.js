import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-stats-uncapped-");

const { db } = await import("../server/src/db.js");
const { getWatchStats } = await import("../server/src/utils/dataRepo.js");

test("stats includes watch rows beyond the 25,000-row API safety limit", async () => {
  const total = 25_005;
  const insert = db.prepare(`
    INSERT INTO watch_history (
      id, title, title_lower, media_type, watched_at, source, tmdb_id,
      poster_url, sync_action, media_key, created_at, updated_at
    ) VALUES (
      @id, @title, @title_lower, 'movie', @watched_at, 'plex', @tmdb_id,
      @poster_url, 'watched', @media_key, @created_at, @updated_at
    )
  `);
  db.transaction(() => {
    for (let index = 0; index < total; index += 1) {
      const id = `stats-row-${index}`;
      const tmdbId = `stats-movie-${index}`;
      const watchedAt = new Date(Date.UTC(2020, 0, 1) + index * 60_000).toISOString();
      insert.run({
        id,
        title: `Stats Movie ${index}`,
        title_lower: `stats movie ${index}`,
        watched_at: watchedAt,
        tmdb_id: tmdbId,
        poster_url: "/media/posters/stats.webp",
        media_key: `movie:none:none:tmdb:${tmdbId}`,
        created_at: index + 1,
        updated_at: index + 1,
      });
    }
  })();

  const stats = await getWatchStats();
  assert.equal(stats.totalWatches, total);
  assert.equal(stats.reports.all.total, total);
  assert.equal(stats.uniqueMoviesLogged, total);
});
