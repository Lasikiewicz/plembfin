# Metadata Sources (TMDB, TheTVDB, Fanart.tv, OMDb, YouTube)

Where movie/TV metadata comes from, how the sources are split, and how everything is
cached. The frontend never talks to a metadata API directly — the server proxies and
caches every source (the CSP is `connect-src 'self'`).

## Files

| File | Role |
| --- | --- |
| `server/src/utils/tmdbGateway.js` | TMDB gateway + the merged TV details assembly; caches in `tmdb_metadata_cache`, `tmdb_search_cache`, `tmdb_person_cache` |
| `server/src/utils/tvdbGateway.js` | TheTVDB v4 gateway; caches in `tvdb_metadata_cache`, `tvdb_season_cache` |
| `server/src/utils/fanartGateway.js` | Fanart.tv artwork (posters, backdrops, HD logos) |
| `server/src/utils/omdbGateway.js` | OMDb — IMDb rating/votes by IMDb id (`omdb_cache`, 7-day TTL) |
| `server/src/utils/tmdbClient.js` | Thin poster-URL helper for the poster pipeline's TMDB fallback |
| `public/modules/tmdb.js` | Frontend fetch + in-memory cache over the `/api/tmdb-*` endpoints |

## Who provides what

| Data | Movies | TV shows |
| --- | --- | --- |
| Title, overview, status, genres, artwork | TMDB | **TheTVDB** |
| Season/episode numbering, titles, overviews, air dates | — | **TheTVDB** |
| Cast/credits, trailers, reviews, recommendations, watch providers, content ratings | TMDB | TMDB |
| Extra artwork (posters/backdrops/logos gallery) | TMDB + Fanart.tv | TMDB + TVDB + Fanart.tv |
| IMDb rating badge | OMDb | OMDb |
| Trailer titles/metadata | YouTube Data API | YouTube Data API |

The split is invisible to callers: `getTmdbDetails()` / `getTmdbSeason()`
(`tmdbGateway.js`) return one merged shape for TV, keyed by TMDB id. The full rationale
and edge cases (remoteIds verification, Specials handling, `DETAILS_SCHEMA_VERSION`
bumping) are in the "TV metadata" section of [architecture.md](architecture.md).

## API keys

- **TMDB** — user-supplied key (Settings → API Keys or `TMDB_API_KEY`). Required for
  metadata-rich pages.
- **TheTVDB** — works out of the box via a built-in shared project key
  (`TVDB_PROJECT_KEY` overrides it); a personal key (Settings or `TVDB_API_KEY`) takes
  precedence and raises the personal rate limit. Bearer tokens are cached ~25 days,
  keyed by a fingerprint of the key in use.
- **Fanart.tv** — built-in shared project key (`FANART_PROJECT_KEY` overrides); an
  optional personal key is passed as `client_key` for a higher limit.
- **OMDb** — optional user key (Settings → Integrations or `OMDB_API_KEY`); enables the
  IMDb rating pill.
- **YouTube** — optional user key; enables trailer metadata via `GET /api/youtube-meta`
  (key sent as an `X-goog-api-key` header, never in the URL).

## Caching

Every gateway throttles requests, de-duplicates in-flight calls (`inflight` maps), and
caches in SQLite:

| Cache table | Contents | TTL |
| --- | --- | --- |
| `tmdb_metadata_cache` | Merged details per item, key `movie_<id>` / `tv_<id>` (or `tv_tvdb_<id>` when no TMDB match), stamped with `DETAILS_SCHEMA_VERSION` | 1 day for airing/in-production shows; longer for ended/released |
| `tmdb_search_cache` | Search responses, including negative results | 15 min (1 day for misses) |
| `tmdb_person_cache` | Person details + credits, `PERSON_SCHEMA_VERSION` | 7 days |
| `tvdb_metadata_cache` | Raw TVDB series/extended responses + title-search results | 14 days active / 180 days archived series; searches 180 days (1 hour for misses) |
| `tvdb_season_cache` | Raw TVDB season episode lists | 2 days upcoming / 7 days active / 180 days archived |
| `omdb_cache` | IMDb rating/votes | 7 days |

Schema-version bumps (`DETAILS_SCHEMA_VERSION`, `PERSON_SCHEMA_VERSION`,
`PROGRESS_CACHE_SCHEMA_VERSION` in `showProgressCache.js`) force refetches after a
shape change — never hand-edit cache rows to migrate them.

`prewarmTmdbLibrary` (driven by the scheduler) warms details for recently watched items
so detail pages open hot. Settings → Cache (`GET /api/cache-stats`,
`POST /api/clear-cache`, handlers in `index.js`) reports and clears the caches;
`POST /api/refresh-tmdb-metadata` force-refreshes items.

## API endpoints (all admin-authenticated, all in `server/src/index.js`)

| Endpoint | Backing |
| --- | --- |
| `GET /api/tmdb-details` (alias `media-details`) | `getTmdbDetails` — merged movie/TV details |
| `GET /api/tmdb-details-batch` | Batched details for explorer prefetch |
| `GET /api/tmdb-season` | Season episode list (TVDB-backed for TV) |
| `GET /api/tmdb-person` | Person details + filmography |
| `GET /api/tmdb-search`, `GET /api/tvdb-search`, `GET /api/media-search` | Remote + local search |
| `GET /api/tmdb-images`, `GET /api/tvdb-images`, `GET /api/fanart-images` | Artwork galleries for the edit-image dialog |
| `GET /api/tmdb-poster`, `GET /api/tmdb-profile` | Image proxies (rate-limited 300/min) |
| `GET /api/omdb-rating` | IMDb rating pill |
| `GET /api/youtube-meta` | Trailer metadata |
| `POST /api/refresh-tmdb-metadata`, `POST /api/rematch-tv-shows` | Cache refresh / identity fixes |

## Frontend

`public/modules/tmdb.js` wraps the endpoints with in-memory caches
(`state.tmdbDetailsCache`, `state.tmdbSeasonCache`) and helpers like
`resolveEpisodeTitleFromTmdb` that upgrade "Episode 5" labels to real titles as data
arrives. Explorer prefetch (`observeExplorerTmdbPrefetch`) warms details for visible
cards.
