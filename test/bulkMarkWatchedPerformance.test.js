import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = process.env.DATA_DIR || `${process.cwd()}/data/test-bulk-mark-performance`;

const {
  dispatchGroupsForRows,
} = await import("../server/src/utils/dataRepo.js");
const {
  __resetEmbySeriesCache,
  findEmbyItems,
} = await import("../server/src/utils/embyClient.js");
const {
  __resetJellyfinSeriesCache,
  findJellyfinItems,
} = await import("../server/src/utils/jellyfinClient.js");
const {
  __resetPlexIdentityCache,
  findPlexItem,
} = await import("../server/src/utils/plexClient.js");
const { resetOutboundGovernor } = await import("../server/src/utils/outboundGovernor.js");
const { shouldDeferScheduledOutbound } = await import("../server/src/scheduler.js");
const { createRestoreLookupCache } = await import("../server/src/utils/restoreLookupCache.js");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("restore lookup cache shares one in-flight resolution and keeps a bounded result", async () => {
  const cache = createRestoreLookupCache({ maxEntries: 100 });
  let calls = 0;
  const resolver = async () => {
    calls += 1;
    await Promise.resolve();
    return [{ Id: "native-1" }];
  };
  const results = await Promise.all([
    cache.resolve("restore-key", { title: "Cached Show - S01E01" }, resolver),
    cache.resolve("restore-key", { title: "Cached Show - S01E01" }, resolver),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  assert.equal(cache.size, 1);
  cache.delete("restore-key");
  assert.equal(cache.size, 0);
});

test("dispatch grouping uses broader provider bridges and episode coordinates", () => {
  const first = { id: "a", media_type: "movie", title: "Bridge Film", imdb_id: "tt1", watched_at: "2026-01-01T00:00:00Z" };
  const second = { id: "b", media_type: "movie", title: "Bridge Film", tmdb_id: "2", watched_at: "2026-01-01T00:01:00Z" };
  const bridge = { id: "outside", media_type: "movie", title: "Bridge Film", imdb_id: "tt1", tmdb_id: "2", watched_at: "2025-01-01T00:00:00Z" };
  const episode1 = { id: "e1", media_type: "episode", show_title: "Fast Show", tmdb_id: "10", season: 1, episode: 1, watched_at: "2026-01-01T00:00:00Z" };
  const episode2 = { id: "e2", media_type: "episode", show_title: "Fast Show", tmdb_id: "10", season: 1, episode: 2, watched_at: "2026-01-01T00:00:00Z" };

  const groups = dispatchGroupsForRows([first, second, episode1, episode2], [first, second, bridge, episode1, episode2]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.find((group) => group.key.startsWith("movie|")).rows.map((row) => row.id), ["a", "b"]);
});

test("scheduled outbound work defers only for a large active dispatch", () => {
  assert.equal(shouldDeferScheduledOutbound({ total: 9, completed: 1 }), false);
  assert.equal(shouldDeferScheduledOutbound({ total: 10, completed: 1 }), true);
  assert.equal(shouldDeferScheduledOutbound({ total: 1, completed: 0 }), false);
});

for (const platform of ["emby", "jellyfin"]) {
  test(`${platform} sibling episodes share one provider fan-out and episode-list fetch`, async () => {
    resetOutboundGovernor();
    if (platform === "emby") __resetEmbySeriesCache();
    else __resetJellyfinSeriesCache();
    const originalFetch = globalThis.fetch;
    let providerRequests = 0;
    let episodeRequests = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("AnyProviderIdEquals")) {
        providerRequests += 1;
        return response({ Items: [{ Id: "series-1", Name: "Fast Show", ProviderIds: { Imdb: "tt1", Tmdb: "2", Tvdb: "3" } }] });
      }
      if (url.searchParams.get("ParentId") === "series-1") {
        episodeRequests += 1;
        return response({ Items: Array.from({ length: 6 }, (_, index) => ({ Id: `ep-${index + 1}`, ParentIndexNumber: 1, IndexNumber: index + 1 })) });
      }
      return response({ Items: [] });
    };
    try {
      const config = { baseUrl: "http://127.0.0.1:8096", apiKey: "key", userId: "user" };
      const lookup = platform === "emby" ? findEmbyItems : findJellyfinItems;
      const results = await Promise.all(Array.from({ length: 6 }, (_, index) => lookup(config, {
        type: "episode",
        title: `Fast Show - S01E0${index + 1}`,
        season: 1,
        episode: index + 1,
        ids: { imdb: "tt1", tmdb: "2", tvdb: "3" },
      })));
      assert.deepEqual(results.map((items) => items[0]?.Id), ["ep-1", "ep-2", "ep-3", "ep-4", "ep-5", "ep-6"]);
      assert.equal(providerRequests, 3);
      assert.equal(episodeRequests, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const platform of ["emby", "jellyfin"]) {
  test(`${platform} title fallback is shared when provider ids miss`, async () => {
    resetOutboundGovernor();
    if (platform === "emby") __resetEmbySeriesCache();
    else __resetJellyfinSeriesCache();
    const originalFetch = globalThis.fetch;
    let providerRequests = 0;
    let searchRequests = 0;
    let episodeRequests = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("AnyProviderIdEquals")) {
        providerRequests += 1;
        return response({ Items: [] });
      }
      if (url.searchParams.has("SearchTerm")) {
        searchRequests += 1;
        return response({ Items: [{ Id: "fallback-series", Name: "Fallback Show", ProviderIds: { Imdb: "tt-fallback" } }] });
      }
      if (url.searchParams.get("ParentId") === "fallback-series") {
        episodeRequests += 1;
        return response({ Items: Array.from({ length: 6 }, (_, index) => ({ Id: `fallback-ep-${index + 1}`, ParentIndexNumber: 1, IndexNumber: index + 1 })) });
      }
      return response({ Items: [] });
    };
    try {
      const config = { baseUrl: "http://127.0.0.1:8096", apiKey: "key", userId: "user" };
      const lookup = platform === "emby" ? findEmbyItems : findJellyfinItems;
      const results = await Promise.all(Array.from({ length: 6 }, (_, index) => lookup(config, {
        type: "episode",
        title: `Fallback Show - S01E0${index + 1}`,
        season: 1,
        episode: index + 1,
        ids: { imdb: "tt-missing", tmdb: "999", tvdb: "888" },
      })));
      assert.deepEqual(results.map((items) => items[0]?.Id), [
        "fallback-ep-1",
        "fallback-ep-2",
        "fallback-ep-3",
        "fallback-ep-4",
        "fallback-ep-5",
        "fallback-ep-6",
      ]);
      assert.equal(providerRequests, 3);
      assert.equal(searchRequests, 1);
      assert.equal(episodeRequests, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("Plex sibling episodes resolve the series once and share one allLeaves fetch", async () => {
  resetOutboundGovernor();
  __resetPlexIdentityCache();
  const originalFetch = globalThis.fetch;
  let allLeavesRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/allLeaves")) {
      allLeavesRequests += 1;
      return response({ MediaContainer: { Metadata: Array.from({ length: 6 }, (_, index) => ({ ratingKey: `ep-${index + 1}`, type: "episode", parentIndex: 1, index: index + 1 })) } });
    }
    if (url.pathname === "/library/all") {
      return response({ MediaContainer: { Metadata: [{ ratingKey: "series-1", type: "show", title: "Fast Show" }] } });
    }
    return response({ MediaContainer: { Metadata: [] } });
  };
  try {
    const config = { baseUrl: "http://127.0.0.1:32400", token: "token" };
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => findPlexItem(config, {
      type: "episode",
      title: `Fast Show - S01E0${index + 1}`,
      season: 1,
      episode: index + 1,
      ids: { imdb: "tt1", tmdb: "2", tvdb: "3" },
    })));
    assert.deepEqual(results.map((item) => item?.ratingKey), ["ep-1", "ep-2", "ep-3", "ep-4", "ep-5", "ep-6"]);
    assert.equal(allLeavesRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Plex episode lookup uses show_title when a rating snapshot has a leaf title", async () => {
  resetOutboundGovernor();
  __resetPlexIdentityCache();
  const originalFetch = globalThis.fetch;
  let searchedQuery = "";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/search") {
      searchedQuery = url.searchParams.get("query") || "";
      return response({ MediaContainer: { Metadata: [{ ratingKey: "series-1", type: "show", title: "Fast Show" }] } });
    }
    if (url.pathname.endsWith("/allLeaves")) {
      return response({ MediaContainer: { Metadata: [{ ratingKey: "episode-1", type: "episode", parentIndex: 1, index: 1 }] } });
    }
    return response({ MediaContainer: { Metadata: [] } });
  };
  try {
    const config = { baseUrl: "http://127.0.0.1:32400", token: "token" };
    const result = await findPlexItem(config, {
      type: "episode",
      title: "Curiouser and Curiouser!",
      show_title: "Fast Show",
      season: 1,
      episode: 1,
      ids: {},
    });
    assert.equal(result?.ratingKey, "episode-1");
    assert.equal(searchedQuery, "Fast Show");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all media providers resolve normalized tv ratings as series", async () => {
  resetOutboundGovernor();
  __resetEmbySeriesCache();
  __resetJellyfinSeriesCache();
  __resetPlexIdentityCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1" && url.port === "32400") {
      return response({ MediaContainer: { Metadata: [{ ratingKey: "plex-series", type: "show", title: "Rated Show" }] } });
    }
    return response({ Items: [{ Id: `${url.port === "8096" ? "emby" : "jellyfin"}-series`, Name: "Rated Show", ProviderIds: { Tmdb: "98177" } }] });
  };
  try {
    const media = { type: "tv", title: "Rated Show", ids: { tmdb: "98177" } };
    const plex = await findPlexItem({ baseUrl: "http://127.0.0.1:32400", token: "token" }, media);
    const emby = await findEmbyItems({ baseUrl: "http://127.0.0.1:8096", apiKey: "key", userId: "user" }, media);
    const jellyfin = await findJellyfinItems({ baseUrl: "http://127.0.0.1:8920", apiKey: "key", userId: "user" }, media);
    assert.equal(plex?.ratingKey, "plex-series");
    assert.deepEqual(emby.map((item) => item.Id), ["emby-series"]);
    assert.deepEqual(jellyfin.map((item) => item.Id), ["jellyfin-series"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
