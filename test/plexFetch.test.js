import test from "node:test";
import assert from "node:assert/strict";

import { fetchPlexWithRefresh, plexRequestHeaders } from "../server/src/utils/plexFetch.js";
import {
  __resetPlexIdentityCache,
  hydratePlexEpisodeMetadata,
  mergePlexMetadataItem,
} from "../server/src/utils/plexClient.js";
import { buildPlexMediaFromMetadata } from "../server/src/utils/parsers.js";

test("adaptive Plex state keeps full provider GUID metadata", () => {
  const merged = mergePlexMetadataItem(
    {
      ratingKey: "43671",
      title: "Super Troopers",
      guid: "plex://movie/canonical",
      Guid: [{ id: "imdb://tt0247745" }, { id: "tmdb://39939" }],
      viewCount: 0,
    },
    {
      ratingKey: "43671",
      title: "Super Troopers",
      viewCount: 1,
      lastViewedAt: 1787728716,
    },
  );

  assert.equal(merged.viewCount, 1);
  assert.equal(merged.lastViewedAt, 1787728716);
  assert.equal(merged.guid, "plex://movie/canonical");
  assert.deepEqual(merged.Guid, [{ id: "imdb://tt0247745" }, { id: "tmdb://39939" }]);
});

test("Plex episode notifications hydrate series ids from the native grandparent key", async () => {
  const originalFetch = globalThis.fetch;
  const config = { baseUrl: "https://plex.example.test", token: "token" };
  let seriesRequests = 0;
  __resetPlexIdentityCache();

  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.pathname, "/library/metadata/series-42");
    seriesRequests += 1;
    return new Response(JSON.stringify({
      MediaContainer: {
        Metadata: [{
          ratingKey: "series-42",
          type: "show",
          title: "Reacher",
          guid: "plex://show/reacher",
          Guid: [{ id: "tmdb://108978" }, { id: "tvdb://366924" }],
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const episode = {
    ratingKey: "episode-7",
    type: "episode",
    title: "Picture Says a Thousand Words",
    grandparentTitle: "Reacher",
    grandparentKey: "/library/metadata/series-42",
    parentIndex: 2,
    index: 3,
    guid: "plex://episode/episode-specific",
    Guid: [{ id: "tmdb://episode-specific" }],
    viewCount: 0,
  };

  try {
    const hydrated = await hydratePlexEpisodeMetadata(config, episode);
    const media = buildPlexMediaFromMetadata(hydrated);
    assert.equal(media.ids.tmdb, "108978");
    assert.equal(media.ids.tvdb, "366924");
    assert.equal(media.season, 2);
    assert.equal(media.episode, 3);

    await hydratePlexEpisodeMetadata(config, episode);
    assert.equal(seriesRequests, 1, "the same Plex series should be fetched once for repeated episode notifications");
  } finally {
    globalThis.fetch = originalFetch;
    __resetPlexIdentityCache();
  }
});

test("managed Plex headers bind JWT requests to the stable device", () => {
  assert.deepEqual(plexRequestHeaders({ token: "jwt", clientIdentifier: "device-1" }), {
    Accept: "application/json",
    "X-Plex-Token": "jwt",
    "X-Plex-Client-Identifier": "device-1",
  });
});

test("managed Plex requests force one refresh and retry once after HTTP 401", async () => {
  const calls = [];
  const config = { token: "old-jwt", clientIdentifier: "device-1", connectionId: "connection-1", authKind: "plex_jwt" };
  const response = await fetchPlexWithRefresh(config, "https://plex.example/library/sections", {}, undefined, {
    fetchImpl: async (_url, options) => {
      calls.push(options.headers);
      return { status: calls.length === 1 ? 401 : 200 };
    },
    refreshToken: async (options) => {
      assert.deepEqual(options, { force: true });
      return "fresh-jwt";
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]["X-Plex-Token"], "old-jwt");
  assert.equal(calls[1]["X-Plex-Token"], "fresh-jwt");
  assert.equal(calls[1]["X-Plex-Client-Identifier"], "device-1");
  assert.equal(config.token, "fresh-jwt");
});
