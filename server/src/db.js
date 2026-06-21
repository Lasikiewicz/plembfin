import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "./paths.js";

ensureDataDirs();

export const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* non-POSIX FS (Windows, some Docker volumes) */ }
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
db.exec(schema);

// Column migrations (ALTER TABLE IF NOT EXISTS isn't valid SQLite syntax)
try {
  const watchCols = db.pragma("table_info(watch_history)").map(c => c.name);
  if (!watchCols.includes("logo_url")) db.exec("ALTER TABLE watch_history ADD COLUMN logo_url TEXT");
} catch { /* column already exists */ }

// ---------------------------------------------------------------------------
// In-process derived-cache version. A monotone integer invalidates in-memory
// caches; bump it on every write that changes history-derived results.
// ---------------------------------------------------------------------------
let dataVersion = 1;
export function getDataVersion() {
  return dataVersion;
}
export function bumpDataVersion() {
  dataVersion += 1;
  return dataVersion;
}

// JSON column helpers -------------------------------------------------------
export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

export function now() {
  return Date.now();
}

// Run a function inside a single transaction.
export function transaction(fn) {
  return db.transaction(fn)();
}

const insertAuditLog = db.prepare(
  "INSERT INTO audit_log (ts, action, actor_ip, detail) VALUES (?, ?, ?, ?)"
);
export function writeAuditLog(action, { ip = null, detail = null } = {}) {
  try {
    insertAuditLog.run(Date.now(), String(action), ip ?? null, detail ? JSON.stringify(detail) : null);
  } catch { /* audit failures must never break the primary flow */ }
}
