import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { auditPhantomWatchHistory } from "../server/src/utils/phantomWatchAudit.js";

function makeDb() {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE watch_history (
    id TEXT PRIMARY KEY, title TEXT, media_type TEXT, watched_at TEXT, source TEXT,
    imdb_id TEXT, tmdb_id TEXT, tvdb_id TEXT, season INTEGER, episode INTEGER,
    media_key TEXT, show_title TEXT, sync_action TEXT
  )`);
  return database;
}

function insert(database, row) {
  database.prepare(`INSERT INTO watch_history
    (id,title,media_type,watched_at,source,imdb_id,tmdb_id,tvdb_id,season,episode,media_key,show_title,sync_action)
    VALUES (@id,@title,@media_type,@watched_at,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@media_key,@show_title,@sync_action)`).run({
    media_type: "movie", source: "plex", sync_action: "watched", imdb_id: null, tmdb_id: null,
    tvdb_id: null, season: null, episode: null, media_key: null, show_title: null, ...row,
  });
}

test("audit finds cross-key platform duplicates without modifying history", () => {
  const database = makeDb();
  insert(database, {
    id: "first", title: "Audit Movie", watched_at: "2026-07-27T10:00:00.000Z",
    media_key: "movie:none:title:audit-movie", tmdb_id: null,
  });
  insert(database, {
    id: "echo", title: "Audit Movie", watched_at: "2026-07-27T10:02:00.000Z",
    media_key: "movie:tmdb:123", tmdb_id: "123",
  });

  const result = auditPhantomWatchHistory(database);
  assert.equal(result.scanned, 2);
  assert.equal(result.candidate_groups, 1);
  assert.equal(result.review_groups, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 2);
  database.close();
});

test("audit ignores genuine rewatches outside the same-event window", () => {
  const database = makeDb();
  insert(database, { id: "first", title: "Rewatch Movie", watched_at: "2026-07-01T10:00:00.000Z", media_key: "movie:rewatch" });
  insert(database, { id: "later", title: "Rewatch Movie", watched_at: "2026-07-20T10:00:00.000Z", media_key: "movie:rewatch" });
  assert.equal(auditPhantomWatchHistory(database).candidate_groups, 0);
  database.close();
});
