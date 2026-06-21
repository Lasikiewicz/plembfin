<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/plembfin_header_logo_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="public/plembfin_header_logo_light.png">
    <img alt="Plembfin Logo" src="public/plembfin_header_logo_dark.png" width="600" style="max-width: 100%;">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-blue?style=flat-square&logo=node.js" alt="Node version" />
  <img src="https://img.shields.io/badge/Database-SQLite-orange?style=flat-square&logo=sqlite" alt="SQLite" />
  <img src="https://img.shields.io/badge/Docker-Compatible-blue?style=flat-square&logo=docker" alt="Docker support" />
  <img src="https://img.shields.io/badge/Frontend-Vanilla_JS_/_CSS-ff69b4?style=flat-square" alt="Frontend Tech" />
</p>

---

**Plembfin** is a self-hosted **personal watch history tracker and playstate sync** for Plex, Emby, and Jellyfin. It listens for playback webhooks from your media servers, records everything you watch in a local SQLite database, and keeps your watched/unwatched state in sync across all connected platforms automatically. Plembfin is easy to configure and comes with a clean, polished UI with both light and dark theme options.

With an in-process scheduler, Trakt history imports, Seerr requests, and automatic cloud backups, Plembfin keeps your entire media ecosystem in perfect sync without requiring cloud dependencies.

---

## 📸 Screenshots

<p align="center">
  <img src="docs/screenshots/now-playing.png" alt="Now Playing dashboard" width="100%" />
  <em>Now Playing dashboard with active sessions and recent watch history</em>
</p>

<p align="center">
  <img src="docs/screenshots/movies.png" alt="Movies library view" width="100%" />
  <em>Full poster grid with search, filters, and sort options</em>
</p>

<p align="center">
  <img src="docs/screenshots/part-watched.png" alt="Part Watched view" width="100%" />
  <em>In-progress items with resume progress and quick mark-watched actions</em>
</p>

<p align="center">
  <img src="docs/screenshots/tvshows.png" alt="TV Shows library view" width="100%" />
  <em>TV Shows library with rich show details</em>
</p>

<p align="center">
  <img src="docs/screenshots/history.png" alt="Watch history view" width="100%" />
  <em>Complete watch log across all connected platforms</em>
</p>

<p align="center">
  <img src="docs/screenshots/stats.png" alt="Stats view" width="100%" />
  <em>All-time play counts, top shows, platform breakdowns, and monthly watch activity</em>
</p>

<p align="center">
  <img src="docs/screenshots/bio.png" alt="Person bio view" width="100%" />
  <em>Biography, photos, and full filmography pulled from TMDB</em>
</p>

<p align="center">
  <img src="docs/screenshots/search.png" alt="Global search" width="100%" />
  <em>Instant search results across movies, TV shows, and people</em>
</p>

---

## 🌟 Key Features

*   🔄 **Bi-directional Synchronization**: Syncs watched and unwatched states between Plex, Emby, and Jellyfin.
*   ⏱️ **Resume Progress Sync**: Automatically propagates playback progress (resume offsets) so you can pause a movie on Plex and pick up exactly where you left off on Jellyfin.
*   📊 **Real-Time Dashboard**: A clean, single-page dashboard displaying real-time "Now Playing" activity, weekly viewing charts, and detailed history.
*   📈 **Stats Reviews**: Year, month, and all-time reports highlight most-played movies and TV shows with poster rankings, first/last plays, platform breakdowns, and watch activity.
*   🔒 **Self-Hosted & Private**: Built on a local SQLite database running in WAL mode. All poster assets, metadata, and watch histories reside on your own hardware.
*   🛡️ **Security Hardening**: Ships with strict HTTP security headers (CSP, `X-Frame-Options`, `Permissions-Policy`), scrypt password hashing, rate-limited login, HMAC-signed sessions, and a forced first-login password change when the default credentials are in use. See [`docs/hardening.md`](docs/hardening.md) for the full production checklist.
*   🖼️ **Art Pipeline & Caching**: Fetches posters, backdrops, and logo art from your media servers, TMDB, and Fanart.tv (in parallel), resizes them with `sharp`, and caches them locally under `data/media` for near-instant rendering.
*   🧹 **Echo Loop Prevention**: Utilizes a memory-mapped loop detector to suppress echo webhooks triggered by Plembfin's own updates.
*   ☁️ **Automated Backups**: Backs up your database daily to a local folder and optionally mirrors to Backblaze B2 cloud storage.
*   🔍 **Seerr Integration**: Integrates with Overseerr/Jellyseerr/Seerr to check request and availability statuses directly from the movie and show detail views.
*   📅 **In-Process Scheduler**: An in-memory scheduler checks for active play sessions, processes manual sync overrides, and triggers catch-up syncs every minute.

---

## 🚀 Getting Started

### Method A: Docker Compose (Recommended)

