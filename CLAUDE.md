# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Guidelines

> These rules are absolute constraints. Adhere to them strictly under all circumstances.

- **No Git Pushes** — Never execute `git push` or push commits to any remote repository unless the user explicitly instructs you to push in their request.
- **No Deployments** — Never deploy the application or run deployment commands (e.g., `firebase deploy`) unless explicitly instructed by the user. Exception: if the user simply says `Deploy`, treat that as explicit instruction to deploy the entire site to Firebase and push the current Git branch to its remote.
- **No Unsolicited Actions** — Do only exactly what the user asks. Do not perform unsolicited refactorings, add extra features, or modify files outside the direct scope of the request.
- **No Tests or Browser Actions** — Never run test commands (e.g., `npm test`, `pytest`) or open web browsers/browser tools unless the user has explicitly requested it.

## Commands

```bash
# Install dependencies (native modules better-sqlite3 + sharp install via prebuilt binaries)
npm install

# Run the app locally (serves UI + API + scheduler on http://localhost:5055)
npm start

# Run with auto-reload during development
npm run dev

# One-time import of data from the old Firebase project into local SQLite
npm run migrate

# Build & run as a container
docker compose up --build
```

There are no tests or linters configured in this project.

The app listens on `PORT` (default `5055`). Default admin login on a fresh install is
`admin` / `admin` — override with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment
variables. On first boot the server writes `data/config.json` with the admin credentials,
a generated API key, and a session secret.

## Architecture

This is a **self-hosted, single-process app** in the style of Sonarr/Radarr/Jellyseerr.
One long-running Node process serves the web UI, the `/api/*` surface, and an in-process
per-minute scheduler. All state lives in a local **SQLite** database and a local **media
folder** under `data/`. (It was previously a Firebase app — Hosting + Cloud Functions +
Firestore + Storage + Auth — which was fully migrated to local infrastructure.)

### Process layout

**Entrypoint** (`server/server.js`) — an Express app that:
- static-serves `public/` (the SPA) and `data/media` (cached artwork at `/media/...`)
- mounts the API router at `/api/*` (raw body captured so webhook/JSON handlers parse it themselves)
- runs `setInterval(runScheduledTick, 60000)` in place of the old `scheduledSync` Cloud Function
- falls back to `index.html` for client-side routes

**API** (`server/src/index.js`) — a manual `dispatch()` router that strips the `/api/`
prefix and routes to `handleWebhook`, `handleHistory`, `handleMovies`, etc. `dispatch` is
imported and mounted by `server.js`.

**Frontend** (`public/`) — a plain ES module SPA with no build step (`app.js` ~9000 lines
plus `public/modules/`). No framework, bundler, or TypeScript.

### Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` (WAL mode) and applies `schema.sql` on boot. The
repo modules (`firestoreRepo.js`, `configStore.js`, `posterCache.js`, `activeSessions.js`,
`loopStore.js`, `tmdbGateway.js`) use prepared SQL statements. Firestore document semantics
were translated as: `.doc(id).set(x,{merge})` → `INSERT ... ON CONFLICT DO UPDATE`,
`.batch()` → `db.transaction()`, `serverTimestamp()` → `Date.now()`, `.count()` →
`SELECT COUNT(*)`.

Because the process is long-lived, the old Firestore-backed derived caches were replaced by
**in-process memoization** keyed by an in-memory `dataVersion` integer (`getDataVersion()` /
`bumpDataVersion()` in `db.js`). `invalidateHistoryDerivedCaches()` just bumps the version;
the in-memory `historyCache`/`movieCache`/`showCache`/`statsCache` reload on the next read.

### Auth (`server/src/utils/auth.js` + `server/src/appConfig.js`)

Local username/password login (no Firebase). `appConfig.js` resolves credentials from env or
`data/config.json` (hashing the password with scrypt) and generates an API key + session
secret on first run. `requireAdmin(req,res)` accepts either a signed HttpOnly session cookie
(`plembfin_session`, HMAC over the session secret) **or** the API key (via `X-Api-Key`,
`Authorization: Bearer`, or `?api_key=`). Routes: `POST /api/login`, `POST /api/logout`,
`GET /api/auth/status`. The webhook + now-playing EventSource use the API key.

### Data flow: webhook → sync

