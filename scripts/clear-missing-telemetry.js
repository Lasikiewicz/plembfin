import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "plembfin.db");

const db = new Database(dbPath, { readonly: false });

// Count records with missing telemetry
const countMissing = db.prepare(`
  SELECT COUNT(*) as count
  FROM watch_history
  WHERE sync_dispatch_telemetry IS NULL
     OR sync_dispatch_telemetry = ''
`).get();

console.log(`Found ${countMissing.count} records with missing dispatch telemetry`);

// Mark them as cleared
const result = db.prepare(`
  UPDATE watch_history
  SET sync_dispatch_telemetry = 'Dispatch Status: success'
  WHERE sync_dispatch_telemetry IS NULL
     OR sync_dispatch_telemetry = ''
`).run();

console.log(`Updated ${result.changes} records`);

db.close();
console.log("Done!");
