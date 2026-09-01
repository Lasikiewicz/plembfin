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
  activity_group_key TEXT,
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
INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('up_next', 1, 0);

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

-- Local personal media organization. Watchlist choices and custom lists remain
-- Plembfin-local. Ratings are still canonical here, but the separate optional
-- rating-sync queue may mirror them to explicitly enabled providers.
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
  episode_tmdb_id TEXT,
  episode_tvdb_id TEXT,
  episode_imdb_id TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'import', 'reconcile')),
  canonical_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_ratings_updated ON personal_ratings(updated_at DESC);

-- Provider-specific rating observations. This ledger is deliberately separate
-- from watched-state tables: a remote rating of NULL is an explicit unrated
-- observation, not a missing watched event.
CREATE TABLE IF NOT EXISTS personal_rating_sources (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin', 'trakt')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  provider_item_id TEXT,
  provider_ids_json TEXT,
  remote_rating INTEGER CHECK (remote_rating BETWEEN 1 AND 10 OR remote_rating IS NULL),
  remote_state TEXT NOT NULL DEFAULT 'unknown' CHECK (remote_state IN ('rated', 'unrated', 'unknown')),
  remote_rated_at INTEGER,
  last_seen_at INTEGER,
  last_snapshot_generation INTEGER,
  last_complete_snapshot_at INTEGER,
  last_inbound_at INTEGER,
  last_outbound_rating INTEGER,
  last_outbound_state TEXT CHECK (last_outbound_state IN ('rated', 'unrated')),
  last_outbound_intent_id TEXT,
  last_outbound_at INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'unknown' CHECK (sync_status IN ('unknown', 'synced', 'pending', 'conflict', 'not_found', 'reauth_required', 'failed')),
  last_error TEXT,
  PRIMARY KEY (provider, media_key)
);
CREATE INDEX IF NOT EXISTS idx_personal_rating_sources_snapshot
  ON personal_rating_sources(provider, last_snapshot_generation, remote_state);

-- Durable, deduplicated outbound rating mutations. desired_state remains
-- explicit for clears, so an unrated tombstone can never be confused with a
-- missing queue value.
CREATE TABLE IF NOT EXISTS personal_rating_sync_queue (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin', 'trakt')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('rated', 'unrated')),
  desired_rating INTEGER CHECK (desired_rating BETWEEN 1 AND 10 OR desired_rating IS NULL),
  source TEXT NOT NULL CHECK (source IN ('manual', 'import', 'reconcile', 'push')),
  intent_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'not_found', 'reauth_required', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  PRIMARY KEY (provider, media_key)
);
CREATE INDEX IF NOT EXISTS idx_personal_rating_sync_queue_due
  ON personal_rating_sync_queue(status, next_attempt_at, updated_at);

-- One current run/cursor per provider is enough for restart-safe status. The
-- generation is the complete-snapshot gate: missing remote rows only mean
-- "unrated" after a full provider scan has completed successfully.
CREATE TABLE IF NOT EXISTS personal_rating_sync_runs (
  provider TEXT PRIMARY KEY CHECK (provider IN ('plex', 'emby', 'jellyfin', 'trakt')),
  run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'baseline' CHECK (mode IN ('baseline', 'import')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'succeeded', 'partial', 'failed')),
  baseline_complete INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  cleared_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

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

