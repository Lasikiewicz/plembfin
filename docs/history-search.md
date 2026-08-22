# History Page & Search

Two views that live alongside the library pages: the full watch log (`/history`) and
global search (`/search`). Both are implemented in `public/modules/explorer.js`
alongside the Movies/TV grids.

## History page (`/history`)

The complete watch log, newest first, with infinite scroll through the entire SQLite
history.

| File | Role |
| --- | --- |
| `public/modules/explorer.js` | `renderHistoryView`, `loadHistoryView`, `renderHistoryItems`, `observeHistorySentinel`, `resetHistoryView` |
| `server/src/index.js` | `handleHistory` - `GET /api/history?limit=&offset=&search=&mediaType=` |
| `server/src/utils/dataRepo.js` | `queryWatchHistory` (with dedupe), `getCachedHistory` |

Behavior:

- **Paging** - the endpoint returns an explicit `hasMore` flag so the page can
  lazy-load through the full log with an IntersectionObserver sentinel.
- **Dedupe** - raw history collapses duplicates to one entry per movie or show episode
  per calendar day, so same-day webhook echoes don't crowd out genuine later rewatches
  (`dedupe` option in `queryWatchHistory`).
- **View modes** - grid / list / cards (`plembfin:historyView`), filter all/movies/shows
  (`plembfin:historyFilter`), search box (server-side `?search=`), adjustable poster
  width (`applyHistoryPosterWidth`).
- **Row actions** - each entry links to its detail page; sync pills, edit-date, and
  debug modal are available per row (see [media-detail.md](media-detail.md)).

## Clean Duplicate History Rows

Settings → Tools → **Clean Duplicate History Rows** (`POST /api/dedup-history`) permanently
deletes rows from `watch_history`. It first backfills missing IMDb/TMDB/TVDB provider IDs and canonicalizes `media_key` values for title-fallback records matching ID-bearing records. It then groups rows by `media_key` and collapses plays that
fall within `SAME_EVENT_WINDOW_MS` (10 minutes) of each other into one viewing, keeping the
earliest row of each chain. Plays chain together while each is inside the window of the one
before it, so a run of copies arriving over several minutes collapses to a single row.

The window matters: a watch propagated between media servers is written down once per
server, milliseconds to minutes apart and never on the same instant. Requiring an identical
`watched_at` therefore reports almost none of the duplicates that exist. Ten minutes is
shorter than any real playthrough, so no genuine rewatch can fall inside it.

Rows further apart than the window are separate viewings. The tool counts those items and
reports how many it preserved rather than collapsing them, so rewatch history survives the
clean-up. `GET /api/health/sync` reports the same split up front as
`dataQuality.sameEventDuplicateRows` and `dataQuality.rewatchedItems`, computed with the same
rule, so the number of rows the tool would delete and the number of items with genuine
rewatches are both visible before running it. The dashboard, show explorer, and show detail
views use the same retained-event count; marking an already watched item does not create a
second watch.

Episode rows are grouped by show title plus season/episode when cleaning, so
copies with different platform keys (title vs IMDb vs TMDB vs TVDB) are still
recognized as the same event. Movies remain provider-ID-first so films with the
same title are not accidentally merged.

The dashboard's recent-history rail is a separate, smaller consumer of the same
endpoint - see [dashboard.md](dashboard.md).

## Remove Duplicate Watches (library-wide)

Settings → Tools → Database Repairs → **Remove Duplicate Watches** runs the same
keep-the-oldest-date cleanup used by the per-season "Remove duplicate watches" control
(`public/modules/edit-dialogs.js`), but across the whole library instead of one season at
a time. Separate buttons run it for TV episodes and for movies.

| File | Role |
| --- | --- |
| `public/modules/tools-duplicates.js` | `runDuplicateWatchCleanup(mediaType)` - scans, confirms, then cleans up |
| `server/src/routes/media.js` | `handleDuplicateWatchScan` (`GET /api/duplicate-watch-scan?mediaType=`), `handleDuplicateWatchCleanup` (`POST /api/duplicate-watch-cleanup`) |
| `server/src/utils/dataRepo.js` | `dedupeHistory` (with `playHistory`), `deleteWatchDates` |

