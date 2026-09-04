# SQLite Schema

Reference for `data/plembfin.db`. The full authoritative schema is in
`server/src/schema.sql`; this doc adds context on the less-obvious fields.

## Table list

| Table | Purpose | Written by | Read by |
| --- | --- | --- | --- |
| `watch_history` | Canonical watch records (one row per unique watched item) | webhook `completed`/`unplayed`, scheduled catch-up, import | history endpoints, dashboard |
| `live_tracking_cache` | Snapshot of currently-playing sessions from the scheduler | elected worker only | `handleNowPlaying` |
| `active_sessions` | Live sessions from webhook `active` events (5-min TTL) | webhook `active` phase | `handleNowPlaying`, `active-sessions` |
| `playback_progress` | Resume position records | webhook `ended`, sync orchestrator | resume propagation |
| `up_next_provider_items` | Latest generation of provider Resume/Continue Watching/Next Up observations, keyed by provider feed and native item ID | scheduled provider feed sync | unified Up Next builder, source-ledger mutation lookup |
| `up_next_provider_feed_state` | Per-provider/feed generation, completion, freshness, count, cursor, retry, and redacted error state | scheduled provider feed sync | Up Next cache/status response |
| `playstate` | Per-item watched/unwatched state for sync targets | sync orchestrator | sync orchestrator |
| `sync_history` | Permanent log of sync dispatch results, with `activity_group_key` for grouped movie/show activity | sync outcome changes | sync-history and sync-activity endpoints |
| `runtime_state` | Single-row JSON blob - last cron time, force-sync state/log, `nowPlayingRefresh` signal | scheduler, force-sync, webhooks | dashboard polling |
| `cache_versions` | Monotone cross-process cache generations (`history` for canonical watch state, `discover` for changed TMDB feed snapshots, `up_next` for changed dashboard queue snapshots) | SQLite triggers and explicit invalidation | every web/worker process |
| `scheduler_lease` | Current worker leader, fencing generation, heartbeat and tick time | worker coordinator | health and worker coordination |
| `background_jobs` / `background_job_logs` | Durable cron/force-sync queue, state, results and ordered logs | web enqueues; leader claims | sync APIs and worker |
| `settings` | Single-row JSON blob - Plex/Emby/Jellyfin/TMDB/TVDB connection settings | config endpoint | everything that talks to servers |
| `media_auth_devices` | Stable per-provider client identities used by managed account connections | media auth routes | Plex/Emby/Jellyfin authentication clients |
| `media_auth_flows` | Expiring, browser-bound account authorization attempts | media auth routes | media auth polling/completion |
| `media_connections` | Active encrypted provider token and verified remote identity | media auth routes | runtime media-server config adapter |
| `tracker_connections` | Encrypted Trakt OAuth connection plus initial-sync policy/cursor state | tracker auth routes | scheduled tracker sync and outbound dispatcher |
| `tracker_auth_flows` | Expiring Trakt device-code authorization attempts | tracker auth routes | tracker auth polling/completion |
| `tracker_item_state` | Last observed Trakt state/timestamp and echo-suppression markers per canonical item | tracker sync/dispatcher | Trakt change detection |
| `tracker_play_history` | Dedup ledger of individually-imported Trakt plays, keyed by Trakt history id | tracker sync | rewatch/multi-play import |
| `personal_rating_sources` | Last per-provider personal-rating observation, snapshot generation, conflict status, and outbound echo markers | rating snapshot/queue worker | rating reconciliation and status |
| `personal_rating_sync_queue` | Durable latest-intent personal-rating writes with leases, retries, and outcomes | local rating actions, rating push/reconcile | rating queue worker and status |
| `personal_rating_sync_runs` | Per-provider baseline/import generation and scan counters | rating snapshot worker | rating status and missing-row safety |
| `personal_watchlist` | Canonical present-set of local movie/TV watchlist rows | personal-media actions, watched completion hook | Watchlist page, watchlist sync |
| `personal_watchlist_meta` | Singleton monotone canonical watchlist revision | watchlist repository | mutation ordering and queue intent |
| `personal_watchlist_mutations` | Append-only present/absent mutations, including removal tombstones and origin/reason | local/provider/watched/restore paths | latest desired state, reconciliation |
| `personal_watchlist_provider_items` | Provider/user/representation observations, ownership, container IDs, and outbound status | watchlist snapshot/queue worker | safe removal, status, retry |
| `personal_watchlist_sync_queue` | Durable latest-intent provider additions/removals with leases and retry state | watchlist repository/worker | watchlist queue worker |
| `personal_watchlist_sync_runs` | Provider snapshot generations, completion markers, cursors, counts, and errors | watchlist snapshot worker | complete-snapshot safety/status |
| `personal_watchlist_activity` | Redacted watchlist-specific activity and removal reasons | watchlist repository/worker | Watchlist settings activity feed |
| `loop_keys` | Loop-detection KV with TTL | sync orchestrator | sync orchestrator |
| `poster_cache` | Cached artwork metadata (binaries in `data/media/`) | poster handler | poster resolution |
| `tmdb_metadata_cache` | Movie details (pure TMDB) or TV show details (TVDB structure + TMDB extras merged), key `${mediaType}_${tmdbId}` (or `tv_tvdb_${tvdbId}` if no TMDB match) | tmdb-details handler | detail pages, prefetch |
| `tmdb_search_cache` | TMDB search results and versioned Discover feed snapshots | tmdb-search/discover handlers | TMDB search and Discover |
| `tmdb_season_cache` | Unused compatibility table; season data is stored in `tvdb_season_cache` | - (unused) | - |
| `tmdb_person_cache` | TMDB person details, key `person_${personId}` | tmdb-person handler | cast pages |
| `tvdb_metadata_cache` | Raw TheTVDB series/extended response, key `series_${tvdbId}` (also holds title-search results, key `search_${hash}`) | tvdbGateway | tv show detail resolution |
| `tvdb_season_cache` | Raw TheTVDB season/extended episode list, key `${tvdbId}_${seasonNumber}` | tvdbGateway | tmdb-season handler |
| `omdb_cache` | OMDb/IMDb ratings, 7-day TTL, key is the IMDb ID (`tt…`) | omdb-rating handler | media detail pages |
| `fanart_cache` | Raw fanart.tv responses including "no artwork" misses, 7-day TTL (1 day for misses), key `movies/<tmdbId>` / `tv/<tvdbId>` | fanartGateway | artwork resolution, edit-image galleries |
| `youtube_meta_cache` | Trailer metadata per YouTube video ID, 30-day TTL | youtube-meta handler | trailer playback |
| `audit_log` | Security-relevant event log (login, credential change, rotation) | `writeAuditLog()` in `db.js` | ops/debugging only |
| `diagnostic_log` | Captured console output, bounded ring buffer of 20,000 rows | `diagnosticLogger.js` | Settings → Logs panel |
| `schema_migrations` | Ordered migration ledger (`id`, `applied_at`) | `db.js` at startup | startup only |

