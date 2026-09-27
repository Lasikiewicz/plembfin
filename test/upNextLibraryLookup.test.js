import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-library-lookup-");

const {
  __setUpNextLibraryLookupNow,
  clearUpNextLibraryLookupCache,
  createUpNextLibraryEpisodeLookup,
  createUpNextLibraryLookup,
} = await import("../server/src/utils/upNextLibraryLookup.js");
const { __resetJellyfinSeriesCache } = await import("../server/src/utils/jellyfinClient.js");

const config = {
  jellyfin: { baseUrl: "https://jellyfin.example.test", apiKey: "api-key", userId: "jellyfin-user" },
};

const show = (n) => ({ title: `Offline Show ${n}`, tvdb_id: String(9000 + n) });
const episode = (n) => ({
  media_type: "episode",
  title: `Offline Show ${n} - S01E02`,
  show_title: `Offline Show ${n}`,
  season: 1,
  episode: 2,
  show_ids: { tvdb: String(9000 + n) },
});

function withOfflineJellyfin(run) {
  return async () => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    let now = 1_000_000;
    let requests = 0;
    clearUpNextLibraryLookupCache();
    __resetJellyfinSeriesCache();
    __setUpNextLibraryLookupNow(() => now);
    console.error = () => {};
    globalThis.fetch = async () => {
      requests += 1;
      return new Response("Not Found", { status: 404 });
    };
    try {
      await run({ requests: () => requests, advance: (ms) => { now += ms; } });
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      __setUpNextLibraryLookupNow(null);
      clearUpNextLibraryLookupCache();
      __resetJellyfinSeriesCache();
    }
  };
}

test("an unreachable provider stands down its series inventory lookups until the backoff ends", withOfflineJellyfin(async ({ requests, advance }) => {
  const lookup = createUpNextLibraryEpisodeLookup(config);
  assert.deepEqual(await lookup(show(1)), []);
  const afterFirst = requests();
  assert.ok(afterFirst > 0, "the first lookup reaches the provider");

  // A later rebuild in the same outage, for other shows, sends nothing.
  for (let n = 2; n <= 6; n += 1) assert.deepEqual(await createUpNextLibraryEpisodeLookup(config)(show(n)), []);
  assert.equal(requests(), afterFirst);

  advance(61_000);
  await createUpNextLibraryEpisodeLookup(config)(show(7));
  assert.ok(requests() > afterFirst, "the provider is retried once the backoff has passed");
}));

test("an unreachable provider stands down its episode item lookups and caches no miss", withOfflineJellyfin(async ({ requests, advance }) => {
  const lookup = createUpNextLibraryLookup(config);
  assert.deepEqual(await lookup(episode(1)), {});
  const afterFirst = requests();
  assert.ok(afterFirst > 0);

  for (let n = 2; n <= 6; n += 1) assert.deepEqual(await createUpNextLibraryLookup(config)(episode(n)), {});
  assert.equal(requests(), afterFirst);

  // The failed lookup was not cached as "absent": after the backoff the same
  // episode is asked again.
  advance(61_000);
  await createUpNextLibraryLookup(config)(episode(1));
  assert.ok(requests() > afterFirst);
}));

// Answers a Jellyfin library holding "Remembered Show" S01E02 as item jf-e2,
// or holding no episodes at all when `present` is false.
function jellyfinLibrary({ present }) {
  const series = { Id: "jf-series", Name: "Remembered Show", Type: "Series", ProviderIds: { Tvdb: "9100" } };
  const episodeItem = {
    Id: "jf-e2",
    Name: "Episode Two",
    Type: "Episode",
    SeriesId: "jf-series",
    SeriesName: "Remembered Show",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    ProviderIds: {},
  };
  return async (input) => {
    const url = new URL(String(input?.url || input));
    const types = `${url.searchParams.get("IncludeItemTypes") || ""}`.toLowerCase();
    const items = /\/episodes/i.test(url.pathname) || types.includes("episode")
      ? (present ? [episodeItem] : [])
      : [series];
    return Response.json({ Items: items, TotalRecordCount: items.length });
  };
}

