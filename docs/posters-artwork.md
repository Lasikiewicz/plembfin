# Posters & Artwork Pipeline

How every poster, backdrop, logo, and profile photo in the app gets fetched, resized,
cached, and rendered. This pipeline exists so the browser never loads images directly
from media servers (mixed content, LAN-only addresses, tokens in URLs) and so remote
artwork is fetched once, not per page view.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/posterCache.js` | Fetch → sharp resize → store in `data/media/` → record in `poster_cache` |
| `server/src/index.js` | `handlePoster` (`GET /api/poster`) — candidate resolution; `handleTmdbPoster` / `handleTmdbProfile` proxies |
| `server/src/utils/tmdbClient.js` | TMDB poster-URL fallback lookup |
| `public/modules/images.js` | Frontend: `posterMarkup`, fallback hydration, lookup caching, TMDB URL builders |
| `server/server.js` | Static mount `/media` → `data/media/` (365-day immutable cache headers) |

## Backend: `GET /api/poster?id=<id>&variant=<poster|backdrop>`

`handlePoster` resolves `id` in this order: **watch record id → `media_key` →
`playback_progress` row → live session** (`findLiveSessionPosterRow` matches
`live_tracking_cache` / `active_sessions` — this is what lets a currently-playing item
that has never been watched still get a poster; see
[now-playing.md](now-playing.md)).

For the resolved row it tries candidates in order:

1. the stored `poster_url` on the row (which may already be a cached `/media/...` URL)
2. the configured media server's image endpoint (Plex thumb path / Emby / Jellyfin
   `Items/<id>/Images/Primary`)
3. TMDB fallback (`fetchPosterFromTmdb`)

The first candidate that downloads successfully goes through `cacheArtworkFromUrl`
(`posterCache.js`):

- Plex tokens are stripped from the URL and sent as an `X-Plex-Token` header
- body limits (10 MB), content-type checks, 12s timeout
- resized with **sharp** to webp — poster 340w/q80, backdrop 1600w/q82, profile
  780w/q82, logo 800w/q90 (falls back to the original bytes if sharp fails)
- written to `data/media/posters|backdrops|profiles|logos/<sha1>.webp` and served at
  `/media/...`
- metadata recorded in the `poster_cache` table keyed by
  sha1(`mediaKey[:variant]`)

**Negative caching:** failures are recorded as `failed` (retry after 24h) or `missing`
(retry after 7 days) so a dead lookup doesn't hammer upstream on every page view.
HTTP 429/503 are treated as transient and not persisted. `usableCachedPoster` only
trusts a `cached` row whose file still exists on disk.

The cache key is the **mediaKey** (canonical title + type + IDs), so a live session, a
history row, and a playstate row for the same item share one cached image.

## Frontend (`public/modules/images.js`)

- `posterMarkup(item)` renders an `<img>` when a usable URL is known, otherwise a
  `poster-fallback` span carrying a `data-poster-id`.
- `hydratePosterFallbacks(container)` finds fallback spans and calls
  `lookupPosterUrl(posterId)` → `GET /api/poster` — deduped in-flight
  (`state.posterLookupInflight`), cached in memory (`state.posterLookupCache`) and in
  localStorage so revisits skip the API entirely
  (`clearPersistentPosterLookupCache` resets it).
- Explorer/dashboard views gate hydration behind IntersectionObservers so only visible
  cards trigger lookups.
- `bindPosterImageErrorHandler` swaps a broken `<img>` back to the fallback path.
- `configuredImageUrl` builds direct media-server image URLs for contexts where the
  server URL is known and same-origin rules allow it (the CSP `img-src` is extended at
  runtime with configured server origins — see [architecture.md](architecture.md)).
- **`isCachedStorageImageUrl()` returns `true` only for `/media/posters/` and
  `/media/backdrops/` URLs. TMDB `image.tmdb.org` URLs are NOT treated as cached.**
  Code that decides whether artwork still needs caching must use this helper.

## Custom artwork

Media detail pages let the user pick artwork from TMDB/TVDB/Fanart galleries
(`edit-dialogs.js` → `openEditImageDialog`, endpoints `GET /api/tmdb-images`,
`/api/tvdb-images`, `/api/fanart-images`). The selection is stored per watch row
(`poster_url`, `logo_url`, `backdrop_url` columns) via `POST /api/update-watch`, cached
locally through the same pipeline, and TV shows inherit the first available artwork
from their episode rows. Data-URL uploads are also accepted and persisted through
`cacheArtworkFromUrl`.

## Profile photos

Cast profile images go through `GET /api/tmdb-profile` (rate-limited, cached under the
`profiles/` variant) — same pipeline, `profile` variant.

## Troubleshooting

Missing/wrong posters: see the poster section of
[troubleshooting.md](troubleshooting.md). Useful checks: the `poster_cache` row for the
mediaKey (`status`, `detail`, `original_url`), whether the file exists under
`data/media/`, and whether the negative-cache TTL is suppressing retries.
