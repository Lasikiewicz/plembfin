import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";
import { fakeProvider, statusError } from "./playlistFakes.js";

makeTempDataDir("plembfin-playlist-import-");

const { db } = await import("../server/src/db.js");
const {
  guessPlaylistKind,
  importAppPlaylists,
  importedPlaylistName,
  listPlaylistImportCandidates,
  mergedPlaylistKind,
  playlistKindsCompatible,
} = await import("../server/src/utils/playlistImport.js");
const { syncPlaylist } = await import("../server/src/utils/playlistPullEngine.js");

const config = {
  plex: { baseUrl: "http://plex.test", token: "t" },
  emby: { baseUrl: "http://emby.test", apiKey: "k", userId: "u" },
  jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "k", userId: "u" },
};

const entries = (...types) => types.map((type, index) => ({ entryId: `e${index}`, itemId: `i${index}`, type }));

// apps[provider]: { playlists: [{ id, title, smart?, entries | Error }] } or an Error.
function clients(apps) {
  const calls = [];
  const clientFor = (provider) => ({
    provider,
    async fetchPlaylists() {
      calls.push([provider, "fetchPlaylists"]);
      const app = apps[provider];
      if (app instanceof Error) throw app;
      return (app?.playlists || []).map(({ id, title, smart = false, entries: items }) => ({
        id, title, smart, itemCount: Array.isArray(items) ? items.length : 0,
      }));
    },
    async fetchPlaylistItems(_config, id) {
      calls.push([provider, "fetchPlaylistItems", id]);
      const items = apps[provider].playlists.find((playlist) => playlist.id === id).entries;
      if (items instanceof Error) throw items;
      return items;
    },
  });
  return { clientFor, calls };
}

