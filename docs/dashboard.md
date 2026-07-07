# Dashboard

The home view (`/`): Now Playing, the recent-history rows, and the part-watched
("continue watching") rail.

## Files

| File | Role |
| --- | --- |
| `public/modules/dashboard.js` | All dashboard rendering (`renderDashboard`, `renderHistoryCard`, `renderPartWatched`, dedupe helpers, poster observer) |
| `public/modules/sync.js` | Now Playing polling + rendering (`loadActiveSessions`, `renderActiveSessions`, `startHistoryPolling`) |
| `public/modules/timeline.js` | Browser-side direct probe of media-server session endpoints |
| `server/src/index.js` | `handleNowPlaying`, `handleHistory` (`?limit=` preview), `handlePlaybackProgressList` |
| `public/app.js` | Route `/` → dashboard view; history preview loading + localStorage cache |

## Sections

### Now Playing

Fully documented in [now-playing.md](now-playing.md) — the merge of
`live_tracking_cache` (scheduler polling) and `active_sessions` (webhook `active`
events), polled by the browser every 10 seconds with visibility gating, plus the
browser-side LAN probe (`fetchLocalActiveSessions`). When nothing is playing the poll
interval backs off to 2 minutes (`NOW_PLAYING_EMPTY_POLL_MS`).

### Recent history

`GET /api/history` (preview limit 120) rendered as either **cards** or **posters**
(toggle persisted in `plembfin:dashboardHistoryView`), filtered all/movies/shows, fit
to two rows of whatever the viewport holds (`getRowFitLimit`,
`updateDashboardSplitState` re-fits on resize). Same-day duplicate rows are collapsed
(`dedupeMediaRecords`) so webhook echoes don't crowd the rail. The rendered payload is
cached in localStorage (`plembfin:dashboardHistory:v1`, 24h TTL) for instant paint on
reload; the `X-Now-Playing-Refresh` header from the now-playing poll signals when to
re-fetch.

Each card shows poster, platform badge, sync-status pill, and links into the media
detail page ([media-detail.md](media-detail.md)).

### Part-watched (continue watching)

`GET /api/playback-progress` lists resume records (`playback_progress` table).
`loadPartWatched` / `renderPartWatched` render them as progress-bar cards, deduped by
media identity (`dedupePlaybackProgress`). Actions: mark watched
(`POST /api/playback-progress/watch`) and dismiss/mark unwatched
(`POST /api/playback-progress/unwatch`).

### Version badge / update check

The sidebar version badge is populated from `/api/changelog` on dashboard load; see
the "Changelog & update check" section of [architecture.md](architecture.md).

## Posters

Dashboard posters use the standard fallback → `/api/poster` hydration pipeline with a
dedicated IntersectionObserver (`observeDashboardPosters`) so only visible cards
trigger lookups. See [posters-artwork.md](posters-artwork.md).

## Gotchas

- The dashboard is the **only** view where Now Playing polls; `pollNowPlayingOnce`
  bails when `document.hidden` or when the active view isn't the dashboard.
- Mobile (≤ 760px) must be re-verified after any dashboard layout change — the split
  state and row-fit logic have broken on mobile after desktop-only redesigns before.
