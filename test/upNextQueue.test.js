import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-queue-");
const { buildUpNextProjection } = await import("../server/src/utils/upNextService.js");
const { insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
const { saveCanonicalPoster } = await import("../server/src/utils/mediaArtwork.js");
const { recordUpNextRailSeeds } = await import("../server/src/utils/upNextSeedLedger.js");
const { removeManualUpNextShow, upsertManualUpNextShow } = await import("../server/src/utils/upNextManual.js");

test("queue projection keeps canonical resumes first and provider next-up after them", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{ title: "The Expanse", tmdb_id: "123", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
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

test("Jellyfin observations take part in the Up Next projection", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{ title: "Jellyfin Show", tmdb_id: "5150", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-next",
      media_type: "episode",
      title: "Jellyfin Show - S01E01",
      show_title: "Jellyfin Show",
      season: 1,
      episode: 1,
      show_ids: { tmdb: "5150" },
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, "Jellyfin Show");
  assert.equal(projection.items[0].queue_kind, "next_up");
  assert.deepEqual(projection.items[0].provider_items, { jellyfin: ["jellyfin-next"] });
});

test("an explicit unwatched state suppresses a stale provider next-up card", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [{
      media_key: "episode:1:1:tmdb:5150",
      media_type: "episode",
      title: "Jellyfin Show - S01E01",
      show_title: "Jellyfin Show",
      show_tmdb_id: "5150",
      season: 1,
      episode: 1,
      state: "unwatched",
      updated_at: Date.parse("2026-09-01T11:00:00.000Z"),
    }],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-next-stale",
      media_type: "episode",
      title: "Jellyfin Show - S01E01",
      show_title: "Jellyfin Show",
      season: 1,
      episode: 1,
      show_ids: { tmdb: "5150" },
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 0);
});

test("provider specials are not promoted into the Up Next rail", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "special-1",
      media_type: "episode",
      title: "Special Show - S00E01",
      show_title: "Special Show",
      season: 0,
      episode: 1,
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 0);
});

test("a watched episode suppresses a stale provider resume card", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [{
      media_key: "episode:3:7:tmdb:113962",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      show_tmdb_id: "113962",
      season: 3,
      episode: 7,
      state: "watched",
      updated_at: Date.parse("2026-09-01T11:00:00.000Z"),
    }],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-lioness-s03e07-stale",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      season: 3,
      episode: 7,
      show_ids: { tmdb: "113962" },
      position_ms: 162184,
      duration_ms: 2684557,
      progress: 6,
    }],
  });

  assert.equal(projection.items.length, 0);
});

test("queue projection carries show watch recency into provider next-up ordering", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    shows: [
      { title: "Ted Lasso", tmdb_id: "97546", latest_watched_at: "2026-08-28T20:00:00.000Z" },
      { title: "Reacher", tmdb_id: "108978", latest_watched_at: "2026-09-03T20:00:00.000Z" },
    ],
    providerItems: [
      { provider: "jellyfin", feed_kind: "next_up", provider_item_id: "ted-next", media_type: "episode", title: "Ted Lasso - S03E02", show_title: "Ted Lasso", show_ids: { tmdb: "97546" }, season: 3, episode: 2, air_date: "2026-08-01" },
      { provider: "jellyfin", feed_kind: "next_up", provider_item_id: "reacher-next", media_type: "episode", title: "Reacher - S03E08", show_title: "Reacher", show_ids: { tmdb: "108978" }, season: 3, episode: 8, air_date: "2026-08-01" },
    ],
  });

  assert.deepEqual(projection.items.map((item) => item.show_title), ["Reacher", "Ted Lasso"]);
});

test("native provider resume membership remains visible when position is omitted", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    shows: [{ title: "Ted Lasso", tmdb_id: "97546", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-resume-without-position",
      media_type: "episode",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      episode_title: "Richmond's Got Talent",
      season: 4,
      episode: 3,
      show_ids: { tmdb: "97546" },
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].queue_kind, "resume");
  assert.equal(projection.items[0].progress, 0);
  assert.equal(projection.items[0].playback_position_known, false);
  assert.deepEqual(projection.items[0].provider_items, { emby: ["emby-resume-without-position"] });
});

