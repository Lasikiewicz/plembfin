import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-queue-");
const { buildUpNextProjection } = await import("../server/src/utils/upNextService.js");
const { saveCanonicalPoster } = await import("../server/src/utils/mediaArtwork.js");

test("queue projection keeps canonical resumes first and provider next-up after them", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "movie:tmdb:10",
      media_type: "movie",
      title: "A Part-Watched Movie",
      tmdb_id: "10",
      position_ms: 300000,
      duration_ms: 1200000,
      progress: 25,
      updated_at: 300,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "episode-next",
      media_type: "episode",
      title: "The Expanse - S02E05",
      show_title: "The Expanse",
      episode_title: "Home",
      season: 2,
      episode: 5,
      show_ids: { tmdb: "123" },
      air_date: "2017-02-01",
    }],
  });

  assert.deepEqual(projection.items.map((item) => item.queue_kind), ["resume", "next_up"]);
  assert.equal(projection.items[0].media_type, "movie");
  assert.equal(projection.items[0].progress, 25);
  assert.equal(projection.items[1].media_type, "episode");
  assert.equal(projection.items[1].progress, 0);
  assert.deepEqual(projection.items[1].provider_items, { jellyfin: ["episode-next"] });
});

test("a matching provider next-up observation does not duplicate a canonical resume", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "episode:show:123:s:2:e:5",
      media_type: "episode",
      title: "The Expanse - S02E05 - Home",
      show_title: "The Expanse",
      tmdb_id: "123",
      season: 2,
      episode: 5,
      position_ms: 600000,
      duration_ms: 2400000,
      progress: 25,
      updated_at: 500,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "next_up",
      provider_item_id: "emby-episode-5",
      media_type: "episode",
      title: "Home",
      show_title: "The Expanse",
      season: 2,
      episode: 5,
      show_ids: { tmdb: "123" },
      air_date: "2017-02-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].queue_kind, "resume");
});

test("provider-backed posters use the authenticated poster proxy", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "next_up",
      provider_item_id: "emby-poster-episode",
      media_type: "episode",
      title: "Example Show - S01E01",
      show_title: "Example Show",
      season: 1,
      episode: 1,
      show_ids: { tvdb: "series-1" },
      item: {
        Id: "emby-poster-episode",
        SeriesId: "emby-poster-series",
        SeriesPrimaryImageTag: "series-tag",
      },
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(
    projection.items[0].poster_url,
    "/api/poster?id=emby-poster-episode&provider=emby&format=image&v=2",
  );
  assert.equal(
    projection.items[0].show_poster_url,
    "/api/poster?id=emby-poster-episode&provider=emby&format=image&v=2",
  );
});

test("canonical episode rows reuse the cached show poster when no provider poster exists", async () => {
  saveCanonicalPoster({ media_type: "episode", show_title: "Reacher", show_tmdb_id: "108978" }, "/media/posters/reacher.webp", { source: "test" });
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "episode:3:2:tmdb:108978",
      media_type: "episode",
      title: "Reacher - S03E02",
      show_title: "Reacher",
      tmdb_id: "108978",
      season: 3,
      episode: 2,
      position_ms: 300000,
      duration_ms: 1200000,
      progress: 25,
      updated_at: 300,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].poster_url, "/media/posters/reacher.webp");
  assert.equal(projection.items[0].show_poster_url, "/media/posters/reacher.webp");
});
