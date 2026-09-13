import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-rail-seed-");
const { seedUpNextProviderRails, railSeedPositionMs, UP_NEXT_RAIL_SEED_PERCENT } = await import("../server/src/utils/upNextRailSeed.js");
const {
  isUpNextRailSeedPosition,
  mediaIsUpNextRailSeed,
  recordUpNextRailSeeds,
  countUpNextRailSeeds,
} = await import("../server/src/utils/upNextSeedLedger.js");
const { minResumePositionMs, watchedThresholdPercent } = await import("../server/src/utils/tuning.js");

// 5% is the default minimum resume percentage on all three servers; a seed at
// or under it is stored and then filtered out of the rail, which is exactly
// how the first attempt failed.
test("the seed position clears the providers' minimum and stays well short of watched", () => {
  const episode = 43 * 60 * 1000;
  const position = railSeedPositionMs(episode);
  assert.ok(UP_NEXT_RAIL_SEED_PERCENT > 5);
  assert.ok((position / episode) * 100 > 5);
  assert.ok((position / episode) * 100 < watchedThresholdPercent());
  // And it is necessarily above Plembfin's own resume threshold, which is why
  // the ledger exists at all.
  assert.ok(position > minResumePositionMs());
});

test("an item with no known runtime is skipped rather than seeded with a guess", () => {
  assert.equal(railSeedPositionMs(0), 0);
  assert.equal(railSeedPositionMs(null), 0);
  assert.equal(railSeedPositionMs(undefined), 0);
});

test("a recorded seed is rejected as playback, and a real position clears it", () => {
  recordUpNextRailSeeds([{ provider: "plex", providerItemId: "4774", positionMs: 154477, durationMs: 2574624 }]);
  assert.ok(isUpNextRailSeedPosition("plex", "4774", 154477));
  // Provider rounding must not defeat the match.
  assert.ok(isUpNextRailSeedPosition("plex", "4774", 155000));
  // Same id on another provider is a different item entirely.
  assert.equal(isUpNextRailSeedPosition("emby", "4774", 154477), false);

  // Real playback moves the position, which both passes through and forgets
  // the seed so the item behaves normally from then on.
  assert.equal(isUpNextRailSeedPosition("plex", "4774", 900000), false);
  assert.equal(isUpNextRailSeedPosition("plex", "4774", 154477), false);
});

test("the media wrapper reads provider identity off an ingestion payload", () => {
  recordUpNextRailSeeds([{ provider: "jellyfin", providerItemId: "abc", positionMs: 60000, durationMs: 1000000 }]);
  assert.ok(mediaIsUpNextRailSeed({ source: "jellyfin", provider_item_id: "abc", positionMs: 60000 }));
  assert.equal(mediaIsUpNextRailSeed({ source: "emby", provider_item_id: "abc", positionMs: 60000 }), false);
  assert.equal(mediaIsUpNextRailSeed({ source: "jellyfin", provider_item_id: "abc", positionMs: 0 }), false);
});