test("native provider resume positions remain visible as part-watched progress", async () => {
  const positionMs = 162184;
  const durationMs = 2684557;
  recordUpNextRailSeeds([{
    provider: "emby",
    providerItemId: "emby-seeded-resume",
    positionMs,
    durationMs,
  }]);

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    shows: [{ title: "Lioness", tmdb_id: "113962", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-seeded-resume",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      episode_title: "Kiss the Girls",
      season: 3,
      episode: 7,
      show_ids: { tmdb: "113962" },
      position_ms: positionMs,
      duration_ms: durationMs,
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].position_ms, positionMs);
  assert.equal(projection.items[0].duration_ms, durationMs);
  assert.ok(Math.abs(projection.items[0].progress - ((positionMs / durationMs) * 100)) < 0.001);
  assert.equal(projection.items[0].playback_position_known, true);
});

test("canonical resume positions remain visible when they match a legacy rail seed", async () => {
  const positionMs = 162184;
  const durationMs = 2684557;
  recordUpNextRailSeeds([{
    provider: "jellyfin",
    providerItemId: "jellyfin-seeded-resume",
    positionMs,
    durationMs,
    mediaKey: "episode:3:7:tmdb:113962",
  }]);

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "episode:3:7:tmdb:113962",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      show_tmdb_id: "113962",
      season: 3,
      episode: 7,
      position_ms: positionMs,
      duration_ms: durationMs,
      progress: (positionMs / durationMs) * 100,
      updated_at: 500,
      source: "jellyfin",
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].position_ms, positionMs);
  assert.equal(projection.items[0].progress, (positionMs / durationMs) * 100);
  assert.equal(projection.items[0].playback_position_known, true);
});

test("uncertain provider membership keeps only the furthest episode for a show", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    shows: [
      { title: "Ludwig (2024)", latest_watched_at: "2026-08-01T12:00:00.000Z" },
      { title: "Ludwig", latest_watched_at: "2026-08-01T12:00:00.000Z" },
    ],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [
      {
        provider: "emby",
        feed_kind: "resume",
        provider_item_id: "emby-ludwig-1",
        series_provider_item_id: "emby-ludwig",
        media_type: "episode",
        title: "Ludwig (2024) - S02E01",
        show_title: "Ludwig (2024)",
        episode_title: "Episode 1",
        season: 2,
        episode: 1,
      },
      {
        provider: "plex",
        feed_kind: "resume",
        provider_item_id: "plex-ludwig-2",
        series_provider_item_id: "plex-ludwig",
        media_type: "episode",
        title: "Ludwig (2024) - S02E02",
        show_title: "Ludwig (2024)",
        episode_title: "Episode 2",
        season: 2,
        episode: 2,
        ids: { imdb: "tt-ludwig-episode-2" },
      },
      {
        provider: "jellyfin",
        feed_kind: "next_up",
        provider_item_id: "jellyfin-ludwig-2",
        series_provider_item_id: "jellyfin-ludwig",
        media_type: "episode",
        title: "Ludwig - S02E02",
        show_title: "Ludwig",
        episode_title: "Episode 2",
        season: 2,
        episode: 2,
        ids: { imdb: "tt-ludwig-episode-2" },
      },
    ],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, "Ludwig (2024)");
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 2);
  assert.deepEqual(projection.items[0].provider_items, {
    jellyfin: ["jellyfin-ludwig-2"],
    plex: ["plex-ludwig-2"],
  });
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
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-episode-5",
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

