import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { findMalformedScheduledEpisodeRows, findPhantomWatchBurstRows, repairMalformedScheduledEpisodeRows, repairPhantomWatchBursts } from "../server/src/utils/phantomWatchRepair.js";

function makeDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE watch_history (
      id TEXT PRIMARY KEY, title TEXT, media_type TEXT, watched_at TEXT, source TEXT,
      imdb_id TEXT, tmdb_id TEXT, tvdb_id TEXT, season INTEGER, episode INTEGER,
      media_key TEXT, show_title TEXT, episode_title TEXT, watch_provenance TEXT,
      sync_action TEXT, sync_dispatch_telemetry TEXT
    );
    CREATE TABLE playstate (media_key TEXT PRIMARY KEY, state TEXT);
  `);
  return database;
}

function insert(database, row) {
  database.prepare(`INSERT INTO watch_history
    (id, title, media_type, watched_at, source, media_key, show_title, episode_title, watch_provenance, tvdb_id, season, episode, sync_action, sync_dispatch_telemetry)
    VALUES (@id, @title, @media_type, @watched_at, @source, @media_key, @show_title, @episode_title, @watch_provenance, @tvdb_id, @season, @episode, @sync_action, @sync_dispatch_telemetry)`)
    .run({
      media_type: "episode",
      source: "jellyfin",
      episode_title: null,
      watch_provenance: null,
      tvdb_id: null,
      sync_action: "watched",
      sync_dispatch_telemetry: "Origin: jellyfin\nDetails: Manual watch state propagated; sync completed.",
      ...row,
    });
}

test("repairs an implausible cross-show burst but preserves explicit manual watches", () => {
  const database = makeDb();
  for (let index = 0; index < 8; index += 1) {
    insert(database, {
      id: `phantom-${index}`,
      title: `Show ${index} - S01E01`,
      show_title: `Show ${index}`,
      season: 1,
      episode: 1,
      media_key: `episode:${index}`,
      watched_at: `2026-07-16T08:00:${String(index).padStart(2, "0")}.000Z`,
    });
  }
  insert(database, {
    id: "manual-watch",
    title: "Intentionally Bulk Watched",
    media_type: "movie",
    source: "jellyfin",
    watched_at: "2026-07-16T08:00:20.000Z",
    media_key: "movie:manual",
    show_title: null,
    season: null,
    episode: null,
    sync_dispatch_telemetry: "Origin: manual\nAction: Marked Watched",
  });

  const detected = findPhantomWatchBurstRows(database);
  assert.equal(detected.ids.length, 8);
  const result = repairPhantomWatchBursts(database);
  assert.equal(result.deleted, 8);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 1);
  database.close();
});

test("does not classify a normal spaced-out binge as a phantom burst", () => {
  const database = makeDb();
  for (let index = 0; index < 8; index += 1) {
    const watchedAt = new Date(Date.UTC(2026, 6, 16, 8, index * 20, 0)).toISOString();
    insert(database, {
      id: `real-${index}`,
      title: `Show ${index} - S01E01`,
      show_title: `Show ${index}`,
      season: 1,
      episode: 1,
      media_key: `real:${index}`,
      watched_at: watchedAt,
    });
  }
  assert.equal(findPhantomWatchBurstRows(database).ids.length, 0);
  database.close();
});

test("removes only extra copies of an exact same-item same-timestamp event", () => {
  const database = makeDb();
  insert(database, {
    id: "exact-a",
    title: "Duplicate Movie",
    media_type: "movie",
    show_title: null,
    season: null,
    episode: null,
    media_key: "movie:duplicate",
    watched_at: "2026-07-16T08:25:00.000Z",
  });
  insert(database, {
    id: "exact-b",
    title: "Duplicate Movie",
    media_type: "movie",
    show_title: null,
    season: null,
    episode: null,
    media_key: "movie:duplicate",
    watched_at: "2026-07-16T08:25:00.000Z",
  });
  insert(database, {
    id: "rewatch",
    title: "Duplicate Movie",
    media_type: "movie",
    show_title: null,
    season: null,
    episode: null,
    media_key: "movie:duplicate",
    watched_at: "2026-07-20T08:25:00.000Z",
  });

  const result = repairPhantomWatchBursts(database);
  assert.equal(result.deleted, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE id = 'rewatch'").get().count, 1);
  assert.equal(result.bursts[0].reason, "exact-same-item-same-timestamp");
  database.close();
});

test("repairs an impossible same-show episode batch", () => {
  const database = makeDb();
  for (let index = 0; index < 8; index += 1) {
    insert(database, {
      id: `same-show-${index}`,
      title: `Episode ${index}`,
      show_title: "Trying",
      season: 4,
      episode: index + 1,
      media_key: `trying:s04e0${index + 1}`,
      watched_at: "2026-07-24T01:02:00.000Z",
    });
  }
  const detected = findPhantomWatchBurstRows(database);
  assert.equal(detected.ids.length, 8);
  assert.equal(detected.bursts[0].reason, "same-group-impossible-batch");
  database.close();
});

test("finds and repairs malformed scheduled episode rows without touching valid history", () => {
  const database = makeDb();
  insert(database, {
    id: "malformed-episode",
    title: "Platonic - S10E09",
    show_title: "Platonic",
    episode_title: "S10E0?",
    season: 10,
    episode: 9,
    media_key: "episode:10:9:title:platonic",
    tvdb_id: "391020",
    watched_at: "2026-06-20T15:22:00.000Z",
    watch_provenance: JSON.stringify({
      source: "jellyfin",
      event: "library_history",
      ingest_path: "jellyfin_scheduled_library_history",
      user: "configured-user",
      source_timestamp: "2026-06-20T15:22:00.000Z",
    }),
  });
  insert(database, {
    id: "valid-episode",
    title: "Platonic - S02E01",
    show_title: "Platonic",
    episode_title: "The Engagement Party",
    season: 2,
    episode: 1,
    media_key: "episode:2:1:tvdb:391020",
    watched_at: "2025-08-05T12:00:00.000Z",
    watch_provenance: JSON.stringify({
      source: "jellyfin",
      event: "library_history",
      ingest_path: "jellyfin_scheduled_library_history",
      user: "configured-user",
      source_timestamp: "2025-08-05T12:00:00.000Z",
    }),
  });
  database.prepare("INSERT INTO playstate (media_key, state) VALUES (?, 'watched')").run("episode:10:9:title:platonic");

  const audit = findMalformedScheduledEpisodeRows(database);
  assert.equal(audit.count, 1);
  assert.equal(audit.rows[0].id, "malformed-episode");

  const result = repairMalformedScheduledEpisodeRows(database);
  assert.equal(result.deleted, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM playstate WHERE media_key = ?").get("episode:10:9:title:platonic").count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE id = 'valid-episode'").get().count, 1);
  database.close();
});
