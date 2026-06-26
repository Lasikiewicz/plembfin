# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Guidelines

> These rules are absolute constraints. Adhere to them strictly under all circumstances.

- **No Git Pushes** — Never execute `git push` or push commits to any remote repository unless the user explicitly instructs you to push in their request.
- **No Deployments** — Never deploy the application or run deployment commands unless explicitly instructed by the user.
- **No Unsolicited Actions** — Do only exactly what the user asks. Do not perform unsolicited refactorings, add extra features, or modify files outside the direct scope of the request.
- **No Tests or Browser Actions** — Never run test commands (e.g., `npm test`, `pytest`) or open web browsers/browser tools unless the user has explicitly requested it.

## "Push to git" command

When the user says **"Push to git"** (exactly), run this full pre-push workflow before committing:

### 1 — Review all pending changes
```bash
git diff --stat HEAD
```
Read the list of changed files to understand what was touched in this session.

### 2 — Sync docs and README
For every changed file, check whether the corresponding doc **and** the relevant section of `README.md` need updating:

| Changed area | Doc to check | README section to check |
| --- | --- | --- |
| Webhook auth / `parsers.js` / `auth.js` | `docs/webhooks.md` | ⚡ Webhook Setup |
| Scheduler / `scheduled.js` / `cron-sync` | `docs/scheduled-sync.md` | 🛠️ Architecture |
| Now-playing / `live_tracking_cache` | `docs/now-playing.md` | — |
| `schema.sql` / new SQLite tables | `docs/sqlite-schema.md` | ⚙️ Configuration Reference |
| Auth / sessions / cookies | `docs/architecture.md` | 🔧 Full Setup Guide |
| New feature or setting | `docs/architecture.md` | 🌟 Key Features / 🔧 Full Setup Guide |
| New env variable | `docs/architecture.md` | ⚙️ Configuration Reference |
| Any server-side breaking change | `docs/troubleshooting.md` | relevant setup section |
| Overall architecture change | `docs/README.md` | 🛠️ Architecture |
| Docker / deployment change | `docs/README.md` | 🚀 Getting Started |
| Backup destinations / backup UI | — | 💾 Backup & Restore System |
| Key Features list in README | — | 🌟 Key Features |
| Push-to-git / agent workflow change | `CLAUDE.md` | 🧑‍💻 Development Workflow |

**Important**: Always read the actual README sections that correspond to changed areas — do not assume they are already up to date. README prose can become stale even when docs/ files are current.

Update any doc **and** the matching README section that is out of date before proceeding.

### 3 — Sync in-app help
For every changed feature or setting, check the relevant frontend module in `public/modules/` or `public/app.js`:
- **`HELP_TOPICS`** array — update or add topic bodies if flows changed
- **`renderSettingsInlineHelp()`** — check that the inline help content in each settings panel still matches the current behaviour
- **`webhookWarning()` / `plexWebhookSetup()` / `embyWebhookSetup()` / `jellyfinWebhookSetup()`** — update if webhook setup steps changed (live in `modules/help-content.js` after refactor)
- **`cronSyncGuide()`** — update if scheduler endpoint or behaviour changed
- **`adminTokenGuide()`** — update if auth flow changed

### 4 — Write the commit message
Use this format — the first line becomes the changelog `message`; bullet-point body lines are parsed into `details` by `scripts/update-changelog.js`:

```
<type>: <concise one-line summary of the session>

- Key change 1 (user-visible description, no code jargon)
- Key change 2
- Key change 3
...
```

Types: `feat` (new feature), `fix` (bug fix), `security` (security change), `chore` (maintenance), `docs` (docs only).

Keep bullet points to the 3–8 most significant user-visible changes. Skip internal refactors that don't affect behaviour.

### 5 — Stage and commit
Stage all modified files **except** `data/`, `node_modules/`, and any secrets. Commit using the message written in step 4.

### 6 — Push
```bash
git push origin main
```
CI will then auto-bump the patch version, add a `changelog.json` entry, and build/push the Docker image.

## Commands

```bash
# Install dependencies (native modules better-sqlite3 + sharp install via prebuilt binaries)
npm install

# Run the app locally (serves UI + API + scheduler on http://localhost:5055)
npm start

# Run with auto-reload during development
npm run dev

# Build & run as a container
docker compose up --build
```

There are no tests or linters configured in this project.

The app listens on `PORT` (default `5055`). Default admin login on a fresh install is
`admin` / `admin` — override with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment
variables. On first boot the server writes `data/config.json` with the admin credentials,
a generated API key, and a session secret.

## Frontend Module Discipline

> These rules prevent `app.js` from growing back into a monolith.

### File size limits
- **`public/app.js`** — orchestrator only. Must stay under **3,000 lines**. If it approaches this limit, extract the next logical group into a module.
- **`public/modules/*.js`** — individual modules. Soft limit **1,000 lines**; hard limit **1,500 lines**. If a module exceeds 1,000 lines, split it before adding more to it.