test("a native provider resume joins the canonical local episode when the show identity is verified", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [{ title: "Ted Lasso", imdb_id: "tt10986410", tmdb_id: "97546", tvdb_id: "383203", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    progressRows: [{
      media_key: "episode:4:6:imdb:tt10986410",
      media_type: "episode",
      title: "Ted Lasso - S04E06",
      show_title: "Ted Lasso",
      imdb_id: "tt10986410",
      tmdb_id: "97546",
      tvdb_id: "383203",
      season: 4,
      episode: 6,
      position_ms: 1_181_147,
      duration_ms: 2_761_759,
      progress: 42.7,
      updated_at: 500,
      source: "emby",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "ted-episode-406",
      series_provider_item_id: "ted-series",
      media_type: "episode",
      title: "Ted Lasso - S04E06",
      show_title: "Ted Lasso",
      episode_title: "Don’t Jump Around Much Anymore",
      season: 4,
      episode: 6,
      ids: { imdb: "tt38494472", tvdb: "11767186" },
      position_ms: 1_181_147,
      duration_ms: 2_761_759,
      progress: 42.7,
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].media_key, "episode:4:6:imdb:tt10986410");
  assert.deepEqual(projection.items[0].provider_items, { emby: ["ted-episode-406"] });
});

test("provider-backed posters use the authenticated poster proxy", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{ title: "Example Show", tvdb_id: "series-1", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-poster-episode",
      media_type: "episode",
      title: "Example Show - S01E01",
      show_title: "Example Show",
      season: 1,
      episode: 1,
      show_ids: { tvdb: "series-1" },
      item: {
        Id: "jellyfin-poster-episode",
        SeriesId: "jellyfin-poster-series",
        SeriesPrimaryImageTag: "series-tag",
      },
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(
    projection.items[0].poster_url,
    "/api/poster?id=jellyfin-poster-episode&provider=jellyfin&format=image&v=2",
  );
  assert.equal(
    projection.items[0].show_poster_url,
    "/api/poster?id=jellyfin-poster-episode&provider=jellyfin&format=image&v=2",
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

test("canonical movie rows reuse the cached movie poster when no provider poster exists", async () => {
  saveCanonicalPoster({ media_type: "movie", title: "Arrival", tmdb_id: "329865" }, "/media/posters/arrival.webp", { source: "test" });
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "movie:tmdb:329865",
      media_type: "movie",
      title: "Arrival",
      tmdb_id: "329865",
      position_ms: 300000,
      duration_ms: 6000000,
      progress: 5,
      updated_at: 300,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].poster_url, "/media/posters/arrival.webp");
});

test("provider-sourced local resumes expose a safe poster proxy when their stored path is provider-relative", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "movie:title:moana",
      media_type: "movie",
      title: "Moana",
      source: "plex",
      poster_url: "/library/metadata/43844/thumb/123",
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
      updated_at: 300,
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(
    projection.items[0].poster_url,
    "/api/poster?id=movie%3Atitle%3Amoana&format=image&v=2",
  );
});

test("title-only movie resumes collapse into the identified provider item and keep its poster", async () => {
  saveCanonicalPoster(
    { media_type: "movie", title: "Moana", tmdb_id: "1108427", imdb_id: "tt27419466" },
    "/media/posters/moana.webp",
    { source: "test" },
  );
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "movie:title:moana",
      media_type: "movie",
      title: "Moana",
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
      updated_at: 300,
      source: "plex",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "43844",
      media_type: "movie",
      title: "Moana",
      ids: { imdb: "tt27419466", tmdb: "1108427" },
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].id, "movie|id:imdb:tt27419466");
  assert.equal(projection.items[0].poster_url, "/media/posters/moana.webp");
  assert.deepEqual(projection.items[0].provider_items, { plex: ["43844"] });
});

test("provider next-up is filtered by a locally watched episode with a different media key", async () => {
  insertWatchRecordSync({
    title: "Expedition X - S01E05",
    show_title: "Expedition X",
    episode_title: "Mt Adams UFO Encounter",
    media_type: "episode",
    season: 1,
    episode: 5,
    tmdb_id: "99363",
    tvdb_id: "375704",
    imdb_id: "tt11774420",
    watched_at: "2020-03-11T12:00:00.000Z",
    source: "manual",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-12T12:00:00.000Z"),
    localFallback: false,
    shows: [{ title: "Expedition X", tmdb_id: "99363", tvdb_id: "375704", imdb_id: "tt11774420" }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-expedition-x-s01e05",
      series_provider_item_id: "jellyfin-expedition-x",
      media_type: "episode",
      title: "Expedition X - S01E05",
      show_title: "Expedition X",
      episode_title: "Mt Adams UFO Encounter",
      season: 1,
      episode: 5,
      ids: { imdb: "tt11946530" },
      air_date: "2020-03-11",
    }],
  });

  assert.deepEqual(projection.items, []);
});

