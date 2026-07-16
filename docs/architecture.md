# Architecture — Start Here

**This is the first document to read before changing anything in this repo.** It maps
every file in the project, explains how the pieces fit together, and routes you to the
feature doc that covers the area you are touching. If you only read one doc, read this one.

## The big picture

Plembfin is a **self-hosted, single-process Node.js app** in the style of Sonarr/Radarr/
Jellyseerr. One long-running `node server/server.js` process serves:

- the **web UI** — a plain ES-module SPA in `public/` with no framework, bundler, or build step
- the **API** — every route lives under `/api/*`, dispatched by one hand-written router
- the **scheduler** — an in-process `setInterval` tick that runs sync work every minute

All state lives in a local **SQLite** database (`data/plembfin.db`, WAL mode) and a local
media folder (`data/media/`). There is no external database, no cloud functions, and no
separate production environment.

What the app does: it receives play/stop/scrobble **webhooks** from Plex, Emby, and
Jellyfin, records watch history, and **propagates watched/unwatched state and resume
progress to the other platforms** so all three stay in sync. On top of that it provides
a dashboard (Now Playing + recent history), Movies/TV Shows library browsers, a stats
page, an upcoming-episodes calendar, rich media detail pages (TMDB/TVDB metadata,
cast, trailers, artwork), Jellyseerr/Overseerr requesting, and a backup system.

## Task router — "I need to change X, where do I go?"

| Task | Files | Doc |
| --- | --- | --- |
| Add/change an API route | `server/src/index.js` (`dispatch()` route table) plus the owning `server/src/routes/*.js` module | this doc |
| Webhook parsing or phases | `server/src/utils/parsers.js`, `handleWebhook` in `server/src/routes/sync.js` | [webhooks.md](webhooks.md) |
| Watched/unwatched propagation between platforms | `server/src/utils/syncOrchestrator.js`, platform clients | [webhooks.md](webhooks.md) |
| Plex API calls, Plex WebSocket listener | `server/src/utils/plexClient.js`, `plexNotificationListener.js` | [plex.md](plex.md) |
| Emby API calls | `server/src/utils/embyClient.js` | [emby.md](emby.md) |
| Jellyfin API calls | `server/src/utils/jellyfinClient.js` | [jellyfin.md](jellyfin.md) |
| Background/scheduled sync, catch-up sync | `server/src/scheduler.js`, `server/src/scheduled.js` | [scheduled-sync.md](scheduled-sync.md) |
| Now Playing (dashboard live sessions) | `handleNowPlaying` in `server/src/routes/sync.js`, `server/src/utils/liveSessions.js`, `activeSessions.js`, `public/modules/sync.js` | [now-playing.md](now-playing.md) |
| Dashboard rendering | `public/modules/dashboard.js` | [dashboard.md](dashboard.md) |
| Movies library page | `public/modules/explorer.js`, `queryMovies` in `dataRepo.js` | [movies.md](movies.md) |
| TV Shows library page | `public/modules/explorer.js`, `queryShows`, `showProgressCache.js`, `nextAiringCache.js` | [tv-shows.md](tv-shows.md) |
| Upcoming episode calendar | `public/modules/upcoming.js`, `handleUpcoming` in `routes/metadata.js`, `nextAiringCache.js` | [upcoming.md](upcoming.md) |
| Movie/show/person detail pages | `public/modules/media-detail*.js`, `media-person.js` | [media-detail.md](media-detail.md) |
| History page, Search page | `public/modules/explorer.js`, `handleHistory` in `routes/media.js`, `handleMediaSearch` in `routes/metadata.js` | [history-search.md](history-search.md) |
| Stats page | `public/modules/stats.js`, `getWatchStats` in `dataRepo.js` | [stats.md](stats.md) |
| TMDB/TVDB/Fanart/OMDb metadata | `server/src/routes/metadata.js`, `server/src/utils/tmdbGateway.js`, `tvdbGateway.js`, `fanartGateway.js`, `omdbGateway.js` | [metadata.md](metadata.md) |
| Posters, backdrops, logos, artwork caching | `server/src/utils/posterCache.js`, `handlePoster` in `routes/metadata.js`, `public/modules/images.js` | [posters-artwork.md](posters-artwork.md) |
| Backups (all three subsystems) | `server/src/routes/backups.js`, `server/src/utils/backup.js`, `watchHistoryBackups.js`, `plembfinBackups.js`, `backupDestinations/`, `public/modules/tools-backups.js` | [backups.md](backups.md) |
| Settings pages, connection config | `server/src/routes/admin.js`, `server/src/utils/configStore.js`, `public/modules/settings-shell.js`, `public/modules/settings.js`, `public/modules/tools.js`, `public/modules/tools-backups.js` | [settings.md](settings.md) |
| Login, sessions, API key, webhook secret | `server/src/utils/auth.js`, `server/src/appConfig.js`, `public/modules/auth.js` | [auth.md](auth.md) |
| SPA routing, view switching, module layout | `public/app.js`, `public/modules/state.js`, `app-events.js` | [frontend.md](frontend.md) |
| Database tables and their meaning | `server/src/schema.sql`, `server/src/db.js` | [sqlite-schema.md](sqlite-schema.md) |
| Build check, CI, Docker, release/changelog pipeline | `scripts/`, `.github/workflows/`, `Dockerfile` | [development.md](development.md) |
| Production security posture | — | [hardening.md](hardening.md), [security-checklist.md](security-checklist.md) |
| "Something is broken, where do I look?" | — | [troubleshooting.md](troubleshooting.md) |

