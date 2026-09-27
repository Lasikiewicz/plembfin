import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";
import { fakeProvider, statusError } from "./playlistFakes.js";

makeTempDataDir("plembfin-playlist-pull-");

const { db } = await import("../server/src/db.js");
const {
  confirmHeldPlaylistChange,
  discardHeldPlaylistChange,
  syncAllPlaylists,
  syncPlaylist,
} = await import("../server/src/utils/playlistPullEngine.js");

const config = {
  plex: { baseUrl: "http://plex.test", token: "t" },
  emby: { baseUrl: "http://emby.test", apiKey: "k", userId: "u" },
  jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "k", userId: "u" },
};

// library[provider][media_key]: an id, "" (not in the library), or an Error.
// identities[itemId]: what the app says an entry is (identifyEntry), or an Error.
function setup({ library = {}, identities = {} } = {}) {
  const fakes = { plex: fakeProvider("plex"), emby: fakeProvider("emby"), jellyfin: fakeProvider("jellyfin") };
  const answer = (value) => {
    if (value instanceof Error) throw value;
    return value;
  };
  const deps = {
    client: (provider) => fakes[provider].client,
    resolveItemId: async (provider, _config, row) => answer(library[provider]?.[row.media_key] ?? ""),
    identifyEntry: async (_provider, _config, entry) => answer(identities[entry.itemId] ?? null),
  };
  const sync = (listId, options = {}) => syncPlaylist(listId, { config, deps, ...options });
  const scheduled = (listId) => sync(listId, { countNotFound: true });
  return { fakes, deps, sync, scheduled };
}

let listCounter = 0;
function createList({ name = `Pull list ${++listCounter}`, items = [], targets = [] } = {}) {
  const id = `pull-${listCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
  items.forEach(({ key, type = "movie", tmdb = null }, position) => {
    // Episode keys end in sNeM; the schema requires the coordinates.
    const [, season = null, episode = null] = type === "episode" ? key.match(/s(\d+)e(\d+)$/).map(Number) : [];
    db.prepare(`
      INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, season, episode, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, key, type, key, tmdb, season, episode, position, now, now);
  });
  for (const provider of targets) {
    db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, provider, now, now);
  }
  return id;
}

const keys = (listId) => db.prepare("SELECT media_key FROM personal_list_items WHERE list_id = ? ORDER BY position").all(listId).map((row) => row.media_key);
const list = (listId) => db.prepare("SELECT * FROM personal_lists WHERE id = ?").get(listId);
const target = (listId, provider) => db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ? AND provider = ?").get(listId, provider);
const remoteId = (listId, provider) => target(listId, provider).remote_playlist_id;
const holds = (listId) => db.prepare("SELECT provider, kind, change_count FROM personal_list_held_changes WHERE list_id = ?").all(listId)
  .map((row) => ({ ...row }));
const pullOf = (result, provider) => result.pull.find((row) => row.provider === provider);

