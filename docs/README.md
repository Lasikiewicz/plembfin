# Plembfin Documentation

Reference docs for how Plembfin works under the hood. These exist so that when
something breaks — or when an AI agent is asked to change something — you can be
pointed at the relevant file instead of re-deriving the architecture from the source.

> **Start with [architecture.md](architecture.md).** It is the master guide: the big
> picture, a complete map of every file in the repository, and a task router that
> points to the right feature doc for whatever you're changing.

## Map

### Core

| Doc | Read it when… |
| --- | --- |
| [architecture.md](architecture.md) | **Always read first.** Big picture, full file map, task router, request flow, env vars. |
| [frontend.md](frontend.md) | Working on the SPA: routing, state, module layout, data-loading conventions. |
| [sqlite-schema.md](sqlite-schema.md) | Reading the database directly and need to know what a table or field means. |
| [development.md](development.md) | Build check, git hooks, CI workflows, Docker, the release/changelog pipeline. |
| [troubleshooting.md](troubleshooting.md) | Symptom-first index: "X is broken → look here." Start here if you don't know which doc you need. |

### Sync engine

| Doc | Read it when… |
| --- | --- |
| [webhooks.md](webhooks.md) | A watched/unwatched event didn't record or didn't propagate; webhook phases and auth. |
| [scheduled-sync.md](scheduled-sync.md) | The every-minute in-process background worker: catch-up sync and live-session polling. |
| [now-playing.md](now-playing.md) | "Now Playing" is wrong, empty, or stale. **This is the one that bit us before.** |

### Platform integrations

| Doc | Read it when… |
| --- | --- |
| [plex.md](plex.md) | Anything Plex: client, webhook parsing, the WebSocket unwatch listener, account resolution. |
| [emby.md](emby.md) | Anything Emby: client, webhook parsing, catch-up polling. |
| [jellyfin.md](jellyfin.md) | Anything Jellyfin: client, webhook plugin, catch-up polling. |
| [metadata.md](metadata.md) | TMDB/TVDB/Fanart/OMDb/YouTube: who provides what, API keys, cache tables and TTLs. |

### Pages & features

| Doc | Read it when… |
| --- | --- |
| [dashboard.md](dashboard.md) | The home view: Now Playing, recent history rows, part-watched rail. |
| [movies.md](movies.md) | The Movies library page. |
| [tv-shows.md](tv-shows.md) | The TV Shows library page: progress, next-airing, show identity tools. |
| [upcoming.md](upcoming.md) | The Upcoming page: month calendar, search, and future episode air dates. |
| [media-detail.md](media-detail.md) | Movie/show/person detail pages: metadata, watch actions, Seerr, edit dialogs. |
| [history-search.md](history-search.md) | The History page and global Search. |
| [stats.md](stats.md) | The Stats page and its report payload. |
| [posters-artwork.md](posters-artwork.md) | Posters, backdrops, logos: the fetch-resize-cache pipeline end to end. |
| [settings.md](settings.md) | Settings task routes, overview status, connection config persistence, maintenance tools, and in-app help. |
| [backups.md](backups.md) | All three backup subsystems and the remote destination adapters. |
| [watch-history-backups.md](watch-history-backups.md) | The original design/delivery plan for the watch-history backup subsystem. |

### Security

| Doc | Read it when… |
| --- | --- |
| [auth.md](auth.md) | Login, sessions, API key, webhook secret, audit log. |
| [hardening.md](hardening.md) | Production checklist: credentials, HTTPS/reverse-proxy, Docker hardening, secret rotation. |
| [security-checklist.md](security-checklist.md) | The completed 2026-06 security remediation checklist (what was fixed and where). |

`screenshots/` holds the images embedded in the root README.

## The most important mental model

This is a **single-process, self-hosted Node.js application**. There are no separate
runtimes, no cloud functions, no external databases, and no background services.
Everything — the web UI, the API, and the per-minute scheduler — runs in one
`node server/server.js` process, backed by a local SQLite file at `data/plembfin.db`.

Data written to the database is always in the same file regardless of where you run
the app. There is no "works locally but not in production" because there is no
separate production environment — you run the binary directly, or in a container
via `docker compose up`.

Common gotchas:
1. **Media server reachability** — Plembfin contacts Plex/Emby/Jellyfin from the
   machine it runs on, not from the browser. A URL that the browser can reach but
   the server cannot (e.g. a different LAN segment or a VPN-gated address) will
   fail silently for the background sync while appearing fine in the UI probe.
2. **Webhook secret in URL** — The webhook endpoint requires `?token=<webhookSecret>`
   in the URL. Omitting it returns 401. Copy the full URL from Settings → Connections → Webhooks.
3. **Config persistence** — Credentials and settings are stored in `data/config.json`
   (generated on first boot) and in the `settings` SQLite row. The Docker volume mount
   at `/data` must be persistent across container restarts or settings will reset.