## Schema migrations

`server/src/db.js` applies `schema.sql`, then runs ordered migration steps and records
each applied id in `schema_migrations`. Existing databases that already have a migrated
column still record the migration id after the idempotent check succeeds, so every
database converges on the same ledger.

## `up_next_provider_items` and `up_next_provider_feed_state`

The provider tables are a rebuildable source ledger, not a second watch-history store.
`up_next_provider_items` keeps one row per `(provider, feed_kind, provider_item_id)` in
the currently active feed generation. It retains canonical identity hints (IMDb/TMDB/
TVDB IDs and series IDs), episode coordinates, source timestamps, progress, poster
metadata, and the native IDs needed for later provider writes. `provider_ids_json` is
normalized metadata rather than a raw provider response.

`up_next_provider_feed_state` makes refreshes atomic from the queue's point of view:
the scheduler writes a generation, replaces active rows only after a complete response,
and records `failed`/`partial` status without discarding the last successful generation.
The dashboard receives feed freshness and redacted errors, never
provider URLs, API keys, tokens, or raw payloads. A changed active ledger advances the
`up_next` cache version and the live-update stream.

These two tables are cleared by tracked-data wipes and are intentionally rebuildable;
portable watch-history backups do not need to include them. Restoring canonical
`watch_history`, `playstate`, and `playback_progress` remains sufficient to recover the
local queue, while the next scheduled provider catch-up repopulates source observations.

