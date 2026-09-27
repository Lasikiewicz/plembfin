import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";
import { fakeProvider, statusError } from "./playlistFakes.js";

makeTempDataDir("plembfin-playlist-push-");

const { db } = await import("../server/src/db.js");
const { pushPlaylist } = await import("../server/src/utils/playlistPushEngine.js");

const config = {
  plex: { baseUrl: "http://plex.test", token: "t" },
  emby: { baseUrl: "http://emby.test", apiKey: "k", userId: "u" },
  jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "k", userId: "u" },
};

// library[provider][media_key]: an id, "" (not in the library), or an Error.
function setup({ library = {} } = {}) {
  const fakes = { plex: fakeProvider("plex"), emby: fakeProvider("emby"), jellyfin: fakeProvider("jellyfin") };
  const answer = (value) => {
    if (value instanceof Error) throw value;
    return value;
  };
  const deps = {
    client: (provider) => fakes[provider].client,
    resolveItemId: async (provider, _config, row) => answer(library[provider]?.[row.media_key] ?? ""),
  };
  return { fakes, deps, push: (listId) => pushPlaylist(listId, { config, deps }) };
}

let listCounter = 0;
function createList({ name = `List ${++listCounter}`, items = [], targets = [] } = {}) {
  const id = `list-${listCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
  items.forEach((item, position) => addItem(id, item, position));
  for (const provider of targets) {
    db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, provider, now, now);
  }
  return id;
}

function addItem(listId, { key, type = "movie", season = null, episode = null }, position) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO personal_list_items (list_id, media_key, media_type, title, season, episode, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(listId, key, type, key, season, episode, position, now, now);
}

function setOrder(listId, keys) {
  keys.forEach((key, position) => db.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?").run(position, listId, key));
}

function target(listId, provider) {
  return db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ? AND provider = ?").get(listId, provider);
}

function availability(listId, provider) {
  return Object.fromEntries(db.prepare("SELECT media_key, status, episode_count FROM personal_list_item_availability WHERE list_id = ? AND provider = ?")
    .all(listId, provider).map((row) => [row.media_key, [row.status, row.episode_count]]));
}

function ledger(listId, provider) {
  return db.prepare("SELECT provider_item_id, media_key, season, episode, remote_position FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ? ORDER BY remote_position")
    .all(listId, provider);
}

const episodes = (...ids) => ids.map(([providerItemId, season, episode]) => ({ providerItemId, season, episode }));

test("first push creates the app playlist in order and records availability", async () => {
  const listId = createList({
    items: [{ key: "movie:a" }, { key: "episode:y", type: "episode", season: 2, episode: 1 }, { key: "movie:gone" }, { key: "episode:x", type: "episode", season: 1, episode: 1 }],
    targets: ["emby"],
  });
  const { fakes, push } = setup({
    library: { emby: { "movie:a": "A", "episode:x": "X", "episode:y": "Y" }, jellyfin: { "movie:a": "JA" } },
  });

  const result = await push(listId);
  assert.equal(result.providers[0].status, "synced");
  const playlistId = target(listId, "emby").remote_playlist_id;
  assert.ok(playlistId);
  // Episodes are separate items in Plembfin's order, not sorted.
  assert.deepEqual(fakes.emby.items(playlistId), ["A", "Y", "X"]);
  assert.deepEqual(availability(listId, "emby"), {
    "movie:a": ["available", null],
    "episode:y": ["available", null],
    "movie:gone": ["missing", null],
    "episode:x": ["available", null],
  });
  assert.deepEqual(ledger(listId, "emby").map((row) => [row.provider_item_id, row.media_key, row.remote_position]), [
    ["A", "movie:a", 0], ["Y", "episode:y", 1], ["X", "episode:x", 2],
  ]);
  assert.equal(target(listId, "emby").remote_name, db.prepare("SELECT name FROM personal_lists WHERE id = ?").get(listId).name);
  // Jellyfin is configured and resolves the movie, but the playlist does not target it.
  assert.deepEqual(fakes.jellyfin.state.calls, []);
  assert.deepEqual(fakes.plex.state.calls, []);
});

test("a later push reconciles to Plembfin's order, removes dropped items, and leaves app-added entries alone", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["emby"] });
  const library = { emby: { "movie:a": "A", "movie:b": "B", "movie:c": "C", "movie:d": "D" } };
  const { fakes, push } = setup({ library });
  await push(listId);
  const playlistId = target(listId, "emby").remote_playlist_id;
  // Added in Emby, unknown to the ledger: the pull pass imports it, the push must not remove it.
  fakes.emby.state.playlists.get(playlistId).entries.push({ entryId: "app-entry", itemId: "APP" });

  db.prepare("DELETE FROM personal_list_items WHERE list_id = ? AND media_key = 'movie:b'").run(listId);
  addItem(listId, { key: "movie:d" }, 5);
  setOrder(listId, ["movie:c", "movie:d", "movie:a"]);
  const result = await push(listId);

  assert.deepEqual(fakes.emby.items(playlistId), ["C", "D", "A", "APP"]);
  assert.equal(result.providers[0].removed, 1);
  assert.equal(result.providers[0].added, 1);
  assert.deepEqual(ledger(listId, "emby").map((row) => row.provider_item_id), ["C", "D", "A"]);
  // An unchanged playlist needs no writes at all.
  const before = fakes.emby.state.calls.length;
  await push(listId);
  assert.deepEqual(fakes.emby.state.calls.slice(before).map(([name]) => name), ["fetchPlaylist", "fetchPlaylistItems"]);
});

test("a playlist still holding a show item is not pushed until it becomes episodes", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "tv:show", type: "tv" }], targets: ["emby"] });
  const { fakes, push } = setup({ library: { emby: { "movie:a": "A" } } });
  const result = await push(listId);
  assert.equal(result.skipped, "show_conversion");
  assert.deepEqual(fakes.emby.state.calls, []);
});

test("a failed lookup or an empty lookup never removes an existing entry", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "episode:e1", type: "episode", season: 1, episode: 1 }, { key: "movie:b" }], targets: ["emby"] });
  const library = { emby: { "movie:a": "A", "movie:b": "B", "episode:e1": "E1" } };
  const { fakes, push } = setup({ library });
  await push(listId);
  const playlistId = target(listId, "emby").remote_playlist_id;
  assert.deepEqual(fakes.emby.items(playlistId), ["A", "E1", "B"]);

  library.emby["movie:a"] = new Error("Emby lookup timed out");
  library.emby["movie:b"] = "";
  library.emby["episode:e1"] = "";
  const result = await push(listId);
  assert.equal(result.providers[0].status, "synced");
  assert.equal(result.providers[0].removed, 0);
  assert.deepEqual(fakes.emby.items(playlistId), ["A", "E1", "B"]);
  assert.deepEqual(availability(listId, "emby")["movie:b"], ["available", null]);
  assert.deepEqual(availability(listId, "emby")["episode:e1"], ["available", null]);
});

test("an unanswered lookup with nothing in the playlist keeps the previous availability", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }], targets: ["emby"] });
  const library = { emby: { "movie:a": "A", "movie:b": "" } };
  const { push } = setup({ library });
  await push(listId);
  assert.deepEqual(availability(listId, "emby")["movie:b"], ["missing", null]);
  library.emby["movie:b"] = new Error("fetch failed");
  await push(listId);
  assert.deepEqual(availability(listId, "emby")["movie:b"], ["missing", null]);
});

test("an entry removed in the app is not re-added before the pull pass decides", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }], targets: ["emby"] });
  const { fakes, push } = setup({ library: { emby: { "movie:a": "A", "movie:b": "B" } } });
  await push(listId);
  const playlistId = target(listId, "emby").remote_playlist_id;
  const entries = fakes.emby.state.playlists.get(playlistId).entries;
  entries.splice(entries.findIndex((entry) => entry.itemId === "B"), 1);

  const result = await push(listId);
  assert.equal(result.providers[0].added, 0);
  assert.deepEqual(fakes.emby.items(playlistId), ["A"]);
  assert.deepEqual(availability(listId, "emby")["movie:b"], ["available", null]);
  // The vanished entry's ledger row stays for the pull pass to judge.
  assert.deepEqual(ledger(listId, "emby").map((row) => row.provider_item_id).sort(), ["A", "B"]);
});

test("a rejected batch falls back to single adds, and items the app did not keep are reported missing", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:stale" }, { key: "movie:b" }, { key: "movie:dropped" }], targets: ["jellyfin"] });
  const { fakes, push } = setup({ library: { jellyfin: { "movie:a": "A", "movie:stale": "STALE", "movie:b": "B", "movie:dropped": "DROP" } } });
  fakes.jellyfin.state.rejectIds.add("STALE");
  fakes.jellyfin.state.dropIds.add("DROP");

  const result = await push(listId);
  const playlistId = target(listId, "jellyfin").remote_playlist_id;
  assert.deepEqual(fakes.jellyfin.items(playlistId), ["A", "B"]);
  assert.equal(result.providers[0].notKept, 2);
  const adds = fakes.jellyfin.state.calls.filter(([name]) => name === "addPlaylistItems").map(([, , ids]) => ids);
  assert.deepEqual(adds, [["STALE", "B", "DROP"], ["STALE"], ["B"], ["DROP"]]);
  assert.deepEqual(availability(listId, "jellyfin"), {
    "movie:a": ["available", null],
    "movie:stale": ["missing", null],
    "movie:b": ["available", null],
    "movie:dropped": ["missing", null],
  });
});

test("a Plembfin rename is pushed, an app-side rename is left for the pull pass", async () => {
  const listId = createList({ name: "Original", items: [{ key: "movie:a" }], targets: ["plex"] });
  const { fakes, push } = setup({ library: { plex: { "movie:a": "A" } } });
  await push(listId);
  const playlistId = target(listId, "plex").remote_playlist_id;

  fakes.plex.state.playlists.get(playlistId).title = "Renamed in Plex";
  await push(listId);
  assert.equal(fakes.plex.state.playlists.get(playlistId).title, "Renamed in Plex");

  db.prepare("UPDATE personal_lists SET name = 'Renamed in Plembfin' WHERE id = ?").run(listId);
  assert.equal((await push(listId)).providers[0].renamed, true);
  assert.equal(fakes.plex.state.playlists.get(playlistId).title, "Renamed in Plembfin");
  assert.equal(target(listId, "plex").remote_name, "Renamed in Plembfin");
});

test("Plex reorders by placing entries after their predecessor", async () => {
  const listId = createList({ items: [{ key: "movie:a" }, { key: "movie:b" }, { key: "movie:c" }], targets: ["plex"] });
  const { fakes, push } = setup({ library: { plex: { "movie:a": "A", "movie:b": "B", "movie:c": "C" } } });
  await push(listId);
  const playlistId = target(listId, "plex").remote_playlist_id;
  setOrder(listId, ["movie:c", "movie:a", "movie:b"]);
  await push(listId);
  assert.deepEqual(fakes.plex.items(playlistId), ["C", "A", "B"]);
  const moves = fakes.plex.state.calls.filter(([name]) => name === "movePlaylistItem");
  assert.equal(moves[0][3], "");
});

test("an entry moved to the top in Plex is put back with one move to the end", async () => {
  const keys = ["a", "b", "c", "d", "e"];
  const listId = createList({ items: keys.map((key) => ({ key: `movie:${key}` })), targets: ["plex"] });
  const { fakes, push } = setup({ library: { plex: Object.fromEntries(keys.map((key) => [`movie:${key}`, key.toUpperCase()])) } });
  await push(listId);
  const playlistId = target(listId, "plex").remote_playlist_id;
  const entries = fakes.plex.state.playlists.get(playlistId).entries;
  entries.unshift(entries.pop());
  fakes.plex.state.ignoreInnerMoves = true;
  const calls = fakes.plex.state.calls.length;
  await push(listId);
  assert.deepEqual(fakes.plex.items(playlistId), ["A", "B", "C", "D", "E"]);
  assert.equal(fakes.plex.state.calls.slice(calls).filter(([name]) => name === "movePlaylistItem").length, 1);
  assert.deepEqual(ledger(listId, "plex").map((row) => row.provider_item_id), ["A", "B", "C", "D", "E"]);
});

test("a Plex move the app ignores is rebuilt by moving entries to the end, and the ledger keeps the real order", async () => {
  const keys = ["a", "b", "c", "d", "e"];
  const listId = createList({ items: keys.map((key) => ({ key: `movie:${key}` })), targets: ["plex"] });
  const { fakes, push } = setup({ library: { plex: Object.fromEntries(keys.map((key) => [`movie:${key}`, key.toUpperCase()])) } });
  await push(listId);
  const playlistId = target(listId, "plex").remote_playlist_id;
  fakes.plex.state.ignoreInnerMoves = true;
  setOrder(listId, ["movie:a", "movie:c", "movie:b", "movie:d", "movie:e"]);
  await push(listId);
  assert.deepEqual(fakes.plex.items(playlistId), ["A", "C", "B", "D", "E"]);
  assert.deepEqual(ledger(listId, "plex").map((row) => row.provider_item_id), ["A", "C", "B", "D", "E"]);

  // An app that obeys no move at all: the ledger records what the app holds.
  const entries = fakes.plex.state.playlists.get(playlistId).entries;
  fakes.plex.client.movePlaylistItem = async () => ({ status: "fulfilled" });
  setOrder(listId, ["movie:e", "movie:d", "movie:c", "movie:b", "movie:a"]);
  const result = await push(listId);
  assert.equal(result.providers[0].orderMismatch, true);
  assert.deepEqual(ledger(listId, "plex").map((row) => row.provider_item_id), entries.map((entry) => entry.itemId));
});

test("no app playlist is created until an item resolves there", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby"] });
  const library = { emby: { "movie:a": "" } };
  const { fakes, push } = setup({ library });
  assert.equal((await push(listId)).providers[0].created, false);
  assert.equal(target(listId, "emby").remote_playlist_id, null);
  assert.deepEqual(fakes.emby.state.calls, []);
  library.emby["movie:a"] = "A";
  assert.equal((await push(listId)).providers[0].created, true);
  assert.deepEqual(fakes.emby.items(target(listId, "emby").remote_playlist_id), ["A"]);
});

test("a playlist not found in the app is skipped, never recreated by the push", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby"] });
  const { fakes, push } = setup({ library: { emby: { "movie:a": "A" } } });
  await push(listId);
  const playlistId = target(listId, "emby").remote_playlist_id;
  fakes.emby.state.playlists.delete(playlistId);
  const result = await push(listId);
  assert.equal(result.providers[0].status, "skipped");
  assert.equal(target(listId, "emby").remote_playlist_id, playlistId);
  assert.equal(fakes.emby.state.calls.filter(([name]) => name === "createPlaylist").length, 1);
});

test("a read failure records the error and writes nothing", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby"] });
  const { fakes, push } = setup({ library: { emby: { "movie:a": "A" } } });
  await push(listId);
  fakes.emby.client.fetchPlaylistItems = async () => { throw statusError(500); };
  const before = fakes.emby.state.calls.length;
  const result = await push(listId);
  assert.equal(result.providers[0].status, "error");
  assert.match(target(listId, "emby").last_error, /500/);
  assert.deepEqual(fakes.emby.state.calls.slice(before).map(([name]) => name), ["fetchPlaylist"]);
});

test("a deselected app loses its playlist and target; a deleted playlist keeps targets for restore", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby", "jellyfin"] });
  const { fakes, push } = setup({ library: { emby: { "movie:a": "A" }, jellyfin: { "movie:a": "JA" } } });
  await push(listId);
  const embyPlaylist = target(listId, "emby").remote_playlist_id;
  const jellyfinPlaylist = target(listId, "jellyfin").remote_playlist_id;

  db.prepare("UPDATE personal_list_targets SET desired_state = 'absent' WHERE list_id = ? AND provider = 'emby'").run(listId);
  await push(listId);
  assert.equal(fakes.emby.state.playlists.has(embyPlaylist), false);
  assert.equal(target(listId, "emby"), undefined);
  assert.deepEqual(ledger(listId, "emby"), []);
  assert.deepEqual(availability(listId, "emby"), {});
  assert.equal(fakes.jellyfin.state.playlists.has(jellyfinPlaylist), true);

  db.prepare("UPDATE personal_lists SET deleted_at = ?, deleted_origin = 'plembfin' WHERE id = ?").run(Date.now(), listId);
  assert.equal((await push(listId)).providers[0].status, "deleted");
  assert.equal(fakes.jellyfin.state.playlists.has(jellyfinPlaylist), false);
  assert.equal(target(listId, "jellyfin").remote_playlist_id, null);
  assert.deepEqual(ledger(listId, "jellyfin"), []);
});

test("an unconfigured provider is skipped without any call", async () => {
  const listId = createList({ items: [{ key: "movie:a" }], targets: ["emby"] });
  const { fakes, deps } = setup({ library: { emby: { "movie:a": "A" } } });
  const result = await pushPlaylist(listId, { config: { ...config, emby: { disabled: true } }, deps });
  assert.equal(result.providers[0].status, "skipped");
  assert.deepEqual(fakes.emby.state.calls, []);
  assert.match(target(listId, "emby").last_error, /not configured/);
});
