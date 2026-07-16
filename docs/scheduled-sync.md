# Scheduled Sync

The in-process scheduler runs `runScheduledTick()` **every minute** via
`setInterval` in `server/server.js`. It is guarded against overlap: if a tick is
still running when the next fires, the new tick is skipped.

The same logic runs on demand via:
- `GET /api/cron-sync/status` - returns the last cron trigger/result as JSON for
  automation that needs a reliable success/failure signal after a streamed run.
- `POST /api/cron-sync` — `handleCronSync` (streams a text log back, auth by API key
  or session cookie).
- `POST /api/force-sync` — runs it and stores progress in `runtime_state` for the
  dashboard to poll; `POST /api/stop-force-sync` cancels.

Implementation lives in `server/src/scheduled.js`.

## What it does each run

1. **Live session tracking** (this feeds Now Playing) — **runs every minute**:
   - `fetchLiveSessions(config)` polls the configured servers for what's playing now.
   - `buildCacheRow()` shapes each session; `upsertLiveTrackingCache()` writes them
     to the `live_tracking_cache` SQLite table.
   - Reconciles against the previously-cached rows: a cached session that is **no
     longer playing** and had `last_progress >= 90` is treated as a **completed
     watch** (`processCompletedSession` → inserts history + propagates). Sessions
     that vanish below the threshold are marked/cleared as stale.
2. **Manual dispatch queue** — **runs every minute**:
   - `syncPendingManualDispatches` processes anything queued by the UI (manual mark-watched, retries).
   - Records whose targets keep failing are retried with **exponential backoff**
     (1 m → 5 m → 15 m → 1 h → 6 h, tracked in the `sync_retry_count` /
     `sync_next_retry_at` columns on `watch_history`). After 10 failed attempts a
     record becomes terminal — its telemetry says automatic retries are exhausted
     and only a manual **Retry Sync** (which resets the counters) re-queues it.
     A `sync_history` row is only written when the outcome changes (first
     failure, success, or giving up), not on every identical failed attempt.
3. **Catch-up library sync** — **runs every 15 minutes** (configurable via `CATCHUP_SYNC_INTERVAL_MS` env variable) to avoid heavy redundant API queries:
   - Pulls recently-watched and continue-watching (resumable) items from each active server: `syncRecentlyWatchedFromPlex`/`syncRecentlyResumableFromPlex` (and Emby/Jellyfin equivalents) in `scheduled.js`.
   - Emby/Jellyfin episode resume rows retain series provider IDs so the corresponding SxxExx item can be found on another server. Resume and playstate records sharing any IMDb, TMDB, or TVDB ID are treated as one media item even when app titles differ.
   - Propagates playstate changes that were missed by webhooks. Each is wrapped in try/catch so one platform failing doesn't abort the run.

This is how a play that finishes without a final scrobble webhook still gets
recorded: the poller sees it hit ≥ 90% then disappear, and completes it.

4. **TV next-airing cache** — `runScheduledTick()` maintains
   `data/next-airing-cache.json`. To prevent timing out, the cache is
   built and refreshed in small batches (default 40 shows per 30-minute tick)
   sorted by the oldest update times. Each show is looked up through the regular
   `getTmdbDetails` cache layer (no forced refetch), so a refresh cycle only
   reaches TMDB/TVDB when a show's cached details have actually expired. This
   allows the TV Shows page to sort by upcoming episode date without querying
   TMDB for every row, while avoiding timeouts on large libraries.

## Why it matters for Now Playing

`live_tracking_cache` is the **primary** source for Now Playing (see
[now-playing.md](now-playing.md)). If the poller can't reach the media servers,
`live_tracking_cache` goes empty and Now Playing shows idle — even though the UI and
webhooks are fine.

**Reachability:** the poller runs on the same machine as the Plembfin server process.
It can reach any URL that machine can reach — including `localhost`, LAN IPs, and VPN
addresses.

## Debugging

- Trigger it manually and watch the log: `POST /api/cron-sync` with your API key
  (the response streams a line-by-line log identical to what the scheduler runs).
- Or watch the server process stdout — tick start/stop and any errors are logged.
- Key log lines: `"live sessions: N, cached sessions in tracking: M"` tells you
  whether the poller is seeing anything.
- Force sync from the dashboard: **Settings → System → Sync → Force Sync** streams the same
  log in-browser and shows per-platform status.
