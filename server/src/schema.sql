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
  watch_provenance TEXT,
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

CREATE TABLE IF NOT EXISTS show_merge_history (
  id TEXT PRIMARY KEY,
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  merged_at INTEGER NOT NULL,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_show_merge_history_target ON show_merge_history(target_title, merged_at DESC);

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

-- Cross-process mutex for writes that change a media server's played state.
-- A watched write and the corresponding progress-clear + unplayed pair must
-- never pass each other on the wire: whichever operation acquires this lease
-- first finishes first, and the newer operation writes the final state.
CREATE TABLE IF NOT EXISTS outbound_state_leases (
  lease_key TEXT PRIMARY KEY,
  owner_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT,
  acquired_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbound_state_leases_expiry ON outbound_state_leases(expires_at);

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

-- Durable, per-media history of every ingest, local state change, and outbound
-- dispatch. Both this provenance record and sync_history are retained with
-- backups; the Activity UI paginates sync_history instead of truncating it.
CREATE TABLE IF NOT EXISTS watch_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT,
  watch_record_id TEXT,
  media_key TEXT,
  media_type TEXT,
  title TEXT,
  title_lower TEXT,
  show_title TEXT,
  show_title_lower TEXT,
  source TEXT,
  source_event TEXT,
  phase TEXT,
  source_timestamp TEXT,
  captured_at TEXT,
  target TEXT,
  status TEXT,
  details TEXT,
  device TEXT,
  device_id TEXT,
  client TEXT,
  client_version TEXT,
  user_name TEXT,
  session_id TEXT,
  item_id TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_audit_media_key ON watch_audit_events(media_key, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_record_id ON watch_audit_events(watch_record_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_tmdb_id ON watch_audit_events(tmdb_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_tvdb_id ON watch_audit_events(tvdb_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_imdb_id ON watch_audit_events(imdb_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_title ON watch_audit_events(title_lower, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_show_title ON watch_audit_events(show_title_lower, timestamp);

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

-- Show-level poster overrides. Keep these separate from watch_history.poster_url:
-- an episode row may legitimately use an episode still, while the selected
-- show poster must be shared by every non-episode surface.
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

-- Captured console output for the Settings -> Logs panel. Bounded to
-- DIAGNOSTIC_LOG_MAX_ROWS by diagnosticLogger.js, which prunes the oldest rows
-- on flush, so this table is a ring buffer rather than an unbounded archive.
-- Every process writes here, which is how the panel merges web and worker logs.
CREATE TABLE IF NOT EXISTS diagnostic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT,
  category TEXT,
  role TEXT,
  instance TEXT,
  message TEXT
);
CREATE INDEX IF NOT EXISTS diagnostic_log_ts ON diagnostic_log (ts);
CREATE INDEX IF NOT EXISTS diagnostic_log_category_ts ON diagnostic_log (category, ts);
CREATE INDEX IF NOT EXISTS diagnostic_log_level_ts ON diagnostic_log (level, ts);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at INTEGER
);

CREATE TABLE IF NOT EXISTS cache_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('history', 1, 0);
INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('discover', 1, 0);

-- Keep cache invalidation in the same transaction as canonical state writes.
-- Explicit bumpDataVersion() calls remain useful for file-backed derived data;
-- duplicate bumps are harmless and force the conservative full-rebuild path.
CREATE TRIGGER IF NOT EXISTS trg_watch_history_cache_insert AFTER INSERT ON watch_history BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_watch_history_cache_update AFTER UPDATE ON watch_history BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_watch_history_cache_delete AFTER DELETE ON watch_history BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playstate_cache_insert AFTER INSERT ON playstate BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playstate_cache_update AFTER UPDATE ON playstate BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playstate_cache_delete AFTER DELETE ON playstate BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playback_progress_cache_insert AFTER INSERT ON playback_progress BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playback_progress_cache_update AFTER UPDATE ON playback_progress BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playback_progress_cache_delete AFTER DELETE ON playback_progress BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;

CREATE TABLE IF NOT EXISTS scheduler_lease (
  id TEXT PRIMARY KEY,
  holder_id TEXT,
  holder_role TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  acquired_at INTEGER,
  heartbeat_at INTEGER,
  expires_at INTEGER,
  last_tick_at INTEGER
);
INSERT OR IGNORE INTO scheduler_lease (id, generation) VALUES ('scheduler', 0);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  claimed_by TEXT,
  claim_generation INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim ON background_jobs(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_background_jobs_type ON background_jobs(type, requested_at DESC);

CREATE TABLE IF NOT EXISTS background_job_logs (
  job_id TEXT NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY(job_id, seq)
);

-- Force Sync plans: the read-only preview produced before an execution run.
-- actions_json can be large for big libraries; the API pages it server-side
-- and the summary is stored separately so list views never load actions.
CREATE TABLE IF NOT EXISTS sync_plans (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT,
  summary_json TEXT,
  actions_json TEXT,
  skipped_json TEXT,
  fingerprint_json TEXT,
  config_revision TEXT,
  snapshot_file TEXT,
  result_json TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sync_plans_created ON sync_plans(created_at DESC);

-- External watch trackers (Trakt first; provider-neutral for future adapters).
CREATE TABLE IF NOT EXISTS tracker_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('connected', 'reauth_required', 'disabled')),
  remote_user_id TEXT,
  remote_username TEXT,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_iv TEXT NOT NULL,
  client_secret_tag TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_tag TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_tag TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  access_token_expires_at INTEGER,
  initial_sync_mode TEXT NOT NULL DEFAULT 'baseline' CHECK (initial_sync_mode IN ('baseline', 'import')),
  baseline_complete INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER,
  last_validated_at INTEGER,
  last_error TEXT,
  history_synced_at INTEGER,
  prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracker_auth_flows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_iv TEXT NOT NULL,
  client_secret_tag TEXT NOT NULL,
  device_code_ciphertext TEXT NOT NULL,
  device_code_iv TEXT NOT NULL,
  device_code_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  user_code TEXT NOT NULL,
  verification_url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  initial_sync_mode TEXT NOT NULL DEFAULT 'baseline',
  prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'denied')),
  expires_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracker_auth_flows_expiry ON tracker_auth_flows(expires_at);

CREATE TABLE IF NOT EXISTS tracker_item_state (
  provider TEXT NOT NULL,
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  remote_watched_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  last_outbound_state TEXT CHECK (last_outbound_state IN ('watched', 'unwatched')),
  last_outbound_at INTEGER,
  PRIMARY KEY(provider, media_key)
);

-- Per-play dedup ledger for imported tracker history (Trakt can report the
-- same item watched multiple times - each play has its own history id).
-- Lets the poller import every individual rewatch exactly once without
-- re-fetching or re-diffing the whole watch_history table on every tick.
CREATE TABLE IF NOT EXISTS tracker_play_history (
  provider TEXT NOT NULL,
  history_id TEXT NOT NULL,
  media_key TEXT NOT NULL,
  watched_at TEXT NOT NULL,
  watch_record_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(provider, history_id)
);
CREATE INDEX IF NOT EXISTS idx_tracker_play_history_media ON tracker_play_history(provider, media_key);

-- Local personal media organization. These records intentionally remain
-- Plembfin-local: ratings, watchlist choices, and custom lists do not alter
-- any connected media server or tracker state.
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