// Both skip paths must return before any provider call. The fake config points
// at an unroutable host, so a write attempt would fail the test rather than
// pass silently.
test("an item already on the provider resume rail is never re-seeded", async () => {
  const before = countUpNextRailSeeds();
  const [summary] = await seedUpNextProviderRails({
    config: { plex: { baseUrl: "http://plex.invalid", token: "t" } },
    providers: ["plex"],
    targetsByProvider: {
      plex: { resolved: [{ item: { title: "Ted Lasso" }, providerItemId: "3478", runtimeMs: 2761759 }] },
    },
    existingResumeIds: { plex: new Set(["3478"]) },
  });
  assert.equal(summary.seeded_count, 0);
  assert.equal(summary.skipped_count, 1);
  assert.match(summary.results[0].reason, /already on the provider's resume rail/i);
  assert.equal(countUpNextRailSeeds(), before);
});

test("an item with no resolved runtime is skipped without a provider call", async () => {
  const [summary] = await seedUpNextProviderRails({
    config: { plex: { baseUrl: "http://plex.invalid", token: "t" } },
    providers: ["plex"],
    targetsByProvider: {
      plex: { resolved: [{ item: { title: "Unknown Runtime" }, providerItemId: "9999", runtimeMs: 0 }] },
    },
  });
  assert.equal(summary.seeded_count, 0);
  assert.equal(summary.skipped_count, 1);
  assert.match(summary.results[0].reason, /runtime/i);
});

test("a seeded item that leaves the queue has its position cleared and its ledger row dropped", async (t) => {
  const { recordUpNextRailSeeds: record, listUpNextRailSeeds } = await import("../server/src/utils/upNextSeedLedger.js");
  record([
    { provider: "jellyfin", providerItemId: "gone-from-queue", positionMs: 162000, durationMs: 2700000, title: "Reacher - S04E07" },
    { provider: "jellyfin", providerItemId: "still-queued", positionMs: 162000, durationMs: 2700000, title: "Ludwig - S02E01" },
  ]);

  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (String(options.method || "GET").toUpperCase() === "POST") {
      writes.push({ path: url.pathname, body: String(options.body || "") });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const [summary] = await seedUpNextProviderRails({
    config: { jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "k", userId: "u" } },
    providers: ["jellyfin"],
    targetsByProvider: {
      jellyfin: { resolved: [{ item: { title: "Ludwig" }, providerItemId: "still-queued", runtimeMs: 2700000 }] },
    },
    existingResumeIds: { jellyfin: new Set(["still-queued"]) },
  });

  // Earlier tests in this file left their own jellyfin seeds behind, and they
  // are stale too, so assert on the specific items rather than the total.
  assert.ok(summary.cleared_count >= 1);
  const remaining = listUpNextRailSeeds("jellyfin").map((seed) => seed.providerItemId);
  assert.ok(!remaining.includes("gone-from-queue"), "the stale ledger row is dropped");
  assert.ok(remaining.includes("still-queued"), "the queued one is kept");

  const clearWrite = writes.find((write) => write.path.includes("gone-from-queue"));
  assert.ok(clearWrite, "the stale item's position is written back to the provider");
  assert.match(clearWrite.body, /"PlaybackPositionTicks":0/);
});

test("the seed's own playback session is not reported as live playback", async () => {
  const { UP_NEXT_SEED_DEVICE_ID } = await import("../server/src/utils/embyClient.js");
  const { fetchLiveSessions } = await import("../server/src/utils/liveSessions.js");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/Sessions") {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify([
      {
        Id: "seed-session",
        UserId: "emby-user",
        DeviceId: UP_NEXT_SEED_DEVICE_ID,
        NowPlayingItem: { Id: "18695", Name: "Sugar Land", SeriesName: "Lioness", Type: "Episode", ParentIndexNumber: 3, IndexNumber: 6, RunTimeTicks: 35726940000 },
        PlayState: { PositionTicks: 2143620000 },
      },
      {
        Id: "real-session",
        UserId: "emby-user",
        DeviceId: "a-real-device",
        NowPlayingItem: { Id: "18434", Name: "Plum Out of Luck", SeriesName: "Reacher", Type: "Episode", ParentIndexNumber: 4, IndexNumber: 6, RunTimeTicks: 24347200000 },
        PlayState: { PositionTicks: 1509887470 },
      },
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { sessions } = await fetchLiveSessions({
      plex: {},
      emby: { baseUrl: "http://emby.test", apiKey: "k", userId: "emby-user" },
      jellyfin: {},
    });
    // Episode sessions are titled "<Series> - SxxEyy", not by episode name.
    const titles = sessions.map((session) => session.title || "");
    assert.ok(!titles.some((title) => /Lioness/.test(title)), "the seed session is ignored");
    assert.ok(titles.some((title) => /Reacher/.test(title)), "a real session still comes through");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