test("an app-added movie is imported in place, pushed to the other app, and not re-imported", async () => {
  const listId = createList({ items: [{ key: "movie:a", tmdb: "1" }, { key: "movie:b", tmdb: "2" }], targets: ["plex", "jellyfin"] });
  const { fakes, sync } = setup({
    library: {
      plex: { "movie:a": "PA", "movie:b": "PB", "movie:tmdb:3": "PC" },
      jellyfin: { "movie:a": "JA", "movie:b": "JB", "movie:tmdb:3": "JC" },
    },
    identities: { PC: { media_type: "movie", title: "C", tmdb_id: "3", tvdb_id: "", imdb_id: "" } },
  });
  await sync(listId);
  const plexId = remoteId(listId, "plex");
  fakes.plex.state.playlists.get(plexId).entries.splice(1, 0, { entryId: "app-1", itemId: "PC" });

  const result = await sync(listId);
  assert.equal(pullOf(result, "plex").added, 1);
  assert.deepEqual(keys(listId), ["movie:a", "movie:tmdb:3", "movie:b"]);
  assert.deepEqual(fakes.plex.items(plexId), ["PA", "PC", "PB"]);
  assert.deepEqual(fakes.jellyfin.items(remoteId(listId, "jellyfin")), ["JA", "JC", "JB"]);

  const plexCalls = fakes.plex.state.calls.length;
  const jellyfinCalls = fakes.jellyfin.state.calls.length;
  const again = await sync(listId);
  assert.equal(pullOf(again, "plex").added + pullOf(again, "jellyfin").added, 0);
  assert.deepEqual(keys(listId), ["movie:a", "movie:tmdb:3", "movie:b"]);
  const reads = ["fetchPlaylist", "fetchPlaylistItems", "fetchPlaylist", "fetchPlaylistItems"];
  assert.deepEqual(fakes.plex.state.calls.slice(plexCalls).map(([name]) => name), reads);
  assert.deepEqual(fakes.jellyfin.state.calls.slice(jellyfinCalls).map(([name]) => name), reads);
});

test("an app-added episode becomes an episode item keyed by its show", async () => {
  const listId = createList({ items: [{ key: "movie:a", tmdb: "1" }], targets: ["emby"] });
  const { fakes, sync } = setup({
    library: { emby: { "movie:a": "A", "episode:tmdb:77:s2e3": "EP" } },
    identities: { EP: { media_type: "episode", title: "Pilot", show_title: "Show", season: 2, episode: 3, show_tmdb_id: "77", show_tvdb_id: "", show_imdb_id: "" } },
  });
  await sync(listId);
  fakes.emby.appAdd(remoteId(listId, "emby"), "EP");
  await sync(listId);
  const row = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? AND media_key = 'episode:tmdb:77:s2e3'").get(listId);
  assert.equal(row.media_type, "episode");
  assert.equal(row.tmdb_id, "77");
  assert.deepEqual([row.show_title, row.season, row.episode], ["Show", 2, 3]);
  assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), ["A", "EP"]);
});

test("an unidentifiable app entry is left alone and never removed", async () => {
  const listId = createList({ items: [{ key: "movie:a", tmdb: "1" }], targets: ["emby"] });
  const { fakes, sync } = setup({ library: { emby: { "movie:a": "A" } }, identities: { TRAILER: null, FLAKY: new Error("timeout") } });
  await sync(listId);
  fakes.emby.appAdd(remoteId(listId, "emby"), "TRAILER");
  fakes.emby.appAdd(remoteId(listId, "emby"), "FLAKY");
  const result = await sync(listId);
  assert.equal(pullOf(result, "emby").unidentified, 2);
  assert.deepEqual(keys(listId), ["movie:a"]);
  assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), ["A", "TRAILER", "FLAKY"]);
});

test("an app removal is imported only after two reads, then removed from the other app", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["plex", "emby"] });
  const { fakes, sync } = setup({
    library: { plex: { "movie:a": "PA", "movie:b": "PB", "movie:c": "PC" }, emby: { "movie:a": "EA", "movie:b": "EB", "movie:c": "EC" } },
  });
  await sync(listId);
  fakes.plex.appRemove(remoteId(listId, "plex"), "PB");

  const first = await sync(listId);
  assert.equal(pullOf(first, "plex").pendingRemovals, 1);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c"]);
  assert.deepEqual(fakes.plex.items(remoteId(listId, "plex")), ["PA", "PC"]);

  const second = await sync(listId);
  assert.equal(pullOf(second, "plex").removed, 1);
  assert.deepEqual(keys(listId), ["movie:a", "movie:c"]);
  assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), ["EA", "EC"]);
});