Frontend module placement rules (file size limits, which module owns which feature,
dependency rules) live in [`../CLAUDE.md`](../CLAUDE.md) and are mirrored in
[frontend.md](frontend.md).

## Complete file map

Every tracked file in the repository, by directory.

### Repository root

| File | What it is |
| --- | --- |
| `CLAUDE.md` | Agent instructions: guardrails, the "Push to git" workflow, frontend module discipline, and a condensed architecture summary. |
| `README.md` | User-facing GitHub readme: features, setup guide, configuration reference, screenshots. |
| `changelog.json` | Bundled release history. CI appends an entry per push and bumps the version; served verbatim at `GET /changelog.json` and consumed by the in-app changelog/update check. |
| `package.json` | Dependencies and npm scripts (`start`, `dev`, `build`, `seed:demo`, `prepare`, `changelog:update`). Version is CI-managed. |
| `package-lock.json` | Locked dependency tree. Version field is CI-managed alongside `package.json`. |
| `Dockerfile` | `node:22-slim` image: installs prod deps, copies `server/`, `public/`, `changelog.json`, creates the non-root `plembfin` user, healthcheck against `/api/ping`, entrypoint drops privileges. |
| `docker-compose.yml` | Base compose file: port 5055, `./data:/data` volume, admin env vars, `no-new-privileges`, resource limits. |
| `docker-compose.secure.yml` | Hardened overlay: read-only rootfs, tmpfs `/tmp`, required env vars (`ADMIN_PASSWORD`, `SESSION_SECRET`, `API_KEY`, `WEBHOOK_SECRET`), forces `COOKIE_SECURE=true`. |
| `.dockerignore` | Excludes `node_modules`, `data`, `docs`, `scratch`, markdown, and secrets from the Docker build context (whitelists the two scripts the image needs). |
| `.env.example` | Commented template of every supported environment variable — copy to `.env` (loaded by `server/src/env.js`). The variables are documented under [Environment variables](#environment-variables) below. |
| `.editorconfig` | Editor whitespace/indent conventions. |
| `.gitattributes` | Normalizes line endings to LF; marks image formats binary. |
| `.gitignore` | Ignores `node_modules`, `data/`, logs, local env files. |
| `.githooks/commit-msg`, `.githooks/pre-push` | Git hooks installed by `scripts/install-git-hooks.js`: release commit messages must contain meaningful changelog bullets; pushes rebase onto `origin/main` and run `npm run build`. |
| `LICENSE.md` | Project license. |
| `SECURITY.md` | Vulnerability reporting policy. |
| `CONTRIBUTING.md` | Contribution guidelines. |
| `CODE_OF_CONDUCT.md` | Community code of conduct. |

### `.github/`

| File | What it is |
| --- | --- |
| `workflows/update-changelog.yml` | The release pipeline. On every push to `main`: runs the build check, runs `scripts/update-changelog.js` to bump the patch version and append a changelog entry, commits that back to `main`, and builds/pushes the Docker image to GHCR tagged `latest` + the version. A second job re-publishes when the push itself is the changelog commit. |
| `workflows/docker-publish.yml` | Manual (`workflow_dispatch`) Docker build & push to GHCR, without touching the changelog. |
| `workflows/security.yml` | `npm audit` (high+) and CodeQL on push/PR/daily schedule. |
| `workflows/secret-scan.yml` | TruffleHog verified-secret scan on push/PR. |
| `dependabot.yml` | Automated dependency update PRs. |
| `ISSUE_TEMPLATE/bug_report.md`, `ISSUE_TEMPLATE/feature_request.md`, `ISSUE_TEMPLATE/config.yml` | GitHub issue forms. |
| `PULL_REQUEST_TEMPLATE.md` | PR description template. |

### `docs/`

See [README.md](README.md) for the full doc index with "read it when…" guidance —
including this file (`architecture.md`), the per-feature docs, and the
[watch-history-backups.md](watch-history-backups.md) design document.
`docs/screenshots/` holds the PNG screenshots embedded in the root README (`bio.png`,
`history.png`, `media.png`, `movies.png`, `now-playing.png`, `part-watched.png`,
`search.png`, `stats.png`, `tvshows.png`).

### `server/`

| File | What it is |
| --- | --- |
| `server.js` | **Process entrypoint.** Express app: access logging (rotating `data/logs/access.log`, secrets redacted), security headers + dynamic CSP, rate limiters, raw-body capture for `/api/*` → `dispatch()`, static mounts for `/media` and `public/`, `/health`, `/changelog.json`, SPA fallback, the per-minute scheduler tick, the Plex notification listener startup, and graceful shutdown. |
| `src/index.js` | **The API router.** `dispatch()` strips `/api/` and routes paths to `handleX` functions exported by `src/routes/*.js`. The full route table is the body of `dispatch()`; feature behavior belongs in the owning route module. |
| `src/db.js` | Opens `data/plembfin.db` via better-sqlite3 (WAL), applies `schema.sql`, runs column migrations, exposes `parseJson`/`toJson`/`transaction`/`writeAuditLog` and the in-process `dataVersion` counter that invalidates derived caches. |
| `src/schema.sql` | Authoritative table definitions. See [sqlite-schema.md](sqlite-schema.md). |
| `src/appConfig.js` | Resolves admin credentials + secrets from env / `data/config.json` (scrypt password hash, generated API key / webhook secret / session secret), warns about insecure config at startup, exports `AUTH`, `verifyWebhookToken`, `rotateWebhookSecret`, `updateAdminCredentials`. |
| `src/env.js` | Minimal `.env` loader (`loadLocalEnv`) — parses `<repo>/.env` without a dotenv dependency; env vars already set take precedence. |
| `src/paths.js` | Resolves `DATA_DIR` and every path under it (`MEDIA_DIR`, `POSTERS_DIR`, `BACKDROPS_DIR`, `PROFILES_DIR`, backup dirs, `DB_PATH`, `CONFIG_PATH`, `PUBLIC_DIR`); `ensureDataDirs()` creates them. |
| `src/scheduled.js` | The background sync engine: live-session polling → `live_tracking_cache`, completed-session detection, resume-progress replication, per-platform catch-up sync (recently watched + resumable), manual dispatch queue, Plex unwatched reconciliation, `runScheduledSync` and `runForceSync`. See [scheduled-sync.md](scheduled-sync.md). |
| `src/scheduler.js` | Scheduler wrapper and Plex notification listener lifecycle: per-minute tick orchestration, scheduled backup runs, next-airing cache refresh, startup/shutdown listener control, and Plex library-item unwatch callback. |

### `server/src/routes/`

| File | What it is |
| --- | --- |
| `admin.js` | Settings/admin API handlers: config, appearance, Seerr/app links, connection tests, and Plex notification probe. |
| `backups.js` | Backup API handlers for portable import/export (`/api/import`, `/api/backup/export`, `/api/backup/import`), encrypted full backups (`/api/plembfin-backups`), and watch-history backup actions (`/api/watch-backups`). |
| `media.js` | Library and history handlers: history, movies, shows/show detail, delete/update watch records, merge shows, full watchstate replay, and missing-telemetry clearing. |
| `metadata.js` | Poster proxy and metadata/search handlers: TMDB details/search/season/images/person/poster/profile, TVDB search/images, Fanart images, media search, Upcoming episodes, YouTube metadata, and OMDb ratings. |
| `sync.js` | Sync/runtime handlers: webhook ingestion, manual watch/unwatch, playback progress, retry sync, sync job/history listing, Now Playing, active sessions, cron sync, force sync, and stop-force-sync. |
| `maintenance.js` | Maintenance/admin utility handlers: ping, changelog/update check, diagnostic logs, backfill/repair/dedup/rematch, cache stats, and cache clearing. |

### `server/src/utils/`

| File | What it is |
| --- | --- |
| `dataRepo.js` | **The data repository** — pure SQLite. All prepared-statement CRUD for watch history, playstate, playback progress, live tracking cache; the memoized derived caches (`getCachedHistory/Movies/Shows`, `getWatchStats`); `mediaKeyFor` canonical keys; query functions behind `/api/history`, `/api/movies`, `/api/shows`, `/api/show`; dedup/merge/backfill helpers. |
| `parsers.js` | Webhook normalization: `parsePlexWebhook` (multipart), `parseEmbyWebhook`, `parseJellyfinWebhook`, `parseCustomWebhook` → a unified `media` object with a `phase` field (`active`/`completed`/`ended`/`unplayed`/`ignored`). Also `parsePlexGuids`, `normalizeProviderIds`, `decodeHtmlEntities`, `buildPlexMediaFromMetadata`. See [webhooks.md](webhooks.md). |
| `syncOrchestrator.js` | Cross-platform propagation: `syncMediaPlaystate` / `syncMediaUnplayedPlaystate` / `syncMediaProgress` fan out to the other platforms' clients, with `TARGETS_BY_SOURCE` routing, echo-loop detection via `loopStore.checkAndClaim`, and result summaries written to telemetry. |
| `plexClient.js` | Plex HTTP client: find items by GUID/title, mark played/unplayed, set resume progress, fetch watched/resumable/metadata/episodes; username→accountID resolution with memoization. Token always sent as `X-Plex-Token` header. See [plex.md](plex.md). |
| `plexNotificationListener.js` | Plex real-time WebSocket listener (`/:/websockets/notifications`): detects watched/unwatched changes the webhook can never deliver, reconnects with backoff, debounces per ratingKey; plus `probePlexNotificationSocket` for the System Integrity Check. |
| `embyClient.js` | Emby HTTP client (same operation set as Plex client, `X-Emby-Token` auth, provider-ID `AnyProviderIdEquals` lookups). See [emby.md](emby.md). |
| `jellyfinClient.js` | Jellyfin HTTP client (same shape as Emby client; sends both `X-Emby-Token` and `X-MediaBrowser-Token`). See [jellyfin.md](jellyfin.md). |
| `liveSessions.js` | Polls Plex/Emby/Jellyfin `sessions` endpoints for what's playing now (`fetchLiveSessions`), normalizes them (`buildCacheRow`, `sessionIdentity`, `hydrateCachedSession`) for `live_tracking_cache`. Feeds Now Playing and completed-session detection. |
| `activeSessions.js` | The `active_sessions` table (webhook `active`-phase sessions, 5-minute TTL enforced on read). |
| `loopStore.js` | SQLite-backed loop-detection KV (`loop_keys` table) with TTL; `checkAndClaim` runs check+claim in one transaction so concurrent webhooks can't both pass. |
| `syncFlags.js` | `watchedPlayedSyncEnabled()` — global kill-switch for watched/played propagation via `WATCHED_PLAYED_SYNC_ENABLED`. |
| `configStore.js` | The `settings` SQLite row: media-server connection config (Plex/Emby/Jellyfin/Seerr/TMDB/Fanart/TVDB/YouTube/OMDb) with env-var defaults, secret-preserving merges (`mergeIncomingConfig`), browser-safe shape (`publicMediaConfig`), URL validation; plus `runtime_state` helpers and the `sync_history` log. |
| `auth.js` | Session cookie sign/verify (HMAC, 7-day TTL), API-key matching, `requireAdmin`, and the auth route handlers (`login`, `logout`, `auth/status`, `auth/apikey`, `auth/webhook-secret`, `auth/credentials`, `auth/sessions/revoke-all`). See [auth.md](auth.md). |
| `outbound.js` | `fetchWithTimeout` (10s default — **all** server-side outbound HTTP must use it; enforced by the build check), `normalizeHttpUrl`, `assertSafeOutboundUrl` (blocks cloud-metadata endpoints). |
| `http.js` | `sendJson` / `sendOptions` / `methodNotAllowed` / `notFound` response helpers. Same-origin only — no CORS headers are ever sent. |
| `requestBody.js` | `readJson` and `readFormData` (urlencoded + multipart via busboy) over the raw body captured by `server.js`. |
| `diagnosticLogger.js` | Wraps `console.log/warn/error` to keep the last 1,000 log lines in memory (secrets redacted) for Settings → System → Logs (`/api/diagnostic-logs`). |
| `posterCache.js` | Artwork fetch-resize-store pipeline: downloads a remote image (Plex token moved to a header), resizes with sharp to webp (poster 340w / backdrop 1600w / profile 780w / logo 800w), writes to `data/media/<variant>s/`, records metadata in `poster_cache` with negative caching for missing/failed. See [posters-artwork.md](posters-artwork.md). |
| `tmdbGateway.js` | TMDB API gateway + SQLite caches (`tmdb_metadata_cache`, `tmdb_search_cache`, `tmdb_person_cache`): details, search, seasons, people, images, library prewarm, request throttling and in-flight dedupe. For TV it merges TVDB structural data — see [metadata.md](metadata.md). |
| `tvdbGateway.js` | TheTVDB v4 gateway (built-in shared project key, optional personal key): series/season/episode data, title search, artwork; raw responses cached in `tvdb_metadata_cache` / `tvdb_season_cache`; `shapeTvdbSeriesAsTmdb` adapts TVDB shapes to TMDB-style fields. |
| `fanartGateway.js` | Fanart.tv gateway (built-in shared key + optional personal `client_key`): best/all posters, backdrops, HD logos for movies (by TMDB id) and TV (by TVDB id). |
| `omdbGateway.js` | OMDb gateway: IMDb rating + vote count by IMDb id, cached 7 days in `omdb_cache`. |
| `tmdbClient.js` | Tiny wrapper `fetchPosterFromTmdb(row)` used by the poster pipeline's TMDB fallback. |
| `nextAiringCache.js` | File-backed cache (`data/next-airing-cache.json`) of each show's next episode air date + status, so the TV Shows page can sort by "next airing" without live TVDB/TMDB calls. TTL 6h for active shows, 7d for ended. |
| `showProgressCache.js` | File-backed cache (`data/tv_progress_cache.json`) of per-show watched/total episode counts, so library rows can show watch progress without recomputing on every request. |
| `backup.js` | Portable full-backup format: exports/imports the core SQLite tables as versioned JSON collections (paged export, batched import, optional reset). Used by Settings → Data & Backup and the encrypted backup subsystem. |
| `watchHistoryBackups.js` | Watch-history-only backup subsystem: gzip JSON of `watch_history` + `playstate` + `playback_progress` with checksum manifest, daily scheduling, retention, dry-run/merge/replace restore, remote destination management (secrets kept server-side, redacted in every API response), cron-sync pausing around restores. See [backups.md](backups.md). |
| `plembfinBackups.js` | Full encrypted backup subsystem: AES-256-GCM (PBKDF2) encrypted export of the entire portable backup, daily scheduling + retention, optional remote mirroring. |
| `backupDestinations/index.js` | Adapter registry: `folder`, `webdav`, `s3` (also `backblaze`), `onedrive`, `dropbox` — all sharing `testConnection / upload / list / download / delete`. |
| `backupDestinations/folder.js` | Local/mounted-folder destination adapter. |
| `backupDestinations/webdav.js` | WebDAV destination adapter (basic auth). |
| `backupDestinations/s3.js` | S3-compatible destination adapter with its own SigV4 signer (AWS S3, Backblaze B2, MinIO…). |
| `backupDestinations/onedrive.js` | OneDrive adapter using the Microsoft device-code OAuth flow (app-folder scope, refresh-token persistence). |
| `backupDestinations/dropbox.js` | Dropbox adapter using the manual no-redirect OAuth code flow (refresh-token persistence). |

### `public/`

| File | What it is |
| --- | --- |
| `index.html` | The single HTML shell: nav tabs (Dashboard / Movies / TV Shows / Upcoming / History / Stats / Settings), one `view-panel` section per view, all modals/dialogs, and `modulepreload` links for every module. Element IDs here are what `bindElements()` queries. |
| `app.js` | **Frontend orchestrator** (keep under 3,000 lines): startup, theme init, backend warm-up ping, `bindElements`, SPA routing (`handleRouting`/`navigateTo`/`selectView`), auth flow wiring, and the callback objects handed to each module's `init*` function. Feature logic belongs in `public/modules/`, not here. |
| `styles.css` | All styling for the app, including responsive/mobile rules (mobile ≤ 760px must be verified for any layout change). |
| `favicon.svg`, `plembfin_header_logo_dark.png`, `plembfin_header_logo_light.png` | App icon and the theme-specific header logos swapped by the theme toggle. |
| `icons/plex.svg`, `icons/emby.svg`, `icons/jellyfin.svg` | Platform badge icons used on cards and pills. |

### `public/modules/`

| Module | Owns |
| --- | --- |
| `state.js` | The single shared `state` object, the `elements` registry, localStorage keys, view/tab constants. No logic. |
| `utils.js` | Formatting/escaping/date helpers (`escapeHtml`, `formatDate`, `platformBadge`, `slug`, show/episode title parsing, duration/progress formatting…). |
| `auth.js` | Login/logout/status against `/api/auth/*`, `onAuthChange`, credential updates, webhook-secret rotation, auth header building. See [auth.md](auth.md). |
| `settings.js` | Builds connection-config payloads from the settings form inputs (`connectionPayloadFromElements`). |
| `settings-shell.js` | Owns settings group/task routes, legacy aliases, overview status, focused panels, and progressive help/advanced disclosures. |
| `logs.js` | Frontend debug-log store (localStorage ring buffer) + fetching backend diagnostic logs. |
| `images.js` | Poster/artwork frontend: `posterMarkup`, `hydratePosterFallbacks`, `/api/poster` lookups with a persistent cache, TMDB image URL builders, `isCachedStorageImageUrl`. See [posters-artwork.md](posters-artwork.md). |
| `sync.js` | Now Playing polling + rendering, sync-status pills/telemetry parsing, sync jobs + sync history panels, cron/force-sync triggers. |
| `dashboard.js` | Dashboard rendering: Now Playing grid, recent-history rows, part-watched (continue watching) rail. See [dashboard.md](dashboard.md). |
| `stats.js` | Stats page: KPI cards, leaderboards, platform split, month chart, yearly/monthly review reports. See [stats.md](stats.md). |
| `explorer.js` | Movies grid, TV Shows grid, History page, Search page: paging, sorting, filters, IntersectionObserver infinite scroll, TMDB prefetch. See [movies.md](movies.md), [tv-shows.md](tv-shows.md), [history-search.md](history-search.md). |
| `upcoming.js` | Upcoming page: month calendar of future TV episode air dates, search, outside-month matches, poster hydration, and show navigation. See [upcoming.md](upcoming.md). |
| `media-detail.js` | Detail-page entry points: open movie/show detail by id/slug/TMDB id, lookups, modal-close routing. |
| `media-detail-context.js` | Detail-modal shell/context: init callbacks, `authHeaders`, modal DOM root, render token, debug modal, actions-menu state. |
| `media-detail-shared.js` | Shared TMDB/Seerr rendering fragments: rating pills, availability labels, Seerr request pills/controls, external ratings, app links. |
| `media-detail-show.js` | TV show detail rendering: seasons/episodes accordion, show modal, per-episode actions. |
| `media-detail-movie.js` | Movie detail rendering + watched-state patching. |
| `media-detail-events.js` | Click delegation inside the detail modal (cast, trailers, poster edit, watch actions, card navigation). |
| `media-person.js` | Person profile pages: bio, filmography with watch badges. |
| `media-lightbox.js` | Trailer playback (YouTube embed) and photo lightbox. |
| `edit-dialogs.js` | Edit watched-date, edit images (poster/logo/backdrop picker), fix-match, and merge-show dialogs. |
| `watch-action.js` | Manual mark watched/unwatched flows: date prompt, batched `/api/manual-watch` posts, delete-media, Seerr request submission. |
| `tmdb.js` | Frontend TMDB enrichment helpers (`fetchTmdbDetails`, season details, episode-title resolution) with in-memory caches. |
| `tools.js` | Settings tools bridge: Trakt/CSV import flows, `initTools()`, and compatibility re-exports for backup/appearance and maintenance tools. |
| `tools-backups.js` | Settings backup and appearance UI: full export/import, watch-history backups, encrypted backups, destination cards, backup passphrase controls, and appearance settings. See [backups.md](backups.md). |
| `tools-maintenance.js` | Maintenance diagnostics: System Integrity Check, repair workflow, dedup history, Trakt backfill, TV re-match, full watchstate sync, cache stats/clear. |
| `help-content.js` | Static help/guide HTML: credential guides, webhook setup per platform, cron guide, settings inline help. |
| `app-events.js` | Global app event wiring (delegated click/submit/keyboard handlers bound at startup). |

### `scripts/`

| File | What it is |
| --- | --- |
| `build-check.js` | The `npm run build` gate: syntax-checks every JS file, validates the JSON manifests, rejects bare `fetch(` in `server/` (must be `fetchWithTimeout`), then boots the server once against a temp DATA_DIR (`PLEMBFIN_BUILD_CHECK=1`). |
| `changelog-message.js` | Shared changelog-message formatting, bullet extraction, and release-detail validation used by local hooks, tests, and CI. |
| `validate-commit-message.js` | CLI used by the commit-message hook to reject user-visible release commits with missing or title-repeating details. |
| `update-changelog.js` | CI helper: validates release details, bumps the patch version (honouring a manually-set higher version), converts the pushed commits' messages + bullet points into a `changelog.json` entry, and syncs `package.json`/`package-lock.json`. |
| `install-git-hooks.js` | Sets `core.hooksPath` to `.githooks` (runs automatically via npm `prepare`). |
| `docker-entrypoint.sh` | Container entrypoint: chowns `/data` when starting as root, then drops to the `plembfin` user via gosu. |
| `exportPlexHistory.js` | Standalone one-shot importer: reads a Plex server's watch history over its API and posts it to `/api/import` in chunks. Driven by env vars (`PLEX_URL`, `PLEX_TOKEN`, `API_KEY`). |
| `forcePushHistory.js` | Standalone one-shot replicator: fetches Plembfin's `/api/history` and replays every row against Plex/Emby/Jellyfin as mark-played calls. |
| `seed-demo-content.js` | `npm run seed:demo` — inserts fictional movies/shows with generated poster art for demo screenshots/dev. |

### `test/`

The focused `node:test` suite run by `npm test` and the build check. Each file runs in
its own process; DB-backed tests point `DATA_DIR` at a temp directory before importing
server modules.

| File | What it covers |
| --- | --- |
| `changelogMessage.test.js` | Changelog subject formatting, bullet extraction, and rejection of missing or title-repeating release details. |
| `parsers.test.js` | Webhook normalization (Plex/Emby/Jellyfin/custom payload parsing, phases, GUID extraction). |
| `mediaKey.test.js` | Canonical `mediaKeyFor`/`canonicalTitleKey` derivation and specials (season 0) normalization in watch records. |
| `syncOrchestrator.test.js` | Target routing, resume-progress actionability, loop-store echo detection. |
| `syncRetry.test.js` | Scheduled-dispatch retry backoff schedule/eligibility, retry columns, `sync_history` retention pruning. |
| `metadataCaches.test.js` | Fanart response cache (hits and negative misses), TMDB details cache freshness, light-vs-full cache row semantics. |
| `exportPlexHistory.test.js` | The standalone Plex history export script's episode-record shaping (specials season zero). |

## Request flow

```
browser ──/api/whatever──▶ Express (server.js) ──▶ dispatch() (index.js) ──▶ handleX()
browser ──/health────────▶ Express ──▶ { ok: true, ts: <epoch> }  (no auth required)
browser ──/──────────────▶ Express ──▶ static public/ (SPA fallback → index.html)
browser ──/media/────────▶ Express ──▶ static data/media/ (cached artwork)
browser ──/changelog.json▶ Express ──▶ bundled changelog.json
```

1. `server.js` mounts the API router at `/api/*` and static-serves `public/` and
   `data/media`.
2. `dispatch()` (`server/src/index.js`) strips the `/api/` prefix and routes by
   path to a `handleX` function. The full route table is the body of `dispatch()`.
3. Auth: webhook routes use `verifyWebhookToken(token)` from
   `X-Plembfin-Webhook-Secret`, `Authorization: Bearer`, or the compatibility
   `?token=` URL param. All other protected routes call `requireAdmin(req, res)`, which accepts
   either a signed HttpOnly session cookie (`plembfin_session`) or an API key
   (`X-Api-Key` header / `Authorization: Bearer`).
4. Secrets stay server-side: `GET /api/config` returns each integration section
   with a `configured` boolean instead of the stored token/API key. A settings
   save that leaves a credential field blank keeps the stored value
   (`mergeIncomingConfig` in `configStore.js`); entering a new value replaces it.
   Test-connection endpoints fall back to the stored credential when the request
   body omits the token.
5. Outbound HTTP: every server-side call to an external service goes through
   `fetchWithTimeout` (`server/src/utils/outbound.js`, 10s default; backup
   transfers use 60s) or carries an explicit `AbortSignal.timeout`. The build
   check (`scripts/build-check.js`) fails on any bare `fetch(` in `server/`.
   Plex HTTP requests send `X-Plex-Token` as a header rather than a query
   parameter so tokens stay out of access logs; the Plex notification WebSocket
   is the one exception because the handshake cannot carry custom headers.

## Data flow: webhook → sync

When a play event arrives at `/api/webhook`:

1. `normalizeWebhook()` parses Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom
   JSON into a unified `media` object (`parsers.js`).
2. The `phase` field drives branching: `active` → upsert active session; `ended` → sync
   resume progress; `unplayed` → delete + propagate unwatched; `completed` → insert watch
   record + propagate watched.
3. `syncMediaPlaystate()` (`syncOrchestrator.js`) propagates to the other two platforms
   via `plexClient` / `embyClient` / `jellyfinClient`, with echo-loop detection via
   `loopStore`.
4. Results are written back as `sync_dispatch_telemetry` on the watch record and logged
   to `sync_history`.

Full detail: [webhooks.md](webhooks.md).

## Scheduler

`server.js` runs `setInterval(tick, 60000)` once the server is up, calling
`runScheduledTick()` from `server/src/scheduler.js` (wrapping `runScheduledSync` from
`scheduled.js`). The tick is guarded against overlap: if the previous tick is still
running when the next fires, the new tick is skipped.

The same logic runs on demand via:
- `GET /api/cron-sync/status` — returns the last cron trigger/result as JSON for automation.
- `POST /api/cron-sync` — streams a text log of what the tick did.
- `POST /api/force-sync` — runs and stores progress in `runtime_state` for the
  dashboard to poll; `stop-force-sync` cancels.

The tick also runs the scheduled watch-history backup and encrypted backup jobs
([backups.md](backups.md)) and maintains `data/next-airing-cache.json`: on startup it
builds a full TVDB-backed TV next-airing cache for every show, then refreshes stale
entries in small batches so the TV Shows library can sort by upcoming episodes without
per-row TVDB calls during page loads.

Full detail: [scheduled-sync.md](scheduled-sync.md).

## TV metadata (TMDB + TheTVDB hybrid)

`server/src/utils/tmdbGateway.js` and `server/src/utils/tvdbGateway.js` split TV show
metadata by source, both behind the same `getTmdbDetails()`/`getTmdbSeason()` API so
every caller (routes, frontend, `deriveNextAiring`) is unaware of the split:

- **TheTVDB** supplies structural data for TV shows — name, overview, status, network,
  genres, artwork, and season/episode numbering, titles, overviews, and air dates.
  This is deliberately more accurate than TMDB's own numbering for many shows.
- **TMDB** supplies everything TheTVDB doesn't have: cast/credits, trailers,
  reviews, similar/recommendations, watch providers, and content ratings. `id` on a
  TV show's details is always the resolved TMDB ID (via TheTVDB's `remoteIds`, or the
  caller-supplied ID), since Seerr requests and `/tvshow/tmdb/:id` routing are
  TMDB-keyed. TheTVDB's `remoteIds` mapping is community-submitted and occasionally
  points at a stale/incorrect TMDB id; `getTvShowDetails` verifies it by fetching that
  id and, if it 404s, falls back to a TMDB title search and uses the corrected id —
  otherwise cast/trailers/images would silently stay empty for that show.
