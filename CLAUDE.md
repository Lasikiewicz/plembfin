# CLAUDE.md

Agent instructions for working with this codebase.

> **Before changing anything, read [`docs/architecture.md`](docs/architecture.md).**
> It is the master guide: the big picture, a complete map of every file in the repo,
> and a task router that points to the feature doc covering the area you are touching.

## Agent Guidelines

- **No Git Pushes** — Never execute `git push` or push commits to any remote repository unless the user explicitly instructs you to push in their request.
- **No Deployments** — Never deploy the application or run deployment commands unless explicitly instructed by the user.
- **No Unsolicited Actions** — Do only exactly what the user asks. Do not perform unsolicited refactorings, add extra features, or modify files outside the direct scope of the request.
- **No Browser Actions Unless Asked** — Never open web browsers/browser tools unless the user has explicitly requested it. Test commands are part of the normal project checks: run `npm test` or `npm run build` when a change touches code covered by those checks or when the user asks for verification.
- **Act immediately on simple requests** — If the user describes a clear, specific change, make it directly without preamble, planning steps, or explanation. Save analysis for genuinely complex or ambiguous tasks.

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
| Webhook auth / `parsers.js` / webhook flow | `docs/webhooks.md` | ⚡ Webhook Setup |
| Scheduler / `scheduled.js` / `cron-sync` | `docs/scheduled-sync.md` | 🛠️ Architecture |
| Now-playing / `live_tracking_cache` | `docs/now-playing.md` | — |
| `schema.sql` / new SQLite tables | `docs/sqlite-schema.md` | ⚙️ Configuration Reference |
| Plex client / notification listener | `docs/plex.md` | ⚡ Webhook Setup |
| Emby client | `docs/emby.md` | ⚡ Webhook Setup |
| Jellyfin client | `docs/jellyfin.md` | ⚡ Webhook Setup |
| TMDB / TVDB / Fanart / OMDb gateways or caches | `docs/metadata.md` | ⚙️ Configuration Reference |
| Poster pipeline (`posterCache.js` / `images.js`) | `docs/posters-artwork.md` | — |
| Dashboard (`dashboard.js`) | `docs/dashboard.md` | 🌟 Key Features |
| Movies page | `docs/movies.md` | 🌟 Key Features |
| TV Shows page / show progress / next-airing | `docs/tv-shows.md` | 🌟 Key Features |
| Media detail / person pages / edit dialogs / watch actions | `docs/media-detail.md` | 🌟 Key Features |
| History page / search | `docs/history-search.md` | 🌟 Key Features |
| Stats page | `docs/stats.md` | 🌟 Key Features |
| Settings tabs / config store / maintenance tools | `docs/settings.md` | 🔧 Full Setup Guide |
| Auth / sessions / cookies / secrets | `docs/auth.md` + `docs/architecture.md` | 🔧 Full Setup Guide |
| Backups / destinations / backup UI | `docs/backups.md` | 💾 Backup & Restore System |
| SPA routing / state / module layout | `docs/frontend.md` | — |
| Scripts / CI workflows / Docker / release pipeline | `docs/development.md` | 🚀 Getting Started |
| New feature or setting | `docs/architecture.md` + the matching feature doc | 🌟 Key Features / 🔧 Full Setup Guide |
| New env variable | `docs/architecture.md` | ⚙️ Configuration Reference |
| New file, or a file moved/renamed | file map in `docs/architecture.md` | — |
| Any server-side breaking change | `docs/troubleshooting.md` | relevant setup section |
| Overall architecture change | `docs/architecture.md` + `docs/README.md` | 🛠️ Architecture |
| Docker / deployment change | `docs/development.md` | 🚀 Getting Started |
| Key Features list in README | — | 🌟 Key Features |
| Push-to-git / agent workflow change | `CLAUDE.md` | 🧑‍💻 Development Workflow |

**Important**: Always read the actual README sections that correspond to changed areas — do not assume they are already up to date. README prose can become stale even when docs/ files are current.

Update any doc **and** the matching README section that is out of date before proceeding.

