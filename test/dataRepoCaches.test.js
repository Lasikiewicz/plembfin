import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-data-repo-caches-");

const repo = await import("../server/src/utils/dataRepo.js");

const getters = {
  history: repo.getCachedHistory,
  movies: repo.getCachedMovies,
  shows: repo.getCachedShows,
  stats: repo.getWatchStats,
};

async function insert(record) {
  const result = await repo.insertWatchRecord(record);
  await result.assetPrefetch;
  return result.id;
}

async function warmAll() {
  return Object.fromEntries(await Promise.all(
    Object.entries(getters).map(async ([name, getter]) => [name, structuredClone(await getter())]),
  ));
}

async function assertMatchesForcedRebuild(label, beforeVersion) {
  const afterVersion = await repo.getHistoryCacheVersion();
  assert.ok(afterVersion > beforeVersion, `${label} must advance historyVersion`);
  const actual = await warmAll();
  await repo.invalidateHistoryDerivedCaches();
  const oracle = await warmAll();
  for (const name of Object.keys(getters)) {
    assert.deepStrictEqual(actual[name], oracle[name], `${label}: ${name} cache differs from a full rebuild`);
  }
}

const movieId = await insert({
  title: "Cache Movie",
  media_type: "movie",
  watched_at: "2026-01-01T12:00:00.000Z",
  source: "plex",
  imdb_id: "tt-cache-movie",
  poster_url: "https://example.test/movie-0.jpg",
});
const episodeId = await insert({
  title: "Cache Show - S01E01 - Pilot",
  media_type: "episode",
  watched_at: "2026-01-02T12:00:00.000Z",
  source: "emby",
  tvdb_id: "cache-show",
  season: 1,
  episode: 1,
  poster_url: "https://example.test/show-0.jpg",
});

test("derived caches stay identical to forced rebuilds across targeted and randomized writes", async () => {
  const cases = [
    ["movie telemetry", () => repo.updateWatchTelemetry(movieId, "Target emby status: Success")],
    ["episode telemetry", () => repo.updateWatchTelemetry(episodeId, "Target plex status: No matching item found")],
    ["telemetry tracked-status flip", () => repo.updateWatchTelemetry(episodeId, "Watch event fetched from Plex library history")],
    ["sync retry", () => repo.updateWatchSyncRetry(movieId, 2, Date.now() + 60_000)],
    ["poster", () => repo.updateWatchPosterUrl(movieId, "https://example.test/movie-1.jpg")],
    ["backdrop", () => repo.setWatchBackdropUrl(episodeId, "https://example.test/show-backdrop.jpg")],
    ["artwork clear", () => repo.clearWatchArtworkUrls(episodeId)],
  ];

  for (const [label, write] of cases) {
    await warmAll();
    const version = await repo.getHistoryCacheVersion();
    await write();
    await assertMatchesForcedRebuild(label, version);
  }

  await warmAll();
  const insertVersion = await repo.getHistoryCacheVersion();
  const insertedId = await insert({
    title: "Inserted Movie",
    media_type: "movie",
    watched_at: "2026-01-03T12:00:00.000Z",
    source: "jellyfin",
    imdb_id: "tt-inserted-movie",
  });
  await assertMatchesForcedRebuild("insert", insertVersion);

  await warmAll();
  const deleteVersion = await repo.getHistoryCacheVersion();
  await repo.deleteWatchRecordById(insertedId);
  await assertMatchesForcedRebuild("delete", deleteVersion);

  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const ids = [movieId, episodeId];
  for (let index = 0; index < 200; index += 1) {
    const id = ids[Math.floor(random() * ids.length)];
    const action = Math.floor(random() * 5);
    await warmAll();
    const version = await repo.getHistoryCacheVersion();
    if (action === 0) {
      await repo.updateWatchTelemetry(id, `Target plex status: ${index % 7 === 0 ? "No matching item found" : "Success"}`);
    } else if (action === 1) {
      await repo.updateWatchSyncRetry(id, index % 6, Date.now() + index * 1000);
    } else if (action === 2) {
      await repo.updateWatchPosterUrl(id, `https://example.test/poster-${index}.jpg`);
    } else if (action === 3) {
      await repo.setWatchBackdropUrl(id, `https://example.test/backdrop-${index}.jpg`);
    } else {
      await repo.clearWatchArtworkUrls(id);
    }
    await assertMatchesForcedRebuild(`random write ${index}`, version);
  }
});

