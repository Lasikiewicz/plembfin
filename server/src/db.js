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
  {
    id: 13,
    up(database) {
      const connectionColumns = database.pragma("table_info(tracker_connections)").map((column) => column.name);
      if (!connectionColumns.includes("prefer_earlier_watched_date")) {
        database.exec("ALTER TABLE tracker_connections ADD COLUMN prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1");
      }
      const flowColumns = database.pragma("table_info(tracker_auth_flows)").map((column) => column.name);
      if (!flowColumns.includes("prefer_earlier_watched_date")) {
        database.exec("ALTER TABLE tracker_auth_flows ADD COLUMN prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1");
      }
    },
  },
  {
    id: 14,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS personal_ratings (
          media_key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'episode')),
          title TEXT NOT NULL,
          tmdb_id TEXT,
          tvdb_id TEXT,
          imdb_id TEXT,
          poster_url TEXT,
          overview TEXT,
          release_date TEXT,
          show_title TEXT,
          season INTEGER,
          episode INTEGER,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_personal_ratings_updated ON personal_ratings(updated_at DESC);

        CREATE TABLE IF NOT EXISTS personal_watchlist (
          media_key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          title TEXT NOT NULL,
          tmdb_id TEXT,
          tvdb_id TEXT,
          imdb_id TEXT,
          poster_url TEXT,
          overview TEXT,
          release_date TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_personal_watchlist_updated ON personal_watchlist(updated_at DESC);

        CREATE TABLE IF NOT EXISTS personal_lists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS personal_list_items (
          list_id TEXT NOT NULL REFERENCES personal_lists(id) ON DELETE CASCADE,
          media_key TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          title TEXT NOT NULL,
          tmdb_id TEXT,
          tvdb_id TEXT,
          imdb_id TEXT,
          poster_url TEXT,
          overview TEXT,
          release_date TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (list_id, media_key)
        );
        CREATE INDEX IF NOT EXISTS idx_personal_list_items_list ON personal_list_items(list_id, updated_at DESC);
      `);
    },
  },
  {
    id: 15,
    up(database) {
      const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'personal_ratings'").get();
      if (!table) return;
      const columns = new Set(database.pragma("table_info(personal_ratings)").map((column) => column.name));
      const tableSql = String(table.sql || "").toLowerCase();
      if (columns.has("show_title") && columns.has("season") && columns.has("episode") && tableSql.includes("'episode'")) return;

      database.exec(`
        DROP TABLE IF EXISTS personal_ratings_migrated;
        CREATE TABLE personal_ratings_migrated (
          media_key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'episode')),
          title TEXT NOT NULL,
          tmdb_id TEXT,
          tvdb_id TEXT,
          imdb_id TEXT,
          poster_url TEXT,
          overview TEXT,
          release_date TEXT,
          show_title TEXT,
          season INTEGER,
          episode INTEGER,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO personal_ratings_migrated
          (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, show_title, season, episode, rating, created_at, updated_at)
        SELECT media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, NULL, NULL, NULL, rating, created_at, updated_at
        FROM personal_ratings;
        DROP TABLE personal_ratings;
        ALTER TABLE personal_ratings_migrated RENAME TO personal_ratings;
        CREATE INDEX IF NOT EXISTS idx_personal_ratings_updated ON personal_ratings(updated_at DESC);
      `);
    },
  },
  {
    id: 16,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS media_artwork (
          identity_key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          title TEXT,
          tmdb_id TEXT,
          tvdb_id TEXT,
          imdb_id TEXT,
          poster_url TEXT,
          poster_source TEXT NOT NULL DEFAULT 'manual',
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_media_artwork_provider_ids
          ON media_artwork(media_type, tmdb_id, tvdb_id, imdb_id);
      `);
    },
  },
  {
    id: 17,
    up(database) {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_ratings'").get();
      if (!table) return;

      const rows = database.prepare(`
        SELECT *
        FROM personal_ratings
        WHERE media_type = 'episode'
          AND trim(COALESCE(show_title, '')) <> ''
          AND season IS NOT NULL
          AND episode IS NOT NULL
        ORDER BY updated_at ASC, media_key ASC
      `).all();
      const groups = new Map();
      for (const row of rows) {
        const groupKey = `${String(row.show_title || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}:${row.season}:${row.episode}`;
        const group = groups.get(groupKey) || [];
        group.push(row);
        groups.set(groupKey, group);
      }

      const cachedTvTmdbIds = new Set(database.prepare(`
        SELECT tmdb_id
        FROM tmdb_metadata_cache
        WHERE media_type = 'tv' AND trim(COALESCE(tmdb_id, '')) <> ''
      `).all().map((row) => String(row.tmdb_id).trim()));
      const cachedSeriesTvdbIds = new Set(database.prepare(`
        SELECT tvdb_id
        FROM tvdb_metadata_cache
        WHERE id LIKE 'series_%' AND trim(COALESCE(tvdb_id, '')) <> ''
      `).all().map((row) => String(row.tvdb_id).trim()));
      const valuePresent = (value) => String(value ?? "").trim() !== "";
      const identityScore = (row) => {
        let score = 0;
        if (valuePresent(row.tmdb_id) && cachedTvTmdbIds.has(String(row.tmdb_id).trim())) score += 100;
        if (valuePresent(row.tvdb_id) && cachedSeriesTvdbIds.has(String(row.tvdb_id).trim())) score += 100;
        if (valuePresent(row.overview)) score += 4;
        if (valuePresent(row.release_date)) score += 2;
        if (valuePresent(row.poster_url)) score += 1;
        return score;
      };
      const update = database.prepare(`
        UPDATE personal_ratings
        SET title = @title,
            tmdb_id = @tmdb_id,
            tvdb_id = @tvdb_id,
            imdb_id = @imdb_id,
            poster_url = @poster_url,
            overview = @overview,
            release_date = @release_date,
            show_title = @show_title,
            season = @season,
            episode = @episode,
            rating = @rating,
            created_at = @created_at,
            updated_at = @updated_at
        WHERE media_key = @media_key
      `);
      const remove = database.prepare("DELETE FROM personal_ratings WHERE media_key = ?");
      let mergedGroups = 0;

      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const ranked = [...group].sort((left, right) => (
          identityScore(right) - identityScore(left)
          || Number(right.updated_at || 0) - Number(left.updated_at || 0)
          || String(left.media_key).localeCompare(String(right.media_key))
        ));
        const canonical = ranked[0];
        const latest = [...group].sort((left, right) => (
          Number(right.updated_at || 0) - Number(left.updated_at || 0)
          || String(left.media_key).localeCompare(String(right.media_key))
        ))[0];
        const pick = (field) => {
          for (const source of [canonical, ...ranked.slice(1)]) {
            if (valuePresent(source[field])) return source[field];
          }
          return null;
        };
        update.run({
          media_key: canonical.media_key,
          title: pick("title") || "Untitled",
          tmdb_id: pick("tmdb_id"),
          tvdb_id: pick("tvdb_id"),
          imdb_id: pick("imdb_id"),
          poster_url: pick("poster_url"),
          overview: pick("overview"),
          release_date: pick("release_date"),
          show_title: pick("show_title"),
          season: canonical.season,
          episode: canonical.episode,
          rating: latest.rating,
          created_at: Math.min(...group.map((row) => Number(row.created_at || 0))),
          updated_at: Math.max(...group.map((row) => Number(row.updated_at || 0))),
        });
        for (const row of group) {
          if (row.media_key !== canonical.media_key) remove.run(row.media_key);
        }
        mergedGroups += 1;
      }

      if (mergedGroups) {
        console.warn(`[personal] merged ${mergedGroups} duplicate episode rating group${mergedGroups === 1 ? "" : "s"}`);
      }
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
const selectDiscoverVersion = db.prepare("SELECT version FROM cache_versions WHERE id = 'discover'");
const bumpDiscoverVersionStmt = db.prepare("UPDATE cache_versions SET version = version + 1, updated_at = ? WHERE id = 'discover' RETURNING version");
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

export function getDiscoverVersion() {
  return Number(selectDiscoverVersion.get()?.version || 1);
}

export function bumpDiscoverVersion() {
  return Number(bumpDiscoverVersionStmt.get(Date.now())?.version || 1);
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