-- A watchlist mutation is an append-only local intent.  The present rows above
-- remain the fast canonical read model; these records preserve removals and
-- revisions so an old provider callback can never delete a newer re-add.
CREATE TABLE IF NOT EXISTS personal_watchlist_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO personal_watchlist_meta (id, revision, updated_at) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS personal_watchlist_mutations (
  id TEXT PRIMARY KEY,
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  origin TEXT NOT NULL CHECK (origin IN ('local', 'plex', 'emby', 'jellyfin', 'watched', 'restore', 'reconcile', 'system')),
  reason TEXT NOT NULL,
  canonical_revision INTEGER NOT NULL,
  event_fingerprint TEXT UNIQUE,
  source_timestamp INTEGER,
  created_at INTEGER NOT NULL,
  superseded_at INTEGER,
  applied_at INTEGER,
  tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_mutations_media
  ON personal_watchlist_mutations(media_key, canonical_revision DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_mutations_active
  ON personal_watchlist_mutations(canonical_revision DESC, desired_state);

-- One row per provider representation and remote item.  Duplicate remote
-- matches are intentionally retained instead of silently choosing one.
CREATE TABLE IF NOT EXISTS personal_watchlist_provider_items (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  connection_id TEXT NOT NULL DEFAULT '',
  remote_scope_key TEXT NOT NULL DEFAULT '',
  representation TEXT NOT NULL CHECK (representation IN ('native', 'playlist', 'favorites', 'rss')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  provider_item_id TEXT NOT NULL DEFAULT '',
  provider_ids_json TEXT,
  remote_state TEXT NOT NULL DEFAULT 'unknown' CHECK (remote_state IN ('present', 'absent', 'unavailable', 'unknown', 'unmanaged')),
  managed_by_plembfin INTEGER NOT NULL DEFAULT 0 CHECK (managed_by_plembfin IN (0, 1)),
  primary_target INTEGER NOT NULL DEFAULT 0 CHECK (primary_target IN (0, 1)),
  container_id TEXT,
  container_name TEXT,
  last_confirmed_present_at INTEGER,
  last_seen_at INTEGER,
  last_complete_generation INTEGER,
  last_outbound_state TEXT CHECK (last_outbound_state IN ('present', 'absent')),
  last_outbound_intent_id TEXT,
  last_outbound_at INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'unknown' CHECK (sync_status IN ('unknown', 'synced', 'pending', 'not_available', 'reauth_required', 'failed', 'needs_review')),
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, connection_id, remote_scope_key, representation, media_key, provider_item_id)
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_provider_items_scope
  ON personal_watchlist_provider_items(provider, connection_id, remote_scope_key, representation, remote_state);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_provider_items_media
  ON personal_watchlist_provider_items(media_key, provider);

-- Durable per-provider desired state.  The unique scope/media key collapses
-- rapid add/remove churn while intent_id and canonical_revision preserve the
-- stale-event guard at the worker boundary.
CREATE TABLE IF NOT EXISTS personal_watchlist_sync_queue (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  connection_id TEXT NOT NULL DEFAULT '',
  remote_scope_key TEXT NOT NULL DEFAULT '',
  representation TEXT NOT NULL CHECK (representation IN ('native', 'playlist', 'favorites', 'rss')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  operation TEXT NOT NULL CHECK (operation IN ('add', 'remove', 'create_container', 'repair')),
  source_mutation_id TEXT,
  intent_id TEXT NOT NULL,
  canonical_revision INTEGER NOT NULL DEFAULT 0,
  provider_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'not_available', 'reauth_required', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  PRIMARY KEY (provider, connection_id, remote_scope_key, representation, media_key)
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_sync_queue_due
  ON personal_watchlist_sync_queue(status, next_attempt_at, updated_at);

CREATE TABLE IF NOT EXISTS personal_watchlist_sync_runs (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  connection_id TEXT NOT NULL DEFAULT '',
  remote_scope_key TEXT NOT NULL DEFAULT '',
  representation TEXT NOT NULL CHECK (representation IN ('native', 'playlist', 'favorites', 'rss')),
  run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'reconcile' CHECK (mode IN ('initial_publish', 'reconcile', 'repair')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'succeeded', 'partial', 'failed')),
  canonical_revision INTEGER NOT NULL DEFAULT 0,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  present_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  cursor_json TEXT,
  complete_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (complete_snapshot IN (0, 1)),
  snapshot_hash TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, connection_id, remote_scope_key, representation)
);

CREATE TABLE IF NOT EXISTS personal_watchlist_activity (
  id TEXT PRIMARY KEY,
  provider TEXT,
  connection_id TEXT,
  remote_scope_key TEXT,
  representation TEXT,
  media_key TEXT,
  media_json TEXT,
  action TEXT NOT NULL,
  origin TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_activity_created
  ON personal_watchlist_activity(created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_personal_watchlist_cache_insert AFTER INSERT ON personal_watchlist BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_personal_watchlist_cache_update AFTER UPDATE ON personal_watchlist BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_personal_watchlist_cache_delete AFTER DELETE ON personal_watchlist BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;

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
