# Media Detail Pages (Movies, TV Shows, People)

The immersive detail pages opened from any card in the app - or directly via URL
(`/movie/:id`, `/movie/tmdb/:id`, `/tvshow/:key`, `/tvshow/tmdb/:id`, `/tvshow/tvdb/:id`,
`/person/:id`).
They render TMDB/TVDB metadata (overview, cast, trailers, ratings, recommendations,
images), watch state, sync status, Seerr request controls, and the edit tools.

## Module family

The detail system is split across eight modules; respect this split when adding code
(see the module table in [`../CLAUDE.md`](../CLAUDE.md)):

| Module | Owns |
| --- | --- |
| `media-detail.js` | Entry points: `openMovieInlineDetail`, `openShowInlineDetail`, `openMovieImmersiveModalByTmdbId`, `openShowImmersiveModalByTmdbId`, slug/id lookups, `nowPlayingHref`, history debug modal opener |
| `media-detail-context.js` | Shell/context: init callbacks into `app.js`, `authHeaders()`, the modal DOM root (`mediaDetailRoot`), shared detail loading indicator, render token (stale-render guard), actions-menu state, `closeMediaDetail` / `clearMediaDetailState` |
| `media-detail-shared.js` | Rendering fragments shared by movie + show pages: rating pills, external ratings (IMDb via OMDb), Seerr availability labels and request pills, app deep-links (`hydrateMediaAppLinks`) |
| `media-detail-movie.js` | Movie page rendering (`renderMovieImmersiveModalContent`), watched-state patching, TMDB-id open path |
| `media-detail-show.js` | Show page rendering: header, season accordion, episode rows with watch state, season/episode deep-linking (`renderImmersiveShowModal`, `renderShowModalContent`) |
| `media-detail-events.js` | One delegated click handler for everything inside the detail root: cast → person page, trailer → lightbox, poster → edit-image dialog, watch buttons, recommendation cards |
| `media-person.js` | Person pages: bio, filmography grid with watch badges (`loadCastMemberDetails`, `hydratePersonFilmographyWatchStatuses`) |
| `media-lightbox.js` | Trailer playback (YouTube embed) and photo lightbox |

Supporting modules: `tmdb.js` (frontend metadata fetch + cache), `edit-dialogs.js`
(edit date / edit images / fix match / merge show), `watch-action.js` (mark watched/
unwatched, delete, Seerr requests), `calendar-picker.js` (the shared calendar + time
picker every date/time control in the app is built on).

## How a detail page opens

1. A card click (delegated in `media-detail-events.js` or `app-events.js`) calls
   `navigateTo("/movie/…")` / `navigateTo("/tvshow/…")`. Show cards in the poster grid
   render as real links, so they can be middle-clicked, opened in a new tab, or copied;
   the delegated handler claims only the plain left-click and routes it through the SPA
   router, leaving modifier and middle clicks to the browser.
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
5. Closing the page (`closeMediaDetail`) navigates back to the recorded return view,
   restoring the library URL so the address bar and the topbar controls match the grid
   the user lands on.

Direct URL loads work identically - routing hydrates the same UI without needing
in-app navigation state. TV URLs support deep links:
`/tvshow/<key>/season/2/episode/5` (and a legacy `#season2ep5` hash form).

Expanding a season - by clicking its header, or by loading a URL that names one -
scrolls it into view with an eased custom animation (`scrollSeasonAccordionIntoView`
in `media-detail-show.js`), landing just below the sticky topbar (via `scroll-margin-top`
on `.season-accordion-trigger`). The app shell keeps `window`/`document` fixed and
scrolls `<main class="page-shell">` internally instead, so this walks up from the
clicked/targeted season's trigger to find whichever ancestor actually has the overflow
rather than assuming it's page-shell specifically. A URL-named season scrolls into view
exactly once on that navigation (`state.pendingSeasonScrollTarget`, consumed by the
first render), not on every later re-render of the same modal.