test("renumbered app entry ids are relinked by library item, never read as removals, additions, or a reorder", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["plex", "emby"] });
  const { fakes, sync, scheduled } = setup({
    library: { plex: { "movie:a": "PA", "movie:b": "PB", "movie:c": "PC" }, emby: { "movie:a": "EA", "movie:b": "EB", "movie:c": "EC" } },
    identities: { EA: { media_type: "movie", title: "a" }, EB: { media_type: "movie", title: "b" }, EC: { media_type: "movie", title: "c" } },
  });
  await sync(listId);
  const embyId = remoteId(listId, "emby");
  const before = fakes.emby.state.playlists.get(embyId).entries.map((entry) => entry.entryId);
  fakes.emby.renumber(embyId);
  assert.notDeepEqual(fakes.emby.state.playlists.get(embyId).entries.map((entry) => entry.entryId), before);

  for (const pass of [await sync(listId), await scheduled(listId), await scheduled(listId)]) {
    const emby = pullOf(pass, "emby");
    assert.equal(emby.removed, 0);
    assert.equal(emby.added, 0);
    assert.equal(emby.pendingRemovals, 0);
    assert.equal(emby.reordered, false);
  }
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c"]);
  assert.deepEqual(fakes.emby.items(embyId), ["EA", "EB", "EC"]);
  assert.deepEqual(fakes.plex.items(remoteId(listId, "plex")), ["PA", "PB", "PC"]);
  const ledger = db.prepare("SELECT remote_entry_id, provider_item_id FROM personal_list_entry_ledger WHERE list_id = ? AND provider = 'emby'").all(listId);
  const live = new Map(fakes.emby.state.playlists.get(embyId).entries.map((entry) => [entry.entryId, entry.itemId]));
  assert.equal(ledger.length, 3);
  for (const row of ledger) assert.equal(live.get(row.remote_entry_id), row.provider_item_id);
});

test("an app removal that renumbers the remaining entries is still imported after two reads", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }, { key: "movie:d" }], targets: ["emby"] });
  const { fakes, sync } = setup({
    library: { emby: { "movie:a": "EA", "movie:b": "EB", "movie:c": "EC", "movie:d": "ED" } },
  });
  await sync(listId);
  const embyId = remoteId(listId, "emby");
  fakes.emby.appRemove(embyId, "EA");
  fakes.emby.renumber(embyId);

  const first = await sync(listId);
  assert.equal(pullOf(first, "emby").pendingRemovals, 1);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c", "movie:d"]);
  const second = await sync(listId);
  assert.equal(pullOf(second, "emby").removed, 1);
  assert.equal(pullOf(second, "emby").reordered, false);
  assert.deepEqual(keys(listId), ["movie:b", "movie:c", "movie:d"]);
  assert.deepEqual(fakes.emby.items(embyId), ["EB", "EC", "ED"]);
});

test("an entry that vanished because the media left the library keeps the Plembfin item", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["emby"] });
  const library = { emby: { "movie:a": "A", "movie:b": "B", "movie:c": "C" } };
  const { fakes, sync } = setup({ library });
  await sync(listId);
  fakes.emby.appRemove(remoteId(listId, "emby"), "B");
  library.emby["movie:b"] = "";
  await sync(listId);
  const result = await sync(listId);
  assert.equal(pullOf(result, "emby").leftLibrary, 1);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c"]);
  assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), ["A", "C"]);
  const availability = db.prepare("SELECT status FROM personal_list_item_availability WHERE list_id = ? AND media_key = 'movie:b' AND provider = 'emby'").get(listId);
  assert.equal(availability.status, "missing");

  // Back in the library under a new id: the push adds it again.
  library.emby["movie:b"] = "B2";
  await sync(listId);
  assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), ["A", "B2", "C"]);
});