## `live_tracking_cache`

Written by `upsertLiveTrackingCache` in `server/src/utils/dataRepo.js` (the data repository):

```
session_id     TEXT PRIMARY KEY  -- e.g. "plex:<id>:<season>:<episode>"
title          TEXT
source_platform TEXT             -- "plex" | "emby" | "jellyfin"
last_progress  REAL              -- 0..100
updated_at     INTEGER           -- epoch ms
completed_at   INTEGER           -- NULL while playing; set when progress ≥ 90 then session disappears
payload_json   TEXT              -- full session object (offset, duration, IDs, raw)
```

`handleNowPlaying` filters `WHERE completed_at IS NULL`. Rows with `completed_at`
set represent recently-finished sessions; they're kept temporarily so the dashboard
can show "just finished" state, then purged after 24h.

## `active_sessions`

Written by `upsertActiveSession`. **Configurable TTL enforced in code (5 minutes by
default):** `listActiveSessions` deletes rows with `updated_at` older than the active
session TTL on every read. The table will be
absent from queries when playback events haven't arrived recently - that's normal.

## `runtime_state` (single row)

JSON blob with:
- `nowPlayingRefresh` - timestamp bumped on webhook events; surfaced via the
  `X-Now-Playing-Refresh` response header so the dashboard knows to reload history
- `forceSyncState` - current force-sync status (`"running"`, `"done"`, `"error"`)
- `forceSyncLog` - streamed log text from the last force-sync run
- `lastCronAt` - epoch ms of the last successful scheduled tick

## `settings` (single row)

JSON blob with provider mode and non-secret connection configuration, legacy manual
Plex URL/token, Emby/Jellyfin URL/API key/user ID, TMDB key, Fanart.tv key, YouTube key,
OMDb key, and Seerr credentials. Managed account and Trakt tokens live encrypted in their
dedicated connection tables and are adapted into runtime configuration only in memory.
Written by `POST /api/config`, read by everything that calls the media server APIs.

## `watch_history` artwork columns

Custom artwork selected from media detail pages is stored on each watch row:
- `poster_url` - selected poster or locally cached `/media/posters/...` URL
- `logo_url` - selected transparent logo/title art URL
- `backdrop_url` - selected background/backdrop or locally cached `/media/backdrops/...` URL

For TV shows, grouped show summaries expose the canonical poster from `media_artwork`
when one exists; episode rows retain their own poster so episode stills remain
independent.

Episode title repair state is stored alongside each episode row:
- `episode_title_status` - `resolved`, `missing`, `retryable_error`, or
  `no_title_provided`; verified title-less rows are excluded from the actionable repair list
- `episode_title_checked_at` - epoch-ms time of the last authoritative repair check
- `episode_title_resolution_error` - bounded, non-secret error text for a retryable lookup

## `media_artwork`

Show-level poster overrides are stored separately from `watch_history`:

- `identity_key` - provider alias (`tv:tmdb:<id>`, `tv:tvdb:<id>`, `tv:imdb:<id>`) or normalized show-title key
- `media_type` - currently `tv` for canonical show posters
- `title`, `tmdb_id`, `tvdb_id`, `imdb_id` - identity values known when the poster was saved
- `poster_url` - selected or locally cached show poster
- `poster_source` - `manual` for Edit Images selections, or the source used by a future automatic resolver
- `updated_at` - last update timestamp

An Edit Images poster change updates all known aliases for the show. It never copies
the show poster into episode rows.

## `personal_ratings`

Personal ratings are local user data. Movie and TV rows use their own provider
identity; episode rows use the parent show's provider identity plus `season` and
`episode` in `media_key`. Episode-level provider IDs are stored separately so a
provider write can address the leaf item without changing the canonical key.
`origin` identifies `manual`, `import`, or `reconcile` writes and
`canonical_updated_at` supplies ordering for conflict resolution and queue intents.
Startup migration 17 merges older episode aliases that share a show title and
episode coordinate, keeping the canonical media-page row and the latest rating.
Migration 20 adds the episode identity/origin columns and the isolated rating
source, queue, and run tables. The Ratings page reads the canonical records, while
`poster_url` remains the episode's own artwork.