const rememberedEpisode = {
  media_type: "episode",
  title: "Remembered Show - S01E02",
  show_title: "Remembered Show",
  season: 1,
  episode: 2,
  show_ids: { tvdb: "9100" },
};

test("a restart during an outage keeps the provider's last library-confirmed id, and a live miss forgets it", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const resetProcessState = () => {
    // What a Plembfin restart loses: every in-memory cache and stand-down.
    clearUpNextLibraryLookupCache();
    __resetJellyfinSeriesCache();
  };
  console.error = () => {};
  try {
    resetProcessState();
    globalThis.fetch = jellyfinLibrary({ present: true });
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), { jellyfin: ["jf-e2"] });

    resetProcessState();
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });
    const offline = await createUpNextLibraryLookup(config)(rememberedEpisode, { detailed: true });
    assert.deepEqual(offline.providerItems, { jellyfin: ["jf-e2"] }, "the card keeps the id Jellyfin last confirmed");
    assert.deepEqual(offline.unanswered, ["jellyfin"], "it is still reported as unanswered");
    // Later lookups in the same stand-down window use it too.
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), { jellyfin: ["jf-e2"] });

    resetProcessState();
    globalThis.fetch = jellyfinLibrary({ present: false });
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), {}, "a live miss is final");

    resetProcessState();
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), {}, "the forgotten id is not revived by a later outage");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    resetProcessState();
  }
});

// Speed finding AK: with a 15-minute miss window, misses for the ~160 eligible
// shows expired faster than the 32-lookups-per-build budget refilled them, so
// every Up Next rebuild paid seconds of provider round trips.
test("a live miss is kept for two hours before the library is asked again", async () => {
  const originalFetch = globalThis.fetch;
  let now = 5_000_000;
  let requests = 0;
  const library = jellyfinLibrary({ present: false });
  clearUpNextLibraryLookupCache();
  __resetJellyfinSeriesCache();
  __setUpNextLibraryLookupNow(() => now);
  globalThis.fetch = async (input) => {
    requests += 1;
    return library(input);
  };
  try {
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), {});
    const afterFirst = requests;
    assert.ok(afterFirst > 0, "the first lookup reaches the library");

    now += 2 * 60 * 60 * 1000 - 1;
    __resetJellyfinSeriesCache();
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), {});
    assert.equal(requests, afterFirst, "a later rebuild inside two hours reuses the miss");

    now += 1;
    await createUpNextLibraryLookup(config)(rememberedEpisode);
    assert.ok(requests > afterFirst, "the miss is re-asked once two hours have passed");
  } finally {
    globalThis.fetch = originalFetch;
    __setUpNextLibraryLookupNow(null);
    clearUpNextLibraryLookupCache();
    __resetJellyfinSeriesCache();
  }
});

// Speed finding AK: refetching 26 series inventories took 13-18s, and a
// 5-minute window made every rebuild after a short idle gap pay it.
test("a series episode inventory is kept for thirty minutes", async () => {
  const originalFetch = globalThis.fetch;
  let now = 5_000_000;
  let requests = 0;
  const library = jellyfinLibrary({ present: true });
  const series = { title: "Remembered Show", tvdb_id: "9100" };
  clearUpNextLibraryLookupCache();
  __resetJellyfinSeriesCache();
  __setUpNextLibraryLookupNow(() => now);
  globalThis.fetch = async (input) => {
    requests += 1;
    return library(input);
  };
  try {
    const first = await createUpNextLibraryEpisodeLookup(config)(series);
    assert.deepEqual(first.map((item) => item.provider_items), [{ jellyfin: ["jf-e2"] }]);
    const afterFirst = requests;

    now += 30 * 60 * 1000 - 1;
    __resetJellyfinSeriesCache();
    assert.deepEqual(await createUpNextLibraryEpisodeLookup(config)(series), first);
    assert.equal(requests, afterFirst, "a rebuild inside thirty minutes reuses the inventory");

    now += 1;
    await createUpNextLibraryEpisodeLookup(config)(series);
    assert.ok(requests > afterFirst, "the inventory is refetched once thirty minutes have passed");
  } finally {
    globalThis.fetch = originalFetch;
    __setUpNextLibraryLookupNow(null);
    clearUpNextLibraryLookupCache();
    __resetJellyfinSeriesCache();
  }
});

