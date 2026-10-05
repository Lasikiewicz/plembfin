import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-stale-episode-refresh-");

const plex = await import("../server/src/utils/plexClient.js");
const emby = await import("../server/src/utils/embyClient.js");
const jellyfin = await import("../server/src/utils/jellyfinClient.js");
const { resetOutboundGovernor } = await import("../server/src/utils/outboundGovernor.js");

const media = {
  type: "episode",
  title: "South Park - S01E05",
  show_title: "South Park",
  season: 1,
  episode: 5,
  ids: { imdb: "tt0121955", tmdb: "764", tvdb: "73871" },
};
const series = { ratingKey: "series-1", type: "show", title: "South Park", Guid: [
  { id: "imdb://tt0121955" }, { id: "tmdb://764" }, { id: "tvdb://73871" },
] };
const episode = { ratingKey: "episode-5", type: "episode", parentIndex: 1, index: 5 };
const nativeSeries = { Id: "series-1", Name: "South Park", ProviderIds: { Imdb: "tt0121955", Tmdb: "764", Tvdb: "73871" } };
const nativeEpisode = { Id: "episode-5", Type: "Episode", ParentIndexNumber: 1, IndexNumber: 5 };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const cases = [
  {
    name: "Plex", reset: plex.__resetPlexIdentityCache, mark: plex.markPlexUnplayed,
    config: { baseUrl: "http://127.0.0.1:32400", token: "test" },
    stub(url, init, state) {
      if (url.pathname === "/library/all") return json({ MediaContainer: { Metadata: [series] } });
      if (url.pathname === "/library/metadata/series-1/allLeaves") {
        state.episodeLists++;
        return json({ MediaContainer: { Metadata: state.episodeLists === 1 ? [] : [episode] } });
      }
      if (url.pathname === "/:/unscrobble") {
        state.writes++;
        return new Response("", { status: 200 });
      }
      return json({ MediaContainer: { Metadata: [] } });
    },
  },
  {
    name: "Emby", reset: emby.__resetEmbySeriesCache, mark: emby.markEmbyUnplayed,
    config: { baseUrl: "http://127.0.0.1:8097", apiKey: "test", userId: "user" },
    stub(url, init, state) {
      const params = url.searchParams;
      if (params.has("AnyProviderIdEquals")) {
        return json(params.get("AnyProviderIdEquals") === "imdb.tt0121955" ? { Items: [nativeSeries] } : { Items: [] });
      }
      if (params.get("ParentId") === "series-1") {
        state.episodeLists++;
        return json({ Items: state.episodeLists === 1 ? [] : [nativeEpisode] });
      }
      if (url.pathname.endsWith("/PlayedItems/episode-5") && init.method === "DELETE") {
        state.writes++;
        return new Response(null, { status: 204 });
      }
      return json({ Items: [] });
    },
  },
  {
    name: "Jellyfin", reset: jellyfin.__resetJellyfinSeriesCache, mark: jellyfin.markJellyfinUnplayed,
    config: { baseUrl: "http://127.0.0.1:8096", apiKey: "test", userId: "user" },
    stub(url, init, state) {
      const params = url.searchParams;
      if (params.has("AnyProviderIdEquals")) {
        return json(params.get("AnyProviderIdEquals") === "imdb.tt0121955" ? { Items: [nativeSeries] } : { Items: [] });
      }
      if (params.get("ParentId") === "series-1") {
        state.episodeLists++;
        return json({ Items: [] });
      }
      if (url.pathname === "/Shows/series-1/Episodes") {
        state.episodeLists++;
        return json({ Items: state.episodeLists <= 2 ? [] : [nativeEpisode] });
      }
      if (url.pathname.endsWith("/PlayedItems/episode-5") && init.method === "DELETE") {
        state.writes++;
        return new Response(null, { status: 204 });
      }
      return json({ Items: [] });
    },
  },
];

for (const item of cases) {
  test(`${item.name}: an exact episode miss refreshes the stale series index before unwatching`, async () => {
    resetOutboundGovernor();
    item.reset();
    const originalFetch = globalThis.fetch;
    const state = { episodeLists: 0, writes: 0 };
    globalThis.fetch = async (input, init = {}) => item.stub(new URL(String(input)), init, state);
    try {
      const result = await item.mark(item.config, media);
      assert.equal(result.status, "fulfilled");
      assert.equal(result.itemId, "episode-5");
      assert.equal(state.writes, 1, "the unwatch write targets the episode found after refresh");
      assert.ok(state.episodeLists >= 2, "the provider episode index was fetched again after the miss");
    } finally {
      globalThis.fetch = originalFetch;
      item.reset();
      resetOutboundGovernor();
    }
  });
}