- A "Specials" (season 0) entry is only included in a show's `seasons` list when
  TheTVDB actually has episodes attached to it — an empty placeholder season is
  dropped rather than shown as a dead, always-empty accordion row.
- **Movies** are 100% TMDB.

Like `fanartGateway.js`, `tvdbGateway.js` ships a hardcoded project API key so TVDB
lookups work out of the box; an optional personal key can be set in Settings →
API Keys → TheTVDB or via `TVDB_API_KEY` for a higher personal rate limit.

Raw TVDB API responses are cached in `tvdb_metadata_cache` / `tvdb_season_cache`;
the merged TMDB+TVDB result is cached in the `tmdb_metadata_cache` table
under `tv_{tmdbId}` keys, so movie caching and downstream consumers (poster pipeline,
Seerr, next-airing) all read one shape. `DETAILS_SCHEMA_VERSION` is bumped whenever the
cached shape changes, which forces every existing cache row to be treated as stale and
refetched on next access — no manual cache clearing needed after an upgrade that changes
this shape.

Full detail: [metadata.md](metadata.md).

## Changelog & update check

Each build ships with a bundled `changelog.json` at the repo root (served verbatim at
`GET /changelog.json`) that records the version this instance was built from — this is what
the sidebar version badge shows. On dashboard load `loadAppVersion()` calls `/api/changelog`
with `?refresh=1` for a quick update check; when a newer release exists the badge changes
from `v0.2.15` to `v0.2.15 - Update available` (accent-tinted).

