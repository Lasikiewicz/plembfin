import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "./paths.js";

ensureDataDirs();

export const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* non-POSIX FS (Windows, some Docker volumes) */ }

// A journal_mode switch needs a momentary exclusive lock and can throw
// SQLITE_BUSY immediately rather than honoring busy_timeout, if another
// process opens the same brand-new database at the same instant (e.g. two
// Plembfin processes starting together for the first time). Retry those
// startup pragmas ourselves so a transient race doesn't crash boot.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function pragmaWithRetry(statement, { attempts = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return db.pragma(statement);
    } catch (error) {
      if (error?.code !== "SQLITE_BUSY" || attempt >= attempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

pragmaWithRetry("busy_timeout = 5000");
pragmaWithRetry("journal_mode = WAL");
pragmaWithRetry("foreign_keys = ON");

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
db.exec(schema);

const migrations = [
  {
    id: 1,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map(c => c.name);
      if (!watchCols.includes("logo_url")) database.exec("ALTER TABLE watch_history ADD COLUMN logo_url TEXT");
    },
  },
  {
    id: 2,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map(c => c.name);
      if (!watchCols.includes("backdrop_url")) database.exec("ALTER TABLE watch_history ADD COLUMN backdrop_url TEXT");
    },
  },
  {
    id: 3,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map(c => c.name);
      if (!watchCols.includes("sync_retry_count")) database.exec("ALTER TABLE watch_history ADD COLUMN sync_retry_count INTEGER DEFAULT 0");
      if (!watchCols.includes("sync_next_retry_at")) database.exec("ALTER TABLE watch_history ADD COLUMN sync_next_retry_at INTEGER DEFAULT 0");
    },
  },
];

function runSchemaMigrations() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER)");
  const appliedStmt = db.prepare("SELECT id FROM schema_migrations WHERE id = ?");
  const insertStmt = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const migration of migrations) {
    db.transaction(() => {
      // Recheck under an IMMEDIATE transaction. Two Plembfin processes may
      // start against the same database at exactly the same time.
      if (appliedStmt.get(migration.id)) return;
      migration.up(db);
      insertStmt.run(migration.id, Date.now());
    }).immediate();
  }
}

try {
  runSchemaMigrations();
} catch (error) {
  console.error("Schema migration failed", error);
  throw error;
}

// Compatibility guard for databases from before the migration table existed.
try {
  const watchCols = db.pragma("table_info(watch_history)").map(c => c.name);
  if (!watchCols.includes("logo_url")) db.exec("ALTER TABLE watch_history ADD COLUMN logo_url TEXT");
  if (!watchCols.includes("backdrop_url")) db.exec("ALTER TABLE watch_history ADD COLUMN backdrop_url TEXT");
} catch { /* column already exists */ }

// ---------------------------------------------------------------------------
// Shared derived-cache version. Each process keeps a fast local copy and polls
// SQLite at a bounded cadence so writes by another process invalidate caches.
// ---------------------------------------------------------------------------
const CACHE_VERSION_POLL_MS = 500;
const selectHistoryVersion = db.prepare("SELECT version FROM cache_versions WHERE id = 'history'");
const bumpHistoryVersion = db.prepare("UPDATE cache_versions SET version = version + 1, updated_at = ? WHERE id = 'history' RETURNING version");
let dataVersion = Number(selectHistoryVersion.get()?.version || 1);
let lastDataVersionCheckAt = 0;
export function getDataVersion() {
  const checkedAt = Date.now();
  if (checkedAt - lastDataVersionCheckAt >= CACHE_VERSION_POLL_MS) {
    lastDataVersionCheckAt = checkedAt;
    const shared = Number(selectHistoryVersion.get()?.version || 1);
    if (shared > dataVersion) dataVersion = shared;
  }
  return dataVersion;
}
export function bumpDataVersion() {
  const sharedBeforeBump = Number(selectHistoryVersion.get()?.version || 1);
  // Canonical SQLite writes advance the version atomically via triggers. Adopt
  // that generation instead of double-bumping, which preserves the safe
  // one-row cache carry-forward optimization. File-only changes still need an
  // explicit increment below.
  if (sharedBeforeBump > dataVersion) {
    dataVersion = sharedBeforeBump;
    lastDataVersionCheckAt = Date.now();
    return dataVersion;
  }
  const row = bumpHistoryVersion.get(Date.now());
  dataVersion = Math.max(dataVersion + 1, Number(row?.version || 1));
  lastDataVersionCheckAt = Date.now();
  return dataVersion;
}

export function refreshDataVersion() {
  lastDataVersionCheckAt = 0;
  return getDataVersion();
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
