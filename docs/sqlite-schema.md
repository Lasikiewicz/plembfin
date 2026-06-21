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
| `sync_history` | Log of all sync dispatch results | every sync attempt | sync-history endpoint |
| `runtime_state` | Single-row JSON blob — last cron time, force-sync state/log, `nowPlayingRefresh` signal | scheduler, force-sync, webhooks | dashboard polling |
| `settings` | Single-row JSON blob — Plex/Emby/Jellyfin/TMDB connection settings | config endpoint | everything that talks to servers |
| `loop_keys` | Loop-detection KV with TTL | sync orchestrator | sync orchestrator |
| `poster_cache` | Cached artwork metadata (binaries in `data/media/`) | poster handler | poster resolution |
| `tmdb_metadata_cache` | TMDB details, 7-day TTL, key `${mediaType}_${tmdbId}` | tmdb-details handler | detail pages, prefetch |
| `tmdb_search_cache` | TMDB search results | tmdb-search handler | TMDB search |
| `tmdb_season_cache` | TMDB season details | tmdb-season handler | TV detail pages |
| `tmdb_person_cache` | TMDB person details, key `person_${personId}` | tmdb-person handler | cast pages |
| `audit_log` | Security-relevant event log (login, credential change, rotation) | `writeAuditLog()` in `db.js` | ops/debugging only |

## `live_tracking_cache`

Written by `upsertLiveTrackingCache` in `server/src/utils/firestoreRepo.js` (the db module):

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

Written by `upsertActiveSession`. **5-minute TTL enforced in code:** `listActiveSessions`
deletes rows with `updated_at` older than 5 minutes on every read. The table will be
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
URL/API key/user ID, TMDB key, YouTube key, and Seerr credentials. Written by
`POST /api/config`, read by everything that calls the media server APIs.

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
