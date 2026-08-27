import test from "node:test";
import assert from "node:assert/strict";

import { fetchPlexWithRefresh, plexRequestHeaders } from "../server/src/utils/plexFetch.js";
import { mergePlexMetadataItem } from "../server/src/utils/plexClient.js";

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
