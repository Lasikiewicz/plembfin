# Plembfin Documentation

Reference docs for how Plembfin works under the hood. These exist so that when
something breaks, you (or Claude) can be pointed at the relevant file instead of
re-deriving the architecture from the source.

> For build/run commands and a high-level architecture summary, see
> [`../CLAUDE.md`](../CLAUDE.md). These docs go deeper on the moving parts that
> have actually caused issues.

## Map

| Doc | Read it when… |
| --- | --- |
| [architecture.md](architecture.md) | You need the big picture: Express server, `dispatch()` router, SQLite data layer, where code lives. |
| [now-playing.md](now-playing.md) | "Now Playing" is wrong, empty, or stale. **This is the one that bit us before.** |
| [webhooks.md](webhooks.md) | A watched/unwatched event didn't record or didn't propagate; understanding webhook phases and auth. |
| [scheduled-sync.md](scheduled-sync.md) | The every-minute in-process background worker: catch-up sync and live-session polling. |
| [watch-history-backups.md](watch-history-backups.md) | Automatic watch-state backups: scheduling, retention, and remote destinations. |
| [sqlite-schema.md](sqlite-schema.md) | You're reading the database directly and need to know what a table or field means. |
| [troubleshooting.md](troubleshooting.md) | Symptom-first index: "X is broken → look here." Start here if you don't know which doc you need. |

## The most important mental model

This is a **single-process, self-hosted Node.js application**. There are no separate
runtimes, no cloud functions, no external databases, and no background services.
Everything — the web UI, the API, and the per-minute scheduler — runs in one
`node server/server.js` process, backed by a local SQLite file at `data/plembfin.db`.

Data written to the database is always in the same file regardless of where you run
the app. There is no emulator/production split and no "works locally but not in
production" because there is no separate production environment — you run the
binary directly, or in a container via `docker compose up`.

Common gotchas:
1. **Media server reachability** — Plembfin contacts Plex/Emby/Jellyfin from the
   machine it runs on, not from the browser. A URL that the browser can reach but
   the server cannot (e.g. a different LAN segment or a VPN-gated address) will
   fail silently for the background sync while appearing fine in the UI probe.
2. **Webhook secret in URL** — The webhook endpoint requires `?token=<webhookSecret>`
   in the URL. Omitting it returns 401. Copy the full URL from Settings → API Endpoints.
3. **Config persistence** — Credentials and settings are stored in `data/config.json`
   (generated on first boot) and in the `settings` SQLite row. The Docker volume mount
   at `/data` must be persistent across container restarts or settings will reset.
