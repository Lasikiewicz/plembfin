# Dashboard

The home view (`/`): Now Playing, one mixed Up Next rail, and Watch History with separate
TV-show and movie rows. Part Watched ("continue watching") belongs in Up Next; the recent
history rows contain completed watches only.

## Files

| File | Role |
| --- | --- |
| `public/modules/dashboard.js` | Dashboard rendering (`renderDashboard`, completed-history rows, mixed Up Next cards, compatibility progress-card renderer, dedupe helpers, poster observer) |
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

The dashboard's Up Next section is a single mixed queue of movies and TV episodes.
`GET /api/up-next` combines actionable canonical resume progress with released `next_up`
episodes from provider observations and a local cache-backed fallback. A local fallback episode
is included only when an active provider observation confirms that exact show and season/episode
coordinate exists in a connected media-server library; local history and metadata alone do not
create a Watch now card. Resume cards always come first and are ordered by authoritative
progress-update time; next-up cards follow in a stable show/season/episode order. A matching
resume and next-up observation becomes one resume card. The builder is bounded to the most
recently active shows and a small number of candidate seasons, and reads TMDB/TVDB metadata
only from SQLite. Missing or stale metadata is queued by library-added/provider-feed discovery
and refreshed by the single background warm-up worker, so a dashboard render cannot create an
outbound provider burst. Canonical local resume cards remain usable without a provider
connection.

The browser hydrates the rail from the 24-hour `plembfin:upNextCache:v4` localStorage
snapshot before requesting the network. The server also keeps the completed mixed snapshot
in `data/up-next-cache.json`, so a restart can serve warm data immediately. Dashboard loads
request `/api/up-next?revalidate=1`: a stale snapshot is returned while one background
rebuild runs, and a changed projection advances the `up_next` cache generation. The
`/api/live-updates` stream announces that generation with `up-next-version`; history-version
events also refresh Up Next after watched/progress changes. Existing cards remain painted
while a refresh is in flight, then the refreshed snapshot is reconciled into the rail.

Building the projection is synchronous work on the shared event loop, so its cost is a
whole-process cost: while it runs, nothing else is served and no timer fires. That includes
the "background" rebuild, which is background only in the sense that the request does not
wait for its result. Resolving a candidate's playstate therefore normalizes the `playstate`
table once per projection into an alias index (`buildPlaystateIndex` in `upNextService.js`)
rather than re-deriving an identity for every row on every lookup. Keep it that way: the
per-row form ran tens of thousands of times per build, which on a library of a few thousand
rows blocked the process for around a minute per rebuild - long enough to stall every HTTP
request and to expire the 60-second scheduler lease, so the symptom presented as the whole
app freezing rather than as a slow rail.

For the same reason the local-fallback pass reads the episode table once for the whole pass.
`queryShowDetail` reads and dedupes every tracked episode row before narrowing to the show
it was asked about, which is correct for a detail page resolving one show but repeats a
full-table read and dedupe per show when Up Next resolves up to 24 of them. It accepts an
`episodeRows` snapshot for that case, produced once by `loadTrackedEpisodeRows`
(`dataRepo.js`); `groupShowRows` copies every row it keeps, so the shared snapshot is never
mutated by the calls consuming it. Any new caller that resolves many shows in one pass
should hand the same snapshot to each call rather than letting each one re-read.

Resume cards show progress, source badges, app links, Watch now, Mark watched, and Clear
progress. The three-dot menu on all Up Next cards provides Mark watched, Rate, watchlist
actions, Clear progress (for resume items), and Remove from up next (to dismiss the card from
the queue and clear progress across connected servers). Clearing an episode deletes its
positive progress and marks it unwatched, so a refresh moves it below remaining resumes as a
zero-progress next-up card. Clearing a movie removes it from the queue. Mark watched commits
locally first, deletes the resume row, adds completed history, and then dispatches to connected
providers. A failed or partial provider feed keeps the last good observations and displays a
compact source-status message; future episodes remain in the Upcoming view.

Episode cards build series routes only from explicit `show_*` identities. An episode-level
`tmdb_id`, `tvdb_id`, or `imdb_id` is never substituted into a `/tvshow/<provider>/<id>`
route; if the series identity is unavailable, the card uses the title route and keeps the
episode coordinates. Dashboard history cards render from the local payload and cached artwork;
they do not prefetch TMDB or resolve missing posters during the dashboard render (a missing
poster remains a placeholder). Visible detail requests remain isolated and immediate when a
user opens a media page.

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

Episode cards always prefer the episode *name* stored on the watch record
(backfilled to a real name at ingest when a media server only reported a coordinate).
Installations that recorded watches before that ingest behaviour can run
Settings → Tools → Database Repairs → **Restore Missing Episode Names** to fill in the
first stored/cached name for any rows still showing a bare coordinate.

### Watch History and legacy progress compatibility

`GET /api/playback-progress` lists positive resume records from the
`playback_progress` table for compatibility with older embeds and non-dashboard tooling.
The dashboard uses the unified `/api/up-next` response for resume cards and does not make a
separate Part Watched request or prepend resume rows to recent history. Completed TV/movie
rows are limited to canonical watched records. The compatibility `loadPartWatched` /
`renderPartWatched` helpers are available to explicit legacy panels; they are not part of the
current dashboard shell.

