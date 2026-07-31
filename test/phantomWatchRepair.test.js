import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { findPhantomWatchBurstRows, repairPhantomWatchBursts } from "../server/src/utils/phantomWatchRepair.js";

function makeDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE watch_history (
      id TEXT PRIMARY KEY, title TEXT, media_type TEXT, watched_at TEXT, source TEXT,
      imdb_id TEXT, tmdb_id TEXT, tvdb_id TEXT, season INTEGER, episode INTEGER,
      media_key TEXT, show_title TEXT, sync_action TEXT, sync_dispatch_telemetry TEXT
    );
    CREATE TABLE playstate (media_key TEXT PRIMARY KEY, state TEXT);
  `);
  return database;
}

function insert(database, row) {
  database.prepare(`INSERT INTO watch_history
    (id, title, media_type, watched_at, source, media_key, show_title, season, episode, sync_action, sync_dispatch_telemetry)
    VALUES (@id, @title, @media_type, @watched_at, @source, @media_key, @show_title, @season, @episode, @sync_action, @sync_dispatch_telemetry)`)
    .run({
      media_type: "episode",
      source: "jellyfin",
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
