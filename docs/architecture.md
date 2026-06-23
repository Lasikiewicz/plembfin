# Architecture

## One process, no build step

**Frontend** (`public/`) — a plain ES-module SPA served as static files.
No framework, no bundler, no TypeScript.
- `public/index.html` — shell + element IDs the JS queries.
- `public/app.js` (~9000 lines) — everything: state, routing, rendering, all
  API calls. A single `state` object holds app state; rendering is manual
  (`renderDashboard`, `renderNowPlaying`, etc.).
- `public/modules/` — thin helpers: `auth.js`, `logs.js`, `settings.js`,
  `timeline.js`.
- `public/styles.css` — all styling.

**Backend** (`server/`) — a single Express process.
- `server/server.js` — entrypoint: static file serving, API mount, in-process scheduler.
- `server/src/index.js` — `dispatch()` router for all `/api/*` routes.
- `server/src/db.js` + `server/src/schema.sql` — SQLite data layer (better-sqlite3, WAL mode).
- `server/src/appConfig.js` — resolves and persists credentials / secrets.
- `server/src/utils/` — auth, HTTP helpers, parsers, sync orchestrator, poster cache, etc.
- `server/src/scheduled.js` — background sync logic called by the in-process timer.

## Request flow

```
browser ──/api/whatever──▶ Express (server.js) ──▶ dispatch() (index.js) ──▶ handleX()
browser ──/health────────▶ Express ──▶ { ok: true, ts: <epoch> }  (no auth required)
browser ──/──────────────▶ Express ──▶ static public/ (SPA fallback → index.html)
browser ──/media/──────────▶ Express ──▶ static data/media/ (cached artwork)
```

1. `server.js` mounts the API router at `/api/*` and static-serves `public/` and
   `data/media`.
2. `dispatch()` (`server/src/index.js`) strips the `/api/` prefix and routes by
   path to a `handleX` function. The full route table is the body of `dispatch()`.
3. Auth: webhook routes use `verifyWebhookToken(token)` (from the `?token=` URL
   param). All other protected routes call `requireAdmin(req, res)`, which accepts
   either a signed HttpOnly session cookie (`plembfin_session`) or an API key
   (`X-Api-Key` header / `Authorization: Bearer`).

## Scheduler

`server.js` runs `setInterval(runScheduledTick, 60000)` once the server is up.
`runScheduledTick` is wrapped to prevent overlap: if the previous tick is still
running when the next fires, the new tick is skipped.

The same logic runs on demand via:
- `POST /api/cron-sync` — streams a text log of what the tick did.
- `POST /api/force-sync` — runs and stores progress in `runtime_state` for the
  dashboard to poll; `stop-force-sync` cancels.

## Changelog & update check

Each build ships with a bundled `changelog.json` at the repo root (served verbatim at
`GET /changelog.json`) that records the version this instance was built from — this is what
the sidebar version badge shows. On dashboard load `loadAppVersion()` calls `/api/changelog`
for a quick update check; when a newer release exists the badge changes from `v0.2.15` to
`v0.2.15 - Update available` (accent-tinted).

`GET /api/changelog` (`handleChangelog` in `index.js`) layers an update check on top: it
reads the bundled `changelog.json` for the current version and fetches the published
`changelog.json` from GitHub raw (`Lasikiewicz/plembfin@main`), cached in-process for 30
minutes (force-refresh with `?refresh=1`, 8-second fetch timeout). The browser cannot reach
GitHub directly because the CSP is `connect-src 'self'`, so the server proxies and caches it.
The response is `{ current, latest, updateAvailable, remoteAvailable, remoteError, newer,
entries }`, where `newer` lists releases with a higher semver than the running build. If
GitHub is unreachable it falls back to the bundled entries. Settings → Changelog renders the
current version, an update banner, and the full release list with newer versions highlighted.

## Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` in WAL mode and applies `schema.sql` on
boot. All database access uses prepared statements.

