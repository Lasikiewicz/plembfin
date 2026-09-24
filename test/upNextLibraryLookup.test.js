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
