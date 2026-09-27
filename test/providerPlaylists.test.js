import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlaylistNotFound,
  providerPlaylistClient,
  reorderProviderPlaylist,
} from "../server/src/utils/providerPlaylists.js";
import { clearPlexServerIdentifierCache } from "../server/src/utils/plexPlaylists.js";

const plexConfig = { baseUrl: "http://plex.test", token: "plex-token" };
const embyConfig = { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" };
const jellyfinConfig = { baseUrl: "http://jellyfin.test", apiKey: "jelly-key", userId: "jelly-user" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    const call = { url, method, headers: options.headers || {}, body: options.body };
    calls.push(call);
    return handler(call);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return calls;
}

test("Plex playlist client creates, reads, adds, removes, renames, and deletes", async (t) => {
  clearPlexServerIdentifierCache();
  const calls = stubFetch(t, ({ url, method }) => {
    if (url.pathname === "/identity") return json({ MediaContainer: { machineIdentifier: "srv1" } });
    if (method === "POST" && url.pathname === "/playlists") return json({ MediaContainer: { Metadata: [{ ratingKey: "900", type: "playlist", title: "Mine" }] } });
    if (method === "GET" && url.pathname === "/playlists") return json({ MediaContainer: { Metadata: [{ ratingKey: "900", type: "playlist", title: "Mine", leafCount: 2 }, { ratingKey: "1", type: "photo" }] } });
    if (method === "GET" && url.pathname === "/playlists/900") return json({ MediaContainer: { Metadata: [{ ratingKey: "900", type: "playlist", title: "Mine" }] } });
    if (method === "GET" && url.pathname === "/playlists/404") return json({}, 404);
    if (method === "GET" && url.pathname === "/playlists/500") return json({}, 500);
    if (method === "GET" && url.pathname === "/playlists/900/items") {
      return json({ MediaContainer: { Metadata: [{ ratingKey: "11", playlistItemID: 101, type: "movie", title: "A" }, { ratingKey: "12", playlistItemID: 102, type: "episode", title: "B" }] } });
    }
    if (method === "DELETE" && url.pathname === "/playlists/gone") return json({}, 404);
    return new Response("", { status: 200 });
  });
  const plex = providerPlaylistClient("plex");

  assert.deepEqual(await plex.createPlaylist(plexConfig, { title: "Mine", itemIds: ["11"] }).then((r) => r.id), "900");
  const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/playlists");
  assert.equal(create.url.searchParams.get("uri"), "server://srv1/com.plexapp.plugins.library/library/metadata/11");
  assert.equal(create.url.searchParams.get("smart"), "0");
  assert.equal(create.headers["X-Plex-Token"], "plex-token");

  assert.deepEqual((await plex.fetchPlaylists(plexConfig)).map((p) => [p.id, p.title, p.itemCount]), [["900", "Mine", 2]]);
  assert.equal((await plex.fetchPlaylist(plexConfig, "900")).title, "Mine");
  assert.equal(await plex.fetchPlaylist(plexConfig, "404"), null);
  await assert.rejects(plex.fetchPlaylist(plexConfig, "500"), (error) => error.status === 500 && !isPlaylistNotFound(error));
  assert.deepEqual((await plex.fetchPlaylistItems(plexConfig, "900")).map((e) => [e.entryId, e.itemId, e.type]), [["101", "11", "movie"], ["102", "12", "episode"]]);

  await plex.addPlaylistItems(plexConfig, "900", ["12", "13"]);
  const add = calls.find((c) => c.method === "PUT" && c.url.pathname === "/playlists/900/items");
  assert.equal(add.url.searchParams.get("uri"), "server://srv1/com.plexapp.plugins.library/library/metadata/12,13");
  assert.equal((await plex.removePlaylistItems(plexConfig, "900", ["101", "102"])).removed, 2);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.pathname === "/playlists/900/items/102"));

  await plex.renamePlaylist(plexConfig, "900", "Renamed");
  const rename = calls.find((c) => c.method === "PUT" && c.url.pathname === "/playlists/900");
  assert.equal(rename.url.searchParams.get("title"), "Renamed");
  assert.equal((await plex.deletePlaylist(plexConfig, "900")).status, "fulfilled");
  assert.equal((await plex.deletePlaylist(plexConfig, "gone")).status, "not_found");
  // The identity lookup is cached across calls.
  assert.equal(calls.filter((c) => c.url.pathname === "/identity").length, 1);
});

test("a failed Plex items read throws instead of returning an empty playlist", async (t) => {
  stubFetch(t, () => json({}, 503));
  await assert.rejects(providerPlaylistClient("plex").fetchPlaylistItems(plexConfig, "900"), (error) => error.status === 503);
});