test("a library lookup that fails keeps the removal undecided", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["emby"] });
  const library = { emby: { "movie:a": "A", "movie:b": "B", "movie:c": "C" } };
  const { fakes, sync } = setup({ library });
  await sync(listId);
  fakes.emby.appRemove(remoteId(listId, "emby"), "B");
  await sync(listId);
  library.emby["movie:b"] = new Error("Emby lookup timed out");
  const result = await sync(listId);
  assert.equal(pullOf(result, "emby").undecided, 1);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c"]);
  library.emby["movie:b"] = "B";
  assert.equal(pullOf(await sync(listId), "emby").removed, 1);
  assert.deepEqual(keys(listId), ["movie:a", "movie:c"]);
});

test("an episode removed in the app is an ordinary removal, and a re-add imports it again", async () => {
  const listId = createList({
    items: [{ key: "episode:tmdb:9:s1e1", type: "episode" }, { key: "episode:tmdb:9:s1e2", type: "episode" }],
    targets: ["plex"],
  });
  const { fakes, sync } = setup({
    library: { plex: { "episode:tmdb:9:s1e1": "E1", "episode:tmdb:9:s1e2": "E2" } },
    identities: { E1: { media_type: "episode", title: "One", show_title: "Show", season: 1, episode: 1, show_tmdb_id: "9" } },
  });
  await sync(listId);
  const playlistId = remoteId(listId, "plex");
  assert.deepEqual(fakes.plex.items(playlistId), ["E1", "E2"]);

  fakes.plex.appRemove(playlistId, "E1");
  await sync(listId);
  assert.equal(pullOf(await sync(listId), "plex").removed, 1);
  assert.deepEqual(keys(listId), ["episode:tmdb:9:s1e2"]);

  fakes.plex.appAdd(playlistId, "E1");
  assert.equal(pullOf(await sync(listId), "plex").added, 1);
  assert.deepEqual(keys(listId), ["episode:tmdb:9:s1e2", "episode:tmdb:9:s1e1"]);
});

test("an app-side add of the wrong type imports anyway; an untyped playlist takes its first item's type", async () => {
  const movies = createList({ items: [{ key: "movie:a", tmdb: "1" }], targets: ["emby"] });
  db.prepare("UPDATE personal_lists SET kind = 'movie' WHERE id = ?").run(movies);
  const untyped = createList({ targets: ["jellyfin"] });
  const episode = { media_type: "episode", title: "Pilot", show_title: "Show", season: 1, episode: 1, show_tmdb_id: "5" };
  const { fakes, sync } = setup({
    library: { emby: { "movie:a": "A", "episode:tmdb:5:s1e1": "EP" }, jellyfin: { "episode:tmdb:5:s1e1": "JEP" } },
    identities: { EP: episode, JEP: episode },
  });
  await sync(movies);
  fakes.emby.appAdd(remoteId(movies, "emby"), "EP");
  assert.equal(pullOf(await sync(movies), "emby").added, 1);
  assert.deepEqual(keys(movies), ["movie:a", "episode:tmdb:5:s1e1"]);
  assert.equal(list(movies).kind, "movie");

  // An empty playlist has no app copy; put one there as the app would hold it.
  db.prepare("UPDATE personal_list_targets SET remote_playlist_id = 'jf-p', remote_name = ? WHERE list_id = ?").run(list(untyped).name, untyped);
  fakes.jellyfin.state.playlists.set("jf-p", { title: list(untyped).name, entries: [{ entryId: "jf-e1", itemId: "JEP" }] });
  await sync(untyped);
  assert.deepEqual(keys(untyped), ["episode:tmdb:5:s1e1"]);
  assert.equal(list(untyped).kind, "tv");
});

test("a playlist still holding a show item is not synced until it becomes episodes", async () => {
  const listId = createList({ items: [{ key: "tv:show", type: "tv", tmdb: "9" }], targets: ["plex"] });
  const { fakes, sync } = setup();
  const result = await sync(listId);
  assert.deepEqual(result.pull, []);
  assert.deepEqual(result.push, []);
  assert.deepEqual(fakes.plex.state.calls, []);
});

