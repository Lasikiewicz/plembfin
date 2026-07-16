# Jellyfin Integration

How Plembfin talks to Jellyfin: webhooks in, API calls out, plus scheduled catch-up
polling. Jellyfin's integration is structurally the same as Emby's (Jellyfin is an Emby
fork and keeps most of the API surface) with a few differences noted below. Read
[architecture.md](architecture.md) first for the big picture.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/jellyfinClient.js` | Outbound HTTP client — all Jellyfin API calls |
| `server/src/utils/parsers.js` | `parseJellyfinWebhook` — webhook normalization |
| `server/src/scheduled.js` | `syncRecentlyWatchedFromJellyfin`, `syncRecentlyResumableFromJellyfin` — catch-up polling |
| `server/src/utils/liveSessions.js` | Polls `/Sessions` for Now Playing |
| `public/modules/help-content.js` | `jellyfinCredentialGuide()`, `jellyfinWebhookSetup()` — in-app setup guides |

## Configuration

Settings → Connections → Jellyfin needs three values (stored in the `settings` SQLite row; env
vars `JELLYFIN_SERVER_URL` / `JELLYFIN_API_KEY` / `JELLYFIN_USER_ID` act as defaults):

- **baseUrl** — reachable *from the Plembfin server machine*
- **apiKey** — a Jellyfin API key (Dashboard → API Keys)
- **userId** — the Jellyfin user whose watch state is tracked and written

All three are required when Jellyfin is enabled (`validateConfig`). Requests send both
`X-Emby-Token` and `X-MediaBrowser-Token` headers so every Jellyfin version accepts
them.

## Inbound: webhooks

Jellyfin needs the **Webhook plugin** installed; it posts JSON to
`/api/webhook?token=<webhookSecret>`. `parseJellyfinWebhook` (`parsers.js`) derives the
phase:

- `PlaybackStart` / `PlaybackProgress` / `PlaybackPause` → `active`
- Mark-played events, or userdata saved with `Played=true` → `completed`
- Mark-unplayed events, or `Played=false` → `unplayed`
- `PlaybackStop` → `completed` if progress ≥ 90%, else `ended`

Jellyfin sends mark-unplayed events, so unwatch propagation works purely through the
webhook. The in-app guide (`jellyfinWebhookSetup()` in `help-content.js`) documents
which notification types to enable in the plugin.

## Inbound: scheduler polling

Every minute `fetchLiveSessions` polls `/Sessions` for Now Playing. The catch-up sync
(every 15 minutes by default) pulls:

- **Recently watched** — `fetchJellyfinWatchedItems` → `syncRecentlyWatchedFromJellyfin`
  records watches whose webhooks were missed.
- **Resumable items** — `fetchJellyfinResumableItems` (`/Users/<id>/Items/Resume`) →
  `syncRecentlyResumableFromJellyfin` replicates resume positions. Episode rows include
  series provider IDs so cross-server lookup can resolve the series before selecting
  the matching season and episode.

Playback positions use tick units (1 tick = 100 ns), converted in `scheduled.js`.

## Outbound operations (`jellyfinClient.js`)

| Function | What it does |
| --- | --- |
| `findJellyfinItems` | Locates library items by provider ID (`AnyProviderIdEquals`), falling back to title/year search; episodes resolved through the series |
| `markJellyfinPlayed` / `markJellyfinUnplayed` | `POST` / `DELETE` on `/Users/<userId>/PlayedItems/<itemId>` |
| `setJellyfinProgress` | Writes a resume position via the item's UserData |
| `markJellyfinUnplayedById` | Unplay by item ID (used by unwatch propagation) |
| `fetchJellyfinSeriesEpisodes` / `fetchJellyfinEpisodes` | Episode lists for season-level operations |
| `fetchJellyfinWatchedItems` / `fetchJellyfinResumableItems` | Feeds for catch-up sync |

A `not_found` result is reported as "skipped — no matching item" in sync telemetry:
the item isn't in Jellyfin's library.

## Artwork

Jellyfin poster URLs use the same `/Items/<id>/Images/Primary` shape as Emby
(`embyLikePosterUrl` in `liveSessions.js`). The server-side poster pipeline caches a
resized local copy — see [posters-artwork.md](posters-artwork.md).