Documentation and README copy must stand on its own for a first-time reader. State the current behavior as a fact; avoid historical or relative wording such as "still", "previously", "formerly", "same as before", "no longer", or "new" unless the sentence is explicitly about an upgrade, migration, or changelog entry. For metadata source descriptions, say which source provides which data instead of referencing what another source used to provide.

### Backlog and documentation sync

When implementing or finishing work described in `TODO.md`, remove the completed
item from the TODO file in the same change. If the completed work changes user-visible
behavior, also update the relevant `docs/` page and README section. Before removing
an item, verify that the code and documentation both describe the current behavior.

### 3 — Sync in-app help
For every changed feature or setting, check the relevant frontend module in `public/modules/` or `public/app.js`:
- **Feature-owned help renderers and modal `helpHtml`** — update any setup copy if flows changed
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

Do not create single-line commits for user-visible changes. If the change affects behavior, UI, docs, setup, data sources, sync, caching, or settings, the commit body must include bullet-point details. The changelog generator only reads body lines that start with `- ` or `* `; without them, the Settings → Changelog entry will be sparse. If you are about to commit without bullet details, stop and rewrite the commit message before committing.

This is an enforced release requirement, not optional guidance. Before committing, compare the staged diff with the bullet list and make sure every significant user-visible outcome is represented. A bullet that merely repeats the subject is not a detail. Use separate `-m` arguments (or a commit-message file) so the body is actually recorded:

```bash
git commit -m "fix: concise summary" \
  -m "- First concrete user-visible outcome
- Second concrete user-visible outcome"
```

The `.githooks/commit-msg` hook rejects `feat`, `fix`, `security`, `enhance`, and `docs` commits that have no meaningful bullet. `scripts/update-changelog.js` applies the same validation in CI, so bypassing local hooks cannot publish a title-only changelog entry. After committing, verify the recorded message with `git log -1 --format=full` before pushing.

### 5 — Stage and commit
Stage all modified files **except** `data/`, `node_modules/`, and any secrets. Commit using the message written in step 4.

### 6 — Push
```bash
git push origin main
```
CI will then auto-bump the patch version, add a `changelog.json` entry, and build/push the Docker image.

The generated entry's headline and version always come from the last commit in the push, while the `details` list is backfilled from bullet points in *every* commit included in that push. Maintenance commits may fall back to their subject; user-visible release commits must pass the meaningful-bullet validation above. Nothing gets silently dropped even if the final commit's message doesn't summarize the whole push. Still, write the last commit's message as a proper user-facing summary of the session's work — features and fixes, no internal implementation details (file names, CSS properties, line counts) — since it becomes the entry's headline.

#### Expect `main` to be ahead — this is normal, not a conflict to escalate

The GitHub Actions workflow above commits its version bump **directly back to `main`** within seconds of every push, and a local pre-push hook also fetches/rebases against the remote before pushing. Together these mean `origin/main` will very often show 1 (sometimes more) commits that your local branch doesn't have yet — usually just `chore: update changelog for <sha>` bump commits that only ever touch `changelog.json`, `package.json`, and `package-lock.json`.

When `git status` or a failed push reports `main` and `origin/main` have diverged, treat it as the expected steady-state, not a real conflict, and reconcile automatically as part of the same "Push to git" run:
```bash
git fetch origin
git merge origin/main --no-edit   # or: git merge --ff-only origin/main if it's a straight fast-forward
git push origin main
```
This is safe to do without stopping to ask, because the only files those CI commits ever touch (`changelog.json`, `package.json`, `package-lock.json`) don't overlap with feature work in `public/` or `server/`, so the merge is conflict-free by construction. Only pause and ask the user if the merge actually produces a conflict (e.g. someone hand-edited `changelog.json`), or if `origin/main` contains commits that touch source files you don't recognize — that would mean unrelated work landed on `main` and needs a real decision, not an automatic merge.

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

`npm test` runs the focused `node:test` suite under `test/`. `npm run build` runs the
syntax check, the same `node:test` suite, JSON validation, the server-side outbound-fetch guard, and a
one-shot server boot against a temp `DATA_DIR`. There is no separate linter configured.

