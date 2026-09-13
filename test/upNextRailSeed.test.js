import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-rail-seed-");
const { clearLegacyUpNextRailSeeds } = await import("../server/src/utils/upNextRailSeed.js");
const {
  isUpNextRailSeedPosition,
  mediaIsUpNextRailSeed,
  recordUpNextRailSeeds,
} = await import("../server/src/utils/upNextSeedLedger.js");

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

test("a legacy seeded item that leaves the queue has its position cleared and its ledger row dropped", async (t) => {
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

  const summary = await clearLegacyUpNextRailSeeds({
    config: { jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "k", userId: "u" } },
    providers: ["jellyfin"],
    desiredIdsByProvider: { jellyfin: new Set(["still-queued"]) },
  });

  assert.ok(summary.some((entry) => entry.provider_item_id === "gone-from-queue" && entry.status === "cleared"));
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
