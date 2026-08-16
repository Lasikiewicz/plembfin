import test from "node:test";
import assert from "node:assert/strict";

import { fetchPlexWithRefresh, plexRequestHeaders } from "../server/src/utils/plexFetch.js";

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
