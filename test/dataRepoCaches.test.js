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