**In-process memoization:** derived caches are keyed by a monotone `dataVersion` integer.
`bumpDataVersion()` invalidates them; the next read reloads from SQLite.

## Auth (`server/src/utils/auth.js` + `server/src/appConfig.js`)

- Admin login: local username / password. Password is hashed with scrypt (64-byte
  output) and stored in `data/config.json`.
- Session: stateless HMAC-SHA256 signed cookie (`plembfin_session`), 7-day TTL.
  All sessions are revoked instantly by rotating `sessionSecret`.
- API key: 48-hex-char random string, stored in `data/config.json`. Sent as
  `X-Api-Key` header or `Authorization: Bearer`.
- Webhook secret: separate 48-hex-char key, rotatable independently. Sent as
  `?token=` URL parameter (the only auth method webhook senders can use).

## Frontend state & routing

- One global `state` object in `app.js` (no framework).
- SPA navigation via `navigateTo(url)` / `handleRouting()` / `history.pushState`.
  Routes: `/` dashboard, `/stats`, `/movie/:id`, `/tvshow/:key`, `/person/:id`, `/settings/:tab`, `/help/:topic`.
- Auth handled by `onAuthChange()` (`modules/auth.js`) — which checks
  `/api/auth/status`. The auth panel is hidden until a session is confirmed.
- After every successful auth operation, `fetchAndCacheApiKey()` is called to
  populate `cachedToken` in `auth.js`; this token goes into `X-Api-Key` headers
  for all subsequent API calls.
- The explorer and history grids use `IntersectionObserver` (1200px rootMargin,
  240-item pages) to pre-fetch the next page. The history endpoint returns an
  explicit `hasMore` flag so the dedicated History page can continue lazy-loading
  through the full SQLite watch log; raw History pages collapse duplicate rows to
  one entry per movie or show episode per calendar day so same-day webhook echoes
  do not crowd out genuine later rewatches. A second observer
  (`observeExplorerTmdbPrefetch`) pre-fetches TMDB details for visible cards.
- The stats view consumes the derived `/api/history?stats=only` payload to render
  all-time, yearly, and monthly review reports with poster-backed rankings,
  first/last plays, platform breakdowns, and watch activity without re-querying
  for each filter change.

## Access logging

Morgan `combined`-format request logs are written to `data/logs/access.log`. The file rotates daily and the last 14 days of logs are retained. Logs are never written to stdout — only to the file — so container log streams stay clean.

## Security headers

Every response carries: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and a `Content-Security-Policy` that allows frames only from YouTube. `Strict-Transport-Security` is added when `COOKIE_SECURE=true`. `x-powered-by` is suppressed.

Startup runs `logSecuritySummary()` (in `appConfig.js`) which warns if the admin password is still the default, or if any pinned secret is shorter than the minimum length. A separate `[security]` warning is emitted if `COOKIE_SECURE` is not set, reminding operators to enable it when the app is behind an HTTPS reverse proxy.

## Graceful shutdown

`server.js` registers `SIGTERM` and `SIGINT` handlers. On signal: the Plex notification WebSocket listener is stopped, `server.close()` drains in-flight HTTP requests, then `db.close()` flushes the WAL. A 5-second watchdog forces `exit(1)` if the drain hangs.

## Environment variables

- `PORT` — HTTP port (default `5055`)
- `DATA_DIR` — data directory (default `<repo>/data`; Docker sets `/data`)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin login (default `admin` / `admin`)
- `API_KEY` — pin the webhook/integration key
- `WEBHOOK_SECRET` — pin the webhook URL secret token
- `SESSION_SECRET` — pin the session signing secret
- `COOKIE_SECURE` — set to `true` when behind an HTTPS reverse proxy
- `OMDB_API_KEY` — optional OMDb API key; when set, enables IMDb rating badges on movie detail pages (free tier: 1,000 req/day from omdbapi.com). Can also be configured in Settings → Integrations.
