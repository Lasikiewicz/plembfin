import test from "node:test";
import assert from "node:assert/strict";

import {
  jellyfinAuthHeaders,
  jellyfinAuthorization,
  jellyfinCredential,
  setJellyfinApiKey,
} from "../server/src/utils/jellyfinAuth.js";
import { findJellyfinItems, markJellyfinPlayed } from "../server/src/utils/jellyfinClient.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Jellyfin auth preserves legacy credential fields while using modern transport", () => {
  const config = { apiKey: "  ", api_key: "legacy-key", token: "ignored-token", userId: "user-1" };

  assert.equal(jellyfinCredential(config), "legacy-key");
  assert.match(jellyfinAuthorization(config), /^MediaBrowser /);
  assert.match(jellyfinAuthorization(config), /UserId="user-1"/);
  assert.match(jellyfinAuthorization(config), /Token="legacy-key"/);

  const headers = jellyfinAuthHeaders(config);
  assert.equal(headers.Authorization, jellyfinAuthorization(config));
  assert.equal(headers["X-Emby-Token"], undefined);
  assert.equal(headers["X-MediaBrowser-Token"], undefined);

  const url = new URL("https://jellyfin.example.test/Items/one?tag=abc");
  setJellyfinApiKey(url, config);
  assert.equal(url.searchParams.get("ApiKey"), "legacy-key");
  assert.equal(url.searchParams.get("api_key"), null);
});

test("Jellyfin API calls use the modern header without legacy query or token headers", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    calls.push({ url: new URL(String(input)), options });
    if (calls.length === 1) {
      return jsonResponse({ Items: [{ Id: "jellyfin-item", ProviderIds: { Tmdb: "123" } }] });
    }
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const config = { baseUrl: "https://jellyfin.example.test", api_key: "legacy-key", userId: "user-1" };
  const media = { type: "movie", title: "Example", ids: { tmdb: "123" } };

  const items = await findJellyfinItems(config, media);
  assert.deepEqual(items.map((item) => item.Id), ["jellyfin-item"]);

  const lookup = calls[0];
  assert.equal(lookup.url.searchParams.get("ApiKey"), null);
  assert.equal(lookup.url.searchParams.get("api_key"), null);
  assert.match(lookup.options.headers.Authorization, /^MediaBrowser .*Token="legacy-key"/);
  assert.equal(lookup.options.headers["X-Emby-Token"], undefined);
  assert.equal(lookup.options.headers["X-MediaBrowser-Token"], undefined);

  const result = await markJellyfinPlayed(config, {
    ...media,
    providerItemId: "jellyfin-item",
  });
  assert.equal(result.status, "fulfilled");
  const mutation = calls[1];
  assert.equal(mutation.url.searchParams.get("ApiKey"), null);
  assert.equal(mutation.url.searchParams.get("api_key"), null);
  assert.match(mutation.options.headers.Authorization, /Token="legacy-key"/);
  assert.equal(mutation.options.headers["X-Emby-Token"], undefined);
  assert.equal(mutation.options.headers["X-MediaBrowser-Token"], undefined);
});
