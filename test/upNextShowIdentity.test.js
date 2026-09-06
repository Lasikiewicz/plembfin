import test from "node:test";
import assert from "node:assert/strict";

import { showIdentityIndex, withLocalShowIdentity, withUsableArtwork } from "../server/src/utils/upNextService.js";

// Provider Next Up feeds often omit series-level provider ids. Reacher S04E02
// arrived carrying only its episode ids (tmdb 7438862) while the series is
// 108978, so Up Next and the watch history linked the same show to two
// different routes - and the episode-id route resolves to nothing, which is
// what made that page slow to load.

const REACHER = { title: "Reacher", imdb_id: "tt9288030", tmdb_id: "108978", tvdb_id: "366924" };

test("an episode with no series ids inherits them from the local library", () => {
  const index = showIdentityIndex([REACHER]);
  const enriched = withLocalShowIdentity({
    media_type: "episode",
    title: "Reacher - S04E02",
    show_title: "Reacher",
    tmdb_id: "7438862",
    show_tmdb_id: null,
    show_tvdb_id: null,
    show_imdb_id: null,
  }, index);

  assert.equal(enriched.show_tmdb_id, "108978");
  assert.equal(enriched.show_tvdb_id, "366924");
  assert.equal(enriched.show_imdb_id, "tt9288030");
  // The episode's own id must survive untouched - it is not the show's.
  assert.equal(enriched.tmdb_id, "7438862");
});

test("a series id supplied by the provider is never overwritten", () => {
  const index = showIdentityIndex([{ ...REACHER, tmdb_id: "999999" }]);
  const item = {
    media_type: "episode",
    show_title: "Reacher",
    show_tmdb_id: "108978",
  };
  assert.equal(withLocalShowIdentity(item, index).show_tmdb_id, "108978");
});

test("two shows sharing a title are dropped rather than guessed", () => {
  // Inheriting the wrong series id would send the viewer to a different show,
  // which is worse than falling back to the title route.
  const index = showIdentityIndex([
    { title: "The Office", tmdb_id: "2316", tvdb_id: "73244" },
    { title: "The Office", tmdb_id: "4046", tvdb_id: "78107" },
  ]);
  assert.equal(index.has("the office"), false);

  const item = { media_type: "episode", show_title: "The Office", show_tmdb_id: null };
  assert.equal(withLocalShowIdentity(item, index).show_tmdb_id, null);
});

test("a duplicate title with identical ids is still usable", () => {
  const index = showIdentityIndex([REACHER, { ...REACHER }]);
  assert.deepEqual(index.get("reacher"), { imdb: "tt9288030", tmdb: "108978", tvdb: "366924" });
});

test("shows carrying no ids at all are not indexed", () => {
  const index = showIdentityIndex([{ title: "Some Untracked Show" }]);
  assert.equal(index.size, 0);
});

test("a movie is left alone", () => {
  const index = showIdentityIndex([REACHER]);
  const movie = { media_type: "movie", title: "Reacher", show_tmdb_id: null };
  assert.equal(withLocalShowIdentity(movie, index).show_tmdb_id, null);
});

test("an empty or missing index is a no-op rather than an error", () => {
  const item = { media_type: "episode", show_title: "Reacher" };
  assert.deepEqual(withLocalShowIdentity(item, new Map()), item);
  assert.deepEqual(withLocalShowIdentity(item, undefined), item);
});

test("the episode title is used when no separate show title is carried", () => {
  const index = showIdentityIndex([REACHER]);
  const enriched = withLocalShowIdentity({
    media_type: "episode",
    title: "Reacher - S04E02",
    show_tmdb_id: null,
  }, index);
  assert.equal(enriched.show_tmdb_id, "108978");
});

test("a series id equal to the episode's own id is discarded, not trusted", () => {
  // Reacher S04E02 arrived from a provider with the episode id in both fields.
  // A series id can never equal one of its own episodes' ids.
  const index = showIdentityIndex([REACHER]);
  const enriched = withLocalShowIdentity({
    media_type: "episode",
    title: "Reacher - S04E02",
    show_title: "Reacher",
    tmdb_id: "7438862",
    tvdb_id: "11867797",
    show_tmdb_id: "7438862",
    show_tvdb_id: "11867797",
  }, index);

  assert.equal(enriched.show_tmdb_id, "108978");
  assert.equal(enriched.show_tvdb_id, "366924");
  assert.equal(enriched.tmdb_id, "7438862");
});

test("a self-referential series id is dropped even with no library match", () => {
  // Falling back to the title route beats a route that resolves to nothing.
  const enriched = withLocalShowIdentity({
    media_type: "episode",
    title: "Unknown Show - S01E01",
    show_title: "Unknown Show",
    tmdb_id: "999",
    show_tmdb_id: "999",
  }, showIdentityIndex([]));
  assert.equal(enriched.show_tmdb_id, null);
});

test("a genuinely different series id is left alone", () => {
  const enriched = withLocalShowIdentity({
    media_type: "episode",
    show_title: "Reacher",
    tmdb_id: "7438862",
    show_tmdb_id: "108978",
  }, showIdentityIndex([REACHER]));
  assert.equal(enriched.show_tmdb_id, "108978");
});

test("artwork that cannot resolve from this origin is dropped", () => {
  // A bare Plex path is served by the SPA fallback, so it renders no image at
  // all; dropping it lets /api/poster resolve a real one.
  const cleaned = withUsableArtwork({
    poster_url: "/library/metadata/4680/thumb/1756",
    show_poster_url: "/library/metadata/4680/thumb/1756",
  });
  assert.equal(cleaned.poster_url, null);
  assert.equal(cleaned.show_poster_url, null);
});

test("cached, api and absolute artwork URLs are preserved", () => {
  for (const url of [
    "/media/posters/e7375ed5ca67b147c19ca115b65944c92ef65104.webp",
    "/media/posters/abc.webp?v=1788428110506",
    "/api/poster?id=1234",
    "https://image.tmdb.org/t/p/w500/abc.jpg",
  ]) {
    assert.equal(withUsableArtwork({ poster_url: url }).poster_url, url, `should keep ${url}`);
  }
});

test("an item with no artwork is returned untouched", () => {
  const item = { media_type: "episode", title: "Reacher - S04E02" };
  assert.deepEqual(withUsableArtwork(item), item);
});
