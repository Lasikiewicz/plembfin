# Emby Integration

How Plembfin talks to Emby: webhooks in, API calls out, plus scheduled catch-up
polling. Read [architecture.md](architecture.md) first for the big picture.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/embyClient.js` | Outbound HTTP client — all Emby API calls |
| `server/src/utils/parsers.js` | `parseEmbyWebhook` — webhook normalization |
| `server/src/scheduled.js` | `syncRecentlyWatchedFromEmby`, `syncRecentlyResumableFromEmby` — catch-up polling |
| `server/src/utils/liveSessions.js` | Polls `/Sessions` for Now Playing |
| `public/modules/help-content.js` | `embyCredentialGuide()`, `embyWebhookSetup()` — in-app setup guides |

## Configuration

Settings → Apps → Emby needs three values (stored in the `settings` SQLite row; env
vars `EMBY_SERVER_URL` / `EMBY_API_KEY` / `EMBY_USER_ID` act as defaults):

- **baseUrl** — reachable *from the Plembfin server machine*
- **apiKey** — an Emby API key (Dashboard → Advanced → API Keys)
- **userId** — the Emby user whose watch state is tracked and written

All three are required when Emby is enabled (`validateConfig`). Requests authenticate
with the `X-Emby-Token` header.

## Inbound: webhooks

Emby posts JSON to `/api/webhook?token=<webhookSecret>`. **Enable "Send All
Properties" on the Emby webhook** — without the full item payload, events can arrive
without enough title/type/progress data to record a watch.

`parseEmbyWebhook` (`parsers.js`) derives the phase:

- `playback.start` / `playback.unpause` / `playback.progress` / `playback.pause` → `active`
- `item.markplayed`, or a userdata-saved event with `Played=true` → `completed`
- `item.markunplayed`, or `Played=false` → `unplayed`
- `playback.stop` → `completed` if progress ≥ 90%, else `ended`

Unlike Plex, Emby **does** send mark-unplayed events, so unwatch propagation works
purely through the webhook — no extra listener is needed.

## Inbound: scheduler polling

Every minute `fetchLiveSessions` polls `/Sessions` for Now Playing. The catch-up sync
(every 15 minutes by default) pulls:

- **Recently watched** — `fetchEmbyWatchedItems` (user's items filtered to
  `IsPlayed`, ordered by play date) → `syncRecentlyWatchedFromEmby` records watches
  whose webhooks were missed.
- **Resumable items** — `fetchEmbyResumableItems` (`/Users/<id>/Items/Resume`) →
  `syncRecentlyResumableFromEmby` replicates resume positions to the other platforms.

Playback positions use Emby's tick units (1 tick = 100 ns); `scheduled.js` converts
with `ticksToMilliseconds`.

## Outbound operations (`embyClient.js`)

| Function | What it does |
| --- | --- |
| `findEmbyItems` | Locates library items by provider ID (`AnyProviderIdEquals` with `imdb.` / `tmdb.` / `tvdb.` terms), falling back to title/year search; episodes resolved through the series |
| `markEmbyPlayed` / `markEmbyUnplayed` | `POST` / `DELETE` on `/Users/<userId>/PlayedItems/<itemId>` |
| `setEmbyProgress` | Writes a resume position via the item's UserData |
| `markEmbyUnplayedById` | Unplay by item ID (used by unwatch propagation) |
| `fetchEmbySeriesEpisodes` / `fetchEmbyEpisodes` | Episode lists for season-level operations |
| `fetchEmbyWatchedItems` / `fetchEmbyResumableItems` | Feeds for catch-up sync |

A `not_found` result is reported as "skipped — no matching item" in sync telemetry:
the item isn't in Emby's library, which is normal for non-mirrored libraries.

## Artwork

Emby poster URLs are built from `/Items/<id>/Images/Primary` with the image tag
(`embyLikePosterUrl` in `liveSessions.js`, `configuredImageUrl` in
`public/modules/images.js`). The server-side poster pipeline caches a resized local
copy — see [posters-artwork.md](posters-artwork.md).
