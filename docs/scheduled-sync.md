# Scheduled Sync

The in-process scheduler runs `runScheduledTick()` **every minute** via
`setInterval` in `server/server.js`. It is guarded against overlap: if a tick is
still running when the next fires, the new tick is skipped.

The same logic runs on demand via:
- `POST /api/cron-sync` — `handleCronSync` (streams a text log back, auth by API key
  or session cookie).
- `POST /api/force-sync` — runs it and stores progress in `runtime_state` for the
  dashboard to poll; `POST /api/stop-force-sync` cancels.

Implementation lives in `server/src/scheduled.js`.

## What it does each run

1. **Catch-up watched sync** — for each active platform, pull recently-watched items
   and propagate any that haven't been synced yet:
   - `syncRecentlyWatchedFromPlex` / `...FromEmby` / `...FromJellyfin`
     (`scheduled.js`). Each is wrapped in try/catch so one platform failing doesn't
     abort the run.
2. **Manual dispatch queue** — `syncPendingManualDispatches` processes anything
   queued by the UI (manual mark-watched, retries).
3. **Live session tracking** (this feeds Now Playing):
   - `fetchLiveSessions(config)` polls the configured servers for what's playing now.
   - `buildCacheRow()` shapes each session; `upsertLiveTrackingCache()` writes them
     to the `live_tracking_cache` SQLite table.
   - Reconciles against the previously-cached rows: a cached session that is **no
     longer playing** and had `last_progress >= 90` is treated as a **completed
     watch** (`processCompletedSession` → inserts history + propagates). Sessions
     that vanish below the threshold are marked/cleared as stale.

This is how a play that finishes without a final scrobble webhook still gets
recorded: the poller sees it hit ≥ 90% then disappear, and completes it.

4. **TV next-airing cache** â€” `runScheduledTick()` maintains
   `data/next-airing-cache.json` from TMDB. The first run after startup builds the
   cache for every show with a TMDB ID, and later runs refresh stale entries so the
   TV Shows page can sort by upcoming episode date without querying TMDB for every
   row.

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
- Force sync from the dashboard: **Settings → Tools → Force Sync** streams the same
  log in-browser and shows per-platform status.
