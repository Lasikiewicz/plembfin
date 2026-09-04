import test from "node:test";
import assert from "node:assert/strict";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Plex Continue Watching uses the native hub membership feed", async () => {
  const { fetchPlexContinueWatchingItems } = await import("../server/src/utils/plexClient.js");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    calls.push(requestUrl);
    assert.equal(requestUrl.pathname, "/hubs/continueWatching");
    return jsonResponse({
      MediaContainer: {
        Hub: [{
          title: "Continue Watching",
          Metadata: [
            {
              type: "episode",
              ratingKey: "plex-episode-1",
              title: "Richmond's Got Talent",
              grandparentTitle: "Ted Lasso",
              parentIndex: 4,
              index: 3,
              duration: 2_700_000,
              lastViewedAt: 1_788_442_732,
              // The local Plex hub omits viewOffset. Membership is still valid.
            },
            {
              type: "movie",
              ratingKey: "plex-movie-1",
              title: "Example Film",
              lastViewedAt: 1_788_442_700,
            },
          ],
        }],
      },
    });
  };

  try {
    const items = await fetchPlexContinueWatchingItems({
      baseUrl: "https://plex.example.test",
      token: "token",
    });
    assert.deepEqual(items.map((item) => item.ratingKey), ["plex-episode-1", "plex-movie-1"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get("includeUserState"), "1");
    assert.equal(calls[0].searchParams.get("includeMeta"), "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Emby Continue Watching uses the dedicated Resume endpoint", async () => {
  const { fetchEmbyResumableItems } = await import("../server/src/utils/embyClient.js");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    calls.push(requestUrl);
    assert.equal(requestUrl.pathname, "/Users/emby-user/Items/Resume");
    return jsonResponse({
      Items: [
        {
          Id: "emby-episode-1",
          Type: "Episode",
          Name: "Richmond’s Got Talent",
          SeriesName: "Ted Lasso",
          ParentIndexNumber: 4,
          IndexNumber: 3,
          UserData: { Played: false, PlaybackPositionTicks: 0 },
        },
        {
          Id: "emby-episode-2",
          Type: "Episode",
          Name: "Other Lives",
          SeriesName: "SEAL Team",
          ParentIndexNumber: 1,
          IndexNumber: 2,
          UserData: { Played: false, PlaybackPositionTicks: 0 },
        },
      ],
      TotalRecordCount: 2,
    });
  };

  try {
    const items = await fetchEmbyResumableItems({
      baseUrl: "https://emby.example.test",
      apiKey: "api-key",
      userId: "emby-user",
    });
    assert.deepEqual(items.map((item) => item.Id), ["emby-episode-1", "emby-episode-2"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get("MediaTypes"), "Video");
    assert.equal(calls[0].searchParams.get("EnableTotalRecordCount"), "true");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Emby and Jellyfin availability inventories paginate the complete unplayed feed", async () => {
  const { fetchEmbyLibraryItems } = await import("../server/src/utils/embyClient.js");
  const { fetchJellyfinLibraryItems } = await import("../server/src/utils/jellyfinClient.js");
  const originalFetch = globalThis.fetch;

  try {
    for (const [provider, fetchItems, config] of [
      ["emby", fetchEmbyLibraryItems, { baseUrl: "https://emby.example.test", apiKey: "api-key", userId: "emby-user" }],
      ["jellyfin", fetchJellyfinLibraryItems, { baseUrl: "https://jellyfin.example.test", apiKey: "api-key", userId: "jellyfin-user" }],
    ]) {
      const calls = [];
      globalThis.fetch = async (url) => {
        const requestUrl = new URL(String(url));
        calls.push(requestUrl);
        assert.equal(requestUrl.searchParams.get("Filters"), "IsUnplayed");
        assert.equal(requestUrl.searchParams.get("IncludeItemTypes"), "Movie,Episode");
        assert.equal(requestUrl.searchParams.get("Limit"), "500");
        const start = Number(requestUrl.searchParams.get("StartIndex"));
        const items = start === 0
          ? [{ Id: `${provider}-1`, Type: "Episode", UserData: { Played: false } }, { Id: `${provider}-2`, Type: "Movie", UserData: { Played: false } }]
          : [{ Id: `${provider}-3`, Type: "Episode", UserData: { Played: false } }];
        return jsonResponse({ Items: items, TotalRecordCount: 3 });
      };

      const items = await fetchItems(config, { limit: 0 });
      assert.deepEqual(items.map((item) => item.Id), [`${provider}-1`, `${provider}-2`, `${provider}-3`]);
      assert.deepEqual(calls.map((url) => url.searchParams.get("StartIndex")), ["0", "2"]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
