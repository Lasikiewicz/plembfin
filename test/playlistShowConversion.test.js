import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-playlist-conversion-");

const { db } = await import("../server/src/db.js");
const { convertAllPlaylistShows, convertPlaylistShows, fetchShowEpisodes } = await import("../server/src/utils/playlistShowConversion.js");

// seasons[tmdbId]: { seasonNumber: [episode numbers] } or an Error per season.
function metadata(seasons) {
  return {
    getDetails: async ({ tmdbId }) => ({
      id: tmdbId,
      external_ids: { tvdb_id: `tvdb-${tmdbId}` },
      seasons: Object.keys(seasons[tmdbId] || {}).map((number) => ({ season_number: Number(number) })),
    }),
    getSeason: async ({ tmdbId, seasonNumber }) => {
      const value = seasons[tmdbId][seasonNumber];
      if (value instanceof Error) throw value;
      return { episodes: value.map((number) => ({ episode_number: number, name: `S${seasonNumber}E${number}`, air_date: "2030-01-01" })) };
    },
  };
}

let counter = 0;
function createList(items, { kind = "tv", targets = [] } = {}) {
  const id = `conv-${++counter}`;
  db.prepare("INSERT INTO personal_lists (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(id, `Conv ${counter}`, kind);
  items.forEach(([key, type, tmdb, season = null, episode = null], position) => {
    db.prepare(`INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, show_title, season, episode, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`).run(id, key, type, key, tmdb, type === "episode" ? "Show" : null, season, episode, position);
  });
  for (const provider of targets) {
    db.prepare("INSERT INTO personal_list_targets (list_id, provider, remote_playlist_id, created_at, updated_at) VALUES (?, ?, 'remote', 1, 1)").run(id, provider);
  }
  return id;
}

const order = (listId) => db.prepare("SELECT media_key, position FROM personal_list_items WHERE list_id = ? ORDER BY position").all(listId)
  .map((row) => row.media_key);

test("a show becomes every listed episode at its place, minus exclusions, keeping episodes already there", async () => {
  const listId = createList([
    ["episode:tmdb:1:s9e9", "episode", "1", 9, 9],
    ["tv:tmdb:7", "tv", "7"],
    ["episode:tmdb:7:s1e2", "episode", "7", 1, 2],
  ], { targets: ["plex"] });
  db.prepare("INSERT INTO personal_list_item_exclusions (list_id, media_key, season, episode, origin, excluded_at) VALUES (?, 'tv:tmdb:7', 1, 3, 'plex', 1)").run(listId);
  db.prepare(`INSERT INTO personal_list_entry_ledger (list_id, provider, remote_entry_id, provider_item_id, media_key, season, episode, remote_position, origin, first_seen_at, last_seen_at)
    VALUES (?, 'plex', 'e1', 'rk1', 'tv:tmdb:7', 1, 1, 0, 'plembfin', 1, 1)`).run(listId);

  // Specials and unaired episodes count (decision 17).
  const results = await convertPlaylistShows(listId, { deps: metadata({ 7: { 0: [1], 1: [1, 2, 3] } }) });
  assert.deepEqual(results.map((row) => [row.status, row.added]), [["converted", 2]]);
  assert.deepEqual(order(listId), ["episode:tmdb:1:s9e9", "episode:tmdb:7:s0e1", "episode:tmdb:7:s1e1", "episode:tmdb:7:s1e2"]);
  const added = db.prepare("SELECT title, tmdb_id, show_title, release_date FROM personal_list_items WHERE list_id = ? AND media_key = 'episode:tmdb:7:s1e1'").get(listId);
  assert.deepEqual({ ...added }, { title: "S1E1", tmdb_id: "7", show_title: "tv:tmdb:7", release_date: "2030-01-01" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_list_item_exclusions WHERE list_id = ?").get(listId).n, 0);
  // The show's app entry now stands for the episode, so the push keeps it.
  assert.equal(db.prepare("SELECT media_key FROM personal_list_entry_ledger WHERE list_id = ? AND remote_entry_id = 'e1'").get(listId).media_key, "episode:tmdb:7:s1e1");
});

test("a failed or empty episode read keeps the show for the next pass", async () => {
  const listId = createList([["movie:x", "movie", "3"], ["tv:tmdb:8", "tv", "8"], ["tv:tmdb:6", "tv", "6"]], { kind: "tv" });
  const deps = metadata({ 8: { 1: [1], 2: new Error("TVDB timed out") }, 6: {} });
  const results = await convertPlaylistShows(listId, { deps });
  assert.deepEqual(results.map((row) => row.status), ["error", "error"]);
  assert.deepEqual(order(listId), ["movie:x", "tv:tmdb:8", "tv:tmdb:6"]);
  await assert.rejects(fetchShowEpisodes({ tmdb_id: "6", title: "Empty" }, deps), /No episodes/);
});

test("the scheduled conversion covers every playlist with a show, Plembfin-only and deleted ones too", async () => {
  const local = createList([["tv:tmdb:4", "tv", "4"]]);
  const deleted = createList([["tv:tmdb:4", "tv", "4"]]);
  db.prepare("UPDATE personal_lists SET deleted_at = 5 WHERE id = ?").run(deleted);
  const results = await convertAllPlaylistShows({ deps: metadata({ 4: { 1: [1, 2] } }) });
  assert.ok(results.some((row) => row.listId === local));
  assert.deepEqual(order(local), ["episode:tmdb:4:s1e1", "episode:tmdb:4:s1e2"]);
  assert.deepEqual(order(deleted), ["episode:tmdb:4:s1e1", "episode:tmdb:4:s1e2"]);
});
