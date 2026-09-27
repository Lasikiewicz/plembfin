import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-playlist-route-");
// A web-only role never starts a sync, so no test here touches the network.
process.env.ROLE = "web";

const { AUTH } = await import("../server/src/appConfig.js");
const { db } = await import("../server/src/db.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { handlePersonalMedia } = await import("../server/src/routes/personal.js");

await saveMediaConfig({
  plex: { authMode: "manual", baseUrl: "http://plex.invalid:32400", token: "plex-token" },
  jellyfin: { authMode: "manual", baseUrl: "http://jellyfin.invalid:8096", apiKey: "jf-key", userId: "jf-user" },
});

function targets(listId) {
  return db.prepare("SELECT provider, desired_state, remote_playlist_id FROM personal_list_targets WHERE list_id = ? ORDER BY provider").all(listId);
}

async function createPlaylist(name, providers = undefined, kind = "movie") {
  const created = await call("POST", { action: "list-create", name, kind, ...(providers ? { providers } : {}) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.list.id;
}

async function call(method, body = undefined) {
  const capture = { body: null, status: 200 };
  const res = {
    status(code) { capture.status = code; return this; },
    set() { return this; },
    send(payload) { capture.body = payload ? JSON.parse(payload) : null; return this; },
  };
  const req = {
    method,
    body,
    query: {},
    cookies: {},
    get(name) { return String(name || "").toLowerCase() === "x-api-key" ? AUTH.apiKey : ""; },
  };
  await handlePersonalMedia(req, res);
  return capture;
}

const movie = (id) => ({ media_type: "movie", tmdb_id: String(id), title: `Movie ${id}` });

test("the rule genre list needs a Movies or TV kind before it reads any app", async () => {
  for (const kind of [undefined, "mixed", "music"]) {
    const response = await call("POST", { action: "list-rule-genres", ...(kind ? { kind } : {}) });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /kind must be movie or tv/);
  }
});

test("the playlists stamp matches the page payload and changes when a playlist changes", async () => {
  const stamp = async () => (await call("POST", { action: "list-stamp" })).body.stamp;
  const page = (await call("GET")).body;
  assert.match(page.playlists_stamp, /^[0-9a-f]{40}$/);
  assert.equal(await stamp(), page.playlists_stamp);
  assert.equal(await stamp(), page.playlists_stamp, "unchanged playlists keep the stamp");
  const created = await call("POST", { action: "list-create", name: "Stamp Check", kind: "movie" });
  const afterCreate = await stamp();
  assert.notEqual(afterCreate, page.playlists_stamp);
  await call("POST", { action: "list-add", list_id: created.body.list.id, ...movie(77) });
  assert.notEqual(await stamp(), afterCreate);
  assert.equal(await stamp(), (await call("GET")).body.playlists_stamp);
});

test("playlist items keep their order: new items go to the top, re-adding keeps the place", async () => {
  const created = await call("POST", { action: "list-create", name: "Order Check", kind: "movie" });
  assert.equal(created.status, 201);
  const listId = created.body.list.id;
  // Ids out of key order, so neither updated_at nor media_key order matches.
  for (const id of [3, 1, 2]) {
    assert.equal((await call("POST", { action: "list-add", list_id: listId, ...movie(id) })).status, 200);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await call("POST", { action: "list-add", list_id: listId, ...movie(1), title: "Movie 1 renamed" })).status, 200);

  const list = (await call("GET")).body.lists.find((entry) => entry.id === listId);
  assert.deepEqual(list.items.map((item) => [item.title, item.position]), [
    ["Movie 2", 0],
    ["Movie 1 renamed", 1],
    ["Movie 3", 2],
  ]);
});

test("Remove items once watched is saved and returned on create and update", async () => {
  const created = await call("POST", { action: "list-create", name: "Watch Once", kind: "movie", remove_watched: true });
  assert.equal(created.status, 201);
  assert.equal(created.body.list.remove_watched, true);
  const listId = created.body.list.id;
  const read = async () => (await call("GET")).body.lists.find((entry) => entry.id === listId).remove_watched;
  assert.equal(await read(), true);
  assert.equal((await call("POST", { action: "list-update", list_id: listId, remove_watched: false })).status, 200);
  assert.equal(await read(), false);
  // Leaving it out of an update keeps it as it was.
  assert.equal((await call("POST", { action: "list-update", list_id: listId, name: "Watch Once Renamed" })).status, 200);
  assert.equal(await read(), false);
  assert.equal((await createPlaylist("Off By Default").then(async (id) => (await call("GET")).body.lists.find((entry) => entry.id === id).remove_watched)), false);
});

test("a soft-deleted playlist is hidden, rejects item changes, and frees its name", async () => {
  const created = await call("POST", { action: "list-create", name: "Gone Soon", kind: "movie" });
  const listId = created.body.list.id;
  db.prepare("UPDATE personal_lists SET deleted_at = ?, deleted_origin = 'local' WHERE id = ?").run(Date.now(), listId);

  assert.equal((await call("GET")).body.lists.some((entry) => entry.id === listId), false);
  assert.equal((await call("POST", { action: "list-add", list_id: listId, ...movie(9) })).status, 404);
  assert.equal((await call("POST", { action: "list-create", name: "gone soon", kind: "movie" })).status, 201);
});

const episode = (season, number, extra = {}) => ({
  media_type: "episode",
  title: `Episode ${number}`,
  show_title: "Show",
  show_tmdb_id: "77",
  season,
  episode: number,
  ...extra,
});

test("create requires Movies or TV, and adds are checked against the playlist type", async () => {
  const missing = await call("POST", { action: "list-create", name: "No Type" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "kind_required");

  const movies = await createPlaylist("Typed Movies", undefined, "movie");
  const tv = await createPlaylist("Typed TV", undefined, "tv");
  const listed = (await call("GET")).body.lists;
  assert.equal(listed.find((entry) => entry.id === tv).kind, "tv");

  const wrongIntoTv = await call("POST", { action: "list-add", list_id: tv, ...movie(5) });
  assert.equal(wrongIntoTv.status, 400);
  assert.equal(wrongIntoTv.body.code, "wrong_type");
  const wrongIntoMovies = await call("POST", { action: "list-add", list_id: movies, ...episode(1, 1) });
  assert.equal(wrongIntoMovies.body.code, "wrong_type");
  const wholeShow = await call("POST", { action: "list-add", list_id: tv, media_type: "tv", tmdb_id: "77", title: "Show" });
  assert.equal(wholeShow.body.code, "show_needs_episodes");

  // An episode added on its own keeps its show and coordinates.
  assert.equal((await call("POST", { action: "list-add", list_id: tv, ...episode(2, 3) })).status, 200);
  const row = db.prepare("SELECT media_key, media_type, tmdb_id, show_title, season, episode FROM personal_list_items WHERE list_id = ?").get(tv);
  assert.deepEqual({ ...row }, { media_key: "episode:tmdb:77:s2e3", media_type: "episode", tmdb_id: "77", show_title: "Show", season: 2, episode: 3 });
});

test("a Mixed playlist takes movies and episodes, but a show still needs its episodes picked", async () => {
  const mixed = await createPlaylist("Typed Mixed", undefined, "mixed");
  assert.equal((await call("GET")).body.lists.find((entry) => entry.id === mixed).kind, "mixed");
  assert.equal((await call("POST", { action: "list-add", list_id: mixed, ...movie(40) })).status, 200);
  assert.equal((await call("POST", { action: "list-add", list_id: mixed, ...episode(1, 4) })).status, 200);
  const wholeShow = await call("POST", { action: "list-add", list_id: mixed, media_type: "tv", tmdb_id: "77", title: "Show" });
  assert.equal(wholeShow.body.code, "show_needs_episodes");
  const rows = db.prepare("SELECT media_type FROM personal_list_items WHERE list_id = ? ORDER BY position").all(mixed);
  assert.deepEqual(rows.map((row) => row.media_type), ["episode", "movie"]);
  assert.equal(db.prepare("SELECT kind FROM personal_lists WHERE id = ?").get(mixed).kind, "mixed");
  assert.equal((await call("POST", { action: "list-create", name: "Bad Type", kind: "music" })).body.code, "kind_required");
});

test("an untyped playlist takes the type of its first item", async () => {
  const listId = await createPlaylist("Was Empty");
  db.prepare("UPDATE personal_lists SET kind = NULL WHERE id = ?").run(listId);
  assert.equal((await call("POST", { action: "list-add", list_id: listId, ...episode(1, 1) })).status, 200);
  assert.equal(db.prepare("SELECT kind FROM personal_lists WHERE id = ?").get(listId).kind, "tv");
  assert.equal((await call("POST", { action: "list-add", list_id: listId, ...movie(6) })).body.code, "wrong_type");
});

test("picked episodes go to the top as one block in episode order; ones already there keep their place", async () => {
  const listId = await createPlaylist("Picked", undefined, "tv");
  for (const [season, number] of [[1, 2], [3, 1]]) {
    assert.equal((await call("POST", { action: "list-add", list_id: listId, ...episode(season, number) })).status, 200);
  }
  const result = await call("POST", {
    action: "list-add-episodes",
    list_id: listId,
    show: { title: "Show", tmdb_id: "77" },
    episodes: [
      { season: 2, episode: 1, title: "Two One" },
      { season: 1, episode: 2 },
      { season: 0, episode: 1, title: "Special" },
      { season: 1, episode: 1 },
    ],
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.added, 3);
  const list = (await call("GET")).body.lists.find((entry) => entry.id === listId);
  assert.deepEqual(list.items.map((item) => [item.season, item.episode]), [[0, 1], [1, 1], [2, 1], [3, 1], [1, 2]]);
  assert.equal(list.items[2].title, "Two One");
});

test("deleting any playlist moves it to Recently deleted and keeps its app targets", async () => {
  const targeted = await createPlaylist("In Plex");
  const local = await createPlaylist("Local Only");
  const now = Date.now();
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, remote_playlist_id, created_at, updated_at) VALUES (?, 'plex', 'P1', ?, ?)").run(targeted, now, now);

  assert.equal((await call("POST", { action: "list-delete", list_id: targeted })).status, 200);
  assert.equal((await call("POST", { action: "list-delete", list_id: local })).status, 200);

  const row = db.prepare("SELECT deleted_at, deleted_origin FROM personal_lists WHERE id = ?").get(targeted);
  assert.equal(row.deleted_origin, "local");
  assert.ok(row.deleted_at);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_list_targets WHERE list_id = ?").get(targeted).n, 1);
  const payload = (await call("GET")).body;
  assert.equal(payload.lists.some((entry) => entry.id === targeted || entry.id === local), false);
  const deleted = payload.deleted_lists.find((entry) => entry.id === targeted);
  assert.deepEqual(deleted.providers, ["plex"]);
  assert.deepEqual(deleted.pending_app_deletes, ["plex"]);
  assert.equal(payload.deleted_lists.find((entry) => entry.id === local).deleted_origin, "local");
});

test("create selects connected apps only and reports them with the picker's availability", async () => {
  const listId = await createPlaylist("Two Apps", ["jellyfin", "plex", "plex"]);
  assert.deepEqual(targets(listId).map((row) => [row.provider, row.desired_state]), [["jellyfin", "present"], ["plex", "present"]]);

  const rejected = await call("POST", { action: "list-create", name: "Needs Emby", kind: "movie", providers: ["emby"] });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Emby is not connected/);
  assert.equal((await call("POST", { action: "list-create", name: "Bad App", kind: "movie", providers: ["kodi"] })).status, 400);

  const payload = (await call("GET")).body;
  assert.deepEqual(payload.playlist_providers, [
    { provider: "plex", configured: true },
    { provider: "emby", configured: false },
    { provider: "jellyfin", configured: true },
  ]);
  const list = payload.lists.find((entry) => entry.id === listId);
  assert.deepEqual(list.providers.map((entry) => [entry.provider, entry.status]), [["jellyfin", "pending"], ["plex", "pending"]]);
});

test("update renames and deselects: an app with a playlist is marked absent, one without is dropped", async () => {
  const listId = await createPlaylist("Before Rename", ["plex", "jellyfin"]);
  db.prepare("UPDATE personal_list_targets SET remote_playlist_id = 'P9' WHERE list_id = ? AND provider = 'plex'").run(listId);
  await createPlaylist("Taken Name");

  assert.equal((await call("POST", { action: "list-update", list_id: listId, name: "taken name" })).status, 409);
  const updated = await call("POST", { action: "list-update", list_id: listId, name: "After Rename", providers: [] });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  assert.equal(db.prepare("SELECT name FROM personal_lists WHERE id = ?").get(listId).name, "After Rename");
  assert.deepEqual(targets(listId).map((row) => [row.provider, row.desired_state]), [["plex", "absent"]]);
  assert.deepEqual((await call("GET")).body.lists.find((entry) => entry.id === listId).providers, []);

  // Selecting it again before the sync deleted the app playlist keeps that playlist.
  assert.equal((await call("POST", { action: "list-update", list_id: listId, providers: ["plex"] })).status, 200);
  assert.deepEqual(targets(listId), [{ provider: "plex", desired_state: "present", remote_playlist_id: "P9" }]);
});

test("an app that is disconnected later can stay selected but not be newly added", async () => {
  const listId = await createPlaylist("Kept Emby");
  const now = Date.now();
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, 'emby', ?, ?)").run(listId, now, now);
  assert.equal((await call("POST", { action: "list-update", list_id: listId, providers: ["emby", "plex"] })).status, 200);
  assert.deepEqual(targets(listId).map((row) => row.provider), ["emby", "plex"]);
});

