# Plex Integration

How Plembfin talks to Plex: three inbound channels (webhook, WebSocket, polling) and
one outbound client. Read [architecture.md](architecture.md) first for the big picture.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/plexClient.js` | Outbound HTTP client — all Plex API calls |
| `server/src/utils/plexNotificationListener.js` | Real-time WebSocket listener for library watch-state changes |
| `server/src/utils/parsers.js` | `parsePlexWebhook` / `parsePlexGuids` / `buildPlexMediaFromMetadata` — webhook + metadata normalization |
| `server/src/scheduled.js` | `syncRecentlyWatchedFromPlex`, `syncRecentlyResumableFromPlex`, `checkPlexUnwatchedStatus` — catch-up polling |
| `server/src/utils/liveSessions.js` | Polls `/status/sessions` for Now Playing |
| `public/modules/help-content.js` | `plexCredentialGuide()`, `plexWebhookSetup()` — in-app setup guides |

## Configuration

Settings → Media Servers → Plex needs three values (stored in the `settings` SQLite row via
`configStore.js`; env vars `PLEX_SERVER_URL` / `PLEX_TOKEN` / `PLEX_USERNAME` act as
defaults):

- **baseUrl** — reachable *from the Plembfin server machine*, not just the browser
- **token** — an X-Plex-Token
- **username** — which Plex account's watch state to track and write. `admin` or
  `owner` maps to account ID 1; any other name is resolved against `/accounts` and
  memoized (`resolvePlexAccountId` in `plexClient.js`, 10-min TTL, 1-min negative TTL)

`validateConfig` requires all three when Plex is enabled. Test the connection with
Open the Plex card under **Settings → Media Servers** and select **Test**
(`POST /api/test-connection`).

## Auth style

Every Plex HTTP request sends the token as an `X-Plex-Token` **header**
(`plexAuthHeaders`), never a query parameter, so tokens stay out of access logs. The
single exception is the notification WebSocket, whose handshake cannot carry custom
headers — there the token stays in the URL.

## Inbound channel 1: webhooks

Plex webhooks (a Plex Pass feature) POST **multipart form data** to
`/api/webhook?token=<webhookSecret>`. `parsePlexWebhook` (`parsers.js`) reads the
`payload` field and derives the phase:

- `media.play` / `media.resume` / `media.progress` / `media.pause` → `active`
- `media.scrobble` / `user.playrate` → `completed`
- `media.stop` → `completed` at the watched threshold (90% by default), else `ended`

Provider IDs come from `parsePlexGuids`, which understands both modern
(`tmdb://`, `tvdb://`, `imdb://`) and legacy agent (`themoviedb`, `thetvdb`) GUID
formats.

Two Plex-specific caveats (also in [webhooks.md](webhooks.md)):

- Native Plex webhooks fire only on **state changes** — there is no heartbeat. A single
  `media.play` creates an `active_sessions` row that expires after the active-session
  TTL (5 minutes by default) unless
  another event arrives. Continuous "still playing" tracking comes from the scheduler's
  session polling, not from webhooks.
- Plex **never sends unwatched (unscrobble) events**. The WebSocket listener below
  compensates.

## Inbound channel 2: the notification WebSocket

`plexNotificationListener.js` connects to `ws(s)://<plex>/:/websockets/notifications`
and watches `timeline` notifications for movies (type 1) and episodes (type 4) from the
library section. It is pure transport: reconnect with backoff (3s → 60s), debounce per
ratingKey (2.5s), then hand each changed ratingKey to `onLibraryItemChange`.

Reverse proxies in front of Plex (Cloudflare, nginx, Traefik, etc.) commonly drop an idle
WebSocket after a timeout without ever sending a close frame, leaving a "zombie"
connection that looks open but never delivers another message — and since undici's
`WebSocket` only exposes the plain browser surface (no ping/pong control), there's no way
to probe it directly. An idle watchdog checks every 30s and forces a reconnect if no frame
has arrived for 5 minutes, self-healing a silently-dead connection instead of leaving it
stuck indefinitely.

The callback (`handlePlexLibraryItemChange` in `server/src/scheduler.js`) fetches the
item's metadata and checks its actual view state. A watched transition is recorded in
Plembfin history and propagated to Emby/Jellyfin; an unwatched transition runs the same
unwatch propagation as the dashboard action. This channel covers library UI changes
that Plex webhooks do not reliably report, including unwatching. Either transition also
bumps the `nowPlayingRefresh` runtime-state signal (same as the webhook route), which is
what tells any open Plembfin browser tab to refresh — see
[now-playing.md](now-playing.md) for how the frontend consumes that signal.

The listener is started by `server.js` at boot (`startPlexNotificationListener`) and
stopped during graceful shutdown. `probePlexNotificationSocket` runs the same connection
one-shot for the System Integrity Check (`POST /api/test-plex-notifications`), which
proves the full path works — including any reverse proxy's WebSocket upgrade in front of
Plex.

## Inbound channel 3: scheduler polling

Every minute the scheduler (`scheduled.js`) polls `/status/sessions` via
`fetchLiveSessions` for Now Playing and completed-session detection. Every 15 minutes
(configurable via `CATCHUP_SYNC_INTERVAL_MS`) the catch-up sync pulls:

- **Recently watched** (`fetchPlexWatchedItems` → `syncRecentlyWatchedFromPlex`) —
  records watches that never produced a scrobble webhook. History items are filtered to
  the configured username/account ID (`plexHistoryItemMatchesConfiguredUser`).
- **Resumable items** (`fetchPlexResumableItems` → `syncRecentlyResumableFromPlex`) —
  replicates resume positions set on Plex to the other platforms.

Every 6 hours, **unwatched reconciliation** (`checkPlexUnwatchedStatus`) verifies items
Plembfin thinks are watched are still watched on Plex, as a backstop for unwatches
missed while the WebSocket listener was disconnected.

## Outbound operations (`plexClient.js`)

Used by the sync orchestrator and manual watch actions:

| Function | What it does |
| --- | --- |
| `findPlexItem` | Locates a library item by provider GUID (tmdb/tvdb/imdb), falling back to title/year search; episodes resolved through the series' leaves |
| `markPlexPlayed` / `markPlexUnplayed` | `/:/scrobble` and `/:/unscrobble` with the resolved account |
| `setPlexProgress` | `/:/progress` to set a resume position |
| `markPlexUnplayedByRatingKey` | Unscrobble by ratingKey (used by unwatch propagation) |
| `fetchPlexMetadataItem` | `/library/metadata/<ratingKey>` lookup (used by the WebSocket callback) |
| `fetchPlexSeriesEpisodes` | All episodes of a series (season-level operations) |
| `fetchPlexWatchedItems` / `fetchPlexResumableItems` | History and on-deck feeds for catch-up sync |

A `not_found` result from a mark-played call is reported as "skipped — no matching item"
in sync telemetry rather than an error: the item simply isn't in that server's library.

## Artwork

Live-session posters use raw Plex thumb paths (`/library/metadata/.../thumb/...`); the
browser never loads them directly — `/api/poster` fetches them server-side with the
token as a header and caches a resized copy (see [posters-artwork.md](posters-artwork.md)
and the poster section of [now-playing.md](now-playing.md)).

## Import script

`scripts/exportPlexHistory.js` is a standalone one-shot importer that reads a Plex
server's full watch history over its API and posts it to `/api/import` in chunks of 100.
Run it with `PLEX_URL`, `PLEX_TOKEN`, and `API_KEY` env vars set.