test("a short read never drives a removal; an emptied playlist of 3+ entries is held after two reads", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }, { key: "movie:d" }], targets: ["emby"] });
  const { fakes, sync } = setup({ library: { emby: { "movie:a": "A", "movie:b": "B", "movie:c": "C", "movie:d": "D" } } });
  await sync(listId);
  const client = fakes.emby.client;
  const fullRead = client.fetchPlaylistItems;
  // The pull's read is the first items read of each sync; the push reads again.
  const readsWith = (shape) => {
    let calls = 0;
    client.fetchPlaylistItems = async (...args) => {
      calls += 1;
      const entries = await fullRead(...args);
      return calls === 1 ? shape(entries) : entries;
    };
  };
  readsWith((entries) => entries.slice(0, 1));
  await sync(listId);
  readsWith((entries) => entries);
  await sync(listId);
  readsWith((entries) => entries.slice(0, 1));
  await sync(listId);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c", "movie:d"]);

  // A one-off empty read: the push's re-read finds the entries, so nothing counts.
  readsWith(() => []);
  const empty = await sync(listId);
  assert.equal(pullOf(empty, "emby").emptyRead, true);
  readsWith(() => []);
  await sync(listId);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c", "movie:d"]);
  assert.deepEqual(holds(listId), []);

  // Really emptied in the app.
  client.fetchPlaylistItems = fullRead;
  fakes.emby.state.playlists.get(remoteId(listId, "emby")).entries = [];
  const first = await sync(listId);
  assert.equal(pullOf(first, "emby").pendingRemovals, 4);
  const second = await sync(listId);
  assert.equal(pullOf(second, "emby").status, "held");
  assert.equal(pullOf(second, "emby").held, 4);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c", "movie:d"]);
  assert.deepEqual(holds(listId), [{ provider: "emby", kind: "removals", change_count: 4 }]);
});

test("an emptied playlist of fewer than 3 entries imports as removals after two reads", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }], targets: ["plex", "emby"] });
  const { fakes, sync } = setup({ library: { plex: { "movie:a": "PA", "movie:b": "PB" }, emby: { "movie:a": "EA", "movie:b": "EB" } } });
  await sync(listId);
  fakes.plex.state.playlists.get(remoteId(listId, "plex")).entries = [];
  const first = await sync(listId);
  assert.equal(pullOf(first, "plex").removed, 0);
  assert.deepEqual(keys(listId), ["movie:a", "movie:b"]);
  const second = await sync(listId);
  assert.equal(pullOf(second, "plex").removed, 2);
  assert.deepEqual(keys(listId), []);
  assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), []);
});

test("a failed playlist read skips the app and changes nothing", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby"] });
  const { fakes, scheduled } = setup({ library: { emby: { "movie:a": "A" } } });
  await scheduled(listId);
  fakes.emby.client.fetchPlaylist = async () => { throw statusError(500); };
  const result = await scheduled(listId);
  assert.equal(pullOf(result, "emby").status, "error");
  assert.equal(target(listId, "emby").not_found_passes, 0);
  assert.deepEqual(keys(listId), ["movie:a"]);
});

test("an app deletion needs two scheduled not-found passes, then deletes everywhere", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["plex", "emby"] });
  const { fakes, sync, scheduled } = setup({ library: { plex: { "movie:a": "PA" }, emby: { "movie:a": "EA" } } });
  await sync(listId);
  const embyPlaylist = remoteId(listId, "emby");
  fakes.plex.state.playlists.delete(remoteId(listId, "plex"));

  await sync(listId);
  assert.equal(target(listId, "plex").not_found_passes, 0);
  const first = await scheduled(listId);
  assert.equal(pullOf(first, "plex").status, "not_found");
  assert.equal(list(listId).deleted_at, null);
  assert.equal(fakes.emby.state.playlists.has(embyPlaylist), true);

  const second = await scheduled(listId);
  assert.equal(pullOf(second, "plex").status, "deleted_in_app");
  assert.ok(list(listId).deleted_at);
  assert.equal(list(listId).deleted_origin, "plex");
  assert.equal(fakes.emby.state.playlists.has(embyPlaylist), false);
  // Targets stay for a restore.
  assert.equal(target(listId, "emby").remote_playlist_id, null);
  assert.ok(target(listId, "plex"));
});

