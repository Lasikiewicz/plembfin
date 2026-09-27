import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-playlist-watched-");

const { db } = await import("../server/src/db.js");
const { checkDuePlaylistRules, checkPlaylistRule, fetchShowNextEpisode, normalizePlaylistRule } = await import("../server/src/utils/playlistRuleEngine.js");
const { automaticPlaylistsToMoveOn, readHandoffKeys, readWatchIndex, removeWatchedFromPlaylist, removeWatchedPlaylistItems } = await import("../server/src/utils/playlistWatched.js");
const { genreKey } = await import("../server/src/utils/playlistRuleCatalogue.js");

const config = { plex: { baseUrl: "http://plex.test", token: "t" } };
const NOW = Date.parse("2026-09-26T12:00:00Z");
const ADDED = NOW;
const AFTER = "2026-09-27T10:00:00Z";
const BEFORE = "2026-09-01T10:00:00Z";

let counter = 0;
function createList({ kind = "movie", removeWatched = 1, rule = null } = {}) {
  const id = `watched-${++counter}`;
  db.prepare("INSERT INTO personal_lists (id, name, kind, rule_json, remove_watched, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)")
    .run(id, `Watched ${counter}`, kind, rule ? JSON.stringify(normalizePlaylistRule(rule, kind)) : null, removeWatched);
  return id;
}

