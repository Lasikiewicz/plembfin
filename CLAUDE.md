# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Local development with emulators (auth, firestore, functions, hosting, pubsub, storage)
npm run emulators

# Deploy everything
npm run deploy

# Deploy only hosting (frontend)
npm run deploy:hosting

# Deploy only functions (backend)
npm run deploy:functions
```

There are no tests or linters configured in this project.

The emulators run at: hosting `localhost:5000`, functions `localhost:5001`, firestore `localhost:8180`, auth `localhost:9099`, storage `localhost:9199`, emulator UI `localhost:4000`.

Local admin login (emulator only): username `admin`, password `admin`.

## Architecture

### Two-layer system

**Frontend** (`public/`) — a plain ES module SPA with no build step. Served by Firebase Hosting. All logic is in `public/app.js` (~7000 lines), with thin helpers in `public/modules/` (auth, logs, settings, timeline). There is no framework, no bundler, no TypeScript. CSS is in `public/styles.css`.

**Backend** (`functions/`) — a single Firebase Cloud Function (`api`) that handles all API routes via a manual `dispatch()` router in `functions/src/index.js`. A second function (`scheduledSync`) runs every minute via Cloud Scheduler. Both export from `functions/src/index.js`.

### Request flow

All `/api/*` requests are rewritten by Firebase Hosting to the `api` Cloud Function (europe-west2). The `dispatch()` function strips the `/api/` prefix and routes to handler functions like `handleWebhook`, `handleHistory`, `handleMovies`, etc. Auth is verified on every request via Firebase Auth ID tokens (`functions/src/utils/auth.js`). CORS is handled by the Firebase Functions `cors: true` option.

### Data flow: webhook → sync

When a play event arrives at `/api/webhook`:
1. `normalizeWebhook()` parses Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom JSON payloads into a unified `media` object
2. The `phase` field drives branching: `active` → upsert active session; `ended` → sync resume progress; `unplayed` → delete + propagate unwatched; default → insert watch record + propagate watched
3. `syncMediaPlaystate()` (in `syncOrchestrator.js`) propagates the event to the other two platforms, with loop detection via `loopStore` to prevent echo loops
4. Results are written back to Firestore as `sync_dispatch_telemetry` on the watch record

### Scheduled sync (`scheduledSync` / `/api/cron-sync`)

Runs every minute. Queries recent watch history and live tracking cache, checks if active sessions have crossed the "watched" threshold, and propagates any outstanding sync jobs. Force sync (`/api/force-sync`) runs the same logic on demand and stores progress in `runtimeState` for polling.

### Poster pipeline

Posters go through a two-tier system:
1. **Frontend** (`posterMarkup` / `hydratePosterFallbacks` in `app.js`): renders a `poster-fallback` span if no URL is known, then calls `/api/poster?id=<firestoreDocId>` to resolve it. The TMDB prefetch observer (`observeExplorerTmdbPrefetch`) short-circuits this for explorer cards — it calls `/api/tmdb-details` and directly updates the DOM/cache when it gets a `poster_path` back.
2. **Backend** (`/api/poster`): tries poster candidates in order — stored URL, configured server URL (Plex/Emby/Jellyfin), TMDB fallback — then downloads and caches the winner in Firebase Storage. The cache key is `mediaKey` (canonical title + type + IDs).

**Important**: `isCachedStorageImageUrl()` in `app.js` only returns `true` for `firebasestorage.googleapis.com` URLs. TMDB `image.tmdb.org` URLs are **not** treated as cached and will be stored as `""` by `rememberPosterLookup`. The `posterLookupCache` in-memory map bypasses this for TMDB URLs fetched via the prefetch observer (set directly, not via `rememberPosterLookup`).

### Firestore collections

- `watchHistory` — canonical watch records (one doc per unique watched item)
- `playstateCache` — per-item watched/unwatched state for sync targets
- `playbackProgress` — resume position records
- `activeSessions` — currently-playing sessions from webhook `active` events
- `liveTrackingCache` — richer live session data used by scheduled sync
- `syncHistory` — log of all sync dispatch results
- `runtimeState` (single doc) — last cron time, force sync state/log, now-playing refresh signal
- `mediaConfig` (single doc) — Plex/Emby/Jellyfin connection settings
- `tmdbMetadataCache` — TMDB details cached for 7 days, keyed by `${mediaType}_${tmdbId}`
- `tmdbPersonCache` — TMDB person details, keyed by `person_${personId}`
- `posterCache` — downloaded poster URLs keyed by `mediaKey`

### Frontend state and routing

`app.js` uses a single `state` object (no framework). Navigation is SPA-style via `navigateTo(url)` / `handleRouting()` / `history.pushState`. Routes: `/` → dashboard, `/movie/:id` → movie detail, `/tvshow/:key` → show detail, `/person/:id` → cast member modal, `/help/:topic` → help page.

Auth is managed by `onFirebaseAuthChange()` (`modules/auth.js`). The auth panel starts hidden; it only becomes visible after Firebase confirms no user is signed in. The app shell is shown on successful auth.

The explorer (movies/TV shows grid) uses IntersectionObserver with a 1200px rootMargin to pre-fetch the next page well before the user reaches the bottom. Page size is 240 items. A second IntersectionObserver (`observeExplorerTmdbPrefetch`) pre-fetches TMDB details for visible cards.

### Environment variables (functions)

Set in `functions/.env`:
- `ADMIN_EMAILS` — comma-separated Firebase Auth emails allowed to use the dashboard
- `ADMIN_UIDS` — optional comma-separated Firebase Auth UIDs
- `FUNCTIONS_REGION` — defaults to `europe-west2`