1. Create a `docker-compose.yml` file:
   ```yaml
   services:
     plembfin:
       image: plembfinfire:latest
       build: .
       container_name: plembfin
       ports:
         - "5055:5055"
       volumes:
         # Database, configuration, and cached posters are persisted here
         - ./data:/data
       environment:
         - ADMIN_USERNAME=admin
         - ADMIN_PASSWORD=changeme # Change this before starting the container
         # Optional: Pin a specific API key (otherwise auto-generated)
         # - API_KEY=your-secure-webhook-api-key
         # Optional: Pin a session cookie signing secret
         # - SESSION_SECRET=your-secure-session-secret
       restart: unless-stopped
   ```
2. Build and start the container:
   ```bash
   docker compose up -d --build
   ```
3. Open `http://localhost:5055` in your browser and log in with your configured credentials.

> [!TIP]
> For a hardened production setup (read-only filesystem, required secrets, `COOKIE_SECURE`), use the secure overlay:
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.secure.yml up -d
> ```
> See [`docs/hardening.md`](docs/hardening.md) for the full guide including HTTPS reverse-proxy setup.

---

### Method B: Bare Metal (Node.js)

#### Prerequisites
*   Node.js 20+
*   Native build tools (required for compiling `better-sqlite3` and `sharp` if prebuilt binaries fail).
    *   **Windows**: Install [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) if needed.
    *   **Linux/macOS**: Install standard build tools (`gcc`/`g++` / `make`).

#### Steps
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
   *For live reloading during development, run `npm run dev` instead.*
3. Access the dashboard at `http://localhost:5055`. Default credentials on fresh boots are `admin` / `admin`.

> [!TIP]
> If port `5055` is occupied, change it using the `PORT` environment variable:
> *   **Bash**: `PORT=5056 npm start`
> *   **PowerShell**: `$env:PORT=5056; npm start`

---

## 🔧 Full Setup & Integration Guide

### 1. Sign In & Set Admin Credentials
On your first login with the default credentials (`admin` / `admin`), Plembfin will automatically redirect you to **Settings → General** and display a security banner until the password is changed.

### 2. Connect Your Media Apps
Go to **Settings → Apps** and configure connection settings for the platforms you use:

#### 🎟️ Plex Integration
*   Enable Plex.
*   **Plex Server URL**: Your Plex server network address (e.g., `http://192.168.1.100:32400`).
*   **Plex Token**: Your Plex authentication token ([How to find your Plex Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)).
*   **Plex Username**: Your Plex account username.

#### 🍉 Emby Integration
*   Enable Emby.
*   **Emby Server URL**: Your Emby server address (e.g., `http://192.168.1.100:8096`).
*   **Emby API Key**: Generate an API key in Emby Settings → API Keys.
*   **Emby User ID**: The unique ID of the user whose playback you want to track (can be grabbed from the URL when viewing the user profile in Emby dashboard).

#### 🍀 Jellyfin Integration
*   Enable Jellyfin.
*   **Jellyfin Server URL**: Your Jellyfin server address (e.g., `http://192.168.1.100:8096`).
*   **Jellyfin API Key**: Generate an API key in Jellyfin Dashboard → API Keys.
*   **Jellyfin User ID**: The unique ID of your user (copied from the URL when viewing user options in Jellyfin settings).

