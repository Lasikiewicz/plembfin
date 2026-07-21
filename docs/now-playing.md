# Now Playing

The dashboard's "Now Playing" row. This has caused a real production outage (June
2026), so the failure mode is documented in detail here.

## What feeds it

`handleNowPlaying` (`server/src/index.js`) merges **two** SQLite sources:

1. **`live_tracking_cache`** - written **only** by the every-minute scheduler
   (`server/src/scheduled.js`), which polls Plex/Emby/Jellyfin directly and
   snapshots whatever is currently playing. Only rows with `completed_at IS NULL`
   are returned.
2. **`active_sessions`** - written by the **webhook** `active` phase
   (`upsertActiveSession`). These have a configurable TTL (**5 minutes by default**):
   `listActiveSessions` deletes any row whose `updated_at` is older than the active
   session TTL before returning.

The merge de-duplicates by `(source, title, season, episode)` and sorts by
`updated_at` desc. A session can reach Now Playing via the scheduler, via a
webhook, or both.

```text
Plex/Emby/Jellyfin
   |   (scheduler poll, every 1 min)       (webhook "active" events)
   v                                              |
scheduled.js -> live_tracking_cache   active_sessions <- handleWebhook (phase=active)
                        |                    |
                        `-- handleNowPlaying merges both --'
                                      |
                              GET /api/now-playing
                                      |
                          app.js loadActiveSessions() (polled every 10s)
```

## Frontend (polling)

- `startHistoryPolling()` (`public/modules/sync.js`) starts a `setInterval` that
  calls `loadActiveSessions()` every `NOW_PLAYING_POLL_MS` (10s).
  `stopHistoryPolling()` clears it.
- `loadActiveSessions()` does a plain `fetch` of `/api/now-playing`, parses the
  JSON array, then calls `setActiveSessions()` -> `renderActiveSessions()`.
- **Visibility gating**: polling runs on every view, not just the dashboard, so a
  watched/unwatched change is picked up no matter what page is open; it only stops
  on `visibilitychange` (`pollNowPlayingOnce()` bails + clears the interval whenever
  `document.hidden`) or when signed out. `handleNowPlaying` is a cheap local
  SQLite read (no outbound calls to Plex/Emby/Jellyfin), so polling continuously
  across views has negligible cost.
- The `X-Now-Playing-Refresh` response header signals that watch history changed —
  a webhook fired, or the Plex notification listener (`handlePlexLibraryItemChange`
  in `server/src/scheduler.js`, see [plex.md](plex.md)) detected a watched/unwatched
  change. When it changes, `loadActiveSessions` triggers `loadHistory()` and, if
  the user is currently on the Explorer or History view, also clears derived UI
  caches and re-renders that view so the change shows up immediately.

## Posters

A live session's `posterUrl` is the **raw media-server thumb path** (e.g. Plex
`/library/metadata/.../thumb/...`), not a cached image. A browser on the public
`https://` site can't load that directly: the media server is usually `http://`
on the LAN (mixed-content blocked, and the LAN address isn't reachable remotely).
So the now-playing card renders a `poster-fallback` span and hydrates it through
`/api/poster?id=<media_key>`, the same server-side fetch-and-cache pipeline that
backs history posters (artwork lands in `/media/posters/*.webp`).

`handlePoster` resolves the `id` in this order: watch record -> `media_key` ->
`playback_progress` -> **live session**. The live-session step
(`findLiveSessionPosterRow`) matches the `media_key` against `live_tracking_cache`
and `active_sessions`, then synthesizes a row carrying the thumb path as
`poster_url`. Without it, a currently-playing item that has never been watched
exists in none of the watch tables, so `/api/poster` returns **404** and the
poster never loads. The cache is keyed by `media_key`, so once the episode becomes
a real watch record it reuses the same cached artwork.

## Why the SSE approach broke (historical)

**Symptom (June 2026):** all three apps playing; local dev showed Now Playing; the
live site showed "Entire media ecosystem is idle." Identical code, data confirmed
present in the database.

**Root cause:** the dashboard previously consumed Now Playing as a **Server-Sent
Events stream**: `startNowPlayingStream()` fetched `/api/now-playing?stream=1` and
read a long-lived `text/event-stream` response. The server had a streaming branch
that wrote `data:` frames and kept the connection open with change listeners
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
   - If empty/stale -> the scheduler isn't reaching the servers. Check the server logs
     for poller errors. Confirm the Plex/Emby/Jellyfin URLs in Settings are reachable
     from the Plembfin server.
   - If all rows have `completed_at != NULL` -> they were marked complete after
     reaching the watched threshold (90% by default) and disappearing, so they
     won't show. Expected.

2. **Does the API return it?** DevTools -> Network -> filter `now-playing`. You should
   see repeating requests every 10s returning a JSON array. If the array has
   sessions but the grid is empty, check `renderActiveSessions()` /
   `setActiveSessions()`.

3. **Auth?** A `401` means the session cookie or API key isn't being sent. Check
   that you're signed in and the `plembfin_session` cookie is present.