### Where new code goes
When adding frontend code, place it in the most specific existing module that owns that feature area:

| Feature area | Module |
| --- | --- |
| Formatting, string escaping, date helpers | `modules/utils.js` |
| Poster URLs, image caching, `posterMarkup` | `modules/images.js` |
| Static help/guide HTML | `modules/help-content.js` |
| Sync status, sync history, now-playing polling | `modules/sync.js` |
| Dashboard rendering | `modules/dashboard.js` |
| Stats rendering | `modules/stats.js` |
| Explorer grid, history page, search page | `modules/explorer.js` |
| TV/movie detail modals, person profiles, edit dialogs | `modules/media-detail.js` |
| Backup, import, cache, appearance, maintenance tools | `modules/tools.js` |
| Auth, session, tokens | `modules/auth.js` |
| Debug/diagnostic logs | `modules/logs.js` |
| Connection config payloads | `modules/settings.js` |
| Live session fetching/normalisation | `modules/timeline.js` |
| Shared `state` and `elements` objects | `modules/state.js` |
| App startup, routing, event wiring, `bindElements` | `app.js` |

### Creating a new module
If a new feature area doesn't fit any existing module and would exceed 150 lines:
1. Create `public/modules/<feature>.js` using named ES module exports
2. Add `<link rel="modulepreload" href="/modules/<feature>.js" />` to `index.html`
3. Import it in `app.js` (or the owning module)
4. Update this table above

### Dependency rules
- Modules may import from `state.js`, `utils.js`, `images.js`, `auth.js`, `logs.js`, `settings.js`
- `sync.js` may be imported by `dashboard.js` and `media-detail.js` — not the reverse
- No module may import from `app.js`
- Avoid circular dependencies — if you need A→B and B→A, the shared logic belongs in a third module

## Architecture

This is a **self-hosted, single-process app** in the style of Sonarr/Radarr/Jellyseerr.
One long-running Node process serves the web UI, the `/api/*` surface, and an in-process
per-minute scheduler. All state lives in a local **SQLite** database and a local **media
folder** under `data/`.

### Process layout

**Entrypoint** (`server/server.js`) — an Express app that:
- static-serves `public/` (the SPA) and `data/media` (cached artwork at `/media/...`)
- mounts the API router at `/api/*` (raw body captured so webhook/JSON handlers parse it themselves)
- runs `setInterval(runScheduledTick, 60000)` for the per-minute scheduler
- falls back to `index.html` for client-side routes

**API** (`server/src/index.js`) — a manual `dispatch()` router that strips the `/api/`
prefix and routes to `handleWebhook`, `handleHistory`, `handleMovies`, etc. `dispatch` is
imported and mounted by `server.js`.

**Frontend** (`public/`) — a plain ES module SPA with no build step. `app.js` is the orchestrator (routing, startup, event wiring); feature logic lives in `public/modules/` (`state.js`, `utils.js`, `images.js`, `auth.js`, `logs.js`, `settings.js`, `timeline.js`, `help-content.js`, `sync.js`, `dashboard.js`, `stats.js`, `explorer.js`, `tools.js`). No framework, bundler, or TypeScript.

### Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` (WAL mode) and applies `schema.sql` on boot. The
repo modules (`firestoreRepo.js`, `configStore.js`, `posterCache.js`, `activeSessions.js`,
`loopStore.js`, `tmdbGateway.js`) use prepared SQL statements.

Derived caches use **in-process memoization** keyed by an in-memory `dataVersion` integer
(`getDataVersion()` / `bumpDataVersion()` in `db.js`). `invalidateHistoryDerivedCaches()`
just bumps the version; the in-memory `historyCache`/`movieCache`/`showCache`/`statsCache`
reload on the next read.

### Auth (`server/src/utils/auth.js` + `server/src/appConfig.js`)

Local username/password login. `appConfig.js` resolves credentials from env or
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

### SQLite tables

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

### Frontend state and routing

`app.js` uses a single `state` object (no framework). Navigation is SPA-style via
`navigateTo(url)` / `handleRouting()` / `history.pushState`. Routes: `/` → dashboard,
`/movie/:id`, `/tvshow/:key`, `/person/:id`, `/help/:topic`.

Auth is managed by `onAuthChange()` (`modules/auth.js`) — which checks `/api/auth/status`.
The auth panel becomes visible when no session is active; the app shell shows on successful login.

The explorer grid uses IntersectionObserver (1200px rootMargin) to pre-fetch the next page;
page size 240. A second observer (`observeExplorerTmdbPrefetch`) pre-fetches TMDB details.

### Environment variables

- `PORT` — HTTP port (default `5055`)
- `DATA_DIR` — data directory (default `<repo>/data`; Docker sets `/data`)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin login (default `admin` / `admin`)
- `API_KEY` — pin the webhook/integration key (otherwise generated into `data/config.json`)
- `SESSION_SECRET` — pin the session signing secret (otherwise generated)

