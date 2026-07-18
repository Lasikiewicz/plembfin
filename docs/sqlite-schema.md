# SQLite Schema

Reference for `data/plembfin.db`. The full authoritative schema is in
`server/src/schema.sql`; this doc adds context on the less-obvious fields.

## Table list

| Table | Purpose | Written by | Read by |
| --- | --- | --- | --- |
| `watch_history` | Canonical watch records (one row per unique watched item) | webhook `completed`/`unplayed`, scheduled catch-up, import | history endpoints, dashboard |
| `live_tracking_cache` | Snapshot of currently-playing sessions from the scheduler | in-process scheduler only | `handleNowPlaying` |
| `active_sessions` | Live sessions from webhook `active` events (5-min TTL) | webhook `active` phase | `handleNowPlaying`, `active-sessions` |
| `playback_progress` | Resume position records | webhook `ended`, sync orchestrator | resume propagation |
| `playstate` | Per-item watched/unwatched state for sync targets | sync orchestrator | sync orchestrator |
| `sync_history` | Log of sync dispatch results (90-day / 10,000-row retention, pruned hourly on write) | sync outcome changes | sync-history endpoint |
| `runtime_state` | Single-row JSON blob — last cron time, force-sync state/log, `nowPlayingRefresh` signal | scheduler, force-sync, webhooks | dashboard polling |
| `settings` | Single-row JSON blob — Plex/Emby/Jellyfin/TMDB/TVDB connection settings | config endpoint | everything that talks to servers |
| `loop_keys` | Loop-detection KV with TTL | sync orchestrator | sync orchestrator |
| `poster_cache` | Cached artwork metadata (binaries in `data/media/`) | poster handler | poster resolution |
| `tmdb_metadata_cache` | Movie details (pure TMDB) or TV show details (TVDB structure + TMDB extras merged), key `${mediaType}_${tmdbId}` (or `tv_tvdb_${tvdbId}` if no TMDB match) | tmdb-details handler | detail pages, prefetch |
| `tmdb_search_cache` | TMDB search results | tmdb-search handler | TMDB search |
| `tmdb_season_cache` | Legacy TMDB season cache — no longer written; season data now comes from `tvdb_season_cache` | — (unused) | — |
| `tmdb_person_cache` | TMDB person details, key `person_${personId}` | tmdb-person handler | cast pages |
| `tvdb_metadata_cache` | Raw TheTVDB series/extended response, key `series_${tvdbId}` (also holds title-search results, key `search_${hash}`) | tvdbGateway | tv show detail resolution |
| `tvdb_season_cache` | Raw TheTVDB season/extended episode list, key `${tvdbId}_${seasonNumber}` | tvdbGateway | tmdb-season handler |
| `omdb_cache` | OMDb/IMDb ratings, 7-day TTL, key is the IMDb ID (`tt…`) | omdb-rating handler | media detail pages |
| `fanart_cache` | Raw fanart.tv responses including "no artwork" misses, 7-day TTL (1 day for misses), key `movies/<tmdbId>` / `tv/<tvdbId>` | fanartGateway | artwork resolution, edit-image galleries |
| `youtube_meta_cache` | Trailer metadata per YouTube video ID, 30-day TTL | youtube-meta handler | trailer playback |
| `audit_log` | Security-relevant event log (login, credential change, rotation) | `writeAuditLog()` in `db.js` | ops/debugging only |
| `schema_migrations` | Ordered migration ledger (`id`, `applied_at`) | `db.js` at startup | startup only |

## Schema migrations

`server/src/db.js` applies `schema.sql`, then runs ordered migration steps and records
each applied id in `schema_migrations`. Existing databases that already have a migrated
column still record the migration id after the idempotent check succeeds, so every
database converges on the same ledger.

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
absent from queries when playback events haven't arrived recently — that's normal.

## `runtime_state` (single row)

JSON blob with:
- `nowPlayingRefresh` — timestamp bumped on webhook events; surfaced via the
  `X-Now-Playing-Refresh` response header so the dashboard knows to reload history
- `forceSyncState` — current force-sync status (`"running"`, `"done"`, `"error"`)
- `forceSyncLog` — streamed log text from the last force-sync run
- `lastCronAt` — epoch ms of the last successful scheduled tick

## `settings` (single row)

JSON blob with the full connection configuration: Plex URL/token, Emby/Jellyfin
URL/API key/user ID, TMDB key, Fanart.tv key, YouTube key, OMDb key, and Seerr credentials. Written by
`POST /api/config`, read by everything that calls the media server APIs.

## `watch_history` artwork columns

Custom artwork selected from media detail pages is stored on each watch row:
- `poster_url` — selected poster or locally cached `/media/posters/...` URL
- `logo_url` — selected transparent logo/title art URL
- `backdrop_url` — selected background/backdrop or locally cached `/media/backdrops/...` URL

For TV shows, grouped show summaries inherit the first available poster, logo, and
backdrop from their episode rows.

## `watch_history` sync retry columns

The scheduled dispatcher tracks its automatic-retry backoff on each watch row:
- `sync_retry_count` — consecutive failed dispatch attempts (reset to 0 on
  success or by the manual Retry Sync action)
- `sync_next_retry_at` — epoch-ms timestamp before which the scheduler will not
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

Not exposed via API — query the database directly for ops review:
```sh
sqlite3 data/plembfin.db "SELECT ts, action, ip, detail FROM audit_log ORDER BY ts DESC LIMIT 50;"
```
