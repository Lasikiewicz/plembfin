import Database from "better-sqlite3";
const dbPath = "c:\\Github\\plembfin\\data\\plembfin.db";
const db = new Database(dbPath);

console.log("Clearing tmdb_search_cache...");
const result = db.prepare("DELETE FROM tmdb_search_cache").run();
console.log(`Cleared. Rows deleted: ${result.changes}`);