The app listens on `PORT` (default `5055`). On a fresh install the admin username defaults
to `admin`; if `ADMIN_PASSWORD` isn't set, a random password is generated and printed once
to the server console/logs. Override with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment
variables. On first boot the server writes `data/config.json` with the admin credentials,
a generated API key, and a session secret.

## Frontend Module Discipline

> These rules prevent `app.js` from growing back into a monolith.

### File size limits
- **`public/app.js`** — orchestrator only. Must stay under **3,000 lines**. If it approaches this limit, extract the next logical group into a module.
- **`public/modules/*.js`** — individual modules. Soft limit **1,200 lines**; hard limit **1,500 lines**. If a module exceeds 1,200 lines, split it before adding more to it.

### Where new code goes
When adding frontend code, place it in the most specific existing module that owns that feature area:

| Feature area | Module |
| --- | --- |
| Formatting, string escaping, date helpers | `modules/utils.js` |
| Poster URLs, image caching, `posterMarkup` | `modules/images.js` |
| Static help/guide HTML | `modules/help-content.js` |
| Sync status, sync history, now-playing polling | `modules/sync.js`, `modules/sync-preview.js` |
| Dashboard rendering | `modules/dashboard.js` |
| Stats rendering | `modules/stats.js` |
| Explorer grid, history page, search page | `modules/explorer.js` |
| Upcoming page (month calendar of upcoming episode air dates) | `modules/upcoming.js` |
| TV/movie detail entry points, lookups, modal-close routing | `modules/media-detail.js` |
| Detail-modal shell/context: callbacks, `authHeaders`, modal DOM root, render-token, debug modal | `modules/media-detail-context.js` |
| Shared TMDB/Seerr rendering fragments (cast, trailers, images, ratings, recommendations) | `modules/media-detail-shared.js` |
| TV show detail rendering (seasons, episodes, show modal) | `modules/media-detail-show.js` |
| Movie detail rendering | `modules/media-detail-movie.js` |
| Person profiles and filmography | `modules/media-person.js` |
| Edit dialogs and watched-date/image/match tools | `modules/edit-dialogs.js` |
| Manual watched/unwatched actions | `modules/watch-action.js` |
| Shared calendar/time picker (used by edit dialogs and mark-watched prompts) | `modules/calendar-picker.js` |
| TMDB detail/season/person enrichment helpers | `modules/tmdb.js` |
| Trailer playback and photo lightbox | `modules/media-lightbox.js` |
| Trakt/CSV import and settings tools bridge | `modules/tools.js` |
| Backup and appearance tools | `modules/tools-backups.js` |
| Maintenance diagnostics, cache tools, sync repair tools, and sync health | `modules/tools-maintenance.js`, `modules/tools-health.js` |
| Auth, session, tokens | `modules/auth.js` |
| Debug/diagnostic logs & telemetry export | `modules/logs.js` (categorization, local time formatting, export) |
| Connection label formatting | `modules/settings.js` |
| Shared settings modal, picker, and card-grid primitives | `modules/settings-ui.js` |
| Media-server and metadata-provider settings cards/modals | `modules/settings-services.js` |
| Flat settings routes, landing list, sidebar, help panels, and clean path routing (`/settings/media-servers`, `/settings/sync`, etc.) | `modules/settings-shell.js` |
| Shared `state` and `elements` objects | `modules/state.js` |
| App event wiring | `modules/app-events.js` |
| Media-detail modal click delegation (cast/trailers/poster edit/watch actions/card navigation) | `modules/media-detail-events.js` |
| App startup, routing, `bindElements` | `app.js` |

### Creating a new module
If a new feature area doesn't fit any existing module and would exceed 150 lines:
1. Create `public/modules/<feature>.js` using named ES module exports
2. Add `<link rel="modulepreload" href="/modules/<feature>.js" />` to `index.html`
3. Import it in `app.js` (or the owning module)
4. Update this table above

### Dependency rules
- Modules may import from `state.js`, `utils.js`, `images.js`, `auth.js`, `logs.js`, `settings.js`, `settings-ui.js`
- `sync.js` may be imported by `dashboard.js` and `media-detail.js` — not the reverse
- No module may import from `app.js`
- Avoid circular dependencies — if you need A→B and B→A, the shared logic belongs in a third module