test("a playlist that reappears resets the not-found count", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["jellyfin"] });
  const { fakes, scheduled } = setup({ library: { jellyfin: { "movie:a": "A" } } });
  await scheduled(listId);
  const playlistId = remoteId(listId, "jellyfin");
  const saved = fakes.jellyfin.state.playlists.get(playlistId);
  fakes.jellyfin.state.playlists.delete(playlistId);
  await scheduled(listId);
  fakes.jellyfin.state.playlists.set(playlistId, saved);
  await scheduled(listId);
  assert.equal(target(listId, "jellyfin").not_found_passes, 0);
  fakes.jellyfin.state.playlists.delete(playlistId);
  await scheduled(listId);
  assert.equal(list(listId).deleted_at, null);
});

test("deletions seen on several playlists of one app are held until confirmed or discarded", async () => {
  const first = createList({ items: [{ key: "movie:a" }], targets: ["plex"] });
  const second = createList({ items: [{ key: "movie:a" }], targets: ["plex"] });
  const { fakes, scheduled } = setup({ library: { plex: { "movie:a": "PA" } } });
  await scheduled(first);
  await scheduled(second);
  fakes.plex.state.playlists.clear();
  await scheduled(first);
  await scheduled(second);
  assert.equal(pullOf(await scheduled(first), "plex").status, "held");
  assert.equal(pullOf(await scheduled(second), "plex").status, "held");
  assert.equal(list(first).deleted_at, null);
  assert.deepEqual(holds(first), [{ provider: "plex", kind: "delete", change_count: 1 }]);

  await confirmHeldPlaylistChange(first, "plex", "delete", { config, deps: setupDeps(fakes) });
  assert.ok(list(first).deleted_at);

  const oldId = remoteId(second, "plex");
  await discardHeldPlaylistChange(second, "plex", "delete", { config, deps: setupDeps(fakes) });
  assert.equal(list(second).deleted_at, null);
  assert.notEqual(remoteId(second, "plex"), oldId);
  assert.deepEqual(fakes.plex.items(remoteId(second, "plex")), ["PA"]);
  assert.deepEqual(holds(second), []);
});

function setupDeps(fakes, library = { plex: { "movie:a": "PA" } }) {
  return {
    client: (provider) => fakes[provider].client,
    resolveItemId: async (provider, _config, row) => library[provider]?.[row.media_key] ?? "",
    seriesEpisodes: async () => [],
    identifyEntry: async () => null,
  };
}

test("many removals in one pass are held; the push does not re-add them; confirm applies, discard restores", async () => {
  const items = [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }, { key: "movie:d" }];
  const library = { emby: { "movie:a": "A", "movie:b": "B", "movie:c": "C", "movie:d": "D" } };
  const confirmList = createList({ items, targets: ["emby"] });
  const discardList = createList({ items, targets: ["emby"] });
  const { fakes, deps, sync } = setup({ library });
  for (const listId of [confirmList, discardList]) {
    await sync(listId);
    for (const itemId of ["A", "B", "C"]) fakes.emby.appRemove(remoteId(listId, "emby"), itemId);
    await sync(listId);
    const held = await sync(listId);
    assert.equal(pullOf(held, "emby").status, "held");
    assert.equal(pullOf(held, "emby").held, 3);
    assert.deepEqual(keys(listId), ["movie:a", "movie:b", "movie:c", "movie:d"]);
    assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), ["D"]);
  }

  await confirmHeldPlaylistChange(confirmList, "emby", "removals", { config, deps });
  assert.deepEqual(keys(confirmList), ["movie:d"]);
  assert.deepEqual(holds(confirmList), []);

  await discardHeldPlaylistChange(discardList, "emby", "removals", { config, deps });
  assert.deepEqual(keys(discardList), ["movie:a", "movie:b", "movie:c", "movie:d"]);
  assert.deepEqual(fakes.emby.items(remoteId(discardList, "emby")), ["A", "B", "C", "D"]);
  assert.deepEqual(holds(discardList), []);
});

