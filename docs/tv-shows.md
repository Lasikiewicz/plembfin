# TV Shows Page

The `/tvshows` library view: a poster grid (or list) of every tracked show, with watch
progress, next-airing dates, hide-watched/hide-ended filters, search, sort, and
infinite scroll. Clicking a show opens the show detail page
([media-detail.md](media-detail.md)).

## Files

| File | Role |
| --- | --- |
| `public/modules/explorer.js` | All TV-page rendering and data loading (`renderShowExplorer`, `loadExplorerShows`, `renderShowRecord`, `loadShowDetail`, season/episode folders) |
| `server/src/index.js` | `handleShows` (`GET /api/shows`), `handleShow` (`GET /api/show`), `refreshNextAiringCache`, `handleRematchTvShows`, `handleMergeShows` |
| `server/src/utils/dataRepo.js` | `queryShows` / `queryShowDetail` / `getCachedShows` — show summaries derived from episode rows |
| `server/src/utils/showProgressCache.js` | Per-show watched/total episode counts (file cache `data/tv_progress_cache.json`) |
| `server/src/utils/nextAiringCache.js` | Next-episode air dates (file cache `data/next-airing-cache.json`) |
| `server/src/utils/tvdbGateway.js` + `tmdbGateway.js` | Season/episode structure and metadata (see [metadata.md](metadata.md)) |

## Data model

A "show" is derived from `watch_history` rows with `media_type = "episode"`, grouped by
show title (`show_title_lower` / `canonicalTitleKey`). `getCachedShows()` builds one
summary per show — earliest/latest watch, episode count, inherited artwork (first
available poster/logo/backdrop from its episode rows) — memoized in-process and
invalidated on any history change.

`queryShows({ search, sort, limit, offset, hideWatched, hideEnded })` filters/sorts/
pages that cache. Sort modes include `title_asc`, `title_desc`, `watched_asc`, recency,
and `next_air_asc` (next airing date, powered by the next-airing cache so no metadata
API is hit during page loads).

### Watch progress

`showProgressCache.js` maintains watched-vs-total episode counts per show. Totals come
from TVDB/TMDB details (specials/season 0 excluded — `PROGRESS_CACHE_SCHEMA_VERSION` is
bumped when the calculation changes shape so stale entries refetch). Only genuine
Plembfin-tracked watches count; rows back-filled from library history scans are
distinguishable by their telemetry (`isScheduledLibraryHistoryRow`). Updates are queued
(`queueShowProgressUpdate`) and flushed by the scheduler.

### Next airing

`nextAiringCache.js` stores `{ nextAiringDate, status }` per show in
`data/next-airing-cache.json`. `refreshNextAiringCache` (in `index.js`, driven by the
scheduler) refreshes stale entries in small batches (default 40 shows per pass), oldest
first — active shows go stale after 6 hours, ended shows after 7 days. This lets the
grid sort by upcoming episode and show "next airs" chips without any per-row API calls.

## Frontend behavior

Shares the explorer infrastructure with Movies ([movies.md](movies.md)): 240-item
pages, IntersectionObserver infinite scroll, persisted page cache, poster/list view
modes, adjustable poster width, A–Z filter, server-side search, TMDB prefetch.

TV-specific extras:

- **Hide watched / hide ended** toggles, persisted in `plembfin:hideWatched:shows` /
  `plembfin:hideEnded:shows`, passed through to `GET /api/shows`.
- **Progress bars** on cards from the show progress cache.
- **Next-airing chips** and the `next_air_asc` sort; `scheduleNextAirResort` re-sorts
  the rendered grid when fresher airing data arrives.
- **Season/episode folders** — the list view can expand a show into seasons and
  episodes (`renderShowFolder` / `renderSeasonFolder`, expansion state in
  `state.expandedShows` / `state.expandedSeasons`).

## Show identity maintenance

Two admin tools deal with mis-grouped shows under Settings → System → Advanced:

- **Merge shows** (`POST /api/merge-shows`, `mergeShows` in `dataRepo.js`,
  dialog in `edit-dialogs.js`) — folds one show title's episode rows into another.
- **Re-match TV shows** (`POST /api/rematch-tv-shows`) — re-resolves shows against
  TMDB/TVDB when the automatic match picked the wrong series.
- `backfillUnknownShowTitles` (run at boot from `server.js`) fixes episodes stored
  with an "Unknown Show" title once a better title is known.

## Related endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/shows?search=&sort=&limit=&offset=&hideWatched=&hideEnded=` | Paged show summaries |
| `GET /api/show?id=` / `?title=` | One show's full detail (seasons, episodes, watch rows) |
| `GET /api/tmdb-details` / `GET /api/tmdb-season` | Metadata + episode lists for the detail page |
| `POST /api/merge-shows`, `POST /api/rematch-tv-shows` | Identity fixes |
