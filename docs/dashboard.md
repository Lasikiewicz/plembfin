# Dashboard

The home view (`/`): Now Playing, an Up Next rail, and Watch History with separate TV-show
and movie rows. Part Watched ("continue watching") lives inside Watch History rather than
as a second standalone dashboard panel.

## Files

| File | Role |
| --- | --- |
| `public/modules/dashboard.js` | Dashboard rendering (`renderDashboard`, `renderHistoryCard`, `renderPartWatched`, media-type grouping, dedupe helpers, poster observer) |
| `public/modules/up-next.js` | Cached Up Next loading/rendering and shared media-card presentation |
| `public/modules/media-card.js` | Shared media-card normalization, navigation, poster, metadata, status, and badge contract |
| `public/modules/sync.js` | Now Playing polling + rendering (`loadActiveSessions`, `renderActiveSessions`, `startHistoryPolling`) |
| `server/src/index.js` | `handleNowPlaying`, `handleHistory` (`?limit=` preview), `handlePlaybackProgressList`, `handleUpNext` |
| `public/app.js` | Route `/` -> dashboard view; history preview loading + localStorage cache |

## Sections

### Now Playing

Fully documented in [now-playing.md](now-playing.md): the merge of
`live_tracking_cache` (scheduler polling) and `active_sessions` (webhook `active`
events), polled by the browser every 10 seconds with visibility gating.
The episode label and playback progress use the active appearance accent, matching
Part Watched, while the green Live indicator remains a semantic playback-status color.

### Up Next

The dashboard's Up Next section occupies the former standalone Part Watched footprint.
`GET /api/up-next` selects at most one deterministic, released, unwatched episode per
tracked show, using the existing watch history, playback progress, TVDB season data, and
TMDB/TVDB caches. A partially watched episode is reserved for Watch History and cannot
appear again in Up Next. The query is bounded to the most recently active shows and a
small number of candidate seasons so a large library cannot create an unbounded metadata
request burst. This is built from Plembfin's local history, so media-server and Trakt
connections are optional.

Cards show the parent show, season/episode, episode title, release state, a direct
show-detail link, and a Mark Watched action that uses the shared watched-date/sync flow.
Missing metadata, a provider failure, or no eligible released episode
leaves the section usable with an explanatory empty/error state; future episodes remain in
the Upcoming view.

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

### Watch History and Part-watched (continue watching)

`GET /api/playback-progress` lists resume records (`playback_progress` table).
`loadPartWatched` / `renderPartWatched` render them as progress-bar cards, deduped by
media identity (`dedupePlaybackProgress`). Actions: mark watched
(`POST /api/playback-progress/watch`) and dismiss/mark unwatched
(`POST /api/playback-progress/unwatch`). Each App Used badge opens the matching item
in that configured media app when the item exists there.

The dashboard places these records inside Watch History and splits them into **TV Shows ·
Part Watched** and **Movies · Part Watched**. The existing completed-history rows remain
below them as **TV Shows** and **Movies**. This keeps a partial episode/movie visible once,
in the correct media-type area, while preserving its progress, source, provenance, Resume,
Mark Watched, Clear Progress, and App Used actions. The full `/history` page keeps its
existing All / Movies / TV Shows filters.

The displayed percentage is derived from the saved playback position and duration when
both are available, so an incomplete percentage field from a webhook cannot show `0%`
for an item with real resume progress. SSE history-version events fetch the authoritative
history and progress snapshots in the background; the dashboard reconciles only its visible
history rows, without a full page reload or dashboard-wide rerender.

`renderPartWatched` and the dashboard history-row reconciler work per card rather than
diffing the whole rail as one block:
if a refresh returns the same set of items in the same order (the common case while
something is actively playing, since the playing item's `updated_at` keeps it sorted
first), it patches only each card's progress bar, "% watched" text, and "Last Played"
timestamp in place (`patchPartWatchedCardProgress`) and never touches the poster `<img>`
or rebuilds the card's DOM node. A full rebuild only happens when the set or order of
items actually changes. A live refresh also leaves existing cards on screen untouched
while it re-fetches rather than clearing the rail to a loading placeholder first, so a
routine progress-only update while something plays never flashes the posters.

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
status. Event details occupy the main column while target results, overall status, and
row actions are grouped in a separate outcome column; that outcome section stacks below
the event details at narrower widths. Pending rows use "Awaiting dispatch" and "Waiting
for dispatch" rather than presenting missing target results as an error. Failed rows
carry a red edge and pending ones a yellow edge.

The summary pill above the list ("Showing 1-25 of 26 / 11 failed on page") is clickable
whenever the current page has at least one failed row: clicking it filters the page down
to failed rows only, and clicking it again (it now reads "Showing failed only") restores
the full page. This filters within the loaded page's rows client-side rather than
querying the server, since a row's failed status can come from a target-level result
that a text search would not reliably match.

Partial, failed, and skipped rows with an actionable destination include a Retry
button. `POST /api/sync-history/retry` reconstructs the media identity from the
activity record (including a fresh Plex metadata lookup when a native rating key is
available) and retries only the failed or skipped destinations. The retried row is
updated in place - a target that now succeeds shows success, a target with nowhere to
dispatch to (no server configured for it) shows skipped rather than a stale error, and a
target that wasn't retried keeps its prior result - so a resolved item actually drops out
of the failed count instead of leaving the old error sitting alongside a new row forever.
The row's prior outcome is folded into its raw debug data before being overwritten, so
what it looked like before the retry isn't lost. A "queued:" row (a watch recorded
locally with no durable activity row of its own yet) is retried the same way, but the
outcome is written back onto the underlying watch record's own telemetry, since that is
what the queued row is rendered from.

The "Retry all failed" button next to Refresh retries every failed or skipped item
across the entire sync history, not just the current page. Clicking it discovers the
real total across every page first and confirms before starting. The retry itself runs
as a background job (`retry_all_sync_activity`, alongside `force_sync` and the metadata
refresh jobs - see [scheduled-sync.md](scheduled-sync.md)), so it keeps running - and
survives navigating away, reloading, or closing the tab - the same way Force Sync does.
`POST /api/sync-history/retry-all` enqueues the job; `GET /api/sync-history/retry-all`
polls its status/log/result, which the button label reflects while it runs. Returning to
the Sync Activity page resumes polling an already-running job automatically.

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