test("show rematch stamps every episode in one operation and clears stale artwork", async () => {
  const secondEpisodeId = await insert({
    title: "Cache Show - S01E02 - Second",
    media_type: "episode",
    watched_at: "2026-01-04T12:00:00.000Z",
    source: "plex",
    tmdb_id: "old-tmdb-show",
    tvdb_id: "old-tvdb-show",
    season: 1,
    episode: 2,
    poster_url: "https://example.test/show-old.jpg",
    logo_url: "https://example.test/show-old-logo.png",
    backdrop_url: "https://example.test/show-old-backdrop.jpg",
  });

  const result = await repo.rematchShowWatchRecords({ id: episodeId, tvdbId: "correct-tvdb-show" });
  assert.equal(result.ok, true);
  assert.equal(result.updatedRows, 2);

  for (const id of [episodeId, secondEpisodeId]) {
    const row = await repo.getWatchRecordByIdLight(id);
    assert.equal(row.tvdb_id, "correct-tvdb-show");
    assert.equal(row.tmdb_id, null);
    assert.equal(row.poster_url, null);
    assert.equal(row.logo_url, null);
    assert.equal(row.backdrop_url, null);
  }
});

test("stats merge title-only movie plays into one provider identity", async () => {
  const firstPlayId = await insert({
    title: "Merged Identity Movie",
    media_type: "movie",
    watched_at: "2026-02-01T12:00:00.000Z",
    source: "plex",
    tmdb_id: "merged-tmdb",
  });
  await insert({
    title: "Merged Identity Movie",
    media_type: "movie",
    watched_at: "2026-02-02T12:00:00.000Z",
    source: "plex",
    tmdb_id: "merged-tmdb",
  });
  await insert({
    title: "Merged Identity Movie",
    media_type: "movie",
    watched_at: "2026-02-03T12:00:00.000Z",
    source: "plex_initial_sync",
  });

  const stats = await repo.getWatchStats();
  const matches = stats.reports.all.topMovies.filter((movie) => movie.title === "Merged Identity Movie");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].count, 3);

  const movies = await repo.queryMovies({ search: "Merged Identity Movie" });
  assert.equal(movies.length, 1);
  assert.equal(movies[0].playHistory.length, 3);

  const dateEditorRows = await repo.getWatchDatesForRecord(firstPlayId);
  assert.equal(dateEditorRows.rows.length, 3);
});

test("watch-date editor includes title-only movie rows sharing the canonical media key", async () => {
  const firstPlayId = await insert({
    title: "Canonical Key Movie",
    media_type: "movie",
    watched_at: "2026-03-01T12:00:00.000Z",
    source: "plex",
  });
  await insert({
    title: "Canonical Key Movie",
    media_type: "movie",
    watched_at: "2026-03-02T12:00:00.000Z",
    source: "plex",
  });

  const dateEditorRows = await repo.getWatchDatesForRecord(firstPlayId);
  assert.deepEqual(dateEditorRows.rows.map((row) => row.watched_at), [
    "2026-03-01T12:00:00.000Z",
    "2026-03-02T12:00:00.000Z",
  ]);
});

