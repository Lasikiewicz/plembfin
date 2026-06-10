# Architecture

## Two layers, no build step

**Frontend** (`public/`) — a plain ES-module SPA. No framework, no bundler, no
TypeScript. Served by Firebase Hosting.
- `public/index.html` — shell + element IDs the JS queries.
- `public/app.js` (~7000 lines) — *everything*: state, routing, rendering, all
  API calls. A single `state` object holds app state; there is no reactive
  framework, so rendering is manual (`renderDashboard`, `renderNowPlaying`, etc.).
- `public/modules/` — thin helpers: `auth.js`, `logs.js`, `settings.js`,
  `timeline.js`.
- `public/styles.css` — all styling.

**Backend** (`functions/`) — two exported Cloud Functions, both in
`functions/src/index.js`:
- `api` — handles **all** `/api/*` routes via a manual `dispatch()` router.
  Region `europe-west2`, `timeoutSeconds: 540`, `memory: "512MiB"`, `cors: true`.
- `scheduledSync` — runs **every 1 minute** via Cloud Scheduler. See
  [scheduled-sync.md](scheduled-sync.md).

## Request flow

```
browser ──/api/whatever──▶ Firebase Hosting ──rewrite──▶ api Cloud Function ──▶ dispatch()
```

1. `firebase.json` rewrites `"/api/**"` to the `api` function in `europe-west2`
   (with `pinTag: true`, so a hosting deploy also re-pins/deploys the function).
   Everything else rewrites to `/index.html` (SPA routing).
2. `dispatch()` (`functions/src/index.js:1811`) strips the `/api/` prefix and
   routes by path to a `handleX` function. The full route table is the body of
   `dispatch()` — e.g. `now-playing`, `history`, `webhook`, `config`, `poster`,
   `tmdb-details`, `force-sync`, `cron-sync`, etc.
3. Auth: nearly every handler calls `requireAdmin(req, res)` first
   (`functions/src/utils/auth.js`), which verifies a Firebase Auth ID token and
   checks it against `ADMIN_EMAILS` / `ADMIN_UIDS`. Streaming handlers use
   `requireAdminStreaming`.
4. CORS is handled by the Functions `cors: true` option.

### Important: the Hosting proxy

In production the browser never talks to the function directly — it goes through
Firebase Hosting. Hosting **buffers** function responses, which means
**long-lived / streamed responses (Server-Sent Events) do not stream through**.
This is invisible in the emulator (direct connection). It is the root cause of the
Now Playing outage documented in [now-playing.md](now-playing.md).

## Frontend state & routing

- One global `state` object in `app.js` (no framework).
- SPA navigation via `navigateTo(url)` / `handleRouting()` / `history.pushState`.
  Routes: `/` dashboard, `/movie/:id`, `/tvshow/:key`, `/person/:id`,
  `/help/:topic`.
- Auth handled by `onFirebaseAuthChange()` (`modules/auth.js`). The auth panel is
  hidden until Firebase confirms no user; the app shell shows on success.
- The explorer grid uses `IntersectionObserver` (1200px rootMargin, 240-item
  pages) to pre-fetch the next page, plus a second observer
  (`observeExplorerTmdbPrefetch`) to pre-fetch TMDB details for visible cards.

## Environment variables (`functions/.env`)

- `ADMIN_EMAILS` — comma-separated Firebase Auth emails allowed in.
- `ADMIN_UIDS` — optional comma-separated UIDs.
- `FUNCTIONS_REGION` — defaults to `europe-west2`.

## Emulators

`npm run emulators` runs: hosting `:5000`, functions `:5001`, firestore `:8180`,
auth `:9099`, storage `:9199`, pubsub `:8085`, UI `:4000`. Emulator admin login:
`admin` / `admin`.

The emulator's Firestore is **separate** from production's. Data written locally is
not visible in prod and vice versa — a frequent source of "works locally" confusion.
