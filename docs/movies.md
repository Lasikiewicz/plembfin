# Movies Page

The `/movies` library view: a poster grid (or list) of every movie in the watch
history, with search, sort, alpha filter, and infinite scroll. Clicking a movie opens
the movie detail page ([media-detail.md](media-detail.md)).

## Files

| File | Role |
| --- | --- |
| `public/modules/explorer.js` | All Movies-page rendering and data loading (`renderMovieExplorer`, `loadExplorerMovies`, `renderMovieCard`, sort/search/paging helpers) |
| `server/src/index.js` | `handleMovies` — `GET /api/movies` |
| `server/src/utils/dataRepo.js` | `queryMovies` + `getCachedMovies` — the derived movie list |
| `public/modules/images.js` | Poster markup + hydration for the grid |
| `public/app.js` | Route `/movies` → explorer view in `movies` mode |

## Data model

A "movie" is derived from `watch_history` rows with `media_type = "movie"`.
`getCachedMovies()` (`dataRepo.js`) groups history rows into one entry per movie
(latest watch wins), memoized in-process and invalidated by `bumpDataVersion()` whenever
history changes. `queryMovies({ search, sort, limit, offset })` filters/sorts/pages that
cache. Sort modes: `title_asc`, `title_desc`, `watched_asc`, and watched-date descending
(default order for recency), plus release/year ordering applied client-side.

## Frontend behavior

- **Route** — `/movies` sets `state.activeView = "explorer"`, `state.explorerMode =
  "movies"`. The Movies and TV Shows pages share the explorer panel and most controls.
- **Paging** — pages of 240 (`EXPLORER_PAGE_SIZE` in `app.js`) with an
  IntersectionObserver sentinel (1200px rootMargin) pre-fetching the next page before
  the user reaches the bottom (`observeExplorerSentinel`).
- **Page cache** — responses are cached per query key in `state.explorerPageCache` and
  persisted to localStorage (`plembfin:explorerPageCache:v3`, 14-day TTL) so revisits
  render instantly.
- **View modes** — posters or list, persisted per mode (`plembfin:explorerView:movies`);
  poster width is adjustable (`applyExplorerPosterWidth`).
- **Sort** — persisted in `plembfin:explorerSort:movies`; list headers are clickable
  (`applyListHeaderSort`).
- **Search + alpha filter** — the search box filters server-side via
  `GET /api/movies?search=`; the A–Z strip (`updateAlphaFilter` /
  `handleAlphaFilterClick`) jumps within results.
- **TMDB prefetch** — a second IntersectionObserver (`observeExplorerTmdbPrefetch`)
  pre-fetches TMDB details for visible cards so opening a detail page is instant and
  release-year/rating data can enrich cards.
- **Sync pills** — each card can show sync/availability status derived from the watch
  record's `sync_dispatch_telemetry` (`renderMediaSyncPills` and friends in
  `public/modules/sync.js`).

## Related endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/movies?search=&sort=&limit=&offset=` | Paged movie list |
| `POST /api/delete-media` | Delete a movie (and its watch rows) from history |
| `POST /api/manual-watch` / `POST /api/manual-unwatch` | Manual watch-state changes (see [media-detail.md](media-detail.md)) |
| `GET /api/poster?id=` | Poster hydration (see [posters-artwork.md](posters-artwork.md)) |

## Gotchas

- The movie list is a **derived cache** — if movies look stale after a direct DB edit,
  the `dataVersion` bump was skipped. All repo write helpers call
  `invalidateHistoryDerivedCaches()`; raw SQL edits from outside the process won't.
- Search hits the server, but the alpha filter and some sorts operate on already-loaded
  pages — a movie that hasn't been paged in yet appears once its page loads.
