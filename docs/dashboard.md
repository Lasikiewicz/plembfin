# Dashboard

The home view (`/`): Now Playing, the recent-history rows, and the part-watched
("continue watching") rail.

## Files

| File | Role |
| --- | --- |
| `public/modules/dashboard.js` | All dashboard rendering (`renderDashboard`, `renderHistoryCard`, `renderPartWatched`, dedupe helpers, poster observer) |
| `public/modules/sync.js` | Now Playing polling + rendering (`loadActiveSessions`, `renderActiveSessions`, `startHistoryPolling`) |
| `server/src/index.js` | `handleNowPlaying`, `handleHistory` (`?limit=` preview), `handlePlaybackProgressList` |
| `public/app.js` | Route `/` -> dashboard view; history preview loading + localStorage cache |

## Sections

### Now Playing

Fully documented in [now-playing.md](now-playing.md): the merge of
`live_tracking_cache` (scheduler polling) and `active_sessions` (webhook `active`
events), polled by the browser every 10 seconds with visibility gating.
The episode label and playback progress use the active appearance accent, matching
Part Watched, while the green Live indicator remains a semantic playback-status color.

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
detail page ([media-detail.md](media-detail.md)). When an item has more than one
recorded watch, a second line below "Last Played" reads "Watched Twice" (or "Watched N
Times" for more) - `actualWatchLabel` in `dashboard.js`, driven by the same watch-count
figure (`watch_count`, falling back to `playHistory.length`) as the movie detail page's
rewatch history.

### Part-watched (continue watching)

`GET /api/playback-progress` lists resume records (`playback_progress` table).
`loadPartWatched` / `renderPartWatched` render them as progress-bar cards, deduped by
media identity (`dedupePlaybackProgress`). Actions: mark watched
(`POST /api/playback-progress/watch`) and dismiss/mark unwatched
(`POST /api/playback-progress/unwatch`). Each App Used badge opens the matching item
in that configured media app when the item exists there.

The displayed percentage is derived from the saved playback position and duration when
both are available, so an incomplete percentage field from a webhook cannot show `0%`
for an item with real resume progress. The Now Playing refresh token also invalidates and
reloads this rail, keeping it aligned with playback changes without a full page reload.
Replacing its cards with a loading or empty state also invalidates the rendered-markup
memo, so an unchanged refresh result always restores the cards instead of leaving the
loading message visible.

### Version badge / update check

The sidebar version badge is populated from `/api/changelog` on dashboard load; see
the "Changelog & update check" section of [architecture.md](architecture.md).

### Background sync indicator

A sync line sits above the version badge on every page. It reads "Sync - Idle" when
nothing is being dispatched and "Sync - N of M" while Plembfin is actively pushing
watch-state changes out to Plex/Emby/Jellyfin/Trakt - the scheduler's pending-dispatch
queue working through a backlog, a bulk duplicate-watch cleanup, a manual
watch/unwatch, anything. The indicator is driven by the `sync-progress` events on the
`GET /api/live-updates` SSE stream (`onSyncProgress` in `live-updates.js`, rendered by
`renderSyncProgress` in `app.js`); see the "Manual dispatch queue" part of
[scheduled-sync.md](scheduled-sync.md#what-it-does-each-run) for where the underlying
`{ total, completed }` snapshot comes from.

Active dispatch bursts publish a heartbeat every 15 seconds. An incomplete snapshot
whose heartbeat is more than 90 seconds old is treated as orphaned and reset to Idle;
every live-update connection receives the current value, including an explicit zero,
so a browser cannot retain stale progress after a server restart.

Clicking the line opens the Sync Activity page at `/sync-activity`.

### Sync Activity page

`/sync-activity` (`public/modules/sync-activity.js`) lists what Plembfin has synced,
one row per media item, newest first, backed by `GET /api/sync-history`. The same
Idle / N of M status appears at the top of the page, and the page reloads itself every
15 seconds while it is the visible view so a running sync fills in as it goes.

Each row shows the title, media type, source, action (Marked Watched, Marked Unwatched,
or Resume Progress), timestamp, a "From <source> -> To <targets>" route line naming the
app that reported the play and the apps it was dispatched to, one result per target as
that app's icon followed by its status (hover for the failure detail), and the overall
status. Failed rows carry a red edge and pending ones a yellow edge.

Sync Activity resolves platform names itself (`activityPlatform`) rather than through
`normalizePlatformSource`, which knows only the three media servers and folds anything
else into Plex. That is what lets a Trakt dispatch appear as Trakt, with its own icon,
alongside Plex, Emby, Jellyfin, and Plembfin's own manual actions.

Clicking a title opens that media's page: its local page when the record matches
something in the library, the TMDB or TVDB route when the dispatch carried those ids,
and a search for the title when it carried neither. Clicking anywhere else on a row
expands it to show that item's full log inline; a background refresh reopens rows that
were already expanded.

The "Download log" button sits on the same line as the target results and saves that
single item's record as a plain-text `.log` file: title, media type, action, status,
local and ISO timestamps, record id, the source it came from, the targets it went to,
the details string, every target result with its detail, and the raw payload debug JSON
when the record has one.

## Posters

Dashboard posters use the standard fallback -> `/api/poster` hydration pipeline with a
dedicated IntersectionObserver (`observeDashboardPosters`) so only visible cards
trigger lookups. See [posters-artwork.md](posters-artwork.md).

## Gotchas

- The dashboard is the **only** view where Now Playing polls; `pollNowPlayingOnce`
  bails when `document.hidden` or when the active view isn't the dashboard.
- Mobile (<= 760px) must be re-verified after any dashboard layout change: the split
  state and row-fit logic have broken on mobile after desktop-only redesigns before.
