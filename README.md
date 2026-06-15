# Plembfin

A self-hosted **watch-state bridge** for Plex, Emby, and Jellyfin — in the style of
Sonarr/Radarr/Jellyseerr. It listens for playback webhooks, records your watch history in a
local SQLite database, and propagates watched/unwatched state across every connected
platform automatically. A built-in scheduler keeps things in sync even when the dashboard
is closed.

One Node process serves the web UI, the API, and the scheduler. All state lives under
`data/` (SQLite database + cached artwork + generated config). No cloud services required.

## Quick start (Docker)

```bash
docker compose up --build
```

Then open <http://localhost:5055> and sign in (default `admin` / `admin` — change
`ADMIN_PASSWORD` in `docker-compose.yml` first). Data persists in `./data`.

## Quick start (bare metal)

Requires Node.js 20+. The native modules (`better-sqlite3`, `sharp`) install via prebuilt
binaries; on Windows you may need the
[VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) as a fallback.

```bash
npm install
npm start            # http://localhost:5055
# or: npm run dev    # auto-reload during development
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5055` | HTTP port |
| `DATA_DIR` | `./data` | Database + artwork + config location (Docker uses `/data`) |
| `ADMIN_USERNAME` | `admin` | Dashboard login username |
| `ADMIN_PASSWORD` | `admin` | Dashboard login password |
| `API_KEY` | _generated_ | Webhook/integration key (else written to `data/config.json`) |
| `SESSION_SECRET` | _generated_ | Session cookie signing secret |

On first boot the server writes `data/config.json` with the admin credentials (password
hashed), the API key, and the session secret.

## Setup

1. Sign in to the dashboard.
2. In **Settings → Apps**, fill in the server URL, token/API key, and user ID for each
   platform you use, plus an optional TMDB API key for artwork and metadata.
3. Point each media server's webhook at `http://YOUR_HOST:5055/api/webhook` and include
   your API key (header `X-Api-Key`, or `?api_key=` for servers that only support a URL).
4. (Optional) Import a Trakt history export under **Settings → Tools**, then run
   **Full Sync Watchstates**.

## Authentication

- **Dashboard:** username + password → HttpOnly session cookie.
- **Webhooks / integrations:** the API key (shown after sign-in, stored in
  `data/config.json`) via `X-Api-Key`, `Authorization: Bearer <key>`, or `?api_key=<key>`.

## Migrating from the old Firebase project

If you previously ran the Firebase version, import your data once:

```bash
GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json \
FIREBASE_STORAGE_BUCKET=your-bucket.firebasestorage.app \
npm run migrate
```

This copies every Firestore collection into SQLite and downloads cached poster/backdrop
binaries into `data/media`. It is idempotent and safe to re-run. (`firebase-admin` is a
dev dependency used only by this script.)

## Architecture

See [CLAUDE.md](CLAUDE.md) for a full breakdown of the process layout, data layer, auth,
the webhook→sync flow, and the SQLite schema.