test("reorder takes the full new order and rejects a stale one", async () => {
  const listId = await createPlaylist("Reorder Me");
  // Each new item goes to the top, so this leaves 1, 2, 3.
  for (const id of [3, 2, 1]) await call("POST", { action: "list-add", list_id: listId, ...movie(id) });
  const keys = (await call("GET")).body.lists.find((entry) => entry.id === listId).items.map((item) => item.media_key);

  assert.equal((await call("POST", { action: "list-reorder", list_id: listId, order: keys.slice(0, 2) })).status, 409);
  assert.equal((await call("POST", { action: "list-reorder", list_id: listId, order: [keys[0], keys[0], keys[1]] })).status, 409);
  assert.equal((await call("POST", { action: "list-reorder", list_id: listId, order: [keys[2], keys[0], keys[1]] })).status, 200);

  const list = (await call("GET")).body.lists.find((entry) => entry.id === listId);
  assert.deepEqual(list.items.map((item) => item.title), ["Movie 3", "Movie 1", "Movie 2"]);
  assert.ok(db.prepare("SELECT order_updated_at FROM personal_lists WHERE id = ?").get(listId).order_updated_at);
});

test("items report availability only for the apps the playlist targets", async () => {
  const listId = await createPlaylist("Availability", ["plex"]);
  await call("POST", { action: "list-add", list_id: listId, ...movie(40) });
  const key = (await call("GET")).body.lists.find((entry) => entry.id === listId).items[0].media_key;
  const insert = db.prepare("INSERT INTO personal_list_item_availability (list_id, media_key, provider, status, reason, checked_at) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run(listId, key, "plex", "missing", "Not in the library.", 1);
  insert.run(listId, key, "emby", "available", "", 1);

  const item = (await call("GET")).body.lists.find((entry) => entry.id === listId).items[0];
  assert.deepEqual(Object.keys(item.availability), ["plex"]);
  assert.equal(item.availability.plex.status, "missing");
  assert.equal(item.availability.plex.reason, "Not in the library.");
});

test("restore refuses a taken name, takes a new one, and keeps only its selected apps", async () => {
  const listId = await createPlaylist("Comeback", ["plex", "jellyfin"]);
  await call("POST", { action: "list-add", list_id: listId, ...movie(50) });
  const now = Date.now();
  // Deleted in Plex; Jellyfin was being deselected and its playlist is gone.
  db.prepare("UPDATE personal_list_targets SET desired_state = 'absent' WHERE list_id = ? AND provider = 'jellyfin'").run(listId);
  db.prepare("UPDATE personal_list_targets SET not_found_passes = 2, missing_since = ?, last_error = 'x' WHERE list_id = ? AND provider = 'plex'").run(now, listId);
  db.prepare("UPDATE personal_lists SET deleted_at = ?, deleted_origin = 'plex' WHERE id = ?").run(now, listId);
  await createPlaylist("Comeback");

  assert.equal((await call("POST", { action: "list-restore", list_id: "missing" })).status, 404);
  const refused = await call("POST", { action: "list-restore", list_id: listId });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "name_taken");
  assert.ok(db.prepare("SELECT deleted_at FROM personal_lists WHERE id = ?").get(listId).deleted_at, "a refused restore changes nothing");
  assert.equal((await call("POST", { action: "list-restore", list_id: listId, name: "comeback" })).body.code, "name_taken");
  assert.equal((await call("POST", { action: "list-restore", list_id: listId, name: " " })).status, 400);
  const restored = await call("POST", { action: "list-restore", list_id: listId, name: "Comeback again" });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.name, "Comeback again");

  const row = db.prepare("SELECT name, deleted_at, deleted_origin FROM personal_lists WHERE id = ?").get(listId);
  assert.deepEqual(row, { name: "Comeback again", deleted_at: null, deleted_origin: null });
  const target = db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ?").all(listId);
  assert.deepEqual(target.map((entry) => [entry.provider, entry.desired_state, entry.not_found_passes, entry.missing_since, entry.last_error]), [["plex", "present", 0, null, null]]);
  const list = (await call("GET")).body.lists.find((entry) => entry.id === listId);
  assert.equal(list.items.length, 1);
  assert.equal((await call("POST", { action: "list-restore", list_id: listId })).status, 404);
});

