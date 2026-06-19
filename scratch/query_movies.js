import Database from "better-sqlite3";
const dbPath = "c:\\Github\\plembfin\\data\\plembfin.db";
const db = new Database(dbPath);

console.log("BuM0yCX846ZfjaDV9KBk:", db.prepare("SELECT id, title, tmdb_id, imdb_id, media_key FROM watch_history WHERE id = ?").get("BuM0yCX846ZfjaDV9KBk"));
console.log("31b93920-f0ac-4700-b8d3-7d81dd6ef39d:", db.prepare("SELECT id, title, tmdb_id, imdb_id, media_key FROM watch_history WHERE id = ?").get("31b93920-f0ac-4700-b8d3-7d81dd6ef39d"));