function addList(id, name, kind = null, { deleted = false } = {}) {
  const now = Date.now();
  db.prepare("INSERT INTO personal_lists (id, name, kind, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, kind, now, now, deleted ? now : null);
}

function linkTarget(listId, provider, remoteId) {
  const now = Date.now();
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, remote_playlist_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(listId, provider, remoteId, now, now);
}

function reset() {
  db.prepare("DELETE FROM personal_lists").run();
}

const byId = (result) => new Map(result.apps.flatMap((app) => app.playlists).map((candidate) => [`${candidate.provider}:${candidate.id}`, candidate]));

test("type guess from the entry types", () => {
  assert.equal(guessPlaylistKind(entries("movie", "movie")), "movie");
  assert.equal(guessPlaylistKind(entries("episode")), "tv");
  assert.equal(guessPlaylistKind(entries("episode", "movie")), "mixed");
  assert.equal(guessPlaylistKind([]), "empty");
  assert.equal(guessPlaylistKind(entries("clip", "video")), "empty");
  assert.equal(guessPlaylistKind(entries("clip", "movie")), "movie");
});

test("merge compatibility: same type, Mixed, untyped, or an empty app playlist", () => {
  assert.equal(playlistKindsCompatible("movie", "movie"), true);
  assert.equal(playlistKindsCompatible("movie", "tv"), false);
  assert.equal(playlistKindsCompatible("tv", "mixed"), false);
  assert.equal(playlistKindsCompatible("mixed", "tv"), true);
  assert.equal(playlistKindsCompatible(null, "mixed"), true);
  assert.equal(playlistKindsCompatible("tv", "empty"), true);
});

test("candidates leave out smart and already-linked playlists, including soft-deleted links", async () => {
  reset();
  addList("live", "Linked Live", "movie");
  linkTarget("live", "plex", "p1");
  addList("gone", "Linked Deleted", "movie", { deleted: true });
  linkTarget("gone", "emby", "e1");
  // Same remote id on a different app is a different playlist.
  const { clientFor } = clients({
    plex: { playlists: [
      { id: "p1", title: "Linked Live", entries: entries("movie") },
      { id: "p2", title: "Smart One", smart: true, entries: entries("movie") },
      { id: "p3", title: "Smart Two", smart: true, entries: entries("movie") },
      { id: "p4", title: "Films", entries: entries("movie", "movie", "clip") },
    ] },
    emby: { playlists: [
      { id: "e1", title: "Linked Deleted", entries: entries("movie") },
      { id: "p1", title: "Shows", entries: entries("episode", "episode") },
    ] },
    jellyfin: { playlists: [{ id: "j1", title: "Nothing Yet", entries: [] }] },
  });
  const result = await listPlaylistImportCandidates({ config, clientFor });
  const plex = result.apps.find((app) => app.provider === "plex");
  assert.equal(plex.status, "ok");
  assert.equal(plex.smart_skipped, 2);
  assert.deepEqual([...byId(result).keys()].sort(), ["emby:p1", "jellyfin:j1", "plex:p4"]);
  const films = byId(result).get("plex:p4");
  assert.equal(films.title, "Films");
  assert.equal(films.item_count, 3);
  assert.equal(films.kind_guess, "movie");
  assert.equal(films.other_count, 1);
  assert.equal(byId(result).get("emby:p1").kind_guess, "tv");
  assert.equal(byId(result).get("jellyfin:j1").kind_guess, "empty");
  assert.equal(byId(result).get("jellyfin:j1").item_count, 0);
});

test("a failing app is reported with its error, not as an empty list; a failing items read marks only that playlist", async () => {
  reset();
  const { clientFor } = clients({
    plex: statusError(503),
    emby: { playlists: [
      { id: "e1", title: "Broken", entries: statusError(500) },
      { id: "e2", title: "Fine", entries: entries("movie") },
    ] },
    jellyfin: { playlists: [] },
  });
  const result = await listPlaylistImportCandidates({ config, clientFor });
  const plex = result.apps.find((app) => app.provider === "plex");
  assert.equal(plex.status, "error");
  assert.match(plex.error, /503/);
  const broken = byId(result).get("emby:e1");
  assert.match(broken.error, /500/);
  assert.equal(broken.kind_guess, null);
  assert.equal(broken.clash.merge_into, null);
  assert.equal(byId(result).get("emby:e2").kind_guess, "movie");
  assert.equal(result.apps.find((app) => app.provider === "jellyfin").status, "ok");
});

test("only connected apps are read", async () => {
  reset();
  const { clientFor, calls } = clients({ plex: { playlists: [] }, emby: { playlists: [] }, jellyfin: { playlists: [] } });
  const result = await listPlaylistImportCandidates({
    config: { plex: config.plex, emby: { ...config.emby, disabled: true }, jellyfin: { baseUrl: "http://jellyfin.test" } },
    clientFor,
  });
  assert.deepEqual(result.apps.map((app) => app.provider), ["plex"]);
  assert.deepEqual([...new Set(calls.map(([provider]) => provider))], ["plex"]);
});

test("name clash hints: compatible Plembfin playlist, incompatible name taken, same name across apps", async () => {
  reset();
  addList("fav", "Favourites", "movie");
  addList("mix", "Weekend", "mixed");
  addList("gone", "Old Name", "movie", { deleted: true });
  const { clientFor } = clients({
    plex: { playlists: [
      { id: "p1", title: " favourites ", entries: entries("movie") },
      { id: "p2", title: "Weekend", entries: entries("episode") },
      { id: "p3", title: "Old Name", entries: entries("movie") },
    ] },
    emby: { playlists: [{ id: "e1", title: "FAVOURITES", entries: entries("episode") }] },
    jellyfin: { playlists: [{ id: "j1", title: "Favourites", entries: [] }] },
  });
  const result = await listPlaylistImportCandidates({ config, clientFor });
  const candidates = byId(result);

  const plexFav = candidates.get("plex:p1");
  assert.equal(plexFav.clash.name_taken, true);
  assert.deepEqual(plexFav.clash.merge_into, { id: "fav", name: "Favourites", kind: "movie" });
  assert.deepEqual(plexFav.clash.same_name, [{ provider: "emby", id: "e1" }, { provider: "jellyfin", id: "j1" }]);

  // A TV app playlist cannot merge into a Movies playlist, but the name is taken.
  const embyFav = candidates.get("emby:e1");
  assert.equal(embyFav.clash.name_taken, true);
  assert.equal(embyFav.clash.merge_into, null);
  assert.deepEqual(embyFav.clash.same_name, [{ provider: "plex", id: "p1" }, { provider: "jellyfin", id: "j1" }]);

  // An empty app playlist fits any type.
  assert.equal(candidates.get("jellyfin:j1").clash.merge_into?.id, "fav");
  // Mixed takes episodes.
  assert.equal(candidates.get("plex:p2").clash.merge_into?.id, "mix");
  // A soft-deleted playlist's name is free.
  assert.deepEqual(candidates.get("plex:p3").clash, { name_taken: false, merge_into: null, same_name: [] });
});

test("merge is not offered into a playlist that already has a playlist in that app", async () => {
  reset();
  addList("fav", "Favourites", "movie");
  linkTarget("fav", "plex", "p-old");
  const { clientFor } = clients({
    plex: { playlists: [{ id: "p1", title: "Favourites", entries: entries("movie") }] },
    emby: { playlists: [{ id: "e1", title: "Favourites", entries: entries("movie") }] },
  });
  const candidates = byId(await listPlaylistImportCandidates({ config: { plex: config.plex, emby: config.emby }, clientFor }));
  assert.equal(candidates.get("plex:p1").clash.merge_into, null);
  assert.equal(candidates.get("plex:p1").clash.name_taken, true);
  assert.equal(candidates.get("emby:e1").clash.merge_into?.id, "fav");
});

// Import: fake apps with typed entries, the real pull and push engines.
// identities[itemId] is what the app says an entry is; library[provider] maps
// a Plembfin media key to that app's item id.
const movie = (tmdb) => ({ media_type: "movie", title: `Movie ${tmdb}`, tmdb_id: String(tmdb), tvdb_id: "", imdb_id: "" });
const episode = (show, season, number) => ({
  media_type: "episode", title: `Ep ${number}`, show_title: show, show_tmdb_id: "900", show_tvdb_id: "", show_imdb_id: "", season, episode: number,
});

function importSetup({ identities = {}, library = {} } = {}) {
  const fakes = { plex: fakeProvider("plex"), emby: fakeProvider("emby"), jellyfin: fakeProvider("jellyfin") };
  const deps = {
    client: (provider) => fakes[provider].client,
    resolveItemId: async (provider, _config, row) => library[provider]?.[row.media_key] ?? "",
    identifyEntry: async (_provider, _config, entry) => identities[entry.itemId] ?? null,
  };
  const appPlaylist = (provider, id, title, items) => {
    fakes[provider].state.playlists.set(id, {
      title,
      entries: items.map(([itemId, type], index) => ({ entryId: `${id}-e${index}`, itemId, type })),
    });
  };
  const run = (picks) => importAppPlaylists(picks, {
    config,
    clientFor: (provider) => fakes[provider].client,
    syncList: (listId) => syncPlaylist(listId, { config, deps }),
  });
  return { fakes, appPlaylist, run };
}

const listRow = (id) => db.prepare("SELECT * FROM personal_lists WHERE id = ?").get(id);
const listKeys = (id) => db.prepare("SELECT media_key FROM personal_list_items WHERE list_id = ? ORDER BY position").all(id).map((row) => row.media_key);
const targetRows = (id) => db.prepare("SELECT provider, remote_playlist_id FROM personal_list_targets WHERE list_id = ? ORDER BY provider").all(id)
  .map((row) => ({ ...row }));
const listCount = () => db.prepare("SELECT COUNT(*) AS n FROM personal_lists").get().n;
const removals = (fake) => fake.state.calls.filter(([name]) => name === "removePlaylistItems");

test("helpers: merged type and the app-suffixed name", () => {
  assert.equal(mergedPlaylistKind(["movie", "empty"]), "movie");
  assert.equal(mergedPlaylistKind(["movie", "mixed"]), "mixed");
  assert.equal(mergedPlaylistKind(["empty"]), null);
  assert.equal(mergedPlaylistKind(["movie", "tv"]), undefined);
  assert.equal(importedPlaylistName("Films", "plex"), "Films (Plex)");
  assert.equal(importedPlaylistName("Films", "plex", new Set(["films (plex)"])), "Films (Plex 2)");
  assert.equal(importedPlaylistName("x".repeat(100), "jellyfin").length, 100);
});

test("import separately: new playlist of the guessed type, every entry in app order, other ticked app gets a copy, nothing removed", async () => {
  reset();
  const { fakes, appPlaylist, run } = importSetup({
    identities: { PB: movie(2), PA: movie(1) },
    library: {
      plex: { "movie:tmdb:1": "PA", "movie:tmdb:2": "PB" },
      jellyfin: { "movie:tmdb:1": "JA", "movie:tmdb:2": "JB" },
    },
  });
  appPlaylist("plex", "p1", "Films", [["PB", "movie"], ["PA", "movie"], ["HOME", "clip"]]);
  const result = await run([{ provider: "plex", remote_playlist_id: "p1", mode: "separate", targets: ["plex", "jellyfin"] }]);

  const [entry] = result.imported;
  assert.equal(entry.name, "Films");
  assert.equal(entry.created, true);
  assert.equal(listRow(entry.list_id).kind, "movie");
  assert.deepEqual(listKeys(entry.list_id), ["movie:tmdb:2", "movie:tmdb:1"]);
  assert.deepEqual(result.lists, [{ list_id: entry.list_id, name: "Films", added: 2, unidentified: 1, errors: [] }]);
  // The unidentified entry stays in the app, and nothing was removed.
  assert.deepEqual(fakes.plex.items("p1"), ["PB", "PA", "HOME"]);
  assert.deepEqual(removals(fakes.plex), []);
  const targets = targetRows(entry.list_id);
  assert.deepEqual(targets.map((row) => row.provider), ["jellyfin", "plex"]);
  assert.equal(targets.find((row) => row.provider === "plex").remote_playlist_id, "p1");
  assert.deepEqual(fakes.jellyfin.items(targets.find((row) => row.provider === "jellyfin").remote_playlist_id), ["JB", "JA"]);
  // Emby was not ticked: never touched.
  assert.deepEqual(fakes.emby.state.calls, []);
  // Plex kept its name: no rename.
  assert.equal(fakes.plex.state.calls.some(([name]) => name === "renamePlaylist"), false);
});

test("import separately on a name clash: Name (App), for a taken name and for two picks of one name", async () => {
  reset();
  addList("films", "Films", "movie");
  const { fakes, appPlaylist, run } = importSetup({
    identities: { PA: movie(1), EP: episode("Show", 1, 1), PE: episode("Show", 1, 2) },
    library: { plex: { "movie:tmdb:1": "PA" } },
  });
  appPlaylist("plex", "p1", "films", [["PA", "movie"]]);
  appPlaylist("plex", "p2", "Shows", [["PE", "episode"]]);
  appPlaylist("emby", "e1", "Shows", [["EP", "episode"]]);
  const result = await run([
    { provider: "plex", remote_playlist_id: "p1", mode: "separate" },
    { provider: "plex", remote_playlist_id: "p2", mode: "separate" },
    { provider: "emby", remote_playlist_id: "e1", mode: "separate" },
  ]);
  assert.deepEqual(result.imported.map((entry) => entry.name), ["films (Plex)", "Shows (Plex)", "Shows (Emby)"]);
  assert.equal(listRow(result.imported[1].list_id).kind, "tv");
  // The Plembfin name reaches the app.
  assert.equal(fakes.plex.state.playlists.get("p1").title, "films (Plex)");
  assert.equal(listRow("films").name, "Films");
});

test("merge into an existing playlist: union on both sides, Plembfin order kept, app-only entry placed, nothing removed", async () => {
  reset();
  addList("fav", "Favourites", "movie");
  const now = Date.now();
  db.prepare(`
    INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, position, created_at, updated_at)
    VALUES ('fav', 'movie:tmdb:1', 'movie', 'Movie 1', '1', 0, ?, ?), ('fav', 'movie:tmdb:3', 'movie', 'Movie 3', '3', 1, ?, ?)
  `).run(now, now, now, now);
  const { fakes, appPlaylist, run } = importSetup({
    identities: { P1: movie(1), P2: movie(2) },
    library: { plex: { "movie:tmdb:1": "P1", "movie:tmdb:2": "P2", "movie:tmdb:3": "P3" } },
  });
  appPlaylist("plex", "p1", "favourites", [["P1", "movie"], ["P2", "movie"]]);
  const result = await run([{ provider: "plex", remote_playlist_id: "p1", mode: "merge", merge_into: "fav" }]);

  assert.equal(result.imported[0].list_id, "fav");
  assert.equal(result.imported[0].created, false);
  assert.equal(listCount(), 1);
  assert.deepEqual(listKeys("fav"), ["movie:tmdb:1", "movie:tmdb:2", "movie:tmdb:3"]);
  assert.deepEqual(fakes.plex.items("p1").sort(), ["P1", "P2", "P3"]);
  assert.deepEqual(removals(fakes.plex), []);
  assert.equal(listRow("fav").name, "Favourites");
  assert.equal(fakes.plex.state.playlists.get("p1").title, "Favourites");
});

test("two same-name picks merge into one new playlist; a movie and a mixed one make it Mixed", async () => {
  reset();
  const { fakes, appPlaylist, run } = importSetup({
    identities: { PA: movie(1), EE: episode("Show", 1, 1), EA: movie(1) },
    library: { plex: { "movie:tmdb:1": "PA" }, emby: { "movie:tmdb:1": "EA" } },
  });
  appPlaylist("plex", "p1", "Weekend", [["PA", "movie"]]);
  appPlaylist("emby", "e1", "weekend", [["EE", "episode"], ["EA", "movie"]]);
  const result = await run([
    { provider: "plex", remote_playlist_id: "p1", mode: "merge" },
    { provider: "emby", remote_playlist_id: "e1", mode: "merge" },
  ]);
  const listId = result.imported[0].list_id;
  assert.equal(result.imported[1].list_id, listId);
  assert.equal(listCount(), 1);
  assert.equal(listRow(listId).name, "Weekend");
  assert.equal(listRow(listId).kind, "mixed");
  assert.deepEqual(targetRows(listId), [{ provider: "emby", remote_playlist_id: "e1" }, { provider: "plex", remote_playlist_id: "p1" }]);
  assert.equal(listKeys(listId).length, 2);
  assert.ok(fakes.emby.items("e1").includes("EA"));
  assert.deepEqual([...removals(fakes.plex), ...removals(fakes.emby)], []);
});

test("refusals change nothing: already linked, movies merged with TV, a playlist that already has that app, not connected", async () => {
  reset();
  addList("fav", "Favourites", "movie");
  linkTarget("fav", "plex", "p-linked");
  const { appPlaylist, run } = importSetup();
  appPlaylist("plex", "p-linked", "Favourites", [["PA", "movie"]]);
  appPlaylist("plex", "p1", "Films", [["PA", "movie"]]);
  appPlaylist("emby", "e1", "films", [["EE", "episode"]]);
  appPlaylist("emby", "e2", "Other", [["EA", "movie"]]);
  const before = { lists: listCount(), targets: db.prepare("SELECT COUNT(*) AS n FROM personal_list_targets").get().n };
  const code = async (picks) => {
    try {
      await run(picks);
    } catch (error) {
      return error.publicCode;
    }
    return "ok";
  };

  // A new pick first, so a refusal later in the same import must roll it back.
  assert.equal(await code([
    { provider: "emby", remote_playlist_id: "e2", mode: "separate" },
    { provider: "plex", remote_playlist_id: "p-linked", mode: "separate" },
  ]), "already_linked");
  assert.equal(await code([
    { provider: "plex", remote_playlist_id: "p1", mode: "merge" },
    { provider: "emby", remote_playlist_id: "e1", mode: "merge" },
  ]), "kinds_differ");
  assert.equal(await code([{ provider: "plex", remote_playlist_id: "p1", mode: "merge", merge_into: "fav" }]), "app_taken");
  assert.equal(await code([{ provider: "emby", remote_playlist_id: "e2", mode: "separate", targets: ["emby", "nope"] }]), "bad_target");
  assert.equal(await importAppPlaylists([{ provider: "emby", remote_playlist_id: "e2", targets: ["jellyfin"] }], {
    config: { emby: config.emby },
    clientFor: () => { throw new Error("must not read"); },
  }).catch((error) => error.publicCode), "not_connected");
  assert.deepEqual({ lists: listCount(), targets: db.prepare("SELECT COUNT(*) AS n FROM personal_list_targets").get().n }, before);
});

test("listing never writes", async () => {
  reset();
  addList("fav", "Favourites", "movie");
  const before = db.prepare("SELECT COUNT(*) AS n FROM personal_list_targets").get().n;
  const { calls, clientFor } = clients({ plex: { playlists: [{ id: "p1", title: "Favourites", entries: entries("movie") }] } });
  await listPlaylistImportCandidates({ config: { plex: config.plex }, clientFor });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_list_targets").get().n, before);
  assert.deepEqual(calls.map(([, name]) => name), ["fetchPlaylists", "fetchPlaylistItems"]);
});
