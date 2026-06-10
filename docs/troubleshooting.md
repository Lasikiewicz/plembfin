# Troubleshooting (symptom-first)

Start here. Find the symptom, follow the pointer.

## "Now Playing is empty on the live site but fine locally"

The classic. Causes, in order of likelihood:

1. **SSE reintroduced behind the Hosting proxy.** Firebase Hosting buffers
   streamed responses, so `/api/now-playing?stream=1` never delivers in prod. The
   dashboard must poll the **non-streaming** `/api/now-playing`. Check DevTools →
   Network: a `?stream=1` request stuck *pending* = this. Fix: revert to polling
   (`startHistoryPolling` → `loadActiveSessions` on an interval). Full write-up:
   [now-playing.md](now-playing.md#why-it-broke-the-sse-trap).
2. **Production `liveTrackingCache` is empty.** The cloud poller can't reach your
   media servers. They must be **internet-reachable** — the function runs in
   `europe-west2` and can't hit `localhost`/LAN IPs. Check `settings` URLs and
   `scheduledSync` logs. See [scheduled-sync.md](scheduled-sync.md).
3. **API returns data but grid is empty** → frontend render bug in
   `renderNowPlaying`/`setActiveSessions` (`public/app.js`).

Decision flow:
```
Now Playing idle on prod?
 ├─ Firestore → liveTrackingCache has fresh completedAt:null docs?
 │    ├─ NO  → poller can't reach servers (settings URLs / reachability)
 │    └─ YES → DevTools Network → /api/now-playing
 │             ├─ ?stream=1 pending      → SSE behind Hosting; switch to polling
 │             ├─ returns [] (empty)     → stale function deploy or read bug
 │             └─ returns sessions       → frontend render bug
```

## "Events show on the emulator but not on the live site (or vice versa)"

A webhook has **one** target. The media servers are pointed at one origin's
`/api/webhook`. Emulator URL ≠ production URL. Point them where you want the data.
See [webhooks.md](webhooks.md). (Production watch history being *newer* than the
emulator's is a tell that scrobbles go to prod while the emulator only gets some
other source.)

## "A watched item didn't record"

- Confirm the webhook reached the right environment (above).
- Check `media.phase` was `completed` — e.g. a Plex `media.stop` below 90% becomes
  `ended`, not `completed`. See the phase table in
  [webhooks.md](webhooks.md#normalization--phases).
- Check `syncHistory` / the watch record's `sync_dispatch_telemetry` for errors.

## "A watched item recorded but didn't sync to the other platforms"

- Look at `syncHistory` and the record's `sync_dispatch_telemetry`.
- Check the target platform's client (`embyClient.js` / `jellyfinClient.js` /
  `plexClient.js`) isn't erroring (auth/URL).
- Echo suppression: `loopStore` drops events that look like echoes of a recent
  dispatch — usually correct, but it's in-memory per instance. See
  [webhooks.md](webhooks.md#propagation-sync).

## "Resume position didn't carry over"

`playbackProgress` + `syncMediaProgress`. Triggered on `ended` when
`shouldSyncResumeProgress` is true and the source provided `viewOffset`/`duration`.
Plex must be sending playback lifecycle events with offsets.

## "Posters are missing / wrong"

Two-tier system. Frontend renders a `poster-fallback` then calls
`/api/poster?id=<docId>`. Backend tries: stored URL → configured server URL → TMDB,
then caches the winner to Firebase Storage (`posterCache`, key `mediaKey`).
- Only `firebasestorage.googleapis.com` URLs are treated as "cached"
  (`isCachedStorageImageUrl`); `image.tmdb.org` URLs are not, and are stored as
  `""` by `rememberPosterLookup` (the in-memory `posterLookupCache` bypasses this
  for TMDB URLs from the prefetch observer). This is intentional; see CLAUDE.md
  "Poster pipeline."

## "Can't sign in / 401s everywhere"

Admin gating: `ADMIN_EMAILS` / `ADMIN_UIDS` in `functions/.env`, verified by
`requireAdmin` (`functions/src/utils/auth.js`). Emulator admin login is
`admin`/`admin`.

## General: where do I look?

| Need | Place |
| --- | --- |
| What route handles X | `dispatch()` in `functions/src/index.js:1811` |
| Live function logs | Google Cloud console → Cloud Functions → `api` / `scheduledSync` |
| Production data | Firebase console → Firestore (see [firestore-collections.md](firestore-collections.md)) |
| Run the background worker on demand | `POST /api/cron-sync` (streams a log) |
| Frontend debug logs | `logDebug(...)` calls throughout `public/app.js` (and the in-app logs panel) |

## Deploy notes

- `npm run deploy:hosting` — frontend. Because `api` is `pinTag: true` in
  `firebase.json`, this **also re-deploys the `api` function**.
- `npm run deploy:functions` — backend only.
- `npm run deploy` — everything.
- There are no tests or linters. `node --check public/app.js` is a cheap syntax
  sanity check before deploying frontend changes.
