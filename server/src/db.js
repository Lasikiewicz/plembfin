import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "./paths.js";
import { repairPhantomWatchBursts } from "./utils/phantomWatchRepair.js";

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
  {
    id: 4,
    up(database) {
      const watchCols = new Set(database.pragma("table_info(watch_history)").map((column) => column.name));
      // Very old/imported databases can be upgraded in stages and may not yet
      // have the columns needed for burst detection. The normal compatibility
      // path will finish those upgrades; do not make startup fail here.
      if (!["title", "media_type", "watched_at", "source", "sync_action"].every((column) => watchCols.has(column))) return;
      // The migration runner already owns an IMMEDIATE transaction.
      const result = repairPhantomWatchBursts(database, { transaction: false });
      if (result.deleted) {
        console.warn(`[history] removed ${result.deleted} implausible phantom watch row${result.deleted === 1 ? "" : "s"} from ${result.bursts.length} burst${result.bursts.length === 1 ? "" : "s"}`);
      }
    },
  },
  {
    id: 5,
    up(database) {
      const watchCols = new Set(database.pragma("table_info(watch_history)").map((column) => column.name));
      if (!["title", "media_type", "watched_at", "source", "sync_action"].every((column) => watchCols.has(column))) return;
      // Re-run the guarded repair after the exact-event duplicate rules were
      // expanded. Migration 4 may already have run on an existing database.
      const result = repairPhantomWatchBursts(database, { transaction: false });
      if (result.deleted) {
        console.warn(`[history] removed ${result.deleted} duplicate or implausible phantom watch row${result.deleted === 1 ? "" : "s"} from ${result.bursts.length} burst${result.bursts.length === 1 ? "" : "s"}`);
      }
    },
  },
  {
    id: 6,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map((column) => column.name);
      if (!watchCols.includes("watch_provenance")) database.exec("ALTER TABLE watch_history ADD COLUMN watch_provenance TEXT");
    },
  },
  {
    id: 7,
    up(database) {
      database.exec(`
        CREATE TABLE media_auth_devices (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
          device_identifier TEXT NOT NULL,
          device_name TEXT NOT NULL,
          public_jwk TEXT,
          private_key_ciphertext TEXT,
          private_key_iv TEXT,
          private_key_tag TEXT,
          key_version INTEGER NOT NULL DEFAULT 1,
          retired_at INTEGER,
          replacement_device_id TEXT REFERENCES media_auth_devices(id),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (
            provider = 'plex'
            OR (public_jwk IS NULL AND private_key_ciphertext IS NULL AND private_key_iv IS NULL AND private_key_tag IS NULL)
          )
        );
        CREATE UNIQUE INDEX media_auth_devices_one_active_provider
          ON media_auth_devices(provider) WHERE retired_at IS NULL;
        CREATE UNIQUE INDEX media_auth_devices_identifier
          ON media_auth_devices(provider, device_identifier);

        CREATE TABLE media_connections (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
          base_url TEXT NOT NULL,
          server_id TEXT NOT NULL,
          server_name TEXT,
          auth_device_id TEXT NOT NULL REFERENCES media_auth_devices(id),
          remote_user_id TEXT NOT NULL,
          remote_username TEXT,
          auth_kind TEXT NOT NULL CHECK (auth_kind IN ('plex_jwt', 'plex_managed_jwt', 'plex_legacy', 'emby_user', 'jellyfin_quick_connect', 'jellyfin_user', 'legacy')),
          credential_ciphertext TEXT NOT NULL,
          credential_iv TEXT NOT NULL,
          credential_tag TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 1,
          access_token_expires_at INTEGER,
          last_refreshed_at INTEGER,
          refresh_failure_count INTEGER NOT NULL DEFAULT 0,
          refresh_lease_owner TEXT,
          refresh_lease_expires_at INTEGER,
          status TEXT NOT NULL CHECK (status IN ('connected', 'reauth_required', 'disabled', 'legacy')),
          last_validated_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX media_connections_one_enabled_provider
          ON media_connections(provider) WHERE status IN ('connected', 'reauth_required', 'legacy');
        CREATE INDEX media_connections_device ON media_connections(auth_device_id);

        CREATE TABLE media_auth_flows (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('plex', 'jellyfin')),
          auth_device_id TEXT NOT NULL REFERENCES media_auth_devices(id),
          base_url TEXT,
          remote_flow_id TEXT,
          secret_ciphertext TEXT,
          secret_iv TEXT,
          secret_tag TEXT,
          key_version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK (status IN ('pending', 'authorised', 'completed', 'expired', 'rejected')),
          admin_session_fingerprint TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX media_auth_flows_expiry ON media_auth_flows(expires_at);
      `);
    },
  },
  {
    id: 8,
    up(database) {
      const flowColumns = database.pragma("table_info(media_auth_flows)").map((column) => column.name);
      if (!flowColumns.includes("key_version")) database.exec("ALTER TABLE media_auth_flows ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    id: 9,
    up(database) {
      const columns = new Set(database.pragma("table_info(media_connections)").map((column) => column.name));
      if (!columns.has("server_credential_ciphertext")) database.exec("ALTER TABLE media_connections ADD COLUMN server_credential_ciphertext TEXT");
      if (!columns.has("server_credential_iv")) database.exec("ALTER TABLE media_connections ADD COLUMN server_credential_iv TEXT");
      if (!columns.has("server_credential_tag")) database.exec("ALTER TABLE media_connections ADD COLUMN server_credential_tag TEXT");
      if (!columns.has("server_token_version")) database.exec("ALTER TABLE media_connections ADD COLUMN server_token_version INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    id: 10,
    up(database) {
      const deviceColumns = new Set(database.pragma("table_info(media_auth_devices)").map((column) => column.name));
      if (!deviceColumns.has("legacy_client_identifier")) database.exec("ALTER TABLE media_auth_devices ADD COLUMN legacy_client_identifier TEXT");
      database.exec("UPDATE media_auth_devices SET legacy_client_identifier=device_identifier || '-pms' WHERE legacy_client_identifier IS NULL OR legacy_client_identifier='' ");
      const flowColumns = new Set(database.pragma("table_info(media_auth_flows)").map((column) => column.name));
      if (!flowColumns.has("flow_kind")) database.exec("ALTER TABLE media_auth_flows ADD COLUMN flow_kind TEXT");
    },
  },
  {
    id: 11,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS tracker_connections (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('connected','reauth_required','disabled')),
          remote_user_id TEXT, remote_username TEXT, client_id TEXT NOT NULL,
          client_secret_ciphertext TEXT NOT NULL, client_secret_iv TEXT NOT NULL, client_secret_tag TEXT NOT NULL,
          access_token_ciphertext TEXT NOT NULL, access_token_iv TEXT NOT NULL, access_token_tag TEXT NOT NULL,
          refresh_token_ciphertext TEXT NOT NULL, refresh_token_iv TEXT NOT NULL, refresh_token_tag TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 1, access_token_expires_at INTEGER,
          initial_sync_mode TEXT NOT NULL DEFAULT 'baseline' CHECK (initial_sync_mode IN ('baseline','import')),
          baseline_complete INTEGER NOT NULL DEFAULT 0, last_polled_at INTEGER, last_validated_at INTEGER,
          last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracker_auth_flows (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL, client_id TEXT NOT NULL,
          client_secret_ciphertext TEXT NOT NULL, client_secret_iv TEXT NOT NULL, client_secret_tag TEXT NOT NULL,
          device_code_ciphertext TEXT NOT NULL, device_code_iv TEXT NOT NULL, device_code_tag TEXT NOT NULL,
          key_version INTEGER NOT NULL DEFAULT 1, user_code TEXT NOT NULL, verification_url TEXT NOT NULL,
          interval_seconds INTEGER NOT NULL, initial_sync_mode TEXT NOT NULL DEFAULT 'baseline',
          status TEXT NOT NULL CHECK (status IN ('pending','completed','expired','denied')),
          expires_at INTEGER NOT NULL, last_polled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tracker_auth_flows_expiry ON tracker_auth_flows(expires_at);
        CREATE TABLE IF NOT EXISTS tracker_item_state (
          provider TEXT NOT NULL, media_key TEXT NOT NULL, media_json TEXT NOT NULL,
          remote_watched_at INTEGER, last_seen_at INTEGER NOT NULL,
          last_outbound_state TEXT CHECK (last_outbound_state IN ('watched','unwatched')), last_outbound_at INTEGER,
          PRIMARY KEY(provider, media_key)
        );
      `);
    },
  },
  {
    id: 12,
    up(database) {
      const columns = database.pragma("table_info(tracker_connections)").map((column) => column.name);
      if (!columns.includes("history_synced_at")) database.exec("ALTER TABLE tracker_connections ADD COLUMN history_synced_at INTEGER");
      database.exec(`
        CREATE TABLE IF NOT EXISTS tracker_play_history (
          provider TEXT NOT NULL, history_id TEXT NOT NULL, media_key TEXT NOT NULL,
          watched_at TEXT NOT NULL, watch_record_id TEXT, created_at INTEGER NOT NULL,
          PRIMARY KEY(provider, history_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tracker_play_history_media ON tracker_play_history(provider, media_key);
      `);
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
  if (!watchCols.includes("watch_provenance")) db.exec("ALTER TABLE watch_history ADD COLUMN watch_provenance TEXT");
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
