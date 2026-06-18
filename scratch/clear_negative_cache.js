import Database from "better-sqlite3";

const dbPath = "c:\\Github\\plembfin\\data\\plembfin.db";
const db = new Database(dbPath);

console.log("Checking current counts in poster_cache...");
const beforeCounts = db.prepare("SELECT status, COUNT(*) as count FROM poster_cache GROUP BY status").all();
console.log("Before:", beforeCounts);

console.log("Clearing 'missing' and 'failed' negative cache entries...");
const result = db.prepare("DELETE FROM poster_cache WHERE status IN ('missing', 'failed')").run();
console.log(`Deleted ${result.changes} negative cache entries.`);

const afterCounts = db.prepare("SELECT status, COUNT(*) as count FROM poster_cache GROUP BY status").all();
console.log("After:", afterCounts);