test("handleUpNextRemove clears positive playback progress and marks unplayed", async () => {
  const { handleUpNextRemove } = await import("../server/src/routes/sync.js");
  const { upsertPlaybackProgress } = await import("../server/src/utils/dataRepo.js");
  const { AUTH } = await import("../server/src/appConfig.js");
  const { db } = await import("../server/src/db.js");

  const mediaKey = "episode:1:2:tmdb:999";
  upsertPlaybackProgress({
    media_key: mediaKey,
    media_type: "episode",
    title: "Test Show - S01E02",
    show_title: "Test Show",
    season: 1,
    episode: 2,
    tmdb_id: "999",
    position_ms: 500000,
    duration_ms: 2000000,
    progress: 25,
  });

  const req = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH.apiKey}`,
    },
    get(name) {
      return this.headers[name.toLowerCase()];
    },
    body: {
      media_key: mediaKey,
      media_type: "episode",
      title: "Test Show - S01E02",
      show_title: "Test Show",
      season: 1,
      episode: 2,
      tmdb_id: "999",
    },
  };

  let statusCode = 200;
  let responseData = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    send(data) {
      if (data) responseData = JSON.parse(data);
      return this;
    },
  };

  await handleUpNextRemove(req, res);
  assert.equal(statusCode, 200);
  assert.equal(responseData?.ok, true);

  const remaining = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
  assert.equal(remaining, undefined);
});

// --- Local fallback: an unwatched next episode has no watch history, so it
// can never carry a native provider id of its own. These cover the two ways
// that used to make a real, playable episode vanish from Up Next.

const { db } = await import("../server/src/db.js");

function seedShowMetadata({ tmdbId, tvdbId, title, seasonNumber, episodes, additionalSeasons = [] }) {
  const seasons = [{ seasonNumber, episodes }, ...additionalSeasons];
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, 'tv', ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET details = excluded.details`,
  ).run(
    `tv_${tmdbId}`,
    tmdbId,
    title,
    JSON.stringify({
      id: Number(tmdbId),
      name: title,
      external_ids: { tvdb_id: tvdbId },
      seasons: seasons.map((season) => ({ season_number: season.seasonNumber })),
    }),
    Date.now(),
  );
  for (const season of seasons) {
    db.prepare(
      `INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET details = excluded.details`,
    ).run(
      `${tvdbId}_${season.seasonNumber}`,
      tvdbId,
      season.seasonNumber,
      JSON.stringify({ episodes: season.episodes }),
      Date.now(),
    );
  }
}

test("local fallback resolves an unwatched next episode against the configured libraries", async () => {
  seedShowMetadata({
    tmdbId: "108978",
    tvdbId: "371980",
    title: "Reacher",
    seasonNumber: 4,
    episodes: [
      { number: 6, name: "Plum Out of Luck", aired: "2026-09-01" },
      { number: 7, name: "Vote for Sampson", aired: "2026-09-08" },
    ],
  });
  insertWatchRecordSync({
    title: "Reacher - S04E06",
    show_title: "Reacher",
    episode_title: "Plum Out of Luck",
    media_type: "episode",
    season: 4,
    episode: 6,
    show_tmdb_id: "108978",
    show_tvdb_id: "371980",
    watched_at: "2026-09-05T19:26:00.000Z",
    source: "manual",
  });

  const shows = [{
    id: "reacher",
    title: "Reacher",
    tmdb_id: "108978",
    tvdb_id: "371980",
    episode_count: 1,
    latest_watched_at: "2026-09-05T19:26:00.000Z",
  }];
  const options = {
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    shows,
    progressRows: [],
    playstateRows: [],
    providerItems: [],
  };

  // No library to ask: the old, conservative behavior is preserved.
  const withoutLookup = await buildUpNextProjection(options);
  assert.equal(withoutLookup.items.length, 0);

  const asked = [];
  const withLookup = await buildUpNextProjection({
    ...options,
    resolveProviderItems: async (candidate) => {
      asked.push(`${candidate.season}:${candidate.episode}`);
      return { plex: ["4685"] };
    },
  });
  assert.deepEqual(asked, ["4:7"]);
  assert.equal(withLookup.items.length, 1);
  assert.equal(withLookup.items[0].season, 4);
  assert.equal(withLookup.items[0].episode, 7);
  assert.deepEqual(withLookup.items[0].provider_items, { plex: ["4685"] });
});

test("local fallback crosses from an exhausted season to the first episode of the next season", async () => {
  seedShowMetadata({
    tmdbId: "88001",
    tvdbId: "88001",
    title: "Season Boundary",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
    ],
    additionalSeasons: [{
      seasonNumber: 2,
      episodes: [
        { number: 1, name: "New Beginning", aired: "2026-09-01" },
      ],
    }],
  });
  for (const episode of [1, 2]) {
    insertWatchRecordSync({
      title: `Season Boundary - S01E0${episode}`,
      show_title: "Season Boundary",
      episode_title: episode === 1 ? "One" : "Two",
      media_type: "episode",
      season: 1,
      episode,
      show_tmdb_id: "88001",
      show_tvdb_id: "88001",
      watched_at: `2026-08-${episode === 1 ? "02" : "09"}T11:00:00.000Z`,
      source: "manual",
    });
  }

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "season-boundary",
      title: "Season Boundary",
      tmdb_id: "88001",
      tvdb_id: "88001",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems: async () => ({ plex: ["season-2-episode-1"] }),
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 1);
});