function addItem(listId, { key, type = "movie", tmdb, season = null, episode = null, createdAt = ADDED }) {
  const position = db.prepare("SELECT COUNT(*) AS n FROM personal_list_items WHERE list_id = ?").get(listId).n;
  db.prepare(`INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, season, episode, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(listId, key, type, key, String(tmdb), season, episode, position, createdAt, createdAt);
}

let watchCounter = 0;
function watch({ type = "movie", tmdb, season = null, episode = null, at = AFTER, action = "watched", telemetry = null }) {
  db.prepare(`INSERT INTO watch_history (id, title, media_type, watched_at, tmdb_id, season, episode, sync_action, sync_dispatch_telemetry, created_at, updated_at)
    VALUES (?, 'T', ?, ?, ?, ?, ?, ?, ?, 1, 1)`).run(`wh-${++watchCounter}`, type, at, String(tmdb), season, episode, action, telemetry);
}

const keys = (listId) => db.prepare("SELECT media_key FROM personal_list_items WHERE list_id = ? ORDER BY position").all(listId).map((row) => row.media_key);

test("only a watch after the item was added removes it, and only with the switch on", async () => {
  const id = createList();
  addItem(id, { key: "movie:tmdb:1001", tmdb: 1001 });
  addItem(id, { key: "movie:tmdb:1002", tmdb: 1002 });
  addItem(id, { key: "movie:tmdb:1003", tmdb: 1003 });
  addItem(id, { key: "movie:tmdb:1004", tmdb: 1004 });
  watch({ tmdb: 1001 });
  // Seen before it was added, for a rewatch (decision 57).
  watch({ tmdb: 1002, at: BEFORE });
  // An unscoped library scan row is not a watch.
  watch({ tmdb: 1003, telemetry: "Watch event fetched from Plex library history" });
  const off = createList({ removeWatched: 0 });
  addItem(off, { key: "movie:tmdb:1001", tmdb: 1001 });

  const results = await removeWatchedPlaylistItems({ now: NOW + 1 });
  assert.deepEqual(keys(id), ["movie:tmdb:1002", "movie:tmdb:1003", "movie:tmdb:1004"]);
  assert.deepEqual(keys(off), ["movie:tmdb:1001"]);
  assert.equal(results.find((entry) => entry.listId === id).removed, 1);
  assert.ok(!results.some((entry) => entry.listId === off));
  // A hand-picked playlist hands nothing off.
  assert.equal(readHandoffKeys(id).size, 0);
  assert.ok(db.prepare("SELECT order_updated_at FROM personal_lists WHERE id = ?").get(id).order_updated_at);
});

test("a hand-picked episode leaves on its own; the rest of the show stays", async () => {
  const id = createList({ kind: "tv" });
  addItem(id, { key: "ep-1", type: "episode", tmdb: 2001, season: 1, episode: 1 });
  addItem(id, { key: "ep-2", type: "episode", tmdb: 2001, season: 1, episode: 2 });
  watch({ type: "episode", tmdb: 2001, season: 1, episode: 1 });
  const result = await removeWatchedFromPlaylist(id, { now: NOW + 1 });
  assert.equal(result.removed, 1);
  assert.deepEqual(keys(id), ["ep-2"]);
});

test("automatic TV with the switch on hands a watched show to Up Next for good", async () => {
  const catalogues = { plex: { status: "ok", items: [3001, 3002].map((tmdb) => ({
    provider: "plex", item_id: `plex-${tmdb}`, media_type: "tv", title: `Show ${tmdb}`, year: 2020, release_date: "",
    genres: ["Drama"], genre_keys: [genreKey("Drama")], added_at: NOW - 1000, rating: null, ids: { tmdb: String(tmdb), tvdb: "", imdb: "" },
  })) } };
  const seriesEpisodes = async (_provider, _config, seriesId) => [
    { season: 1, episode: 1, title: `${seriesId} E1` }, { season: 1, episode: 2, title: `${seriesId} E2` },
  ];
  const deps = { readCatalogues: async () => catalogues, seriesEpisodes, now: () => NOW };
  const id = createList({ kind: "tv", rule: { order: "title" } });
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, 'plex', 1, 1)").run(id);
  await checkPlaylistRule(id, { config, deps });
  const titles = () => db.prepare("SELECT title FROM personal_list_items WHERE list_id = ? ORDER BY position").all(id).map((row) => row.title);
  assert.deepEqual(titles(), ["plex-3001 E1", "plex-3002 E1"]);

  watch({ type: "episode", tmdb: 3001, season: 1, episode: 1 });
  await checkPlaylistRule(id, { config, deps });
  // Removed and never added back, not even as its next episode.
  assert.deepEqual(titles(), ["plex-3002 E1"]);
  assert.ok(readHandoffKeys(id).has("show:tmdb:3001"));

  // Unwatching it, or editing the rule, does not bring it back.
  watch({ type: "episode", tmdb: 3001, season: 1, episode: 1, at: "2026-09-28T10:00:00Z", action: "unwatched" });
  db.prepare("UPDATE personal_lists SET rule_json = ? WHERE id = ?").run(JSON.stringify(normalizePlaylistRule({ order: "newest" }, "tv")), id);
  await checkPlaylistRule(id, { config, deps });
  assert.deepEqual(titles(), ["plex-3002 E1"]);

  // With the switch off, the show moves on to its next episode instead.
  const off = createList({ kind: "tv", removeWatched: 0, rule: { order: "title" } });
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, 'plex', 1, 1)").run(off);
  watch({ type: "episode", tmdb: 3002, season: 1, episode: 1 });
  await checkPlaylistRule(off, { config, deps });
  const offTitles = db.prepare("SELECT title FROM personal_list_items WHERE list_id = ? ORDER BY position").all(off).map((row) => row.title);
  assert.deepEqual(offTitles, ["plex-3001 E1", "plex-3002 E2"]);
});

test("automatic movies with the switch on keep a watched movie out", async () => {
  const catalogues = { plex: { status: "ok", items: [4001, 4002].map((tmdb) => ({
    provider: "plex", item_id: `plex-${tmdb}`, media_type: "movie", title: `Movie ${tmdb}`, year: 2020, release_date: "",
    genres: [], genre_keys: [], added_at: NOW - 1000, rating: null, ids: { tmdb: String(tmdb), tvdb: "", imdb: "" },
  })) } };
  const deps = { readCatalogues: async () => catalogues, now: () => NOW };
  const id = createList({ rule: { order: "title" } });
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, 'plex', 1, 1)").run(id);
  await checkPlaylistRule(id, { config, deps });
  watch({ tmdb: 4001 });
  await checkPlaylistRule(id, { config, deps });
  assert.deepEqual(keys(id), ["movie:tmdb:4002"]);
  assert.ok(readHandoffKeys(id).has("movie:tmdb:4001"));
});

test("with the switch off, a watch moves the show on at the next pass, not an hour later", async () => {
  const catalogues = { plex: { status: "ok", items: [7001, 7002].map((tmdb) => ({
    provider: "plex", item_id: `plex-${tmdb}`, media_type: "tv", title: `Show ${tmdb}`, year: 2020, release_date: "",
    genres: ["Drama"], genre_keys: [genreKey("Drama")], added_at: NOW - 1000, rating: null, ids: { tmdb: String(tmdb), tvdb: "", imdb: "" },
  })) } };
  const seriesEpisodes = async (_provider, _config, seriesId) => [1, 2, 3].map((episode) => ({ season: 1, episode, title: `${seriesId} E${episode}` }));
  const deps = { readCatalogues: async () => catalogues, seriesEpisodes, now: () => NOW };
  const off = createList({ kind: "tv", removeWatched: 0, rule: { order: "title" } });
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, 'plex', 1, 1)").run(off);
  await checkPlaylistRule(off, { config, deps });
  const titles = () => db.prepare("SELECT title FROM personal_list_items WHERE list_id = ? ORDER BY position").all(off).map((row) => row.title);
  assert.deepEqual(titles(), ["plex-7001 E1", "plex-7002 E1"]);
  // Checked a minute ago: not due its hourly check, and nothing watched yet.
  const soon = NOW + 60_000;
  assert.ok(!automaticPlaylistsToMoveOn().includes(off));
  assert.ok(!(await checkDuePlaylistRules({ config, deps, now: soon })).some((entry) => entry.listId === off));

  watch({ type: "episode", tmdb: 7001, season: 1, episode: 1 });
  assert.ok(automaticPlaylistsToMoveOn().includes(off));
  const moved = await checkDuePlaylistRules({ config, deps, now: soon });
  assert.equal(moved.find((entry) => entry.listId === off)?.status, "changed");
  assert.deepEqual(titles(), ["plex-7001 E2", "plex-7002 E1"]);
  assert.ok(!automaticPlaylistsToMoveOn().includes(off));

  // A check that fails is not repeated every pass for the same watch; the
  // hourly check retries it. A new watch tries again.
  watch({ type: "episode", tmdb: 7002, season: 1, episode: 1 });
  const failing = { ...deps, readCatalogues: async () => { throw new Error("app down"); } };
  assert.equal((await checkDuePlaylistRules({ config, deps: failing, now: soon })).find((entry) => entry.listId === off)?.status, "error");
  assert.ok(!(await checkDuePlaylistRules({ config, deps: failing, now: soon })).some((entry) => entry.listId === off));
  watch({ type: "episode", tmdb: 7001, season: 1, episode: 2 });
  assert.equal((await checkDuePlaylistRules({ config, deps, now: soon })).find((entry) => entry.listId === off)?.status, "changed");
  assert.deepEqual(titles(), ["plex-7001 E3", "plex-7002 E2"]);

  // Switch on, or hand-picked: Remove items once watched handles those.
  const on = createList({ kind: "tv", removeWatched: 1, rule: { order: "title" } });
  addItem(on, { key: "on-ep", type: "episode", tmdb: 7002, season: 1, episode: 1 });
  const picked = createList({ kind: "tv", removeWatched: 0 });
  addItem(picked, { key: "picked-ep", type: "episode", tmdb: 7002, season: 1, episode: 1 });
  const candidates = automaticPlaylistsToMoveOn();
  assert.ok(!candidates.includes(on));
  assert.ok(!candidates.includes(picked));
});

test("the watch index gives watch times and the furthest episode, specials left out", () => {
  watch({ type: "episode", tmdb: 5001, season: 2, episode: 3 });
  watch({ type: "episode", tmdb: 5001, season: 1, episode: 9 });
  watch({ type: "episode", tmdb: 5001, season: 3, episode: 1, action: "unwatched" });
  watch({ type: "episode", tmdb: 5001, season: 0, episode: 7 });
  const index = readWatchIndex();
  assert.deepEqual(index.furthestEpisode({ tmdb: "5001" }), { season: 2, episode: 3 });
  assert.equal(index.furthestEpisode({ tmdb: "5999" }), null);
  assert.equal(index.episodeWatchedAt({ tmdb: "5001" }, 2, 3), Date.parse(AFTER));
  assert.equal(index.episodeWatchedAt({ tmdb: "5001" }, 3, 1), null);
});

test("a catalogue show's next episode reads only the seasons it needs", async () => {
  const seasons = [];
  const deps = {
    getDetails: async () => ({ id: 77, external_ids: { tvdb_id: 700 }, seasons: [0, 1, 2, 3].map((season_number) => ({ season_number })) }),
    getSeason: async ({ seasonNumber, tvdbId }) => {
      seasons.push(seasonNumber);
      assert.equal(tvdbId, "700");
      const air = { 1: "2020-01-01", 2: "2021-01-01", 3: "2027-01-01" }[seasonNumber];
      return { episodes: [1, 2].map((episode_number) => ({ episode_number, name: `S${seasonNumber}E${episode_number}`, air_date: air })) };
    },
  };
  const today = "2026-09-26";
  assert.equal((await fetchShowNextEpisode({ tmdb_id: "77" }, null, today, deps)).title, "S1E1");
  assert.deepEqual(seasons, [1]);
  seasons.length = 0;
  assert.equal((await fetchShowNextEpisode({ tmdb_id: "77" }, { season: 1, episode: 2 }, today, deps)).title, "S2E1");
  assert.deepEqual(seasons, [1, 2]);
  seasons.length = 0;
  // The next episode has not aired: the show is left out.
  assert.equal(await fetchShowNextEpisode({ tmdb_id: "77" }, { season: 2, episode: 2 }, today, deps), null);
  assert.deepEqual(seasons, [2, 3]);
});