test("permanent delete waits for connected apps to lose their copy, then clears every record", async () => {
  const listId = await createPlaylist("Purge Me", ["plex"]);
  await call("POST", { action: "list-add", list_id: listId, ...movie(60) });
  db.prepare("UPDATE personal_list_targets SET remote_playlist_id = 'P60' WHERE list_id = ?").run(listId);
  assert.equal((await call("POST", { action: "list-purge", list_id: listId })).status, 404);
  await call("POST", { action: "list-delete", list_id: listId });

  const blocked = await call("POST", { action: "list-purge", list_id: listId });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /still deleting this playlist from Plex/);

  db.prepare("UPDATE personal_list_targets SET remote_playlist_id = NULL WHERE list_id = ?").run(listId);
  assert.equal((await call("POST", { action: "list-purge", list_id: listId })).status, 200);
  for (const table of ["personal_lists", "personal_list_items", "personal_list_targets"]) {
    const column = table === "personal_lists" ? "id" : "list_id";
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(listId).n, 0, table);
  }
  assert.equal((await call("GET")).body.deleted_lists.some((entry) => entry.id === listId), false);
});

test("a copy left in a disconnected app does not block permanent delete", async () => {
  const listId = await createPlaylist("Orphan Emby");
  const now = Date.now();
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, remote_playlist_id, created_at, updated_at) VALUES (?, 'emby', 'E1', ?, ?)").run(listId, now, now);
  await call("POST", { action: "list-delete", list_id: listId });
  assert.equal((await call("POST", { action: "list-purge", list_id: listId })).status, 200);
});

