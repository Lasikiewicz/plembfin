import test from "node:test";
import assert from "node:assert/strict";

import { showIdentityIndex, withLocalShowIdentity } from "../server/src/utils/upNextService.js";

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
