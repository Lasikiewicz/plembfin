# Plembfin Documentation

Reference docs for how Plembfin works under the hood. These exist so that when
something breaks, you (or Claude) can be pointed at the relevant file instead of
re-deriving the architecture from ~7000 lines of `app.js`.

> For build/deploy commands and a high-level architecture summary, see
> [`../CLAUDE.md`](../CLAUDE.md). These docs go deeper on the moving parts that
> have actually caused issues.

## Map

| Doc | Read it when… |
| --- | --- |
| [architecture.md](architecture.md) | You need the big picture: frontend SPA ↔ single Cloud Function, the `dispatch()` router, where code lives. |
| [now-playing.md](now-playing.md) | "Now Playing" is wrong, empty, stale, or works locally but not on the live site. **This is the one that bit us before.** |
| [webhooks.md](webhooks.md) | A watched/unwatched event didn't record or didn't propagate; understanding webhook phases. |
| [scheduled-sync.md](scheduled-sync.md) | The every-minute background worker (`scheduledSync`): catch-up sync and live-session polling. |
| [firestore-collections.md](firestore-collections.md) | You're poking around the Firestore console and need to know what a collection/field means — including the camelCase vs snake_case schema traps. |
| [troubleshooting.md](troubleshooting.md) | Symptom-first index: "X is broken → look here." Start here if you don't know which doc you need. |

## The single most important mental model

There are **two completely separate runtimes** that share the same code but
**not** the same data:

- **Local emulator** (`npm run emulators`) — its own isolated Firestore at
  `localhost:8180`. The browser talks to functions **directly**.
- **Production** (`plembfin.web.app`) — the real Firestore. The browser talks to
  the `api` Cloud Function **through the Firebase Hosting proxy**.

Most "works locally but not live" bugs come from one of these differences:
1. **Different data** — the emulator's Firestore and prod's Firestore are not the
   same database. A collection full of sessions locally can be empty in prod.
2. **The Hosting proxy** — prod traffic goes through Firebase Hosting, which
   **buffers responses** and breaks long-lived streaming (SSE). The emulator does
   not, so streaming silently "works" locally and silently fails in prod. See
   [now-playing.md](now-playing.md#why-it-broke-the-sse-trap).
3. **Network reachability** — the Cloud Function runs in `europe-west2` on
   Google's network and cannot reach `localhost`/LAN media-server URLs. The
   emulator runs on your LAN and can.
