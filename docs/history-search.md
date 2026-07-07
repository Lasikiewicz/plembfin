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
| `server/src/index.js` | `handleHistory` — `GET /api/history?limit=&offset=&search=&mediaType=` |
| `server/src/utils/dataRepo.js` | `queryWatchHistory` (with dedupe), `getCachedHistory` |

Behavior:

- **Paging** — the endpoint returns an explicit `hasMore` flag so the page can
  lazy-load through the full log with an IntersectionObserver sentinel.
- **Dedupe** — raw history collapses duplicates to one entry per movie or show episode
  per calendar day, so same-day webhook echoes don't crowd out genuine later rewatches
  (`dedupe` option in `queryWatchHistory`).
- **View modes** — grid / list / cards (`plembfin:historyView`), filter all/movies/shows
  (`plembfin:historyFilter`), search box (server-side `?search=`), adjustable poster
  width (`applyHistoryPosterWidth`).
- **Row actions** — each entry links to its detail page; sync pills, edit-date, and
  debug modal are available per row (see [media-detail.md](media-detail.md)).

The dashboard's recent-history rail is a separate, smaller consumer of the same
endpoint — see [dashboard.md](dashboard.md).

## Search page (`/search`)

Global search across the local library **and** TMDB discovery, reached from the topbar
search or `/search?q=`.

| File | Role |
| --- | --- |
| `public/modules/explorer.js` | `triggerSearchPage`, `renderSearchPage` |
| `server/src/index.js` | `handleMediaSearch` (`GET /api/media-search`), `handleTmdbSearch` (`GET /api/tmdb-search`), `handleTvdbSearch` |
| `server/src/utils/tmdbGateway.js` | `searchTmdb` with the `tmdb_search_cache` table (15-min TTL) |

Behavior:

- Local results match the watch history/library caches; remote results come from TMDB
  search (debounced — `state.globalSearchRemoteTimer`), merged and de-duplicated with
  local items marked as in-library.
- A result click opens the standard detail page: in-library items by their local id,
  discovery-only items via the TMDB routes (`/movie/tmdb/:id`, `/tvshow/tmdb/:id`),
  where the detail page offers Seerr requesting instead of watch history.
- The filter chips (all / movies / shows / people) drive `state.searchFilter`; person
  results open `/person/:id`.
- The topbar also has a compact search dropdown (wired in `app.js`) that reuses the
  same search plumbing and links to the full page.

## Related state

All paging/filter/observer state lives in `state` (`public/modules/state.js`):
`historyView*` keys for the history page, `search*` / `globalSearch*` /
`globalDiscoveryResults` for search.
