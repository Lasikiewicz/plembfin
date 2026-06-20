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

## Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` in WAL mode and applies `schema.sql` on
boot. All database access uses prepared statements. Firestore-style semantics map as:
- `.doc(id).set(x, { merge })` → `INSERT … ON CONFLICT DO UPDATE`
- `.batch()` → `db.transaction()`
- `serverTimestamp()` → `Date.now()`

**In-process memoization:** the old Firestore-backed derived caches are replaced by
in-memory caches keyed by a monotone `dataVersion` integer. `bumpDataVersion()`
invalidates them; the next read reloads from SQLite.

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
  Routes: `/` dashboard, `/movie/:id`, `/tvshow/:key`, `/person/:id`, `/settings/:tab`, `/help/:topic`.
- Auth handled by `onFirebaseAuthChange()` (`modules/auth.js`) — which checks
  `/api/auth/status`. The auth panel is hidden until a session is confirmed.
- After every successful auth operation, `fetchAndCacheApiKey()` is called to
  populate `cachedToken` in `auth.js`; this token goes into `X-Api-Key` headers
  for all subsequent API calls.
- The explorer grid uses `IntersectionObserver` (1200px rootMargin, 240-item pages)
  to pre-fetch the next page, plus a second observer
  (`observeExplorerTmdbPrefetch`) to pre-fetch TMDB details for visible cards.

## Environment variables

- `PORT` — HTTP port (default `5055`)
- `DATA_DIR` — data directory (default `<repo>/data`; Docker sets `/data`)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin login (default `admin` / `admin`)
- `API_KEY` — pin the webhook/integration key
- `WEBHOOK_SECRET` — pin the webhook URL secret token
- `SESSION_SECRET` — pin the session signing secret
- `COOKIE_SECURE` — set to `true` when behind an HTTPS reverse proxy