`GET /api/changelog` (`handleChangelog` in `routes/maintenance.js`) layers an update check on top: it
reads the bundled `changelog.json` for the current version and fetches the published
`changelog.json` from GitHub raw (`Lasikiewicz/plembfin@main`), cached in-process for 30
minutes (8-second fetch timeout). `?refresh=1` forces a refresh but honors a 5-minute
floor, so routine dashboard loads never turn into one GitHub fetch each. The browser cannot reach
GitHub directly because the CSP is `connect-src 'self'`, so the server proxies and caches it.
The response is `{ current, latest, updateAvailable, remoteAvailable, remoteError, newer,
entries }`, where `newer` lists releases with a higher semver than the running build. If
GitHub is unreachable it falls back to the bundled entries. Settings → System → About renders the
current version, an update banner, and the full release list with newer versions highlighted.

## Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` in WAL mode and applies `schema.sql` on
boot. All database access uses prepared statements.

**In-process memoization:** derived caches are keyed by a monotone `dataVersion` integer.
`bumpDataVersion()` invalidates them; the next read reloads from SQLite. This works
because Plembfin is a single long-lived process — never assume a second process can
share these caches.

Gotcha: `getCachedHistory()`, `getCachedMovies()`, and `getCachedShows()` rebuild full
history-derived result sets after invalidation. That is acceptable for current local
install sizes, but large datasets should move hot paths to indexed SQL with
`LIMIT`/`OFFSET` before adding more full-table caches.

