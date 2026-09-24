import test from "node:test";
import assert from "node:assert/strict";

import { hidePlexFromContinueWatching } from "../server/src/utils/plexClient.js";
import { hideEmbyFromResume } from "../server/src/utils/embyClient.js";
import { hideJellyfinFromResume } from "../server/src/utils/jellyfinClient.js";

test("provider dismissal adapters use each provider's native endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    calls.push({ url: new URL(String(input)), options });
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await hidePlexFromContinueWatching({ baseUrl: "https://plex.test", token: "token", username: "owner" }, "plex/item");
  await hideEmbyFromResume({ baseUrl: "https://emby.test", apiKey: "key", userId: "user/id" }, "emby/item");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].url.pathname, "/actions/removeFromContinueWatching");
  assert.equal(calls[0].url.searchParams.get("ratingKey"), "plex/item");
  assert.equal(calls[0].url.searchParams.get("accountID"), "1");

  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].url.pathname, "/Users/user%2Fid/Items/emby%2Fitem/HideFromResume");
  assert.equal(calls[1].url.searchParams.get("Hide"), "true");
});

// Verified live: Jellyfin 12.0.0 answers HideFromResume with 404. Its Resume
// list is only "position above zero and not played", so the adapter confirms
// the cleared position and writes nothing.
test("Jellyfin resume dismissal only confirms the cleared position", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let ticks = 0;
  globalThis.fetch = async (input, options = {}) => {
    calls.push({ url: new URL(String(input)), method: String(options.method || "GET").toUpperCase() });
    return new Response(JSON.stringify({ UserData: { Played: false, PlaybackPositionTicks: ticks } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const config = { baseUrl: "https://jellyfin.test", apiKey: "key", userId: "user/id" };

  const cleared = await hideJellyfinFromResume(config, "jellyfin/item");
  assert.equal(cleared.status, "fulfilled");
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${url.pathname}`), ["GET /Users/user%2Fid/Items/jellyfin%2Fitem"]);

  ticks = 2_450_000_000;
  await assert.rejects(hideJellyfinFromResume(config, "jellyfin/item"), /still has a resume position/);
});
