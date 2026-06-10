# Firestore Collections

Reference for the production Firestore. Field schemas are described where they
matter for debugging. **Watch out for camelCase-in-storage vs snake_case-in-code**
— several collections store camelCase but the code passes around snake_case row
shapes, converting at the repo boundary (`functions/src/utils/firestoreRepo.js`).

> Reminder: the emulator's Firestore is a **separate database** from production.

## Collection list

| Collection | Purpose | Written by | Read by |
| --- | --- | --- | --- |
| `watchHistory` | Canonical watch records (one doc per unique watched item) | webhook `completed`/`unplayed`, scheduled catch-up, import | history endpoints, dashboard |
| `liveTrackingCache` | Snapshot of currently-playing sessions | `scheduledSync` poller only | `handleNowPlaying` |
| `activeSessions` | Live sessions from webhook `active` events (5-min TTL) | webhook `active` phase | `handleNowPlaying`, `active-sessions` |
| `playbackProgress` | Resume position records | webhook `ended`, sync | resume propagation |
| `playstate` | Per-item watched/unwatched state for sync targets | sync orchestrator | sync orchestrator |
| `syncHistory` | Log of all sync dispatch results | every sync attempt | sync-history endpoint |
| `runtimeState` (single doc) | Last cron time, force-sync state/log, `nowPlayingRefresh` signal | cron/force-sync, webhooks | dashboard polling |
| `settings` / `mediaConfig` | Plex/Emby/Jellyfin connection settings | config endpoint | everything that talks to servers |
| `tmdbMetadataCache` | TMDB details, 7-day TTL, key `${mediaType}_${tmdbId}` | tmdb-details handler | detail pages, prefetch |
| `tmdbPersonCache` | TMDB person details, key `person_${personId}` | tmdb-person handler | cast pages |
| `posterCache` | Downloaded poster URLs, key `mediaKey` | poster handler | poster resolution |
| `derivedCache` / `derivedShowSummaries` | Pre-computed history/show-summary caches | history derivation | dashboard/explorer |
| `loopKeys` | Persisted loop-detection keys | sync orchestrator | sync orchestrator |

(Exact set may grow; the console is the source of truth. A collection only appears
in the console once it has ≥ 1 document — e.g. `activeSessions` is *absent* when no
webhook `active` event has arrived recently. That absence is normal.)

## `liveTrackingCache` (the schema trap)

**Stored shape (camelCase)** — written by `upsertLiveTrackingCache`
(`firestoreRepo.js:692`):

```
{
  title: string,
  sourcePlatform: "plex" | "emby" | "jellyfin",
  lastProgress: number,        // 0..100
  updatedAt: number,           // epoch ms
  completedAt: number | null,  // null while playing
  payload: { ... },            // full session object (offsetMs, durationMs, ids, client, raw, …)
  expireAt: Timestamp          // now + 24h (Firestore TTL candidate)
}
```

Doc ID = a session key like `emby:<deviceSessionId>:<season>:<episode>` or
`plex:<id>:<season>:<episode>`.

**Code-side row shape (snake_case)** — what `loadLiveTrackingCache`
(`firestoreRepo.js:673`) returns and `hydrateCachedSession`
(`liveSessions.js:347`) consumes:

```
{ session_id, title, source_platform, last_progress, updated_at, completed_at, payload_json }
```

The repo converts between the two. If Now Playing renders "Unknown media" / 0%,
suspect this conversion (a field renamed on one side only).

`includeCompleted: false` filters out rows where `completedAt != null`. Completed
rows are purged after 24h by `purgeCompletedLiveTrackingCache`
(`firestoreRepo.js:733`).

## `activeSessions`

Written by `upsertActiveSession` (`functions/src/utils/activeSessions.js:64`):

```
{
  title, mediaType, source, progress (0..100), offsetMs, durationMs,
  season, episode, posterUrl, ids, event,
  client: { userName, deviceName },
  updatedAt: number,            // epoch ms
  expireAt: Timestamp           // now + 5 min
}
```

Doc ID = `sessionIdentity(media)` (normalized source/type/season/episode/provider
IDs or title). **5-minute TTL** enforced in code: `listActiveSessions`
(`activeSessions.js:46`) deletes rows with `updatedAt` older than 5 minutes on every
read. So this collection naturally empties out when playback events stop.

## `runtimeState` (single doc)

Holds `nowPlayingRefresh` (a timestamp bumped on webhook events; surfaced via the
`X-Now-Playing-Refresh` response header so the dashboard knows to reload history),
plus force-sync state/log and last cron time.