## Personal rating sync tables

`personal_rating_sources` stores the latest observation for each provider/media key,
including the provider item ID, remote rated/unrated state, snapshot generation,
last inbound timestamp, last outbound intent marker, and a bounded error/status.

`personal_rating_sync_queue` has one row per provider/media key. A newer local or
reconcile intent replaces the older pending intent, which prevents stale ratings
from being delivered after a quick edit/remove sequence. `processing` rows have a
lease owner and expiry so a crashed worker can be reclaimed; transient failures use
`failed` plus `next_attempt_at`, while `not_found` and `reauth_required` await an
explicit retry.

`personal_rating_sync_runs` records one current snapshot generation per provider,
its baseline/import mode, completion marker, counts, cursor, and last error. Missing
remote ratings are only treated as clears after a previous complete generation, so
an incomplete provider response cannot bulk-clear local ratings.

## Personal watchlist tables

`personal_watchlist` remains the compatibility-facing current present-set. Every local
add, local removal, provider-originated removal, watched completion, or restore writes an
append-only `personal_watchlist_mutations` row and advances `personal_watchlist_meta`.
Absent mutations are retained as tombstones so a restart or rapid re-add cannot lose a
removal. The latest canonical revision, rather than the provider timestamp alone, wins.

`personal_watchlist_provider_items` is deliberately scoped by provider connection,
remote user, representation, and media key. It supports duplicate provider copies and
records whether Plembfin owns each item or container. Queue rows explicitly store
`desired_state` (`present` or `absent`), so an absence can never be confused with “no
work”. Processing rows have a lease; transient failures retry with backoff, while
`not_available` and `reauth_required` remain visible for an explicit retry.

`personal_watchlist_sync_runs.complete_snapshot` is the safety gate for remote deletion:
only a successful complete snapshot may interpret a previously owned item missing from
the next snapshot as a confirmed provider removal. Restore resets remote observations,
queue success markers, and snapshot completion, records a restore revision, and stores a
separate restore-pending flag until explicit publish.

## `watch_history` sync retry columns

The scheduled dispatcher tracks its automatic-retry backoff on each watch row:
- `sync_retry_count` - consecutive failed dispatch attempts (reset to 0 on
  success or by the manual Retry Sync action)
- `sync_next_retry_at` - epoch-ms timestamp before which the scheduler will not
  re-dispatch this record (exponential backoff: 1 m → 5 m → 15 m → 1 h → 6 h)

After 10 failed attempts the record is terminal and only a manual Retry Sync
re-queues it. See [scheduled-sync.md](scheduled-sync.md).

## `audit_log`

Written by `writeAuditLog(action, { ip, detail })`. Actions logged:
- `login.success` / `login.failure`
- `credentials.updated`
- `sessions.revoked`
- `webhook-secret.rotated`
- `media.deleted`
- `settings.saved`
- `backup.restored`

Not exposed via API - query the database directly for ops review:
```sh
sqlite3 data/plembfin.db "SELECT ts, action, ip, detail FROM audit_log ORDER BY ts DESC LIMIT 50;"
```

## `diagnostic_log`

`diagnosticLogger.js` wraps `console.log` / `console.warn` / `console.error` and writes
each captured line here. Columns: `ts`, `level`, `category`, `role`, `instance`, `message`.
Secrets are redacted and known-spam lines are dropped before insert.

Writes are batched - entries buffer for up to a second and flush inside one transaction,
so a burst of output costs a single disk sync. The table is a ring buffer capped at 20,000
rows; the oldest rows are trimmed as new batches land, which keeps the Settings → Logs
query flat regardless of how long the process has been running.

Every process writes to this shared table, so the logs panel shows web and worker output
merged without reading other processes' files. `GET /api/diagnostic-logs` serves the panel
from an indexed query; `DELETE` on the same route clears the table.

Indexes: `diagnostic_log_ts`, `diagnostic_log_category_ts`, `diagnostic_log_level_ts` -
one per filter combination the panel offers.

The JSONL files under `data/logs` are a separate crash-forensics archive written
asynchronously. Nothing reads them at runtime, and they are pruned on boot to the last
20 files / 7 days.