Table-by-table reference: [sqlite-schema.md](sqlite-schema.md).

## Auth (`server/src/utils/auth.js` + `server/src/appConfig.js`)

- Admin login: local username / password. Password is hashed with scrypt (64-byte
  output) and stored in `data/config.json`.
- Session: stateless HMAC-SHA256 signed cookie (`plembfin_session`), 7-day TTL.
  All sessions are revoked instantly by rotating `sessionSecret`.
- API key: 48-hex-char random string, stored in `data/config.json`. Sent as
  `X-Api-Key` header or `Authorization: Bearer`.
- Webhook secret: separate 48-hex-char key, rotatable independently. Sent as
  `X-Plembfin-Webhook-Secret`, `Authorization: Bearer`, or the compatibility
  `?token=` URL parameter.

Full detail: [auth.md](auth.md).

## Frontend state & routing

- One global `state` object in `public/modules/state.js` (no framework), with
  feature code split across `public/modules/` and `app.js` kept to startup,
  routing, shared callbacks, and element binding.
- SPA navigation via `navigateTo(url)` / `handleRouting()` / `history.pushState`.
  Routes: `/` dashboard, `/movies`, `/tvshows`, `/upcoming`, `/history`, `/stats`,
  `/search`, `/settings/:tab` (plus `/sync` and `/logs` shortcuts), `/movie/:id`,
  `/movie/tmdb/:id`, `/tvshow/:key(/season/:n(/episode/:n))`, `/tvshow/tmdb/:id`,
  `/person/:id`.