// Speed step 15b: the server logs one summary per Up Next build so the live
// lookups each rebuild pays can be counted from the diagnostic log.
test("build stats count live, cached, and over-budget lookups and inventories", async () => {
  const { formatUpNextBuildSummary } = await import("../server/src/utils/upNextService.js");
  const originalFetch = globalThis.fetch;
  clearUpNextLibraryLookupCache();
  __resetJellyfinSeriesCache();
  globalThis.fetch = jellyfinLibrary({ present: false });
  try {
    const first = {};
    const lookup = createUpNextLibraryLookup(config, { stats: first });
    for (let n = 1; n <= 33; n += 1) await lookup(episode(n));
    assert.deepEqual(first, { itemLive: 32, itemOverBudget: 1 });

    const second = {};
    const nextLookup = createUpNextLibraryLookup(config, { stats: second });
    for (let n = 1; n <= 33; n += 1) await nextLookup(episode(n));
    assert.deepEqual(second, { itemCached: 32, itemLive: 1 }, "the next build reuses the cached misses");

    const inventory = {};
    const series = { title: "Remembered Show", tvdb_id: "9100" };
    await createUpNextLibraryEpisodeLookup(config, { stats: inventory })(series);
    await createUpNextLibraryEpisodeLookup(config, { stats: inventory })(series);
    assert.deepEqual(inventory, { inventoryFetched: 1, inventoryCached: 1 });

    assert.equal(
      formatUpNextBuildSummary({ ...second, ...inventory }, 9, 6840),
      "Up Next build: 9 items in 6.8s; library lookups 1 live, 32 cached, 0 over budget; series inventories 1 fetched, 1 cached.",
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearUpNextLibraryLookupCache();
    __resetJellyfinSeriesCache();
  }
});

// Speed step 15b: real dashboards rebuild too rarely to fill the cache 32
// lookups at a time before the miss window expires, so the lookups a build
// skips for budget are asked in the background (the user's choice).
test("a background top-up asks the lookups a build skipped, so the next build pays none", async () => {
  const { topUpUpNextLibraryLookups } = await import("../server/src/utils/upNextLibraryLookup.js");
  const originalFetch = globalThis.fetch;
  clearUpNextLibraryLookupCache();
  __resetJellyfinSeriesCache();
  globalThis.fetch = jellyfinLibrary({ present: false });
  try {
    const build = {};
    const deferred = [];
    const lookup = createUpNextLibraryLookup(config, { stats: build, deferred });
    for (let n = 1; n <= 80; n += 1) await lookup(episode(n));
    assert.deepEqual(build, { itemLive: 32, itemOverBudget: 48 });
    assert.equal(deferred.length, 48);

    const logs = [];
    const running = topUpUpNextLibraryLookups(config, [...deferred, ...deferred], { pauseMs: 0, log: (line) => logs.push(line) });
    assert.equal(topUpUpNextLibraryLookups(config, deferred, { pauseMs: 0, log: () => {} }), running,
      "a second build while a top-up runs starts no second top-up");
    await running;
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Up Next lookup top-up: 48 skipped lookups in [\d.]+s; 48 live, 0 already cached\.$/);

    const next = {};
    const nextLookup = createUpNextLibraryLookup(config, { stats: next });
    for (let n = 1; n <= 80; n += 1) await nextLookup(episode(n));
    assert.deepEqual(next, { itemCached: 80 }, "the next build finds every answer cached");
    assert.equal(topUpUpNextLibraryLookups(config, [], { pauseMs: 0 }), null, "nothing skipped, nothing to top up");
  } finally {
    globalThis.fetch = originalFetch;
    clearUpNextLibraryLookupCache();
    __resetJellyfinSeriesCache();
  }
});
