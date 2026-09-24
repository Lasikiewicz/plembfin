import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchJellyfinEpisodes,
  fetchJellyfinLibraryItems,
  fetchJellyfinNextUpItems,
  fetchJellyfinPersonalRatingSnapshot,
  fetchJellyfinResumableItems,
  fetchJellyfinWatchedItems,
  findJellyfinItems,
} from "../server/src/utils/jellyfinClient.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const config = {
  baseUrl: "https://jellyfin.example.test",
  apiKey: "api-key",
  userId: "jellyfin-user",
};

const expectedFields = new Set(["ProviderIds", "MediaSources", "MediaStreams", "Width", "Height"]);

function assertSupportedFields(url) {
  const fields = String(url.searchParams.get("Fields") || "")
    .split(",")
    .filter(Boolean);
  assert.ok(fields.length > 0);
  for (const field of fields) {
    assert.equal(expectedFields.has(field), true, `unsupported Jellyfin ItemFields token: ${field}`);
  }
}

test("Jellyfin inventory feeds request supported fields and preserve UserData", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return jsonResponse({
      Items: [{
        Id: "jellyfin-item",
        Type: "Movie",
        Name: "Example",
        ProviderIds: { Tmdb: "123" },
        UserData: { Played: true, Rating: 8, PlaybackPositionTicks: 10 },
      }],
      TotalRecordCount: 1,
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const watched = await fetchJellyfinWatchedItems(config);
  await fetchJellyfinLibraryItems(config, { limit: 1 });
  await fetchJellyfinResumableItems(config, { limit: 1 });
  await fetchJellyfinNextUpItems(config, { limit: 1 });
  await fetchJellyfinPersonalRatingSnapshot(config);
  await fetchJellyfinEpisodes(config, "parent-1");

  assert.equal(watched[0].UserData.Played, true);
  assert.equal(calls.length, 6);
  for (const url of calls) {
    assertSupportedFields(url);
    assert.equal(url.searchParams.get("EnableUserData"), "true");
  }
});

test("Jellyfin resume feed reads the Resume endpoint, which lists a merged episode's non-primary version", async (t) => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    // Jellyfin 12.0: Items?Filters=IsResumable omits the 720p version of a
    // two-version episode; /Items/Resume lists it.
    if (url.pathname.endsWith("/Items/Resume")) {
      return jsonResponse({ Items: [{ Id: "version-720p", Type: "Episode", UserData: { PlaybackPositionTicks: 3e9 } }], TotalRecordCount: 1 });
    }
    return jsonResponse({ Items: [], TotalRecordCount: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const items = await fetchJellyfinResumableItems(config, { limit: 0 });
  assert.deepEqual(items.map((item) => item.Id), ["version-720p"]);
  assert.deepEqual(paths, ["/Users/jellyfin-user/Items/Resume"]);
});

test("Jellyfin resume feed falls back to the IsResumable query when the Resume route is missing", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/Items/Resume")) return jsonResponse({}, 404);
    if (url.searchParams.get("Filters") === "IsResumable") {
      return jsonResponse({ Items: [{ Id: "legacy-resume", Type: "Movie" }], TotalRecordCount: 1 });
    }
    return jsonResponse({ Items: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const items = await fetchJellyfinResumableItems(config, { limit: 0 });
  assert.deepEqual(items.map((item) => item.Id), ["legacy-resume"]);

  globalThis.fetch = async () => jsonResponse({}, 401);
  await assert.rejects(fetchJellyfinResumableItems(config, { limit: 0 }), (error) => error.status === 401);
});

test("Jellyfin provider lookups do not send UserData as an ItemField", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  globalThis.fetch = async (input) => {
    requestUrl = new URL(String(input));
    return jsonResponse({
      Items: [{ Id: "movie-1", ProviderIds: { Tmdb: "123" } }],
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const items = await findJellyfinItems(config, {
    type: "movie",
    title: "Example",
    ids: { tmdb: "123" },
  });

  assert.deepEqual(items.map((item) => item.Id), ["movie-1"]);
  assert.equal(requestUrl.searchParams.get("Fields"), "ProviderIds");
  assert.equal(requestUrl.searchParams.get("EnableUserData"), null);
});