test("held changes are listed and can be confirmed or discarded", async () => {
  const listId = await createPlaylist("Held", ["plex"]);
  const now = Date.now();
  const hold = db.prepare("INSERT INTO personal_list_held_changes (list_id, provider, kind, entry_ids, change_count, reason, held_at) VALUES (?, 'plex', ?, ?, ?, 'many', ?)");
  hold.run(listId, "removals", JSON.stringify(["e1", "e2", "e3"]), 3, now);
  hold.run(listId, "delete", null, 1, now);

  const list = (await call("GET")).body.lists.find((entry) => entry.id === listId);
  assert.deepEqual(list.held_changes.map((entry) => [entry.kind, entry.change_count, entry.confirmed]), [["delete", 1, false], ["removals", 3, false]]);

  assert.equal((await call("POST", { action: "list-held", list_id: listId, provider: "plex", kind: "removals", decision: "maybe" })).status, 400);
  const confirmed = await call("POST", { action: "list-held", list_id: listId, provider: "plex", kind: "delete", decision: "confirm" });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.synced, false);
  assert.ok(db.prepare("SELECT confirmed_at FROM personal_list_held_changes WHERE list_id = ? AND kind = 'delete'").get(listId).confirmed_at);

  assert.equal((await call("POST", { action: "list-held", list_id: listId, provider: "plex", kind: "removals", decision: "discard" })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_list_held_changes WHERE list_id = ? AND kind = 'removals'").get(listId).n, 0);
  assert.equal((await call("POST", { action: "list-held", list_id: listId, provider: "plex", kind: "removals", decision: "discard" })).status, 404);
});

test("automatic playlists: created with a rule, hand edits refused, rule edits, held checks, and Stop updating", async () => {
  const rule = { source: "library", genres: ["Drama"], order: "title" };
  assert.equal((await call("POST", { action: "list-create", name: "Auto Mixed", kind: "mixed", rule })).status, 400);
  const bad = await call("POST", { action: "list-create", name: "Auto Bad", kind: "movie", rule: { source: "catalogue", addedWithinDays: 5 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "invalid_rule");
  const created = await call("POST", { action: "list-create", name: "Auto Drama", kind: "movie", rule, providers: ["plex"] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listId = created.body.list.id;
  assert.equal(created.body.list.rule.genres[0], "Drama");
  assert.equal(created.body.list.rule_hold, null);

  const refusals = [
    { action: "list-add", list_id: listId, ...movie(71) },
    { action: "list-reorder", list_id: listId, order: [] },
    { action: "list-add-episodes", list_id: listId, show: { title: "Show", tmdb_id: "1" }, episodes: [{ season: 1, episode: 1 }] },
  ];
  for (const body of refusals) {
    const response = await call("POST", body);
    assert.equal(response.status, 409, body.action);
    assert.equal(response.body.code, "automatic_playlist");
  }

  // A manual playlist cannot be made automatic; an automatic one can change its rule.
  const manualId = await createPlaylist("Manual For Rules");
  assert.equal((await call("POST", { action: "list-update", list_id: manualId, rule })).body.code, "not_automatic");
  db.prepare("UPDATE personal_lists SET rule_checked_at = 5, rule_error = 'old' WHERE id = ?").run(listId);
  assert.equal((await call("POST", { action: "list-update", list_id: listId, rule: { ...rule, order: "rating" } })).status, 200);
  let row = db.prepare("SELECT * FROM personal_lists WHERE id = ?").get(listId);
  assert.equal(JSON.parse(row.rule_json).order, "rating");
  assert.equal(row.rule_checked_at, null);
  assert.equal(row.rule_error, null);

  // This process is web-only: Refresh now is left to the worker's pass.
  db.prepare("UPDATE personal_lists SET rule_checked_at = 5 WHERE id = ?").run(listId);
  const refreshed = await call("POST", { action: "list-refresh-rule", list_id: listId });
  assert.equal(refreshed.status, 202);
  assert.equal(db.prepare("SELECT rule_checked_at FROM personal_lists WHERE id = ?").get(listId).rule_checked_at, null);
  assert.equal((await call("POST", { action: "list-refresh-rule", list_id: manualId })).status, 400);

  assert.equal((await call("POST", { action: "list-rule-held", list_id: listId, decision: "confirm" })).status, 404);
  db.prepare("UPDATE personal_lists SET rule_hold_json = ?, rule_checked_at = 5 WHERE id = ?").run(JSON.stringify({ removal_count: 4 }), listId);
  const listed = (await call("GET")).body.lists.find((list) => list.id === listId);
  assert.deepEqual(listed.rule_hold, { removal_count: 4, confirmed: false });
  assert.equal((await call("POST", { action: "list-rule-held", list_id: listId, decision: "confirm" })).status, 200);
  row = db.prepare("SELECT * FROM personal_lists WHERE id = ?").get(listId);
  assert.ok(row.rule_hold_confirmed_at);
  assert.equal(row.rule_checked_at, null);
  assert.equal((await call("POST", { action: "list-rule-held", list_id: listId, decision: "discard" })).status, 200);
  assert.equal(db.prepare("SELECT rule_hold_json FROM personal_lists WHERE id = ?").get(listId).rule_hold_json, null);

  assert.equal((await call("POST", { action: "list-stop-rule", list_id: listId })).status, 200);
  assert.equal(db.prepare("SELECT rule_json FROM personal_lists WHERE id = ?").get(listId).rule_json, null);
  assert.equal((await call("POST", { action: "list-add", list_id: listId, ...movie(71) })).status, 200);
  assert.equal((await call("POST", { action: "list-stop-rule", list_id: listId })).status, 400);
});

test("removing from an automatic playlist keeps the title out for good (decision 65)", async () => {
  const { applyPlaylistRuleResult } = await import("../server/src/utils/playlistRuleEngine.js");
  const created = await call("POST", { action: "list-create", name: "Auto TV Remove", kind: "tv", rule: { source: "catalogue", genres: [], order: "newest" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listId = created.body.list.id;
  assert.equal(created.body.list.rule_checking, false);
  const episode = (show, season, number) => ({
    media_key: `episode:tmdb:${show}:s${season}e${number}`, media_type: "episode", title: `Episode ${number}`,
    show_title: `Show ${show}`, tmdb_id: String(show), tvdb_id: "", imdb_id: "", season, episode: number, release_date: "",
  });
  applyPlaylistRuleResult(listId, [episode(500, 1, 1), episode(500, 1, 2), episode(600, 2, 3)]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_list_items WHERE list_id = ?").get(listId).n, 3);

  // The poster menu on a show card (a stack of its episodes) removes the whole show.
  const removed = await call("POST", { action: "list-remove", list_id: listId, media_type: "tv", tmdb_id: "500", title: "Show 500" });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const keys = () => db.prepare("SELECT media_key FROM personal_list_items WHERE list_id = ? ORDER BY media_key").all(listId).map((row) => row.media_key);
  assert.deepEqual(keys(), ["episode:tmdb:600:s2e3"]);
  assert.ok(db.prepare("SELECT 1 FROM personal_list_handoffs WHERE list_id = ? AND identity = 'show:tmdb:500'").get(listId));

  // A later check (or one that read before the removal) never adds the show back.
  applyPlaylistRuleResult(listId, [episode(500, 1, 2), episode(600, 2, 3)]);
  assert.deepEqual(keys(), ["episode:tmdb:600:s2e3"]);
});