The displayed percentage on a resume card is derived from the saved playback position and
duration when both are available, so an incomplete percentage field from a webhook cannot
show `0%` for an item with real resume progress. SSE history/up-next events fetch the
authoritative snapshots in the background; the dashboard reconciles the visible rows and
rail without a full page reload or dashboard-wide rerender.

The legacy Part Watched card reconciler operates per card rather than diffing its
whole panel as one block: when a refresh returns the same set of items in the same order,
it patches only each card's progress bar, "% watched" text, and "Last Played" timestamp
in place (`patchPartWatchedCardProgress`) and never touches the poster `<img>` or rebuilds
the card's DOM node. The mixed Up Next rail uses stable canonical IDs and the same
no-flash refresh behavior; a resume-to-next-up transition is a deliberate membership
and priority change, so it is refreshed from the server instead of being hidden by a
client-side dismissal.

Removing an item from Up Next animates the dismissed tile out of the rail before the
fresh snapshot replaces it: the exit runs in place (`dashboard-card-exit`), and an
overlapping refresh waits for the animation to finish before repainting, so the tile is
never yanked away mid-fade. Items that become watched somewhere else (e.g. completed on
a connected media server or marked watched from a detail page) leave Up Next the same way:
the server projection is authoritative and drops them, and the `/api/live-updates`
`up-next-version`/history events pull the updated snapshot in. The rail never paints the
same episode twice: the merge unifies the same next-up episode even when it is keyed
under two identity sources (a native server series id, e.g. `series:jellyfin:…`, versus
the verified external show id), reuniting them into one card when the show, season/episode,
episode title, and resolved airing year all agree - while a re-release/reboot that shares a
title and coordinate but aired a different year (or is a different episode) stays its own card.

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
one row per movie or show, newest group activity first. `GET /api/sync-activity`
groups the durable `sync_history` events before pagination, so a busy movie cannot
fill a page by itself. The older event-shaped `GET /api/sync-history` endpoint remains
for retry tooling and compatibility. The same Idle / N of M status appears at the top
of the page, and the page reloads itself every 15 seconds while it is visible.

Each group row shows the title, movie/show type, number of recorded events, latest
timestamp/source/action, the latest route and target results, and whether any event in
the group has an issue. A group moves to the top whenever any new checkpoint, watch,
retry, or target result is recorded. Pending groups use "Awaiting dispatch" and
"Waiting for dispatch" rather than presenting missing target results as an error.
Failed groups remain visible as issues even when their newest event succeeded.

Clicking a row loads its latest activity inline. The expanded section contains every
resume checkpoint and every target result for that movie or show, newest first, with a
"Load older events" button for unusually large groups. The event details are fetched
only when opened, so the list stays quick and readable without deleting audit data.

The summary pill above the list ("Showing 1-25 of 26 media groups / 11 with issues on page") is clickable
whenever the current page has at least one failed row: clicking it filters the page down
to failed rows only, and clicking it again (it now reads "Showing failed only") restores
the full page. This filters within the loaded page's rows client-side rather than
querying the server, since a row's failed status can come from a target-level result
that a text search would not reliably match.

Partial, failed, and skipped events with an actionable destination include a Retry
button inside the expanded group. `POST /api/sync-history/retry` reconstructs the media identity from the
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

When an authoritative watch-history restore is blocked, retained media-server projection
failures appear in the Sync - Attention Needed panel grouped by show. A show can be
expanded to reveal its episodes, retried or skipped as a batch, or repaired one item at a
time with a target-specific "Retry on …" action. Each retry runs while the restore fence
remains in place; the fence is released automatically after the last outstanding item is
repaired or skipped. If a failed item no longer has enough saved identity data for a
direct retry, **Fix match** opens the normal local title/provider-ID correction flow and
the retry uses the corrected identity. Items that cannot be repaired can still be
skipped or handled by running the restore again.

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
expands it to show the grouped event list; a background refresh reopens rows that were
already expanded. The `/history` page remains the chronological watch-history view; Sync
Activity is the operational record of what Plembfin attempted and what each destination
reported.

The "Download all logs" button saves every event in the group as one plain-text `.log`
file. Each event includes its title, media type, action, status, local and ISO timestamps,
record id, source, targets, details, target results, and raw payload debug JSON when present.

`sync_history` is deliberately a permanent audit log: it has no age or row-count
retention policy. Pagination and on-demand group detail loading keep responses bounded;
they do not remove old records. Backups retain this audit data with the rest of the
database.

## Posters

Dashboard posters use the standard fallback -> `/api/poster` hydration pipeline with a
dedicated IntersectionObserver (`observeDashboardPosters`) so only visible cards
trigger lookups. Up Next episode cards prefer a cached show poster from the shared artwork
cache or watched history before asking a provider proxy, so a known show keeps its artwork
when a provider feed is unavailable. See [posters-artwork.md](posters-artwork.md).

## Gotchas

- The dashboard is the **only** view where Now Playing polls; `pollNowPlayingOnce`
  bails when `document.hidden` or when the active view isn't the dashboard.
- Mobile (<= 760px) must be re-verified after any dashboard layout change: the split
  state and row-fit logic have broken on mobile after desktop-only redesigns before.