Series that TMDB has no record of are addressed by `/tvshow/tvdb/:id` instead of
`/tvshow/tmdb/:id`. Show metadata is TVDB-backed either way, so the page renders the
same, with two differences: season episode lists are fetched by TVDB id, and the Seerr
request pill is absent because Seerr requests are keyed on TMDB ids. If the resolved
metadata does carry a TMDB id after all, the page switches to the TMDB URL.

A TV URL may also carry `?historyId=<record id>`, which library cards append so the
page opens against the play that was clicked. When that record names a series the app
can resolve, the page loads the full show and enriches it normally. The single-record
shell, which keeps Fix Match usable without a stale lookup replacing it, is reserved
for rows whose own series identity cannot be identified at all - a record that names a
real, different show than the URL's own key is treated as a stale id and ignored rather
than substituted in, and the router only carries a `historyId` forward across a route
change when the show being navigated to is the one already open, not into a link (a
global search result, for instance) that names a different show without supplying its
own.

The show page paints as soon as the show's own metadata arrives. Season episode lists
and the IMDb rating pill hydrate into the rendered page rather than holding up the
first complete render.

## What's on the page

- **Metadata** - overview, genres, runtime, status, ratings; TV structure (seasons/
  episodes, air dates) comes from TVDB, extras (cast, trailers, recommendations,
  watch providers) from TMDB - see [metadata.md](metadata.md).
- **External ratings** - IMDb rating pill via `GET /api/omdb-rating` when an OMDb key
  is configured.
- **Trailers** - YouTube keys from TMDB, metadata enriched via `GET /api/youtube-meta`,
  played in the lightbox.
- **Cast** - profile images proxied/cached via `GET /api/tmdb-profile`; clicking opens
  `/person/:id`.
- **Watch state & actions** - mark watched (with date prompt: today / release date /
  same as other episodes / custom), mark unwatched, delete; episode- season- and
  show-level for TV (`watch-action.js`, `POST /api/manual-watch` in batches of 100,
  `POST /api/manual-unwatch`, `POST /api/delete-media`). "Same as other episodes"
  only appears when an episode is already watched in the same season (episode/season
  scope) or show (show scope), and reuses that episode's watched date/time as the
  base. Marking more than one episode at once (season or show) always staggers each
  episode's `watched_at` one second apart in episode order - for "today" and "same as
  other episodes" alike - so a batch mark sorts correctly instead of every episode
  landing on the same instant (`watchedAtForChoice`, `WATCH_ORDER_STEP_MS`). A mark-watched
  request is skipped as a duplicate whenever the item is already watched, regardless of what
  timestamp the request itself used - a page left open for a while, or a season/show batch
  built from a "which episodes are unwatched" list that's gone stale since the page loaded,
  can never turn into a second logged play; the response reports it as already-logged
  instead. This is checked two ways rather than relying on a single lookup:
  `getCanonicalWatchState` (playstate first, falling back to watch history) and
  `findWatchedByAnyMediaKey` (provider ids, then season+episode+title, then a normalized
  show-title compare that tolerates a "(YYYY)" only one side carries) run independently, not
  one gated behind the other - a record old enough to predate provider-id tracking can be
  keyed loosely enough that playstate's own matching misses it while the more thorough
  watch-history lookup still finds it. A non-watched bookkeeping row occupying the exact same
  media identity and timestamp (left behind by an unwatch transition) is separately replaced
  with the new watched record
  instead of being mistaken for an existing one. Season- and show-level mark-watched
  always dispatches sync for every episode in scope, not only the ones that were
  actually unwatched - episodes plembfin already has as watched are folded into the
  same batch and re-pushed to Plex/Emby/Jellyfin/Trakt using their existing
  `watched_at` (no new watch-history row, no date prompt for them), so a target
  whose own watched flag drifted after the original push (e.g. following a library
  rescan) gets corrected without needing Force Sync. When a season or the whole show
  has nothing left unwatched, the button relabels to "Resync season" / "Resync
  Watched" instead of disabling, so it can still be clicked to re-push
  (`watchActionFromButton`, `runResyncWatchAction` in `watch-action.js`). `POST
  /api/manual-watch` awaits the outbound dispatch to every target before responding
  (rather than backgrounding it), and a manual unwatch (`POST /api/manual-unwatch`,
  `POST /api/playback-progress/unwatch`) always forces a live re-push even when
  Plembfin's own state already says unwatched - so the UI can show a row as
  "Syncing..." for the duration of the request and only flip it to
  watched/unwatched once the response confirms the push actually completed,
  instead of updating optimistically on click.