test("an app rename is imported and pushed to the other apps; the app wins when both changed; a name clash keeps Plembfin's", async () => {
  createList({ name: "Taken name" });
  const listId = createList({ name: "Original", items: [{ key: "movie:a" }], targets: ["plex", "emby"] });
  const { fakes, sync } = setup({ library: { plex: { "movie:a": "PA" }, emby: { "movie:a": "EA" } } });
  await sync(listId);
  const plexPlaylist = fakes.plex.state.playlists.get(remoteId(listId, "plex"));
  const embyPlaylist = fakes.emby.state.playlists.get(remoteId(listId, "emby"));

  plexPlaylist.title = "Renamed in Plex";
  const result = await sync(listId);
  assert.equal(pullOf(result, "plex").renamed, true);
  assert.equal(list(listId).name, "Renamed in Plex");
  assert.equal(embyPlaylist.title, "Renamed in Plex");
  assert.equal(fakes.plex.state.calls.filter(([name]) => name === "renamePlaylist").length, 0);

  // Both renamed since the last sync: the app rename is seen later, so it wins.
  db.prepare("UPDATE personal_lists SET name = 'Plembfin name' WHERE id = ?").run(listId);
  plexPlaylist.title = "Plex name";
  await sync(listId);
  assert.equal(list(listId).name, "Plex name");
  assert.equal(embyPlaylist.title, "Plex name");

  // A Plembfin rename alone is pushed to every app.
  db.prepare("UPDATE personal_lists SET name = 'Plembfin name' WHERE id = ?").run(listId);
  await sync(listId);
  assert.equal(plexPlaylist.title, "Plembfin name");
  assert.equal(embyPlaylist.title, "Plembfin name");

  plexPlaylist.title = "taken NAME";
  await sync(listId);
  assert.equal(list(listId).name, "Plembfin name");
  assert.equal(plexPlaylist.title, "Plembfin name");
});

const reorderApp = (fakes, provider, playlistId, itemIds) => {
  const playlist = fakes[provider].state.playlists.get(playlistId);
  playlist.entries = itemIds.map((itemId) => playlist.entries.find((entry) => entry.itemId === itemId));
};

test("an app reorder is imported when Plembfin's order is unchanged; items missing from that app keep their place", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["plex", "emby"] });
  const { fakes, sync } = setup({
    library: { plex: { "movie:a": "PA", "movie:c": "PC" }, emby: { "movie:a": "EA", "movie:b": "EB", "movie:c": "EC" } },
  });
  await sync(listId);
  const plexId = remoteId(listId, "plex");
  reorderApp(fakes, "plex", plexId, ["PC", "PA"]);
  const moves = fakes.plex.state.calls.length;

  const result = await sync(listId);
  assert.equal(pullOf(result, "plex").reordered, true);
  assert.deepEqual(keys(listId), ["movie:c", "movie:b", "movie:a"]);
  assert.deepEqual(fakes.plex.items(plexId), ["PC", "PA"]);
  assert.deepEqual(fakes.emby.items(remoteId(listId, "emby")), ["EC", "EB", "EA"]);
  assert.equal(fakes.plex.state.calls.slice(moves).some(([name]) => name === "movePlaylistItem"), false, "the app order is not moved back");

  const again = await sync(listId);
  assert.equal(pullOf(again, "plex").reordered, false);
  assert.equal(pullOf(again, "emby").reordered, false);
});

