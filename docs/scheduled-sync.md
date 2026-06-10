# Scheduled Sync (`scheduledSync`)

A Cloud Scheduler job runs `runScheduledSync()` **every 1 minute**
(`functions/src/index.js:1854`, `schedule: "every 1 minutes"`,
`timeoutSeconds: 60`). The same logic runs on demand via:

- `POST /api/cron-sync` — `handleCronSync` (streams a text log back).
- `POST /api/force-sync` — runs it and stores progress in `runtimeState` for the
  dashboard to poll; `stop-force-sync` cancels.

Implementation lives in `functions/src/scheduled.js`.

## What it does each run

1. **Catch-up watched sync** — for each active platform, pull recently-watched
   items and propagate any that haven't been synced yet:
   - `syncRecentlyWatchedFromPlex` / `...FromEmby` / `...FromJellyfin`
     (`scheduled.js:840`+). Each is wrapped in try/catch so one platform failing
     doesn't abort the run.
2. **Manual dispatch queue** — `syncPendingManualDispatches` processes anything
   queued by the UI (manual mark-watched, retries).
3. **Live session tracking** (this feeds Now Playing):
   - `fetchLiveSessions(config)` polls the servers for what's playing now.
   - `buildCacheRow()` shapes each session; `upsertLiveTrackingCache()` writes them
     to `liveTrackingCache` (`scheduled.js:874`–`884`).
   - It then reconciles against the previously-cached rows: a cached session that
     is **no longer playing** and had `last_progress >= 90` is treated as a
     **completed watch** (`processCompletedSession` → inserts history + propagates).
     Sessions that vanish below the threshold are marked/cleared as stale.

This is how a play that finishes without a final scrobble webhook still gets
recorded: the poller sees it hit ≥ 90% then disappear, and completes it.

## Why it matters for Now Playing

`liveTrackingCache` is the **primary** source for Now Playing (see
[now-playing.md](now-playing.md)). If the poller can't reach the media servers,
`liveTrackingCache` goes empty and Now Playing shows idle — even though the UI and
webhooks are fine.

**Reachability:** `scheduledSync` runs in `europe-west2` on Google's network. It
can only poll media-server URLs that are **reachable from the public internet**.
`localhost` / LAN IPs (`192.168.x.x`, `127.0.0.1`) configured in `settings` will
silently fail from the cloud. (The browser-side probe in `loadActiveSessions`
compensates for live display, but the poller's completion/catch-up logic still
won't run.)

## Debugging

- Trigger it manually and watch the log: `POST /api/cron-sync` (the response
  streams a line-by-line log identical to what the scheduler runs).
- Or read Cloud Functions logs for the `scheduledSync` function in the Google Cloud
  console.
- Key log lines: `"live sessions: N, cached sessions in tracking: M"` tells you
  whether the poller is seeing anything.
