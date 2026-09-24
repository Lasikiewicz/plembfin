import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-same-title-series-search-");

const { __resetJellyfinSeriesCache, findJellyfinItems } = await import("../server/src/utils/jellyfinClient.js");
const { __resetEmbySeriesCache, findEmbyItems } = await import("../server/src/utils/embyClient.js");
const { resetOutboundGovernor } = await import("../server/src/utils/outboundGovernor.js");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Live shape (23 September 2026): the library holds only the UK "The Assembly"
// (tmdb 290057, tvdb 453869). The Australian show (tmdb 262100, tvdb 452480)
// is in no library, so its id lookup finds nothing and the title search runs.
const ukSeries = { Id: "uk-series", Name: "The Assembly", ProductionYear: 2025, ProviderIds: { Tmdb: "290057", Tvdb: "453869", Imdb: "tt36000000" } };
const ukEpisode = { Id: "678064ce", SeriesId: "uk-series", ParentIndexNumber: 1, IndexNumber: 1, Name: "Danny Dyer", ProviderIds: {} };

function stubServer() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const params = url.searchParams;
    if (params.get("ParentId") === "uk-series") return response({ Items: [ukEpisode] });
    const anyId = params.get("AnyProviderIdEquals");
    if (anyId) {
      const [provider, value] = anyId.split(".");
      const key = provider.charAt(0).toUpperCase() + provider.slice(1);
      return response({ Items: ukSeries.ProviderIds[key] === value ? [ukSeries] : [] });
    }
    if (params.get("SearchTerm")) return response({ Items: [ukSeries] });
    return response({ Items: [] });
  };
  return () => { globalThis.fetch = originalFetch; };
}

const episode = (showIds) => ({
  type: "episode",
  title: "The Assembly - S01E01",
  show_title: "The Assembly",
  season: 1,
  episode: 1,
  ids: { tmdb: showIds.tmdb, tvdb: showIds.tvdb },
  show_tmdb_id: showIds.tmdb,
  show_tvdb_id: showIds.tvdb,
});
const australian = episode({ tmdb: "262100", tvdb: "452480" });
const idLessUk = { ...episode({ tmdb: "", tvdb: "" }), ids: {} };

const clients = [
  ["Jellyfin", findJellyfinItems, __resetJellyfinSeriesCache, { baseUrl: "http://127.0.0.1:8096", apiKey: "key", userId: "user" }],
  ["Emby", findEmbyItems, __resetEmbySeriesCache, { baseUrl: "http://127.0.0.1:8097", apiKey: "key", userId: "user" }],
];

// Live shape (24 September 2026): both Scrubs series are in the library.
// Jellyfin names both "Scrubs"; Emby names the revival "Scrubs (2026)". An
// Emby review carries only the episode's own ids, so the series id lookup
// finds nothing and the title search matched both, marking S01E03 on each.
const scrubs2001 = { Id: "scrubs-2001", Name: "Scrubs", ProductionYear: 2001, ProviderIds: { Tmdb: "4556", Tvdb: "76156", Imdb: "tt0285403" } };
const scrubs2026 = { Id: "scrubs-2026", Name: "Scrubs", ProductionYear: 2026, ProviderIds: { Tmdb: "295778", Tvdb: "465690", Imdb: "tt40197357" } };
const scrubsEpisodes = {
  "scrubs-2001": { Id: "e-2001", SeriesId: "scrubs-2001", ParentIndexNumber: 1, IndexNumber: 3, Name: "My Best Friend's Mistake", ProviderIds: {} },
  "scrubs-2026": { Id: "e-2026", SeriesId: "scrubs-2026", ParentIndexNumber: 1, IndexNumber: 3, Name: "My Third", ProviderIds: {} },
};

function stubScrubsServer(library) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const params = url.searchParams;
    const parent = params.get("ParentId");
    if (parent) return response({ Items: scrubsEpisodes[parent] ? [scrubsEpisodes[parent]] : [] });
    const anyId = params.get("AnyProviderIdEquals");
    if (anyId) {
      const [provider, value] = anyId.split(".");
      const key = provider.charAt(0).toUpperCase() + provider.slice(1);
      return response({ Items: library.filter((item) => item.ProviderIds[key] === value) });
    }
    if (params.get("SearchTerm")) return response({ Items: library });
    return response({ Items: [] });
  };
  return () => { globalThis.fetch = originalFetch; };
}

const scrubsEpisode = (title, ids = {}) => ({ type: "episode", title: `${title} - S01E03`, show_title: title, season: 1, episode: 3, ids });

for (const [name, find, reset, config] of clients) {
  test(`${name}: an ambiguous title with no year or show id writes to neither same-title series`, async () => {
    resetOutboundGovernor();
    reset();
    const restore = stubScrubsServer([scrubs2001, { ...scrubs2026, Name: name === "Emby" ? "Scrubs (2026)" : "Scrubs" }]);
    try {
      // Episode-level ids (as an Emby review carries) find no series.
      assert.deepEqual((await find(config, scrubsEpisode("Scrubs", { imdb: "tt0696595", tvdb: "184624" }))).map((item) => item.Id), []);
      reset();
      assert.deepEqual((await find(config, scrubsEpisode("Scrubs"))).map((item) => item.Id), []);
      reset();
      // A year or the series' own ids still pick exactly one show.
      assert.deepEqual((await find(config, scrubsEpisode("Scrubs (2026)"))).map((item) => item.Id), ["e-2026"]);
      reset();
      assert.deepEqual((await find(config, scrubsEpisode("Scrubs", { tmdb: "4556", tvdb: "76156" }))).map((item) => item.Id), ["e-2001"]);
      reset();
      // One series listed twice (two libraries) is still one show.
      restore();
      const restoreDuplicate = stubScrubsServer([scrubs2001, { ...scrubs2001, Id: "scrubs-2001-copy" }]);
      try {
        assert.deepEqual((await find(config, scrubsEpisode("Scrubs"))).map((item) => item.Id), ["e-2001"]);
      } finally {
        restoreDuplicate();
      }
    } finally {
      restore();
    }
  });

  test(`${name}: a same-title series whose ids contradict the request's show ids is not the show`, async () => {
    resetOutboundGovernor();
    reset();
    const restore = stubServer();
    try {
      assert.deepEqual((await find(config, australian)).map((item) => item.Id), []);
      reset();
      // An id-less request still takes the title match, and the UK show's own
      // ids still find it.
      assert.deepEqual((await find(config, idLessUk)).map((item) => item.Id), ["678064ce"]);
      reset();
      assert.deepEqual((await find(config, episode({ tmdb: "290057", tvdb: "453869" }))).map((item) => item.Id), ["678064ce"]);
    } finally {
      restore();
    }
  });
}