test("local fallback discovers a newly available season from provider inventory when metadata is stale", async () => {
  seedShowMetadata({
    tmdbId: "88003",
    tvdbId: "88003",
    title: "New Season",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "Finale", aired: "2026-08-01" },
    ],
  });
  insertWatchRecordSync({
    title: "New Season - S01E01",
    show_title: "New Season",
    episode_title: "Finale",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "88003",
    show_tvdb_id: "88003",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "new-season",
      title: "New Season",
      tmdb_id: "88003",
      tvdb_id: "88003",
      episode_count: 1,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderEpisodes: async () => [{
      source: "plex",
      provider: "plex",
      provider_items: { plex: ["new-season-s02e01"] },
      media_type: "episode",
      title: "New Season - S02E01",
      show_title: "New Season",
      season: 2,
      episode: 1,
      air_date: "2026-09-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 1);
  assert.deepEqual(projection.items[0].provider_items, { plex: ["new-season-s02e01"] });
});

test("local fallback scans watched shows beyond the previous recency boundary", async () => {
  const targetTitle = "Long Tail New Season";
  insertWatchRecordSync({
    title: `${targetTitle} - S01E01`,
    show_title: targetTitle,
    episode_title: "The Old Finale",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "88004",
    watched_at: "2026-01-02T11:00:00.000Z",
    source: "manual",
  });

  const shows = Array.from({ length: 50 }, (_, index) => ({
    title: `Recent Show ${index + 1}`,
    tmdb_id: `recent-${index + 1}`,
    episode_count: 1,
    latest_watched_at: `2026-09-${String(index + 1).padStart(2, "0")}T11:00:00.000Z`,
  }));
  shows.push({
    title: targetTitle,
    tmdb_id: "88004",
    episode_count: 1,
    latest_watched_at: "2026-01-02T11:00:00.000Z",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows,
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderEpisodes: async (show) => show.title === targetTitle ? [{
      source: "plex",
      provider: "plex",
      provider_items: { plex: ["long-tail-s02e01"] },
      media_type: "episode",
      title: `${targetTitle} - S02E01`,
      show_title: targetTitle,
      season: 2,
      episode: 1,
      air_date: "2026-09-01",
    }] : [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, targetTitle);
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 1);
});

test("manual Up Next hides a future-dated or unavailable first episode", async () => {
  seedShowMetadata({
    tmdbId: "88002",
    tvdbId: "88002",
    title: "Future Boundary",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
    ],
    additionalSeasons: [{
      seasonNumber: 2,
      episodes: [
        { number: 1, name: "New Beginning", aired: "2026-10-01" },
      ],
    }],
  });
  for (const episode of [1, 2]) {
    insertWatchRecordSync({
      title: `Future Boundary - S01E0${episode}`,
      show_title: "Future Boundary",
      episode_title: episode === 1 ? "One" : "Two",
      media_type: "episode",
      season: 1,
      episode,
      show_tmdb_id: "88002",
      show_tvdb_id: "88002",
      watched_at: `2026-08-${episode === 1 ? "02" : "09"}T11:00:00.000Z`,
      source: "manual",
    });
  }
  upsertManualUpNextShow({ title: "Future Boundary", tmdb_id: "88002", tvdb_id: "88002" }, {
    now: Date.parse("2026-09-10T12:00:00.000Z"),
  });

  const beforeRelease = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "future-boundary",
      title: "Future Boundary",
      tmdb_id: "88002",
      tvdb_id: "88002",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(beforeRelease.items.find((candidate) => candidate.show_title === "Future Boundary"), undefined);

  const unavailable = await buildUpNextProjection({
    now: Date.parse("2026-10-02T12:00:00.000Z"),
    shows: [{
      id: "future-boundary",
      title: "Future Boundary",
      tmdb_id: "88002",
      tvdb_id: "88002",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems: async () => ({}),
  });
  assert.equal(unavailable.items.find((candidate) => candidate.show_title === "Future Boundary"), undefined);

  const available = await buildUpNextProjection({
    now: Date.parse("2026-10-02T12:00:00.000Z"),
    shows: [{
      id: "future-boundary",
      title: "Future Boundary",
      tmdb_id: "88002",
      tvdb_id: "88002",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems: async () => ({ plex: ["future-boundary-s02e01"] }),
  });

  const item = available.items.find((candidate) => candidate.show_title === "Future Boundary");
  assert.equal(item?.season, 2);
  assert.equal(item?.episode, 1);
  assert.deepEqual(item?.provider_items, { plex: ["future-boundary-s02e01"] });
  removeManualUpNextShow({ tmdb_id: "88002" });
});

test("the first unwatched episode remains the detail page's Up Next choice", async () => {
  seedShowMetadata({
    tmdbId: "97546",
    tvdbId: "383203",
    title: "Ted Lasso",
    seasonNumber: 4,
    episodes: [
      { number: 2, name: "Second", aired: "2026-08-01" },
      { number: 3, name: "Richmond's Got Talent", aired: "2026-08-08" },
    ],
  });
  insertWatchRecordSync({
    title: "Ted Lasso - S04E02",
    show_title: "Ted Lasso",
    episode_title: "Second",
    media_type: "episode",
    season: 4,
    episode: 2,
    show_tmdb_id: "97546",
    show_tvdb_id: "383203",
    watched_at: "2026-08-05T11:47:55.353Z",
    source: "manual",
  });
  // The explicit unwatch is the detail page's current state for S04E03. It is
  // still the first unwatched episode after S04E02, so a provider row for it
  // remains eligible while later episodes would be rejected.
  insertWatchRecordSync({
    title: "Ted Lasso - S04E03",
    show_title: "Ted Lasso",
    episode_title: "Richmond's Got Talent",
    media_type: "episode",
    season: 4,
    episode: 3,
    show_tmdb_id: "97546",
    show_tvdb_id: "383203",
    watched_at: "2026-09-12T22:58:10.828Z",
    source: "manual",
    sync_action: "unwatched",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    shows: [{
      id: "ted-lasso",
      title: "Ted Lasso",
      tmdb_id: "97546",
      tvdb_id: "383203",
      episode_count: 2,
      latest_watched_at: "2026-08-05T11:47:55.353Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "3478",
      media_type: "episode",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      episode_title: "Richmond's Got Talent",
      season: 4,
      episode: 3,
      show_ids: { tmdb: "97546", tvdb: "383203" },
      position_ms: 400000,
      duration_ms: 1800000,
      progress: 22,
      updated_at: Date.parse("2026-09-06T10:00:00.000Z"),
    }],
    resolveProviderItems: async () => ({ plex: ["3478"] }),
  });

  const episodes = projection.items.filter((item) => item.show_title === "Ted Lasso");
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].season, 4);
  assert.equal(episodes[0].episode, 3);
});

test("provider Up Next cannot jump past the first unwatched detail-page episode", async () => {
  seedShowMetadata({
    tmdbId: "70001",
    tvdbId: "70001",
    title: "Queue Truth",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
      { number: 3, name: "Three", aired: "2026-08-15" },
      { number: 4, name: "Four", aired: "2026-08-22" },
    ],
  });
  insertWatchRecordSync({
    title: "Queue Truth - S01E01",
    show_title: "Queue Truth",
    episode_title: "One",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "70001",
    show_tvdb_id: "70001",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });
  insertWatchRecordSync({
    title: "Queue Truth - S01E02",
    show_title: "Queue Truth",
    episode_title: "Two",
    media_type: "episode",
    season: 1,
    episode: 2,
    show_tmdb_id: "70001",
    show_tvdb_id: "70001",
    watched_at: "2026-08-03T11:00:00.000Z",
    source: "manual",
    sync_action: "unwatched",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{
      id: "tmdb:70001",
      title: "Queue Truth",
      tmdb_id: "70001",
      tvdb_id: "70001",
      episode_count: 2,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "queue-truth-four",
      media_type: "episode",
      title: "Queue Truth - S01E04",
      show_title: "Queue Truth",
      season: 1,
      episode: 4,
      show_ids: { tmdb: "70001", tvdb: "70001" },
      air_date: "2026-08-22",
    }],
    resolveProviderItems: async () => ({ plex: ["queue-truth-two"] }),
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, "Queue Truth");
  assert.equal(projection.items[0].season, 1);
  assert.equal(projection.items[0].episode, 2);
  assert.deepEqual(projection.items[0].provider_items, { plex: ["queue-truth-two"] });
});
