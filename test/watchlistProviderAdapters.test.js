import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-watchlist-adapters-");

const emby = await import("../server/src/utils/embyWatchlistClient.js");
const jellyfin = await import("../server/src/utils/jellyfinWatchlistClient.js");
const plex = await import("../server/src/utils/plexWatchlistClient.js");

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Emby adapter uses the token header and normalizes a dedicated playlist snapshot", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/Playlists/playlist-1/Items")) {
      return jsonResponse({ Items: [{ Id: "emby-501", Type: "Movie", Name: "Example Film", ProviderIds: { Tmdb: "501" }, ProductionYear: 2025, PlaylistItemId: "entry-501" }] });
    }
    return jsonResponse({ Items: [{ Id: "playlist-1", Name: emby.EMBY_WATCHLIST_NAME }] });
  };
  const snapshot = await emby.fetchEmbyWatchlistSnapshot({ baseUrl: "https://emby.example", apiKey: "secret", userId: "user-1", representation: "playlist" });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.items[0].media_key, "movie:tmdb:501");
  assert.equal(snapshot.items[0].playlist_entry_id, "entry-501");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers["X-Emby-Token"], "secret");
  assert.equal(calls.every((call) => !call.url.includes("secret")), true);
});

test("Jellyfin adapter exposes full playlist and favorites capabilities without putting credentials in URLs", async () => {
  assert.equal(jellyfin.capabilities({ baseUrl: "https://jellyfin.example", apiKey: "secret", userId: "user-2", representation: "favorites" }).capability, "full");
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ Items: [] });
  };
  await jellyfin.listJellyfinPlaylists({ baseUrl: "https://jellyfin.example", apiKey: "secret", userId: "user-2" });
  assert.equal(calls[0].options.headers["X-Emby-Token"], "secret");
  assert.equal(calls[0].options.headers["X-MediaBrowser-Token"], "secret");
  assert.equal(calls[0].url.includes("secret"), false);
});

test("Plex adapter keeps RSS read-only and parses native account watchlist ids", async () => {
  const rss = plex.capabilities({ accountToken: "account-secret", representation: "rss" });
  assert.equal(rss.capability, "read_only");
  assert.equal(rss.add, false);
  const native = plex.capabilities({ accountToken: "account-secret", representation: "native", writeEnabled: true });
  assert.equal(native.capability, "full");

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ MediaContainer: { Metadata: [{ type: "movie", ratingKey: "plex-501", title: "Example Film", guid: "tmdb://501", year: 2025 }] } });
  };
  const snapshot = await plex.fetchPlexWatchlistSnapshot({ baseUrl: "https://plex.example", accountToken: "account-secret", representation: "native" });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.items[0].media_key, "movie:tmdb:501");
  assert.equal(calls[0].options.headers["X-Plex-Token"], "account-secret");
  assert.equal(new URL(calls[0].url).hostname, "discover.provider.plex.tv");
  assert.equal(calls[0].url.includes("account-secret"), false);
});