test("a show's tvdb_id is never surfaced from an unverified episode-tagged id", async () => {
  const { db, toJson } = await import("../server/src/db.js");

  // Plex/Emby/Jellyfin webhooks tag an episode with its OWN tvdb id (TVDB
  // gives every episode a unique id, separate from the series id) - using
  // that directly as the show's series id can route straight to an unrelated
  // show once it's fed into a TVDB series lookup. "9999999" here stands in
  // for such an episode-level id: nothing has ever resolved it as a real
  // series, so it must not come back as this show's tvdb_id.
  await insert({
    title: "Untrusted Tvdb Show - S01E01 - Pilot",
    media_type: "episode",
    watched_at: "2026-04-01T12:00:00.000Z",
    source: "emby",
    tvdb_id: "9999999",
    season: 1,
    episode: 1,
  });

  const showsBefore = await repo.getCachedShows();
  const beforeMatch = showsBefore.find((show) => show.title === "Untrusted Tvdb Show");
  assert.ok(beforeMatch, "show must still be found and visible");
  assert.ok(!beforeMatch.tvdb_id, "an uncached episode-tagged tvdb_id must not be trusted as the show's identity");

  const detailBefore = await repo.queryShowDetail({ title: "Untrusted Tvdb Show" });
  assert.equal(detailBefore.tvdb_id, null);

  // Once that same id has actually been resolved as a real TVDB series (a
  // search result, Fix Match, or a prior correct visit caches it under
  // series_<id>), it becomes a trustworthy candidate for this show too.
  db.prepare(
    `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("series_9999999", "9999999", "Untrusted Tvdb Show", toJson({
    id: 9999999,
    name: "Untrusted Tvdb Show",
    episodes: [],
    seasons: [],
  }), Date.now());
  await repo.invalidateHistoryDerivedCaches();

  const showsAfter = await repo.getCachedShows();
  const afterMatch = showsAfter.find((show) => show.title === "Untrusted Tvdb Show");
  assert.equal(afterMatch.tvdb_id, "9999999", "a genuinely cached series id must be trusted");
});

test("a title lookup prefers a well-established show over a fresher single-row mismatch", async () => {
  // Mirrors a real incident: Trakt import resolved one ambiguous "Collision
  // Show" play to a completely unrelated TMDB id, inserting a lone row dated
  // after every real episode of the actual show. A pure most-recent-wins tie
  // break would let that one bad row hijack the whole title lookup.
  for (let episode = 1; episode <= 6; episode += 1) {
    await insert({
      title: `Collision Show - S01E0${episode}`,
      media_type: "episode",
      watched_at: `2026-05-0${episode}T12:00:00.000Z`,
      source: "manual",
      tmdb_id: "555555",
      season: 1,
      episode,
    });
  }
  await insert({
    title: "Collision Show - S01E02",
    media_type: "episode",
    watched_at: "2026-05-10T12:00:00.000Z",
    source: "trakt_import",
    tmdb_id: "999999",
    imdb_id: "tt-wrong-collision",
    season: 1,
    episode: 2,
  });

  const show = await repo.queryShowDetail({ title: "Collision Show" });
  assert.equal(show.tmdb_id, "555555", "the 6-episode established show must win over the 1-episode mismatched duplicate");
});

test("a title lookup finds every episode regardless of a trailing year on some rows but not others", async () => {
  // Mirrors a real incident: Plex's own title for a show rarely carries a
  // year ("Split Show"), while other imports for the same show used a
  // year-suffixed title ("Split Show (2023)"). An exact show_title match on
  // either variant alone only ever finds half the show's real episodes.
  await insert({
    title: "Split Show - S01E01",
    show_title: "Split Show",
    media_type: "episode",
    watched_at: "2026-06-01T12:00:00.000Z",
    source: "plex",
    tvdb_id: "777777",
    season: 1,
    episode: 1,
  });
  await insert({
    title: "Split Show (2023) - S01E02",
    show_title: "Split Show (2023)",
    media_type: "episode",
    watched_at: "2026-06-02T12:00:00.000Z",
    source: "manual",
    tvdb_id: "777777",
    season: 1,
    episode: 2,
  });

  for (const queryTitle of ["Split Show", "Split Show (2023)"]) {
    const show = await repo.queryShowDetail({ title: queryTitle });
    assert.ok(show, `must resolve for query "${queryTitle}"`);
    assert.equal(show.episode_count, 2, `must find both episodes for query "${queryTitle}"`);
  }
});
