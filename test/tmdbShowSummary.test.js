import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-tmdb-show-summary-");

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");

function cacheShow(id, { details, columns = {} }) {
  db.prepare(`
    INSERT OR REPLACE INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, status, poster_path, schema_version, updated_at_ms)
    VALUES (@id, @tmdbId, 'tv', @title, @details, @status, @posterPath, 1, @now)
  `).run({
    id: `tv_${id}`,
    tmdbId: String(id),
    title: `Show ${id}`,
    details: JSON.stringify(details),
    status: columns.status ?? null,
    posterPath: columns.poster_path ?? null,
    now: Date.now(),
  });
}

async function showFor(tmdbId, title) {
  const result = await repo.insertWatchRecord({
    title: `${title} - S01E01 - Pilot`,
    show_title: title,
    media_type: "episode",
    season: 1,
    episode: 1,
    tmdb_id: String(tmdbId),
    watched_at: new Date().toISOString(),
    source: "test",
  });
  await result.assetPrefetch;
  const shows = await repo.getCachedShows();
  return shows.find((s) => String(s.tmdb_id) === String(tmdbId));
}

// The grid reads `status` from its own column rather than parsing a details
// blob that is 64KB for a real TV entry. Artwork is resolved separately by
// getCanonicalPosterUrl, which still reads the blob; that is the remaining
// half of this finding and is deliberately not asserted here.
test("show status is read from the column, not the details blob", async () => {
  cacheShow(4101, {
    details: { status: "Stale Blob Value", poster_path: "/ignored.jpg" },
    columns: { status: "Returning Series", poster_path: "/from-column.jpg" },
  });
  const show = await showFor(4101, "Column Show");
  assert.ok(show, "show should be in the cached shows");
  assert.equal(show.status, "Returning Series");
});

// A row written before those columns existed still has both fields only inside
// the blob. Without the fallback the grid would silently lose the poster and
// status for every title not yet refreshed after an upgrade.
test("a legacy row with empty columns still resolves from the details blob", async () => {
  cacheShow(4102, {
    details: { status: "Ended", poster_path: "/from-blob.jpg" },
    columns: {},
  });
  const show = await showFor(4102, "Legacy Show");
  assert.ok(show, "show should be in the cached shows");
  assert.equal(show.status, "Ended");
  assert.match(String(show.poster_url), /from-blob\.jpg/);
});
