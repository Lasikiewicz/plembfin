import Database from "better-sqlite3";
import path from "node:path";

const dbPath = "c:\\Github\\plembfin\\data\\plembfin.db";
console.log("Opening database:", dbPath);
const db = new Database(dbPath);

console.log("--- Watch History ---");
const rows = db.prepare("SELECT * FROM watch_history").all();
for (const row of rows) {
  console.log(`- ID: ${row.id}, Title: ${row.title}, Type: ${row.media_type}, WatchedAt: ${row.watched_at}, Source: ${row.source}, SyncAction: ${row.sync_action}`);
}

console.log("--- Sync History ---");
const syncRows = db.prepare("SELECT * FROM sync_history ORDER BY id DESC LIMIT 20").all();
for (const row of syncRows) {
  console.log(`- ID: ${row.id}, Title: ${row.title}, Action: ${row.action}, Status: ${row.status}, Details: ${row.details}`);
}
