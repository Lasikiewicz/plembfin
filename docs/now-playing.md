# Now Playing

The dashboard's "Now Playing" row. This has caused a real production outage (June
2026), so the failure mode is documented in detail here.

## What feeds it

`handleNowPlaying` (`server/src/index.js`) merges **two** SQLite sources:

1. **`live_tracking_cache`** — written **only** by the every-minute scheduler
   (`server/src/scheduled.js`), which polls Plex/Emby/Jellyfin directly and
   snapshots whatever is currently playing. Only rows with `completed_at IS NULL`
   are returned.
2. **`active_sessions`** — written by the **webhook** `active` phase
   (`upsertActiveSession`). These have a **5-minute TTL**: `listActiveSessions`
   deletes any row whose `updated_at` is more than 5 minutes old before returning.

The merge de-duplicates by `(source, title, season, episode)` and sorts by
`updated_at` desc. A session can reach Now Playing via the scheduler, via a
webhook, or both.

```
Plex/Emby/Jellyfin
   │   (scheduler poll, every 1 min)       (webhook "active" events)
   ▼                                              │
scheduled.js → live_tracking_cache   active_sessions ← handleWebhook (phase=active)
                        │                    │
                        └── handleNowPlaying merges both ──┘
                                      │
                              GET /api/now-playing
                                      │
                          app.js loadActiveSessions() (polled every 10s)
```

## Frontend (polling)

- `startHistoryPolling()` (`public/app.js`) starts a `setInterval` that calls
  `loadActiveSessions()` every `NOW_PLAYING_POLL_MS` (10s). `stopHistoryPolling()`
  clears it.
- `loadActiveSessions()` does a plain `fetch` of `/api/now-playing`, parses the
  JSON array, **also** probes the local network directly from the browser
  (`fetchLocalActiveSessions`) and merges any sessions found, then calls
  `setActiveSessions()` → `renderNowPlaying()`.
- **Visibility gating**: polling starts/stops on `visibilitychange` and view
  changes; `pollNowPlayingOnce()` bails + clears the interval whenever
  `document.hidden` or the active view is not the dashboard.
- The `X-Now-Playing-Refresh` response header signals that watch history changed
  (a webhook fired); when it changes, `loadActiveSessions` triggers `loadHistory()`.

### The browser-side local probe

`loadActiveSessions` calls `fetchLocalActiveSessions(configFromInputs(), ...)` —
the **user's browser** hits the configured Plex/Emby/Jellyfin URLs directly and
merges any live sessions it finds. This is why Now Playing can show LAN sessions
even when Plembfin itself can't reach those servers (e.g. the server is on a
different network segment): the browser is on the LAN and can reach them directly.
Sessions are de-duped against the server-returned list.

## Why the SSE approach broke (historical)

**Symptom (June 2026):** all three apps playing; local dev showed Now Playing; the
live site showed "Entire media ecosystem is idle." Identical code, data confirmed
present in the database.

**Root cause:** the dashboard previously consumed Now Playing as a **Server-Sent
Events stream** — `startNowPlayingStream()` fetched `/api/now-playing?stream=1` and
read a long-lived `text/event-stream` response. The server had a streaming branch
that wrote `data:` frames and kept the connection open with `onSnapshot` listeners
and a heartbeat.

**Fix (current design):** SSE dropped entirely for Now Playing. `handleNowPlaying`
returns a plain JSON array, and the dashboard polls it every 10s via
`loadActiveSessions()`.

> Don't reintroduce an SSE consumer for Now Playing. The streaming server branch and
> its heartbeat machinery were deleted. Polling is the right design for this use case.

## Diagnosing "Now Playing is wrong"

Work outside-in:

1. **Is the data in the database?** Run:
   ```sh
   sqlite3 data/plembfin.db "SELECT title, source_platform, last_progress, completed_at FROM live_tracking_cache ORDER BY updated_at DESC LIMIT 10;"
   ```
   With media playing you should see rows with `completed_at` = NULL.
   - If empty/stale → the scheduler isn't reaching the servers. Check the server logs
     for poller errors. Confirm the Plex/Emby/Jellyfin URLs in Settings are reachable
     from the Plembfin server (not just from the browser).
   - If all rows have `completed_at != NULL` → they were marked complete (≥ 90%
     progress then disappeared), so they won't show. Expected.

2. **Does the API return it?** DevTools → Network → filter `now-playing`. You should
   see repeating requests (~every 10s) returning a JSON array. If the array has
   sessions but the grid is empty → a frontend rendering bug in
   `renderNowPlaying` / `setActiveSessions`.

3. **Auth?** A `401` means the session cookie or API key isn't being sent — check
   that you're signed in and the `plembfin_session` cookie is present.