test("a Plembfin reorder since the last sync wins over an app reorder", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["plex"] });
  const { fakes, sync } = setup({ library: { plex: { "movie:a": "PA", "movie:b": "PB", "movie:c": "PC" } } });
  await sync(listId);
  const plexId = remoteId(listId, "plex");
  const setPosition = db.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?");
  ["movie:b", "movie:a", "movie:c"].forEach((key, index) => setPosition.run(index, listId, key));
  db.prepare("UPDATE personal_lists SET order_updated_at = ? WHERE id = ?").run(Date.now() + 60_000, listId);
  reorderApp(fakes, "plex", plexId, ["PC", "PB", "PA"]);

  const result = await sync(listId);
  assert.equal(pullOf(result, "plex").reordered, false);
  assert.deepEqual(keys(listId), ["movie:b", "movie:a", "movie:c"]);
  assert.deepEqual(fakes.plex.items(plexId), ["PB", "PA", "PC"]);
});

test("unidentified app entries are counted on the app's target and survive a Plembfin reorder", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }], targets: ["emby"] });
  const { fakes, sync } = setup({ library: { emby: { "movie:a": "EA", "movie:b": "EB" } }, identities: { TRAILER: null } });
  await sync(listId);
  const embyId = remoteId(listId, "emby");
  fakes.emby.appAdd(embyId, "TRAILER");
  reorderApp(fakes, "emby", embyId, ["TRAILER", "EA", "EB"]);
  const count = () => db.prepare("SELECT unidentified_count FROM personal_list_targets WHERE list_id = ? AND provider = 'emby'").get(listId).unidentified_count;

  await sync(listId);
  assert.equal(count(), 1);

  const setPosition = db.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?");
  ["movie:b", "movie:a"].forEach((key, index) => setPosition.run(index, listId, key));
  db.prepare("UPDATE personal_lists SET order_updated_at = ? WHERE id = ?").run(Date.now() + 60_000, listId);
  await sync(listId);
  assert.deepEqual(fakes.emby.items(embyId), ["EB", "EA", "TRAILER"], "ordered entries first, the unidentified one kept");
  assert.equal(count(), 1);

  fakes.emby.appRemove(embyId, "TRAILER");
  await sync(listId);
  assert.equal(count(), 0);
});

test("the pull never reads a provider the playlist does not target", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby"] });
  const { fakes, sync } = setup({ library: { emby: { "movie:a": "A" }, plex: { "movie:a": "PA" } } });
  await sync(listId);
  await sync(listId);
  assert.deepEqual(fakes.plex.state.calls, []);
  assert.deepEqual(fakes.jellyfin.state.calls, []);
});

// Last: syncAllPlaylists passes over every earlier test's playlist too.
test("a scheduled pass retries an app delete that failed for a deleted playlist", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby"] });
  const { fakes, deps, sync } = setup({ library: { emby: { "movie:a": "EA" } } });
  await sync(listId);
  const embyPlaylist = remoteId(listId, "emby");
  db.prepare("UPDATE personal_lists SET deleted_at = ?, deleted_origin = 'local' WHERE id = ?").run(Date.now(), listId);
  const realDelete = fakes.emby.client.deletePlaylist;
  const original = console.error;
  console.error = () => {};
  try {
    fakes.emby.client.deletePlaylist = async () => { throw statusError(503); };
    await sync(listId);
    assert.equal(remoteId(listId, "emby"), embyPlaylist);

    fakes.emby.client.deletePlaylist = realDelete;
    const passes = await syncAllPlaylists({ config, deps });
    assert.equal(passes.some((pass) => pass.listId === listId), true);
    assert.equal(fakes.emby.state.playlists.has(embyPlaylist), false);
    assert.equal(remoteId(listId, "emby"), null);
    const later = await syncAllPlaylists({ config, deps });
    assert.equal(later.some((pass) => pass.listId === listId), false);
  } finally {
    console.error = original;
  }
});