When a play event arrives at `/api/webhook`:
1. `normalizeWebhook()` parses Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom JSON into a unified `media` object
2. The `phase` field drives branching: `active` → upsert active session; `ended` → sync resume progress; `unplayed` → delete + propagate unwatched; default → insert watch record + propagate watched
3. `syncMediaPlaystate()` (in `syncOrchestrator.js`) propagates to the other two platforms, with loop detection via `loopStore`
4. Results are written back as `sync_dispatch_telemetry` on the watch record

### Scheduled sync (`runScheduledTick` / `/api/cron-sync`)

`server.js` invokes `runScheduledTick()` (in `index.js`, wrapping `runScheduledSync` in
`scheduled.js`) once per minute, guarded against overlap. It queries recent watch history and
the live tracking cache, checks whether active sessions crossed the "watched" threshold, and
propagates outstanding sync jobs. Force sync (`/api/force-sync`) runs the same logic on demand
and stores progress in `runtime_state` for polling.

### Poster pipeline

1. **Frontend** (`posterMarkup` / `hydratePosterFallbacks` in `app.js`): renders a `poster-fallback` span if no URL is known, then calls `/api/poster?id=<watchRecordId>`. The TMDB prefetch observer (`observeExplorerTmdbPrefetch`) short-circuits this for explorer cards.
2. **Backend** (`/api/poster`, `posterCache.js`): tries candidates in order — stored URL, configured server URL (Plex/Emby/Jellyfin), TMDB fallback — resizes with `sharp`, writes the winner to `data/media/posters` (or `backdrops`), and serves it at `/media/...`. The cache key is `mediaKey` (canonical title + type + IDs); metadata lives in the `poster_cache` table.

**Important**: `isCachedStorageImageUrl()` in `app.js` returns `true` only for `/media/posters/` and `/media/backdrops/` URLs. TMDB `image.tmdb.org` URLs are **not** treated as cached.

### SQLite tables (one per former Firestore collection)

- `watch_history` — canonical watch records
- `playstate` — per-item watched/unwatched state for sync targets
- `playback_progress` — resume position records
- `active_sessions` — currently-playing sessions from webhook `active` events
- `live_tracking_cache` — richer live session data used by scheduled sync
- `sync_history` — log of all sync dispatch results
- `runtime_state` (single row, JSON blob) — last cron time, force sync state/log, now-playing refresh signal
- `settings` (single row, JSON blob) — Plex/Emby/Jellyfin/TMDB connection settings
- `loop_keys` — loop-detection KV with TTL
- `poster_cache` — cached artwork metadata (binaries live in `data/media`)
- `tmdb_metadata_cache` / `tmdb_search_cache` / `tmdb_season_cache` / `tmdb_person_cache` — TMDB caches

The Firestore `derivedCache` / `derivedShowSummaries` collections were dropped (now in-process memo).

### Frontend state and routing

`app.js` uses a single `state` object (no framework). Navigation is SPA-style via
`navigateTo(url)` / `handleRouting()` / `history.pushState`. Routes: `/` → dashboard,
`/movie/:id`, `/tvshow/:key`, `/person/:id`, `/help/:topic`.

Auth is managed by `onFirebaseAuthChange()` (`modules/auth.js`) — which now checks
`/api/auth/status` rather than Firebase. The auth panel becomes visible when no session is
active; the app shell shows on successful login.

The explorer grid uses IntersectionObserver (1200px rootMargin) to pre-fetch the next page;
page size 240. A second observer (`observeExplorerTmdbPrefetch`) pre-fetches TMDB details.

### Environment variables

- `PORT` — HTTP port (default `5055`)
- `DATA_DIR` — data directory (default `<repo>/data`; Docker sets `/data`)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin login (default `admin` / `admin`)
- `API_KEY` — pin the webhook/integration key (otherwise generated into `data/config.json`)
- `SESSION_SECRET` — pin the session signing secret (otherwise generated)

### Migrating from the old Firebase project

`scripts/migrate-firestore-to-sqlite.js` (run via `npm run migrate`) reads every Firestore
collection with `firebase-admin` and a service-account key, inserts into the matching SQLite
table, and downloads cached poster/backdrop binaries from Firebase Storage into `data/media`.
It is idempotent. Requires `GOOGLE_APPLICATION_CREDENTIALS` (defaults to
`./service-account-key.json`) and `FIREBASE_STORAGE_BUCKET`.