Unlike the same-event collapse above, this does not use a time window - it groups by
`media_key` (or show title/season/episode for episodes) via `queryWatchHistory`'s existing
dedupe path, and for every movie or episode with more than one recorded watch
(`playHistory.length > 1`), every watch after the oldest is treated as removable. That covers
duplicates a time window would miss: rewatch-import floods, or the kind of wrong-provider-id
Trakt overwrite described in [media-detail.md](media-detail.md). A "recorded watch" here means
a row whose current state actually reads as watched - a row that was itself later explicitly
unwatched is never counted as one of the duplicates to compare or remove, even though it still
appears in the show detail page's play-history list. Conflating the two let a stale unwatched
row sort ahead of a genuine watch and get "kept" while the real watch was deleted as the
supposed duplicate, wrongly unwatching an item that never had a duplicate to begin with.

The button always scans first and shows the real count of duplicate watches and affected
items before asking for confirmation - nothing is deleted until that confirmation is
approved. On confirm, the cleanup runs `deleteWatchDates` in batches of 300 ids, and for each
affected item propagates the corrected canonical state to every connected platform the same
way the per-season cleanup and a manual watch-date deletion already do (see the "Removing a
watch date propagates the correction" behavior in [media-detail.md](media-detail.md)).

## Search page (`/search`)

Global search across the local library, TMDB discovery **and** TVDB, reached from the
topbar search or `/search?q=`.

| File | Role |
| --- | --- |
| `public/modules/explorer.js` | `triggerSearchPage`, `renderSearchPage` |
| `server/src/index.js` | `handleMediaSearch` (`GET /api/media-search`), `handleTmdbSearch` (`GET /api/tmdb-search`), `handleTvdbSearch` (`GET /api/tvdb-search`) |
| `server/src/utils/tmdbGateway.js` | `searchTmdb` with the `tmdb_search_cache` table (15-min TTL) |
| `server/src/utils/tvdbGateway.js` | `searchTvdbSeriesList`, cached in `tvdb_metadata_cache` (7-day TTL for hits, 1 hour for misses) |

Behavior:

- Local results match the watch history/library caches; remote results come from TMDB
  search (debounced - `state.globalSearchRemoteTimer`), merged and de-duplicated with
  local items marked as in-library.
- People use TMDB's dedicated `search/person` endpoint rather than competing with
  movies and shows for the 20 mixed-search result slots. The page initially shows
  the first person page and **Load more people** fetches later pages up to TMDB's
  reported result count.
- TMDB's TV catalogue does not list every series TVDB does, so TVDB is searched in
  parallel with TMDB rather than after it, and its series appear as quickly as any
  other result, marked with a `TVDB` badge. Search result lists from TVDB are cached
  server-side, because the project key's rate pool is shared by every Plembfin install.
- Results from the three sources are merged on a normalised title key (lowercased,
  punctuation collapsed), so a series listed locally, by TMDB and by TVDB appears once.
  TVDB returns series only, so movie and person results are unaffected.
- The topbar dropdown searches TVDB even when no TMDB key is configured, since TVDB
  uses the built-in project key. If TMDB is unavailable, its error notice is shown only
  when TVDB also returned nothing.
- The dropdown collects candidates from every source, then ranks each of its three
  columns by how closely the title answers the query (`searchRelevance` in `app.js`:
  exact title, then prefix, then whole-word, then substring, with in-library titles
  breaking ties) before trimming to five. Ranking after collection rather than capping
  per source is what keeps a close match visible regardless of which catalogue it came
  from. The sort is stable, so equally relevant results keep their collection order and
  the list does not reshuffle between renders.
- A result click opens the standard detail page: in-library items by their local id,
  discovery-only items via the TMDB routes (`/movie/tmdb/:id`, `/tvshow/tmdb/:id`), and
  TVDB-only series via `/tvshow/tvdb/:id`. Detail pages reached this way offer Seerr
  requesting instead of watch history; the Seerr pill is absent for TVDB-only series,
  because Seerr requests are keyed on TMDB ids.
- The filter chips (all / movies / shows / people) drive `state.searchFilter`; person
  results open `/person/:id`.
- The results page lays the three categories out as columns (`.search-columns` in
  `styles.css`). Above 1200px the row is capped at the viewport height and each column
  scrolls its own list; below that the columns stack. The cap is a `max-height`, so
  short result sets size the panels to their content.
- The topbar also has a compact search dropdown (wired in `app.js`) that reuses the
  same search plumbing and links to the full page.

## Related state

All paging/filter/observer state lives in `state` (`public/modules/state.js`):
`historyView*` keys for the history page, `search*` / `globalSearch*` /
`globalDiscoveryResults` for search.