## Backend Module Discipline

> These rules prevent `server/src/index.js` from growing back into a monolith.

### File size limits
- **`server/src/index.js`** - route table only. Keep it under **500 lines**.
- **`server/src/routes/*.js`** - owning route modules. Soft limit **1,200 lines**; hard limit **1,500 lines**. Split by feature area before crossing the hard limit.

### Where new route code goes
- Add the route entry in `dispatch()` inside `server/src/index.js`.
- Put the handler in the owning `server/src/routes/*.js` module.
- Keep shared helpers in `server/src/utils/` only when more than one route module needs them.
- Avoid circular imports back into `server/src/index.js`; route modules may import utilities and data-layer modules directly.

| API area | Module |
| --- | --- |
| Config, appearance, Seerr/app links, connection tests | `server/src/routes/admin.js` |
| Portable, watch-history, and encrypted backup APIs | `server/src/routes/backups.js` |
| History, library, and watch-record edits | `server/src/routes/media.js` |
| TMDB/TVDB/Fanart/OMDb/YouTube metadata and image APIs | `server/src/routes/metadata.js` |
| Webhooks, manual watch/unwatch, playback progress, sync job/history listing, cron/force sync, preview plans, now playing | `server/src/routes/sync.js` |
| Backfill, repair, dedup, rematch, cache, logs, changelog, ping | `server/src/routes/maintenance.js` |
| Scheduler tick and Plex notification listener lifecycle | `server/src/scheduler.js` |

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

**Frontend** (`public/`) — a plain ES module SPA with no build step. `app.js` is the orchestrator (routing, startup, event wiring); feature logic lives in `public/modules/` (`state.js`, `utils.js`, `images.js`, `auth.js`, `logs.js`, `settings.js`, `settings-ui.js`, `settings-services.js`, `settings-shell.js`, `help-content.js`, `sync.js`, `dashboard.js`, `stats.js`, `explorer.js`, `tools.js`, `tools-backups.js`, `tools-maintenance.js`, `media-detail.js`, `media-person.js`, `media-lightbox.js`, `edit-dialogs.js`, `watch-action.js`, `tmdb.js`, `app-events.js`). No framework, bundler, or TypeScript.

### Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` (WAL mode) and applies `schema.sql` on boot. The
repo modules (`dataRepo.js`, `configStore.js`, `posterCache.js`, `activeSessions.js`,
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

`server.js` invokes `runScheduledTick()` (in `scheduler.js`, wrapping `runScheduledSync` in
`scheduled.js`) once per minute, guarded against overlap. It queries recent watch history and
the live tracking cache, checks whether active sessions crossed the "watched" threshold, and
propagates outstanding sync jobs. Force sync (`/api/force-sync`) runs the same logic on demand
and stores progress in `runtime_state` for polling.

### Poster pipeline

1. **Frontend** (`posterMarkup` / `hydratePosterFallbacks` in `modules/images.js`): renders a `poster-fallback` span if no URL is known, then calls `/api/poster?id=<watchRecordId>`. The TMDB prefetch observer (`observeExplorerTmdbPrefetch`) short-circuits this for explorer cards.
2. **Backend** (`/api/poster`, `posterCache.js`): tries candidates in order — stored URL, configured server URL (Plex/Emby/Jellyfin), TMDB fallback — resizes with `sharp`, writes the winner to `data/media/posters` (or `backdrops`), and serves it at `/media/...`. The cache key is `mediaKey` (canonical title + type + IDs); metadata lives in the `poster_cache` table.

**Important**: `isCachedStorageImageUrl()` in `modules/images.js` returns `true` only for `/media/posters/` and `/media/backdrops/` URLs. TMDB `image.tmdb.org` URLs are **not** treated as cached.

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
- `ADMIN_USERNAME` (default `admin`) / `ADMIN_PASSWORD` — admin login. If `ADMIN_PASSWORD` is unset on a brand-new install, a random password is generated and printed once to the server console.
- `API_KEY` — pin the webhook/integration key (otherwise generated into `data/config.json`)
- `SESSION_SECRET` — pin the session signing secret (otherwise generated)
