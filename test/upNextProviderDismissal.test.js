import test from "node:test";
import assert from "node:assert/strict";

import { hidePlexFromContinueWatching } from "../server/src/utils/plexClient.js";
import { hideEmbyFromResume } from "../server/src/utils/embyClient.js";
import { hideJellyfinFromResume } from "../server/src/utils/jellyfinClient.js";

test("Up Next removal uses each provider's native dismissal endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    calls.push({ url: new URL(String(input)), options });
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await hidePlexFromContinueWatching({ baseUrl: "https://plex.test", token: "token", username: "owner" }, "plex/item");
  await hideEmbyFromResume({ baseUrl: "https://emby.test", apiKey: "key", userId: "user/id" }, "emby/item");
  await hideJellyfinFromResume({ baseUrl: "https://jellyfin.test", apiKey: "key", userId: "user/id" }, "jellyfin/item");

  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].url.pathname, "/actions/removeFromContinueWatching");
  assert.equal(calls[0].url.searchParams.get("ratingKey"), "plex/item");
  assert.equal(calls[0].url.searchParams.get("accountID"), "1");

  for (const call of calls.slice(1)) {
    assert.equal(call.options.method, "POST");
    assert.match(call.url.pathname, /^\/Users\/user%2Fid\/Items\/.+%2Fitem\/HideFromResume$/);
    assert.equal(call.url.searchParams.get("Hide"), "true");
  }
});
