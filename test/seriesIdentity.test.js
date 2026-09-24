import test from "node:test";
import assert from "node:assert/strict";

const { librarySeriesItemId, resetSeriesIdentityCache, resolveSeriesIds, withSeriesIdentity } = await import("../server/src/utils/seriesIdentity.js");

test("a library-history episode resolves series ids instead of keeping its own episode ids", async () => {
  resetSeriesIdentityCache();
  // The Jellyfin watched-library row for Ted Lasso S04E04 (23 September):
  // only the episode's ProviderIds, no SeriesProviderIds.
  const item = { Type: "Episode", Id: "ep-4-4", SeriesId: "series-ted", ProviderIds: { Imdb: "tt38494466", Tvdb: "11767184" } };
  assert.equal(librarySeriesItemId(item, "jellyfin"), "series-ted");
  assert.equal(librarySeriesItemId({ Type: "Movie", SeriesId: "x" }, "emby"), null);
  assert.equal(librarySeriesItemId({ type: "episode", grandparentRatingKey: "3470" }, "plex"), "3470");
  assert.equal(librarySeriesItemId({ type: "movie", grandparentRatingKey: "1" }, "plex"), null);
  // Plex session history rows carry the show only as a metadata path, and a
  // parentRatingKey is the season, never the show.
  assert.equal(librarySeriesItemId({ type: "episode", grandparentKey: "/library/metadata/3470" }, "plex"), "3470");
  assert.equal(librarySeriesItemId({ type: "episode", parentRatingKey: "3471" }, "plex"), null);

  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ ProviderIds: { Imdb: "tt10986410", Tmdb: "97546", Tvdb: "383203" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const media = await withSeriesIdentity({
      title: "Ted Lasso - S04E04",
      type: "episode",
      source: "jellyfin",
      season: 4,
      episode: 4,
      ids: { imdb: "tt38494466", tvdb: "11767184" },
      seriesItemId: librarySeriesItemId(item, "jellyfin"),
    }, { jellyfin: { baseUrl: "http://jellyfin.test", userId: "user", apiKey: "key" } });
    assert.deepEqual(media.ids, { imdb: "tt10986410", tmdb: "97546", tvdb: "383203" });
    assert.ok(requested.some((url) => url.includes("/Items/series-ted")));
  } finally {
    globalThis.fetch = originalFetch;
    resetSeriesIdentityCache();
  }
});

test("series identity lookup tolerates an unavailable provider and preserves the episode payload", async () => {
  resetSeriesIdentityCache();

  const media = {
    title: "Ted Lasso - S04E03",
    type: "episode",
    source: "emby",
    ids: { tvdb: "11767183" },
    season: 4,
    episode: 3,
    seriesItemId: "10678",
  };
  const config = { emby: { baseUrl: "", userId: "", apiKey: "" } };

  assert.equal(await resolveSeriesIds("emby", "10678", config.emby), null);
  assert.deepEqual(await withSeriesIdentity(media, config), media);
});
