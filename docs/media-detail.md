# Media Detail Pages (Movies, TV Shows, People)

The immersive detail pages opened from any card in the app — or directly via URL
(`/movie/:id`, `/movie/tmdb/:id`, `/tvshow/:key`, `/tvshow/tmdb/:id`, `/person/:id`).
They render TMDB/TVDB metadata (overview, cast, trailers, ratings, recommendations,
images), watch state, sync status, Seerr request controls, and the edit tools.

## Module family

The detail system is split across eight modules; respect this split when adding code
(see the module table in [`../CLAUDE.md`](../CLAUDE.md)):

| Module | Owns |
| --- | --- |
| `media-detail.js` | Entry points: `openMovieInlineDetail`, `openShowInlineDetail`, `openMovieImmersiveModalByTmdbId`, `openShowImmersiveModalByTmdbId`, slug/id lookups, `nowPlayingHref`, history debug modal opener |
| `media-detail-context.js` | Shell/context: init callbacks into `app.js`, `authHeaders()`, the modal DOM root (`mediaDetailRoot`), render token (stale-render guard), actions-menu state, `closeMediaDetail` / `clearMediaDetailState` |
| `media-detail-shared.js` | Rendering fragments shared by movie + show pages: rating pills, external ratings (IMDb via OMDb), Seerr availability labels and request pills, app deep-links (`hydrateMediaAppLinks`) |
| `media-detail-movie.js` | Movie page rendering (`renderMovieImmersiveModalContent`), watched-state patching, TMDB-id open path |
| `media-detail-show.js` | Show page rendering: header, season accordion, episode rows with watch state, season/episode deep-linking (`renderImmersiveShowModal`, `renderShowModalContent`) |
| `media-detail-events.js` | One delegated click handler for everything inside the detail root: cast → person page, trailer → lightbox, poster → edit-image dialog, watch buttons, recommendation cards |
| `media-person.js` | Person pages: bio, filmography grid with watch badges (`loadCastMemberDetails`, `hydratePersonFilmographyWatchStatuses`) |
| `media-lightbox.js` | Trailer playback (YouTube embed) and photo lightbox |

Supporting modules: `tmdb.js` (frontend metadata fetch + cache), `edit-dialogs.js`
(edit date / edit images / fix match / merge show), `watch-action.js` (mark watched/
unwatched, delete, Seerr requests).

## How a detail page opens

1. A card click (delegated in `media-detail-events.js` or `app-events.js`) calls
   `navigateTo("/movie/…")` / `navigateTo("/tvshow/…")`.
2. `handleRouting` (`app.js`) matches the URL, records the return view
   (`state.mediaDetailReturnView`), sets `state.mediaDetailInline = true`, and calls the
   matching opener in `media-detail.js`.
3. The opener resolves the local watch record (`/api/history`-backed caches, or
   `/api/show?id=`), fetches TMDB/TVDB details through `fetchTmdbDetails`
   (`modules/tmdb.js` → `GET /api/tmdb-details`, cached client- and server-side), and
   renders into the explorer panel's detail root.
4. A **render token** (`bumpMediaRenderToken`) is captured before each async render;
   stale responses check the token and drop themselves so rapid navigation can't paint
   an old page over a new one.
5. Closing the page (`closeMediaDetail`) navigates back to the recorded return view.

Direct URL loads work identically — routing hydrates the same UI without needing
in-app navigation state. TV URLs support deep links:
`/tvshow/<key>/season/2/episode/5` (and a legacy `#season2ep5` hash form).

## What's on the page

- **Metadata** — overview, genres, runtime, status, ratings; TV structure (seasons/
  episodes, air dates) comes from TVDB, extras (cast, trailers, recommendations,
  watch providers) from TMDB — see [metadata.md](metadata.md).
- **External ratings** — IMDb rating pill via `GET /api/omdb-rating` when an OMDb key
  is configured.
- **Trailers** — YouTube keys from TMDB, metadata enriched via `GET /api/youtube-meta`,
  played in the lightbox.
- **Cast** — profile images proxied/cached via `GET /api/tmdb-profile`; clicking opens
  `/person/:id`.
- **Watch state & actions** — mark watched (with date prompt: today / release date /
  custom), mark unwatched, delete; episode- season- and show-level for TV
  (`watch-action.js`, `POST /api/manual-watch` in batches of 100,
  `POST /api/manual-unwatch`, `POST /api/delete-media`).
- **Sync status** — per-platform pills from `sync_dispatch_telemetry`
  (`modules/sync.js`), with retry (`POST /api/retry-sync`).
- **Seerr integration** — when Jellyseerr/Overseerr is configured, availability status
  (`GET /api/seerr/media-status`) and request buttons (`POST /api/seerr/request`,
  season-level for TV, optional 4K) render on the page. The last known status per
  title is persisted in localStorage (`plembfin:seerrStatusCache:v1`), so availability
  pills render instantly on page open; a silent background refresh re-renders the page
  only when the status actually changed (`fetchSeerrMediaStatus` resolves `null` when
  the fresh result matches the persisted one).
- **App links** — "open in Plex/Emby/Jellyfin" deep links via
  `GET /api/media-app-links`. The last known links per title are persisted in
  localStorage (`plembfin:appLinksCache:v1`) and rendered instantly; a background
  refresh (at most once per 5 minutes per title) updates the buttons only on change.
- **Edit tools** — edit watched date (single, per-season, per-show), edit artwork
  (poster/logo/backdrop picker fed by `GET /api/tmdb-images`, `/api/tvdb-images`,
  `/api/fanart-images`; saves via `POST /api/update-watch`), fix match
  (`GET /api/media-search` + re-link), merge show. All in `edit-dialogs.js`.
- **Debug modal** — `openHistoryDebugModal` shows the raw watch record + telemetry for
  a history row.

## Person pages

`loadCastMemberDetails(personId)` fetches `GET /api/tmdb-person` (server-cached, 7-day
TTL), renders bio + filmography, and overlays watch badges by matching filmography
entries against the local library (`findLibraryItem`,
`hydratePersonFilmographyWatchStatuses`). Filmography paginates with an
IntersectionObserver (`FILMOGRAPHY_PAGE_SIZE` 40). `state.personReturnUrl` remembers
where to go back to.

## Gotchas

- Every render path must respect the render token; async work that writes to the DOM
  without checking `currentMediaRenderToken()` causes ghost content on fast navigation.
- TV detail is keyed by **show key** (canonical title) locally but **TMDB id** for
  Seerr/routing; `getCachedTvdbId` and the details' `id` field bridge the two.
- Modal-close routing goes through `media-detail.js` so browser back/forward stays
  consistent with `state.internalHistoryCount`.