test("Emby playlist client uses Emby parameter spelling and the api_key query", async (t) => {
  const calls = stubFetch(t, ({ url, method }) => {
    if (method === "POST" && url.pathname === "/Playlists") return json({ Id: "pl1" });
    if (method === "GET" && url.pathname === "/Users/emby-user/Items") return json({ Items: [{ Id: "pl1", Name: "Mine", Type: "Playlist", ChildCount: 3 }, { Id: "x", Type: "Folder" }] });
    if (method === "GET" && url.pathname === "/Users/emby-user/Items/pl1") return json({ Id: "pl1", Name: "Mine", Type: "Playlist", Overview: "keep" });
    if (method === "GET" && url.pathname === "/Users/emby-user/Items/missing") return json({}, 404);
    if (method === "GET" && url.pathname === "/Playlists/pl1/Items") {
      return json({ Items: [{ Id: "m1", PlaylistItemId: "e1", Type: "Movie" }, { Id: "m2", PlaylistItemId: "e2", Type: "Episode" }], TotalRecordCount: 2 });
    }
    if (method === "POST" && url.pathname === "/Playlists/pl1/Items") return json({ ItemAddedCount: 2 });
    return new Response(null, { status: 204 });
  });
  const emby = providerPlaylistClient("emby");

  assert.equal((await emby.createPlaylist(embyConfig, { title: "Mine", itemIds: ["m1", "m1", "m2"] })).id, "pl1");
  const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/Playlists");
  assert.equal(create.url.searchParams.get("Ids"), "m1,m2");
  assert.equal(create.url.searchParams.get("UserId"), "emby-user");
  assert.equal(create.url.searchParams.get("MediaType"), "Video");
  assert.equal(create.url.searchParams.get("api_key"), "emby-key");
  assert.equal(create.headers["X-Emby-Token"], "emby-key");

  assert.deepEqual((await emby.fetchPlaylists(embyConfig)).map((p) => [p.id, p.title, p.itemCount]), [["pl1", "Mine", 3]]);
  assert.equal(await emby.fetchPlaylist(embyConfig, "missing"), null);
  assert.deepEqual((await emby.fetchPlaylistItems(embyConfig, "pl1")).map((e) => [e.entryId, e.itemId, e.type]), [["e1", "m1", "movie"], ["e2", "m2", "episode"]]);
  assert.equal((await emby.addPlaylistItems(embyConfig, "pl1", ["m3", "m4"])).added, 2);
  await emby.removePlaylistItems(embyConfig, "pl1", ["e1"]);
  assert.equal(calls.find((c) => c.method === "DELETE" && c.url.pathname === "/Playlists/pl1/Items").url.searchParams.get("EntryIds"), "e1");
  await emby.movePlaylistItem(embyConfig, "pl1", "e2", 0);
  assert.ok(calls.some((c) => c.method === "POST" && c.url.pathname === "/Playlists/pl1/Items/e2/Move/0"));

  await emby.renamePlaylist(embyConfig, "pl1", "Renamed");
  const rename = calls.find((c) => c.method === "POST" && c.url.pathname === "/Items/pl1");
  assert.deepEqual(JSON.parse(rename.body), { Id: "pl1", Name: "Renamed", Type: "Playlist", Overview: "keep" });
  await emby.deletePlaylist(embyConfig, "pl1");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.pathname === "/Items/pl1"));
});

test("Jellyfin playlist client authenticates by header and renames through the playlist endpoint", async (t) => {
  const calls = stubFetch(t, ({ url, method }) => {
    if (method === "POST" && url.pathname === "/Playlists") return json({ Id: "jp1" });
    if (method === "GET" && url.pathname === "/Users/jelly-user/Items/folder") return json({ Id: "folder", Type: "Folder" });
    if (method === "GET" && url.pathname === "/Playlists/jp1/Items") {
      // Two pages; the client must follow TotalRecordCount.
      const start = Number(url.searchParams.get("StartIndex"));
      const all = Array.from({ length: 3 }, (_, i) => ({ Id: `m${i}`, PlaylistItemId: `e${i}` }));
      return json({ Items: start === 0 ? all.slice(0, 2) : all.slice(2), TotalRecordCount: 3 });
    }
    return new Response(null, { status: 204 });
  });
  const jellyfin = providerPlaylistClient("jellyfin");

  await jellyfin.createPlaylist(jellyfinConfig, { title: "Mine", itemIds: ["m1"] });
  const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/Playlists");
  assert.equal(create.url.searchParams.get("ids"), "m1");
  assert.equal(create.url.searchParams.get("userId"), "jelly-user");
  assert.equal(create.url.searchParams.get("api_key"), null);
  assert.match(create.headers.Authorization, /Token="jelly-key"/);
  assert.equal(create.headers["X-Emby-Token"], undefined);

  // A non-playlist item is not a deletion signal; it throws.
  await assert.rejects(jellyfin.fetchPlaylist(jellyfinConfig, "folder"), (error) => !isPlaylistNotFound(error));

  calls.length = 0;
  assert.deepEqual((await jellyfin.fetchPlaylistItems(jellyfinConfig, "jp1")).map((e) => e.entryId), ["e0", "e1", "e2"]);
  assert.equal(calls.filter((c) => c.url.pathname === "/Playlists/jp1/Items").length, 2);

  await jellyfin.renamePlaylist(jellyfinConfig, "jp1", "Renamed");
  const rename = calls.find((c) => c.method === "POST" && c.url.pathname === "/Playlists/jp1");
  assert.deepEqual(JSON.parse(rename.body), { Name: "Renamed" });
});

