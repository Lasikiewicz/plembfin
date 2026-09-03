import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalUpNextKey,
  mergeUpNextCandidates,
  normalizeUpNextCandidate,
} from "../server/src/utils/upNextIdentity.js";

function plexEpisode(overrides = {}) {
  return {
    provider: "plex",
    feed_kind: "resume",
    item: {
      type: "episode",
      ratingKey: "plex-episode-1",
      grandparentRatingKey: "plex-series-1",
      grandparentTitle: "The Expanse",
      grandparentGuid: "tmdb://123",
      parentIndex: 2,
      index: 5,
      title: "Home",
      viewOffset: 120000,
      duration: 240000,
      lastViewedAt: 100,
      ...overrides,
    },
  };
}

test("provider episode observations share one canonical identity and keep native ids", () => {
  const merged = mergeUpNextCandidates([
    plexEpisode(),
    {
      provider: "emby",
      feed_kind: "next_up",
      provider_item_id: "emby-episode-1",
      media_type: "episode",
      title: "The Expanse - S02E05",
      show_title: "The Expanse",
      episode_title: "Home",
      season: 2,
      episode: 5,
      show_ids: { tmdb: "123" },
      queue_kind: "next_up",
      air_date: "2017-02-01",
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].queue_kind, "resume");
  assert.equal(merged[0].canonical_key, "episode|series:tmdb:123|s:2|e:5");
  assert.deepEqual(merged[0].provider_items, {
    emby: ["emby-episode-1"],
    plex: ["plex-episode-1"],
  });
});

test("Plex parent GUID aliases preserve the series identity", () => {
  const candidate = normalizeUpNextCandidate({
    provider: "plex",
    feed_kind: "next_up",
    item: {
      type: "episode",
      ratingKey: "plex-episode-upper-case",
      grandparentRatingKey: "plex-series-upper-case",
      grandparentTitle: "The Expanse",
      grandparentGUID: "tmdb://123",
      parentIndex: 2,
      index: 5,
      title: "Home",
    },
  });

  assert.equal(candidate.show_tmdb_id, "123");
  assert.equal(candidate.canonical_key, "episode|series:tmdb:123|s:2|e:5");
});

test("title-only episode observations merge into the one compatible verified series", () => {
  const merged = mergeUpNextCandidates([
    {
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-episode-5",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      season: 1,
      episode: 5,
      show_ids: { imdb: "tt38807772" },
      position_ms: 618000,
      duration_ms: 3221680,
      updated_at: 200,
    },
    {
      source: "local",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      season: 1,
      episode: 5,
      position_ms: 614000,
      duration_ms: 3221680,
      updated_at: 100,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_key, "episode|series:imdb:tt38807772|s:1|e:5");
  assert.equal(merged[0].show_imdb_id, "tt38807772");
  assert.deepEqual(merged[0].provider_items, { emby: ["emby-episode-5"] });
});

test("title-only episode observations stay separate when two verified reboots are possible", () => {
  const merged = mergeUpNextCandidates([
    {
      media_type: "episode",
      title: "The Returned - S01E01",
      show_title: "The Returned",
      season: 1,
      episode: 1,
      show_ids: { tvdb: "series-a" },
    },
    {
      media_type: "episode",
      title: "The Returned - S01E01",
      show_title: "The Returned",
      season: 1,
      episode: 1,
      show_ids: { tvdb: "series-b" },
    },
    {
      media_type: "episode",
      title: "The Returned - S01E01",
      show_title: "The Returned",
      season: 1,
      episode: 1,
    },
  ]);

  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((item) => item.canonical_key).sort(),
    [
      "episode|series:tvdb:series-a|s:1|e:1",
      "episode|series:tvdb:series-b|s:1|e:1",
      "episode|title:the-returned|s:1|e:1",
    ],
  );
});

test("native series identity bridges to a matching external provider id", () => {
  const merged = mergeUpNextCandidates([
    {
      source: "local",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      show_ids: { tvdb: "10652667" },
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 618000,
      duration_ms: 3221680,
    },
    {
      provider: "emby",
      provider_item_id: "12601",
      series_provider_item_id: "10723",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      ids: { tvdb: "10652667" },
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 618000,
      duration_ms: 3221680,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_key, "episode|series:tvdb:10652667|s:1|e:5");
  assert.deepEqual(merged[0].provider_items, { emby: ["12601"] });
});

test("native series identity keeps same-title series separate when external ids are absent", () => {
  const first = normalizeUpNextCandidate({
    provider: "jellyfin",
    provider_item_id: "episode-a",
    series_provider_item_id: "series-a",
    media_type: "episode",
    title: "Pilot",
    show_title: "The Returned",
    season: 1,
    episode: 1,
  });
  const second = normalizeUpNextCandidate({
    provider: "jellyfin",
    provider_item_id: "episode-b",
    series_provider_item_id: "series-b",
    media_type: "episode",
    title: "Pilot",
    show_title: "The Returned",
    season: 1,
    episode: 1,
  });

  assert.notEqual(first.canonical_key, second.canonical_key);
  assert.equal(mergeUpNextCandidates([first, second]).length, 2);
});

test("same-title movies only merge with a verified identity or matching year", () => {
  const remake = { media_type: "movie", title: "The Thing", year: 1982, source: "plex", provider_item_id: "movie-1982" };
  const newer = { media_type: "movie", title: "The Thing", year: 2011, source: "emby", provider_item_id: "movie-2011" };
  assert.notEqual(canonicalUpNextKey(remake), canonicalUpNextKey(newer));
  assert.equal(mergeUpNextCandidates([remake, newer]).length, 2);

  const verified = mergeUpNextCandidates([
    { ...remake, ids: { imdb: "tt0084787" } },
    { media_type: "movie", title: "The Thing", year: 1982, source: "jellyfin", provider_item_id: "movie-copy", ids: { imdb: "tt0084787" } },
  ]);
  assert.equal(verified.length, 1);
});

test("resume cards sort before stable next-up cards", () => {
  const items = mergeUpNextCandidates([
    { media_type: "movie", title: "Older resume", ids: { tmdb: "1" }, queue_kind: "resume", position_ms: 100, duration_ms: 1000, updated_at: 100 },
    { media_type: "movie", title: "Newer resume", ids: { tmdb: "2" }, queue_kind: "resume", position_ms: 100, duration_ms: 1000, updated_at: 200 },
    { media_type: "episode", title: "Show B", show_title: "Show B", show_ids: { tmdb: "3" }, season: 1, episode: 2, queue_kind: "next_up", air_date: "2026-01-01" },
    { media_type: "episode", title: "Show A", show_title: "Show A", show_ids: { tmdb: "4" }, season: 1, episode: 1, queue_kind: "next_up", air_date: "2026-01-02" },
  ]);

  assert.deepEqual(items.map((item) => item.title), ["Newer resume", "Older resume", "Show A - S01E01", "Show B - S01E02"]);
});