- **Rewatch tracking** - a genuine rewatch (a webhook playback event for an
  already-watched item on a later UTC calendar day; see [webhooks.md](webhooks.md#rewatch-detection))
  adds a new watch record instead of being dropped as a duplicate. A bare
  played-flag event never counts as a rewatch. Same-event propagation echoes
  inside the ten-minute duplicate window are removed from displayed history, so
  movie/episode cards and show summaries count actual watches only. Movies and
  episodes with more than one recorded watch show a "Watch History" list (date
  + source app for every play) in place of the single watched-date line; TV show
  and season summaries also show the total actual-watch count.
- **Sync status** - per-platform pills from `sync_dispatch_telemetry`
  (`modules/sync.js`), with retry (`POST /api/retry-sync`). Detail pages also
  expose **Force Sync** for movies and shows. Its dialog offers two independent
  operations, each explicit about what it does: **Set Plembfin as Source of
  Truth** sends this title's watched state exactly as Plembfin currently has
  it recorded to a selected destination (or all), overwriting whatever they
  show, without checking their current state first
  (`syncCanonicalPlaystate` in `syncOrchestrator.js`, and
  `syncMediaUnplayedPlaystate` also clears playback position, not just the
  played flag, on every server an unwatched state is replayed to); and
  **Import Watched Status** reads watched state from a selected server (or
  all) and adds anything Plembfin doesn't already have, without sending
  anything back out or removing anything. A remote item whose played flag has
  no reliable played date (common for episodes bulk-marked watched through a
  server's own library UI, which sets the played flag but never a played
  timestamp) falls back to the episode's own release date rather than being
  silently dropped or given a fabricated "just now" date - this operation is
  explicit and scoped to one title, unlike the background scheduled sync
  (`scheduled.js`), which still skips these entirely to avoid manufacturing a
  burst of phantom watches across an entire rebuilt library
  (`remoteItemToMedia` in `mediaForceSync.js`). If even a release date is
  unavailable, the item is skipped rather than given a fabricated date.
  Whether an item needs inserting is decided from its actual current
  canonical state (`getCanonicalWatchState`), not merely whether *any*
  watched row exists for it anywhere in history
  (`findWatchedByAnyMediaKey`) - a later unwatch (even a stale one recorded
  while a show's identity was mismatched) always wins the display's dedup
  tie-break by recency, so an old watched row can sit on file while the show
  still displays and counts as unwatched. Checking only "does a watched row
  exist" treated that as already handled and silently did nothing; checking
  the canonical pointer instead inserts a fresh record so the source's
  confirmed "still watched" genuinely wins the tie-break back. For a
  show-scoped pull, that canonical check prefers a season+episode map built
  once from the show's own current detail (`queryShowDetail`) over the
  playstate-based canonical lookup - an incoming Plex/Emby/Jellyfin item's
  ids are episode-scoped (its own imdb/tvdb id, not the show's), so a
  playstate lookup keyed on them can miss and fall back to the same
  any-watched-row check the fix exists to avoid; matching against the show's
  own episode list can't disagree with what the page actually renders.
  A pulled episode's tmdb_id/tvdb_id are always the show being pulled, not
  whatever id the source item itself carries: Plex/Emby/Jellyfin tag an
  episode with its own tmdb/tvdb id (both providers assign episodes ids
  separate from their series), and trusting that would tag the inserted row
  with the wrong-scope identity and fragment it into its own show cluster
  instead of the real show's - the same class of episode-vs-series id
  conflation documented for `tvdb_id` resolution in `tv-shows.md`. Only
  imdb_id still comes from the item, since it's meaningfully episode-scoped
  and doesn't affect show grouping (`remoteItemToMedia` in
  `mediaForceSync.js`). The asynchronous
  `POST /api/force-sync/media` operation is followed through
  `GET /api/force-sync/media/status?id=...`, and the dialog shows its detailed
  live terminal output until completion. Every action asks for confirmation before it
  starts, and the activity header exposes **Cancel operation** while it is running.
  Settings → Sync → Sync Tools → Force Sync
  keeps the same two operations and live terminal inline in the Force Sync box for
  the complete library.
  Both operations process several episodes at once (bounded concurrency, see
  `runWithConcurrency` in `concurrency.js`) rather than one at a time, so a show with
  many seasons syncs significantly faster; outbound calls to each media server are still
  throttled per host by the outbound governor regardless of how many episodes are in
  flight.
  For a TV show, the dialog also lists its seasons as checkboxes; leaving all of them
  unchecked scopes the operation to every season (the previous, only behavior), while
  checking one or more limits it to just those seasons. This reuses the same season
  filter (`mediaMatchesRequest` in `mediaForceSync.js`) that already scopes a single
  episode's Force Sync button, extended to accept a list.
  Jellyfin episode matching keeps every same-season/episode copy, so separate
  1080p and 4K items can both receive the watched or unwatched state.
  `POST /api/retry-sync` and `POST /api/update-watch` both take an optional
  `media_key` next to `id`, and fall back to it when the id names no row. A
  record can be superseded between the moment a caller reads its id and the
  moment it acts, so callers that hold an id for any length of time - the manual
  match queue in Settings → Sync → Sync Issues - send the key as well. Both endpoints
  also accept a media key supplied as the `id` itself.
- **Seerr integration** - when Jellyseerr/Overseerr is configured, availability status
  (`GET /api/seerr/media-status`) and request buttons (`POST /api/seerr/request`,
  season-level for TV, optional 4K) render on the page. The last known status per
  title is persisted in localStorage (`plembfin:seerrStatusCache:v1`), so availability
  pills render instantly on page open; a silent background refresh re-renders the page
  only when the status actually changed (`fetchSeerrMediaStatus` resolves `null` when
  the fresh result matches the persisted one). That repaint only fires when the browser
  still considers itself "on" the same title - a TV show opened via `/tvshow/tmdb/:id`
  or `/tvshow/tvdb/:id` never sets `state.activeShowModalKey` (only the plain
  `/tvshow/:key` route does), so a slug-only check there always failed for those two
  routes and left a stale availability badge on screen indefinitely even once the
  background fetch had already resolved correct data - fixed by also matching on
  `state.activeShowTmdbId`/`activeShowTvdbId`. The "Available in <resolution>" wording
  reflects the actual resolution found on the connected server(s): a TV show/season only
  states a resolution when every one of its available episodes shares it (the per-episode
  resolution pills already show a mixed season's real breakdown); a movie states whatever
  resolution `mediaItemResolutionLabel` found for it, walking the same Plex/Emby/Jellyfin
  media-item shapes TV episodes use (`fetchConfiguredAppAvailability` in
  `server/src/routes/admin.js`) rather than a hardcoded "1080p".
- **App links** - "open in Plex/Emby/Jellyfin" deep links via
  `GET /api/media-app-links`. The last known links per title are persisted in
  localStorage (`plembfin:appLinksCache:v1`) and rendered instantly; a background
  refresh (at most once per 5 minutes per title) updates the buttons only on change.
- **Edit tools** - edit watched date (single, per-season, per-show), edit artwork
  (poster/logo/backdrop picker fed by `GET /api/tmdb-images`, `/api/tvdb-images`,
  `/api/fanart-images`, with tiles previewed through the caching artwork proxy so a
  fanart.tv or TVDB CDN the browser cannot reach still shows its gallery; saves via
  `POST /api/update-watch`), fix match
  (TMDB search for movies; TheTVDB search for shows), merge show. All in
  `edit-dialogs.js`. The single-item edit-date dialog lists every recorded watch
  date for that movie/episode (`GET /api/watch-dates?id=`), letting you edit any
  one of them, add another watch date (`POST /api/add-watch-date`, clones the
  anchor row's identity fields onto a new date), or remove one with confirmation
  (`POST /api/delete-watch-date` - rolls `playstate.watched_at` back to whichever
  remaining watch is newest, or clears it if none remain, and clears the
  dashboard/explorer's cached history so the "N actual watches" count updates
  immediately instead of only after some unrelated reload). The list only ever
  shows one row per real viewing event, since a webhook echo can write more
  than one `watch_history` row within the same short window
  (`SAME_EVENT_WINDOW_MS` in `dataRepo.js`); deleting that row also deletes any
  echo chained to it (`sameEventChainIdsFor` in `dataRepo.js`), so a hidden
  duplicate can't resurface as a "new" watch date afterward. An episode's other
  plays are found by `siblingWatchRowsFor()` matching season, episode, and a
  canonical (year-stripped) show title - normalizing the full show_title-or-
  title expression, not just the title fallback, matters for the same reason
  it does in `queryShowDetail` (see `tv-shows.md`): two of an episode's own
  watch rows can carry differently-formatted show_title text, and comparing
  one normalized side against one raw side silently missed a real duplicate
  play instead of listing it. Deleting a watch
  date also replays the resulting canonical state - the rolled-back date if a
  watch remains, or "unwatched" if that was the only one - to every connected
  Plex/Emby/Jellyfin/Trakt server (`propagateWatchDateRemoval` in
  `routes/media.js`, reusing the same `syncCanonicalPlaystate` replay as an
  edited date), so a platform that already received the deleted watch as
  "watched" gets corrected instead of continuing to disagree with Plembfin;
  left uncorrected, that platform's own next catch-up scan could otherwise
  re-import its stale "watched" state as a brand-new phantom watch. The
  per-season "Edit season date" dialog additionally offers **Remove duplicate
  watches** when any episode in the season has more than one recorded watch: it
  keeps only the oldest watch per episode and bulk-deletes the rest in a single
  confirmed action (`POST /api/delete-watch-dates`, `deleteWatchDates` in
  `dataRepo.js`, same echo-chain handling and canonical-state replay per
  affected episode as the single-row delete), rolling each affected
  `playstate.watched_at` back to the surviving (oldest) date the same way the
  single-row delete does. The show-level "Edit Date"
  control (top action bar, `openEditShowDateDialog`) shows one row per season
  instead of a single date for the whole show - each season defaults to its
  own latest watched date and can be changed independently before saving, so
  Season 1 and Season 2 don't have to share one timestamp. Editing, adding, or
  bulk-editing (`POST /api/update-watch-dates`) a watched date replays the
  corrected date to Trakt and every connected Plex/Emby/Jellyfin server as a
  canonical "watched" state in the background (`propagateCorrectedWatchDate` in
  `routes/media.js`, reusing `syncCanonicalPlaystate` - the same replay Force
  Sync's "Set Plembfin as Source of Truth" uses), so the platforms Plembfin is canonical for don't keep
  showing a stale or fabricated date after a manual fix; a record currently
  marked unwatched is left alone. Since Trakt's history is an additive play log,
  this replay clears any existing Trakt plays for the item first
  (`trackerDispatcher.js`) so the correction replaces the old entry instead of
  adding another one alongside it. Trakt's `/sync/history` and
  `/sync/history/remove` both return `200 OK` with a `{ added|deleted, not_found }`
  summary even when nothing actually matched, so `dispatchTrakt` reads that body
  rather than trusting the HTTP status alone: a non-empty `not_found` on the add
  step is reported back as an error instead of a false "success", and a
  canonical replay's clear step reports how many plays it actually deleted (and
  any it didn't recognize) in the telemetry, e.g. "Marked watched on Trakt
  (cleared 0 existing plays first)" - a visible signal that Trakt didn't
  recognize the item to clear, rather than a blind "success" while a stale
  duplicate play stays on Trakt. That `not_found` detail is also what exposed a
  real identity bug: an episode dispatched to Trakt without an id of its own
  used to have its ids re-derived from a TMDB title search every time
  (`hydrateTrackerMedia`/`trackerMediaWithSeriesIds` in `trackerDispatcher.js`)
  and that search result unconditionally replaced whatever ids the episode
  already had - so a short or ambiguous show title that TMDB's search
  resolved to the wrong series (e.g. "G'wed") silently corrupted every Trakt
  request for that show's episodes, `not_found`-ing both the add and the
  clear-existing-plays step. The lookup now only fills in ids an episode is
  missing and is skipped entirely once it already has one, so a correct
  stored id is never overwritten by a guess. Plex/Emby/Jellyfin's own mark-played APIs
  don't accept an arbitrary date, so those servers still record the moment the
  correction ran, not the corrected date itself - only Trakt's history reflects
  the actual corrected timestamp. TV Fix Match sends one `POST /api/rematch-show` request that
  updates every episode record in a transaction, renaming them onto the picked
  series when that name differs; the dialog closes after that local update while
  progress, artwork, and metadata refresh in the background. A rename changes the
  show's route key, so the UI navigates to the new show URL. Movie Fix Match saves the picked
  TMDB id via `PATCH /api/update-watch` (`updateWatchRecord` in `dataRepo.js`, which also
  accepts an `imdb_id`). Because a row's `media_key` is derived from its identity fields,
  correcting them recomputes the key and moves the row onto it - merging it with any other
  watch already recorded under that identity instead of leaving it permanently split under
  its old key - and reconciles `playstate` on both the old key (rolled back to whatever else
  is still there, or cleared) and the new one (merged with whatever it already reflects).
  Season and show date editors use `POST /api/update-watch-dates` to update the
  selected existing rows in one transaction. The season editor can use each
  episode's release day independently; this path never adds a watch-history row.
  Same-event webhook/propagation echoes are removed from displayed play history,
  while later genuine plays remain visible. Show cards, dashboard history, season
  summaries, and episode details expose the retained actual-watch count when it is
  greater than one.
  The artwork dialog has a match search box at the top (`GET /api/tmdb-search`):
  when a title has no automatic TMDB/TVDB match, searching and picking a result
  swaps the identifiers the picker browses with - the record itself is not
  re-linked (use Fix Match for that).
- **Debug modal** - `openHistoryDebugModal` shows the raw watch record + telemetry for
  a history row.

## Person pages

`loadCastMemberDetails(personId)` fetches `GET /api/tmdb-person` (server-cached, 7-day
TTL), renders a sidebar with profile image, name, age, biography, and personal info
(birthdate, place of birth, known-for department), plus social media links (IMDb,
Instagram, X, Facebook, TikTok, Wikidata). The main content area shows filmography
with three filter/sort controls: media type (all/movie/TV), year, and genre. Credits
are sorted by default by release date (newest first); other sort options are popularity,
release date (oldest first), and alphabetical title sort. A watch badge overlay on each
credit indicates whether it's in the library. Filmography paginates with an
IntersectionObserver (`FILMOGRAPHY_PAGE_SIZE` 40) and matches entries against the local
library (`findLibraryItem`, `hydratePersonFilmographyWatchStatuses`). The page layout
is responsive and stacks vertically on smaller screens. `state.personReturnUrl` remembers
where to go back to.

## Gotchas

- Every render path must respect the render token; async work that writes to the DOM
  without checking `currentMediaRenderToken()` causes ghost content on fast navigation.
- TV detail is keyed by **show key** (canonical title) locally but **TMDB id** for
  Seerr/routing; `getCachedTvdbId` and the details' `id` field bridge the two.
- Modal-close routing goes through `media-detail.js` so browser back/forward stays
  consistent with `state.internalHistoryCount`.