test("reorder moves only out-of-place entries, using after-ids on Plex and indexes elsewhere", async (t) => {
  const calls = stubFetch(t, () => new Response("", { status: 200 }));

  const plex = await reorderProviderPlaylist("plex", plexConfig, "900", ["a", "b", "c", "d"], ["c", "a", "b", "d"]);
  assert.equal(plex.moves, 1);
  assert.deepEqual(plex.order, ["c", "a", "b", "d"]);
  const plexMove = calls.find((c) => c.url.pathname === "/playlists/900/items/c/move");
  assert.equal(plexMove.method, "PUT");
  assert.equal(plexMove.url.searchParams.get("after"), null);

  calls.length = 0;
  const plexTail = await reorderProviderPlaylist("plex", plexConfig, "900", ["a", "b", "c"], ["b", "c", "a"]);
  assert.deepEqual(plexTail.order, ["b", "c", "a"]);
  assert.deepEqual(calls.map((c) => [c.url.pathname, c.url.searchParams.get("after")]), [
    ["/playlists/900/items/a/move", "c"],
  ]);

  calls.length = 0;
  const rebuilt = await reorderProviderPlaylist("plex", plexConfig, "900", ["a", "c", "b"], ["a", "b", "c"], { rebuild: true });
  assert.deepEqual(rebuilt.order, ["a", "b", "c"]);
  assert.deepEqual(calls.map((c) => [c.url.pathname, c.url.searchParams.get("after")]), [
    ["/playlists/900/items/a/move", "b"],
    ["/playlists/900/items/b/move", "a"],
    ["/playlists/900/items/c/move", "b"],
  ]);

  calls.length = 0;
  const emby = await reorderProviderPlaylist("emby", embyConfig, "pl1", ["a", "b", "c"], ["c", "b", "a", "unknown"]);
  assert.deepEqual(emby.order, ["c", "b", "a"]);
  assert.deepEqual(calls.map((c) => c.url.pathname), ["/Playlists/pl1/Items/c/Move/0", "/Playlists/pl1/Items/b/Move/1"]);

  calls.length = 0;
  const unchanged = await reorderProviderPlaylist("jellyfin", jellyfinConfig, "jp1", ["a", "b"], ["a", "b"]);
  assert.equal(unchanged.moves, 0);
  assert.equal(calls.length, 0);
});

test("reorder reaches the wanted order for random orders with both move styles", async () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const shuffle = (values) => values.map((value) => [random(), value]).sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  for (const provider of ["plex", "emby"]) {
    for (let round = 0; round < 200; round += 1) {
      const ids = Array.from({ length: 1 + Math.floor(random() * 9) }, (_, index) => `e${index}`);
      const current = shuffle(ids);
      const desired = shuffle(ids).slice(0, Math.floor(random() * (ids.length + 1)));
      const app = [...current];
      const client = {
        provider,
        async movePlaylistItem(_config, _id, entryId, target) {
          app.splice(app.indexOf(entryId), 1);
          app.splice(provider === "plex" ? (target ? app.indexOf(target) + 1 : 0) : target, 0, entryId);
        },
      };
      for (const rebuild of [false, true]) {
        app.splice(0, app.length, ...current);
        const result = await reorderProviderPlaylist(client, {}, "p", current, desired, { rebuild });
        const expected = [...desired, ...current.filter((id) => !desired.includes(id))];
        assert.deepEqual(app, expected, `${provider} ${rebuild ? "rebuild" : "minimal"} ${current} -> ${desired}`);
        assert.deepEqual(result.order, expected);
      }
    }
  }
});

test("unknown providers are rejected", () => {
  assert.throws(() => providerPlaylistClient("trakt"), /Unsupported playlist provider/);
});
