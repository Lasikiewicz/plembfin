# Now Playing

The dashboard's "Now Playing" row. This is the most failure-prone part of the app
and the subject of a real production outage (June 2026), so it's documented in
detail.

## What feeds it

`handleNowPlaying` (`functions/src/index.js:648`) merges **two** Firestore
sources and returns the combined list:

1. **`liveTrackingCache`** — written **only** by the every-minute `scheduledSync`
   poller (`functions/src/scheduled.js:884`), which polls the Plex/Emby/Jellyfin
   servers directly and snapshots whatever is currently playing. Read via
   `loadLiveTrackingCache(db, { includeCompleted: false })`, which filters out rows
   with a `completedAt`.
2. **`activeSessions`** — written by the **webhook** `active` phase
   (`functions/src/index.js:1041` → `upsertActiveSession`). These have a **5-minute
   TTL**: `listActiveSessions` (`functions/src/utils/activeSessions.js:46`) deletes
   any row whose `updatedAt` is older than 5 minutes before returning.

The merge de-duplicates by `(source, title, season, episode)` and sorts by
`updatedAt` desc. So a session can reach Now Playing via the cloud poller, via a
webhook, or both.

```
Plex/Emby/Jellyfin
   │   (cloud poller, every 1 min)        (webhook "active" events)
   ▼                                            │
scheduledSync.fetchLiveSessions ──▶ liveTrackingCache    activeSessions ◀── handleWebhook (phase=active)
                                          │                    │
                                          └──── handleNowPlaying merges both ────┘
                                                          │
                                                  GET /api/now-playing
                                                          │
                                              app.js loadActiveSessions() (polled)
```

## Frontend (current design — polling)

- `startHistoryPolling()` (`public/app.js`) starts a `setInterval` that calls
  `loadActiveSessions()` every `NOW_PLAYING_POLL_MS` (10s). `stopHistoryPolling()`
  clears it.
- `loadActiveSessions()` (`public/app.js:2830`) does a plain `fetch` of
  `/api/now-playing` (no `?stream=1`), parses the JSON array, **also** probes the
  local network directly from the browser (`fetchLocalActiveSessions`) and merges
  any sessions found, then calls `setActiveSessions()` → `renderNowPlaying()`.
- **Visibility gating**: polling is started/stopped on `visibilitychange` and view
  changes, and `pollNowPlayingOnce()` bails + clears the interval whenever
  `document.hidden` or `activeView !== "dashboard"`. So it never runs in the
  background and never runs off the dashboard.
- The `X-Now-Playing-Refresh` response header signals that watch history changed
  (a webhook fired); when it changes, `loadActiveSessions` triggers `loadHistory()`.

### The browser-side local probe

`loadActiveSessions` calls `fetchLocalActiveSessions(configFromInputs(), ...)` —
the **user's browser** hits the configured Plex/Emby/Jellyfin URLs directly and
merges any live sessions it finds. This is why Now Playing can show LAN sessions
even when the cloud function can't reach those servers: the browser is on the LAN,
the function is not. Sessions are de-duped against the server-returned list.

## Why it broke: the SSE trap

**Symptom:** all three apps playing; the local emulator showed Now Playing; the
live site showed "Entire media ecosystem is idle." Identical code, and the data
was confirmed present in production's `liveTrackingCache`.

**Root cause:** the dashboard used to consume Now Playing as a **Server-Sent
Events stream** — `startNowPlayingStream()` fetched `/api/now-playing?stream=1` and
read a long-lived `text/event-stream` response. The server handler had a streaming
branch that wrote `data: …` frames and kept the connection open with Firestore
`onSnapshot` listeners + a heartbeat. (Both the frontend consumer and that server
branch have since been removed — see the fix below.)

SSE works against the **emulator** (browser talks to the function directly). In
**production** the request goes `browser → Firebase Hosting → Cloud Function`, and
**Hosting buffers the response** instead of passing chunks through. The `data:`
frames never reached the browser; the reader sat receiving nothing, the connection
eventually dropped, it reconnected every 5s, and the grid stayed on its "idle"
placeholder forever.

**Fix (current state):** dropped SSE for Now Playing entirely. `handleNowPlaying`
(`functions/src/index.js:648`) is now a plain request/response handler that returns
a JSON array, and the dashboard polls it every 10s via `loadActiveSessions()`. JSON
passes through the Hosting proxy fine. Polling is also *cheaper* than SSE here,
because SSE pinned a Cloud Function instance open (billed by wall-clock GB-seconds)
for the whole time the dashboard was open; short polls spin up and die in under a
second. The `?stream=1` query param is no longer recognised — it returns the same
JSON as any other request.

> Don't reintroduce an SSE consumer behind the Hosting proxy without first
> verifying chunks actually flush through in production (they didn't before). The
> streaming server branch and its `onSnapshot`/heartbeat machinery were deleted, so
> reintroducing SSE means rebuilding both ends.

## Diagnosing "Now Playing is wrong" in future

Work outside-in:

1. **Is the data in Firestore?** Open the **production** Firestore console →
   `liveTrackingCache`. With media playing you should see fresh docs with
   `completedAt: null`. Also check whether `activeSessions` exists (it only exists
   if a webhook `active` event arrived recently — it's fine for it to be absent).
   - If `liveTrackingCache` is empty/stale → the `scheduledSync` poller isn't
     reaching your servers. Check that the Plex/Emby/Jellyfin URLs in `settings`
     are **publicly reachable** (the function runs in the cloud and cannot reach
     `localhost`/`192.168.x.x`). Check function logs for `scheduledSync`.
   - If `liveTrackingCache` docs are all `completedAt != null` → they're being
     marked complete (progress ≥ 90 then disappeared from the live poll), so they
     won't show. That's expected.
2. **Does the API return it?** On the live site, DevTools → Network → filter
   `now-playing`. You should see repeating requests (~every 10s) returning a JSON
   array of sessions. If the array is populated but the grid is empty → a frontend
   rendering bug (`renderNowPlaying` / `setActiveSessions`). If instead you see a
   long-lived `now-playing` request stuck **pending** with no body → someone
   reintroduced SSE; revert to polling.
3. **Auth?** A `401` means the ID token isn't being accepted — check
   `ADMIN_EMAILS`/`ADMIN_UIDS` and that you're signed in.

## Schema gotcha (don't trip on this)

`liveTrackingCache` is stored in **camelCase** (`sourcePlatform`, `lastProgress`,
`payload`, `completedAt`, `updatedAt`, `expireAt`) by `upsertLiveTrackingCache`
(`functions/src/utils/firestoreRepo.js:692`). The reader
`loadLiveTrackingCache` (`functions/src/utils/firestoreRepo.js:673`) converts those
back into the **snake_case** row shape (`source_platform`, `last_progress`,
`payload_json`, `completed_at`) that `hydrateCachedSession`
(`functions/src/utils/liveSessions.js:347`) expects. If you ever see Now Playing
rows render as "Unknown media" with 0% progress, suspect a writer/reader schema
mismatch here. See [firestore-collections.md](firestore-collections.md#livetrackingcache).