- Auth handled by `onAuthChange()` (`modules/auth.js`) — which checks
  `/api/auth/status`. The auth panel is hidden until a session is confirmed.
- Browser API calls use the HttpOnly session cookie after authentication.
  `fetchAndCacheApiKey()` keeps the integration API key in memory only for
  authenticated display/copy flows; it is not persisted to localStorage.

Full detail: [frontend.md](frontend.md).

## Access logging

Sensitive query parameters such as `token`, `api_key`, `secret`, and `password` are
redacted before request log formatting.

Morgan `combined`-format request logs are written to `data/logs/access.log`. The file
rotates daily and the last 14 days of logs are retained. Logs are never written to
stdout — only to the file — so container log streams stay clean.

## Security headers

The CSP keeps scripts and connections same-origin, allows local/TMDB/YouTube/Fanart.tv/
TheTVDB images, sets `frame-ancestors 'none'`, and permits YouTube embeds only in frames.

The `img-src` directive is extended dynamically at request time: `server.js` reads the
stored media config and appends the origins of any configured Plex, Emby, Jellyfin, and
Seerr server URLs to the whitelist. This ensures artwork served directly by those servers
(e.g. backdrop images) is not blocked by the CSP, without permanently whitelisting
arbitrary external origins.

Every response carries: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(),
geolocation=()`, and a `Content-Security-Policy` that allows frames only from YouTube.
`Strict-Transport-Security` is added when `COOKIE_SECURE=true`. `x-powered-by` is
suppressed.

Startup runs `logSecuritySummary()` (in `appConfig.js`) which warns if the admin password
is still the default, or if any pinned secret is shorter than the minimum length. A
separate `[security]` warning is emitted if `COOKIE_SECURE` is not set, reminding
operators to enable it when the app is behind an HTTPS reverse proxy.

## Rate limiting

`server.js` applies express-rate-limit tiers before any route handler: `/api/login`
(10/15min), `/api/webhook` (60/min), TMDB image proxies (300/min), a list of
destructive/expensive admin actions (15/min, GET/HEAD/OPTIONS exempt so status polling
is never throttled), a general `/api` ceiling (1200/min), and a static-asset ceiling
(2000/min).

## Graceful shutdown

`server.js` registers `SIGTERM` and `SIGINT` handlers. On signal: the Plex notification
WebSocket listener is stopped, `server.close()` drains in-flight HTTP requests, then
`db.close()` flushes the WAL. A 5-second watchdog forces `exit(1)` if the drain hangs.

## Environment variables

- `PORT` — HTTP port (default `5055`)
- `DATA_DIR` — data directory (default `<repo>/data`; Docker sets `/data`)
- `ADMIN_USERNAME` (default `admin`) / `ADMIN_PASSWORD` — admin login. If `ADMIN_PASSWORD` is unset on a brand-new install, a random password is generated and printed once to the server console.
- `API_KEY` — pin the webhook/integration key
- `WEBHOOK_SECRET` — pin the webhook secret used by header/Bearer auth and the compatibility `?token=` URL
- `SESSION_SECRET` — pin the session signing secret
- `COOKIE_SECURE` — set to `true` when behind an HTTPS reverse proxy
- `WATCHED_PLAYED_SYNC_ENABLED` — set to `false`/`0`/`off` to disable all watched/played propagation (recording still happens)
- `CATCHUP_SYNC_INTERVAL_MS` — how often the catch-up library sync runs inside the scheduler (default 15 minutes)
- `PLEX_SERVER_URL` / `PLEX_TOKEN` / `PLEX_USERNAME` / `PLEX_ENABLED` — Plex connection defaults (Settings values take precedence)
- `EMBY_SERVER_URL` / `EMBY_API_KEY` / `EMBY_USER_ID` / `EMBY_ENABLED` — Emby connection defaults
- `JELLYFIN_SERVER_URL` / `JELLYFIN_API_KEY` / `JELLYFIN_USER_ID` / `JELLYFIN_ENABLED` — Jellyfin connection defaults
- `TMDB_API_KEY` — TMDB API key default
- `YOUTUBE_API_KEY` — YouTube Data API key default (trailer metadata)
- `OMDB_API_KEY` — optional OMDb API key; when set, enables IMDb rating badges on media detail pages (free tier: 1,000 req/day from omdbapi.com). Can also be configured in Settings → Metadata → OMDb.
- `TVDB_API_KEY` — optional personal TheTVDB API key for a higher personal rate limit. A built-in project key is used when this is unset. Can also be configured in Settings → Metadata → TheTVDB.
- `TVDB_PROJECT_KEY` — advanced: replace the built-in shared TheTVDB project key (used when no personal key is set). Only needed if the built-in key is revoked or exhausted.
- `FANART_PROJECT_KEY` — advanced: replace the built-in shared Fanart.tv project key. Only needed if the built-in key is revoked or exhausted.
- `FANART_API_KEY` — optional personal Fanart.tv key (raises the rate limit as a `client_key`)
- `PLEMBFIN_DEBUG_OUTBOUND` — set to `1` to log a per-host outbound HTTP request count once a minute (visible in Settings → System → Logs); for measuring upstream traffic

Environment variables act as **defaults** for connection settings: values saved in
Settings (stored in the `settings` SQLite row) take precedence over env values
(`mergeEnvDefaults` in `configStore.js`).