#### 🎬 TMDB (Metadata & Posters)
*   **TMDB API Key**: Obtain a free API key from [TheMovieDB](https://www.themoviedb.org/documentation/api) and paste it here. This enables search capability on the dashboard, rich cast lists, and poster fallbacks.

#### 🎨 Fanart.tv (Artwork Fallback)
*   Plembfin includes a built-in project key for [Fanart.tv](https://fanart.tv) — no setup is required. Fanart.tv is queried in parallel with TMDB as a fallback source for posters, backdrops, and transparent logo art.
*   **Personal API Key (optional)**: Register at fanart.tv and enter your personal key under **Settings → API Keys → Fanart.tv** to get higher rate limits and access to your own uploaded artwork.

#### 🔍 Seerr (Request Manager)
*   **Seerr Server URL**: Your Overseerr or Jellyseerr server URL (e.g., `http://192.168.1.100:5055`).
*   **Seerr API Key**: Copy the API key from your Seerr Settings → General.

---

## ⚡ Webhook Setup (Critical for Live Sync)

Playback events are sent to Plembfin via webhooks. Each webhook URL contains a secret token for authentication — copy the full URL from **Settings → General → API Endpoints** after signing in. It will look like:

```
http://<YOUR_HOST>:5055/api/webhook?token=<your-secret>
```

> [!IMPORTANT]
> Always use the full URL including the `?token=` parameter. If you rotate the secret via the **Rotate Secret** button, update the URL in every media server.

### Media Server Settings

#### 1. Plex Webhook Setup
1.  Navigate to Plex Web → **Account Settings → Webhooks**.
2.  Click **Add Webhook**.
3.  Paste the full webhook URL (with `?token=`) from **Settings → General → API Endpoints**.
4.  Enable events: `media.play`, `media.resume`, `media.pause`, `media.stop`, `media.scrobble`.
5.  Save changes.

> **Unwatched sync:** Plex native webhooks cannot send unscrobble events. Plembfin includes a built-in Plex notification listener that connects automatically via WebSocket using your configured Plex URL and token — no external script required.

#### 2. Emby Webhook Setup
1.  Go to Emby Server Settings → **Webhooks** and add a new webhook.
2.  Set the URL to the full webhook URL (with `?token=`) from **Settings → General → API Endpoints**.
3.  Under **Events → Playback**, check: `Start`, `Pause`, `Unpause`, `Stop`.
4.  Under **Events → Users**, check: `Mark Played`, `Mark Unplayed`.
5.  Enable **Send All Properties** so payloads include position data for resume sync.

#### 3. Jellyfin Webhook Setup
1.  Install the **Webhooks** plugin from the Jellyfin Plugin Catalog.
2.  Add a new **Generic Webhook** named `plembfin`.
3.  Set the URL to the full webhook URL (with `?token=`) from **Settings → General → API Endpoints**.
4.  Under **Notification Type**, check: `Playback Start`, `Playback Progress`, `Playback Stop`, `User Data Saved`.
5.  Under **Item Type**, select: `Movies`, `Episodes`.
6.  Check **Send All Properties (ignores template)** and save.

---

## 💾 Backup & Restore System

Plembfin runs an automated daily backup at a customizable time. Backups store your entire database state (watch histories, resume markers, settings, and cached poster references).

### Supported Destinations

*   📁 **Local**: Backups are written to `data/backups/watch-history` on the server running Plembfin. Configure the daily time and how many copies to retain under **Settings → Backups → Automatic Local Backups**.
*   ☁️ **Backblaze B2**: Mirror each backup to a private B2 bucket. Enter Region (e.g. `us-west-004`), Bucket Name, keyID, and Application Key under **Settings → Backups → Automatic Remote Backups**. Backblaze offers a free 10 GB tier.

---

## 📦 Backfills & Imports

### Trakt Watch History Import
1. Download a JSON watch history export of your Trakt profile.
2. Go to **Settings → Tools** in Plembfin, upload the JSON, and start the import.
3. Once completed, click **Full Sync Watchstates** to propagate the Trakt watch history to all connected Plex, Emby, and Jellyfin servers.

---

## ⚙️ Configuration Reference

The following environment variables can be set in your system or defined in `docker-compose.yml`:

| Environment Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `5055` | The network port the web interface and API will listen on. |
| `DATA_DIR` | `./data` | Directory for the SQLite database (`plembfin.db`), configs, and cached posters. |
| `ADMIN_USERNAME` | `admin` | Default administrator username for fresh setups. |
| `ADMIN_PASSWORD` | `admin` | Default administrator password for fresh setups. |
| `API_KEY` | _generated_ | Security token used to authorize incoming webhooks and API calls. |
| `WEBHOOK_SECRET` | _generated_ | Secret token embedded in the webhook URL (`?token=`). Rotatable independently of the API key. |
| `SESSION_SECRET` | _generated_ | Signing secret for the dashboard session cookie. |
| `COOKIE_SECURE` | `false` | Set to `true` when the app is served behind an HTTPS reverse proxy — enables `Secure` cookie flag and `Strict-Transport-Security` header. |
| `FANART_API_KEY` | _none_ | Optional personal Fanart.tv API key for higher rate limits. A built-in project key is used when this is unset. |

---

## 🛠️ Architecture & Under the Hood

Plembfin runs as a single-process Node application:
*   **Web Server**: Powered by Express (`server/server.js`), static-serving the SPA interface (`public/`) and poster binaries (`data/media`).
*   **Manual Router**: A lightweight dispatcher routing API endpoints to specific controllers.
*   **Database**: Uses `better-sqlite3` in WAL mode for rapid reading/writing and locks safety.
*   **Scheduler**: Runs in-process on a `setInterval` timer (no crontab required). It executes once per minute to reconcile active play states, check sync queues, and perform nightly backups.
*   **Pre-push build check**: Before code is deployed or pushed, `npm run build` is run automatically. This checks JavaScript syntax and boots the server temporarily in a clean directory on port 0 to verify startup health.

---

## 🧑‍💻 Development Workflow

### Running locally
```bash
npm install      # install dependencies
npm run dev      # start with auto-reload on http://localhost:5055
```

---

## 📜 License

Plembfin is private software. See the [changelog.json](changelog.json) for the version history and commit logs.

---

## 🙏 Thank You

Plembfin uses the following third-party services for artwork and metadata — thank you to the people and communities that make them possible:

*   **[The Movie Database (TMDB)](https://www.themoviedb.org)** — The primary source for movie and TV show metadata, posters, backdrops, cast information, and logo art. This product uses the TMDB API but is not endorsed or certified by TMDB.
*   **[Fanart.tv](https://fanart.tv)** — Community-driven source of high-quality poster art, backdrop images, and transparent logo art used as a fallback when TMDB images are unavailable. Thank you to all the fanart.tv contributors who upload and curate artwork.

