-- Plembfin local SQLite schema.
-- Record ids are TEXT primary keys; provider ids ({imdb,tmdb,tvdb}) are flattened
-- to columns; timestamps are INTEGER ms (or ISO TEXT for watched_at, which is
-- compared lexicographically throughout).
-- Derived caches (history/movie/show summaries) have no tables on purpose:
-- a single long-lived process memoizes them in memory (see db.js dataVersion).

CREATE TABLE IF NOT EXISTS watch_history (
  id TEXT PRIMARY KEY,
  title TEXT,
  title_lower TEXT,
  media_type TEXT,
  watched_at TEXT,
  source TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  poster_url TEXT,
  logo_url TEXT,
  backdrop_url TEXT,
  youtube_url TEXT,
  sync_action TEXT,
  sync_dispatch_telemetry TEXT,
  sync_retry_count INTEGER DEFAULT 0,
  sync_next_retry_at INTEGER DEFAULT 0,
  media_key TEXT,
  show_title TEXT,
  show_title_lower TEXT,
  episode_title TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_watch_history_watched_at ON watch_history(watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_history_type_watched ON watch_history(media_type, watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_history_media_key ON watch_history(media_key);
CREATE INDEX IF NOT EXISTS idx_watch_history_show_lower ON watch_history(show_title_lower);

CREATE TABLE IF NOT EXISTS playstate (
  media_key TEXT PRIMARY KEY,
  title TEXT,
  title_lower TEXT,
  media_type TEXT,
  state TEXT,
  watched_at TEXT,
  last_source TEXT,
  sources TEXT,            -- JSON array
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  poster_url TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_playstate_state ON playstate(state);

CREATE TABLE IF NOT EXISTS playback_progress (
  media_key TEXT PRIMARY KEY,
  title TEXT,
  media_type TEXT,
  source TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  position_ms INTEGER,
  duration_ms INTEGER,
  progress REAL,
  updated_at INTEGER,
  sync_dispatch_telemetry TEXT
);
CREATE INDEX IF NOT EXISTS idx_playback_progress_updated ON playback_progress(updated_at DESC);

CREATE TABLE IF NOT EXISTS active_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  media_type TEXT,
  source TEXT,
  progress REAL,
  offset_ms INTEGER,
  duration_ms INTEGER,
  season INTEGER,
  episode INTEGER,
  poster_url TEXT,
  ids TEXT,               -- JSON
  event TEXT,
  client TEXT,            -- JSON
  updated_at INTEGER,
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_active_sessions_updated ON active_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS live_tracking_cache (
  session_id TEXT PRIMARY KEY,
  title TEXT,
  source_platform TEXT,
  last_progress REAL,
  updated_at INTEGER,
  completed_at INTEGER,
  payload TEXT,           -- JSON
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_live_tracking_updated ON live_tracking_cache(updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  media_type TEXT,
  title TEXT,
  source TEXT,
  status TEXT,
  details TEXT,
  action TEXT,
  target_states TEXT,     -- JSON
  raw_payload_debug TEXT, -- JSON
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sync_history_timestamp ON sync_history(timestamp DESC);

-- Single-row key/value documents stored as JSON blobs.
CREATE TABLE IF NOT EXISTS runtime_state (
  id TEXT PRIMARY KEY,
  data TEXT,              -- JSON
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  data TEXT,              -- JSON
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS loop_keys (
  id TEXT PRIMARY KEY,
  key TEXT,
  value TEXT,
  created_at INTEGER,
  expire_at INTEGER
);

CREATE TABLE IF NOT EXISTS poster_cache (
  id TEXT PRIMARY KEY,
  media_key TEXT,
  variant TEXT,
  status TEXT,
  source TEXT,
  detail TEXT,
  original_url TEXT,
  storage_path TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  url TEXT,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tmdb_metadata_cache (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  media_type TEXT,
  title TEXT,
  details TEXT,           -- JSON
  schema_version INTEGER,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tmdb_search_cache (
  id TEXT PRIMARY KEY,
  query TEXT,
  media_type TEXT,
  page INTEGER,
  response TEXT,          -- JSON
  missing INTEGER,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tmdb_season_cache (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  season_number INTEGER,
  show_status TEXT,
  details TEXT,           -- JSON
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tmdb_person_cache (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  details TEXT,           -- JSON
  schema_version INTEGER,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tvdb_metadata_cache (
  id TEXT PRIMARY KEY,
  tvdb_id TEXT,
  title TEXT,
  details TEXT,           -- JSON (raw TVDB series/extended response)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tvdb_season_cache (
  id TEXT PRIMARY KEY,
  tvdb_id TEXT,
  season_number INTEGER,
  details TEXT,           -- JSON (raw TVDB season/extended episodes)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS omdb_cache (
  id TEXT PRIMARY KEY,     -- IMDb ID (tt...)
  data TEXT,               -- JSON
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS fanart_cache (
  id TEXT PRIMARY KEY,     -- fanart.tv request path (movies/{tmdbId} or tv/{tvdbId})
  data TEXT,               -- JSON (raw fanart.tv response); NULL when missing = 1
  missing INTEGER DEFAULT 0, -- 1 when fanart.tv has no artwork for this item (404)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS youtube_meta_cache (
  id TEXT PRIMARY KEY,     -- YouTube video ID
  data TEXT,               -- JSON (trailer metadata response)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_ip TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at INTEGER
);
