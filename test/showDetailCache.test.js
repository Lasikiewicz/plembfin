import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { cachedShowDetail, rememberShowDetail } = await import("../public/modules/explorer.js");
const { state } = await import("../public/modules/state.js");

function reset() {
  state.showDetailCache.clear();
  state.showDetailAliases.clear();
}

// A detail page resolves the same show through separate paths - by TMDB id, by
// TVDB id, and by title - which is why the cache is keyed on identity rather
// than on the request URL. Storing under one identifier must satisfy a lookup
// by any of the others, or the duplicate requests come straight back.
test("a show stored under one identifier is found by any of its others", () => {
  reset();
  const show = { id: "show-1", title: "Lioness", tmdb_id: "113962", tvdb_id: "388589", imdb_id: "tt13111658" };
  rememberShowDetail(show);

  assert.equal(cachedShowDetail({ tmdb_id: "113962" }), show);
  assert.equal(cachedShowDetail({ tvdb_id: "388589" }), show);
  assert.equal(cachedShowDetail({ imdb_id: "tt13111658" }), show);
  assert.equal(cachedShowDetail({ title: "Lioness" }), show);
  assert.equal(cachedShowDetail({ id: "show-1" }), show);
  // The episode-row spelling of the same identifiers resolves too.
  assert.equal(cachedShowDetail({ show_tmdb_id: "113962" }), show);
});

test("an unrelated show is not served from the cache", () => {
  reset();
  rememberShowDetail({ id: "show-1", title: "Lioness", tmdb_id: "113962" });
  assert.equal(cachedShowDetail({ tmdb_id: "999999" }), null);
  assert.equal(cachedShowDetail({ title: "Some Other Show" }), null);
  assert.equal(cachedShowDetail({}), null);
});

// /api/show carries authoritative watched rows and dates. The whole point of
// the short window is that this cache collapses one page's duplicate lookups
// and never becomes a source of stale watch state.
test("the cached show expires rather than being held indefinitely", () => {
  reset();
  const show = { id: "show-1", title: "Lioness", tmdb_id: "113962" };
  rememberShowDetail(show);
  assert.equal(cachedShowDetail({ tmdb_id: "113962" }), show);

  const entry = state.showDetailCache.get([...state.showDetailCache.keys()][0]);
  entry.ts = Date.now() - 60_000;
  assert.equal(cachedShowDetail({ tmdb_id: "113962" }), null, "a stale entry must not be served");
});

// clearDerivedUiCaches() empties both maps after any mutation; this asserts the
// lookup genuinely depends on them rather than holding its own copy.
test("clearing the cache maps drops the cached show", () => {
  reset();
  rememberShowDetail({ id: "show-1", title: "Lioness", tmdb_id: "113962" });
  state.showDetailCache.clear();
  state.showDetailAliases.clear();
  assert.equal(cachedShowDetail({ tmdb_id: "113962" }), null);
});

test("a show with no usable identifier is not cached", () => {
  reset();
  const before = state.showDetailCache.size;
  rememberShowDetail({});
  assert.equal(state.showDetailCache.size, before);
  assert.equal(rememberShowDetail(null), null);
});
