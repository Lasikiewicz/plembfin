# Frontend Architecture

The UI is a plain ES-module SPA served straight from `public/` — no framework, no
bundler, no TypeScript, no build step. This doc covers structure, routing, state, and
the module rules. Feature-specific behavior lives in the per-feature docs
([dashboard.md](dashboard.md), [movies.md](movies.md), [tv-shows.md](tv-shows.md),
[media-detail.md](media-detail.md), [history-search.md](history-search.md),
[stats.md](stats.md), [settings.md](settings.md)).

## Structure

- **`public/index.html`** — the single shell: nav tabs, one `view-panel` section per
  view (`data-view-panel="dashboard|history|stats|explorer|upcoming|settings|search"`),
  every modal/dialog, and `modulepreload` links for each module. All element IDs the JS
  uses are defined here and bound once by `bindElements()` in `app.js`.
- **`public/app.js`** — orchestrator only (hard rule: stays under 3,000 lines):
  startup, theme, backend warm-up ping, element binding, routing, auth wiring, and the
  callback objects passed to each module's `init*(callbacks)` function. Modules never
  import from `app.js` — dependencies flow one way, and cross-module calls that would
  point "upward" go through those init callbacks instead.
- **`public/modules/*.js`** — feature modules with named ES exports (soft limit 1,200
  lines, hard limit 1,500). The authoritative "which module owns what" table plus the
  dependency rules live in [`../CLAUDE.md`](../CLAUDE.md); the file map in
  [architecture.md](architecture.md) has a one-line description of each.
- **`public/styles.css`** — all styling, including the ≤ 760px mobile rules. Any
  layout/appearance change must be verified on mobile.

## State

One global `state` object (`modules/state.js`) holds everything: active view, auth
state, loaded data (history, movies, shows, stats, sessions), paging offsets, caches
(poster lookups, TMDB details, explorer pages), UI toggles, and timers. The `elements`
object holds the DOM references bound at startup. Nothing is reactive — rendering is
manual: change state, call the relevant `renderX()`.

Preferences persist in localStorage under `plembfin:*` keys (view modes, sort orders,
filters, theme, cached pages); the constants at the top of `state.js` list them all.

## Routing

SPA navigation via `history.pushState`:

- `navigateTo(url)` — pushes state, scrolls to top on pathname change, then routes.
- `handleRouting(path)` (`app.js`) — parses the URL into `state.activeView` (+ mode/
  detail state) and calls the right opener. Routes:

| URL | View |
| --- | --- |
| `/`, `/dashboard` | Dashboard |
| `/movies`, `/tvshows` | Explorer in movies/shows mode |
| `/upcoming` | Upcoming TV episode calendar |
| `/history`, `/stats`, `/search?q=` | History / Stats / Search |
| `/settings/:tab`, `/sync`, `/logs` | Settings (tab from `SETTINGS_TABS`) |
| `/movie/:idOrSlug`, `/movie/tmdb/:id` | Movie detail (inline in explorer) |
| `/tvshow/:key(/season/:n(/episode/:n))`, `/tvshow/tmdb/:id` | Show detail, with season/episode deep links (legacy `#seasonNepM` hash also parsed) |
| `/person/:id` | Person profile |
| anything else | Dashboard |

- `applyActiveView()` toggles the `view-panel` sections and triggers each view's
  loader; `selectView(view)` is the nav-tab entry point (and enforces the
  forced-password-change pin to Settings).
- Detail pages record `state.mediaDetailReturnView` so closing returns to where the
  user came from; `state.internalHistoryCount` tracks how deep in-app history goes so
  back-button behavior stays sane.
- `popstate` re-runs `handleRouting` for browser back/forward; direct URL loads hydrate
  the same UI (the server falls back to `index.html` for any non-API path).

## Startup sequence (`app.js` bottom + `init` functions)

1. Theme applied from `plembfin:theme` (or `prefers-color-scheme`); warm-up ping to
   `/api/ping`.
2. `bindElements()` populates `elements`.
3. Each module's `init*(callbacks)` is called, handing it the app-level functions it
   may call (`navigateTo`, `setMessage`, `renderExplorer`, …).
4. `initAppEvents` (`modules/app-events.js`) binds the delegated global handlers
   (nav clicks, form submits, search inputs, keyboard shortcuts).
5. `onAuthChange` checks `/api/auth/status`; on success the shell shows,
   `handleRouting(location.pathname)` runs, and the active view loads.

## Data-loading conventions

- Loaders are idempotent and guarded (`state.xLoading`, `state.xLoaded`,
  `{ force }` options) so view switches don't stampede the API.
- Infinite scroll uses IntersectionObserver sentinels (1200px rootMargin, 240-item
  pages) — explorer, history, filmography all follow the same pattern.
- Poster hydration is observer-gated and cached — see
  [posters-artwork.md](posters-artwork.md).
- Now Playing polls only while the dashboard is visible — see
  [now-playing.md](now-playing.md).
- Upcoming loads one month at a time through `/api/upcoming`; its search can prefetch
  the next 12 months to list matches outside the selected month — see
  [upcoming.md](upcoming.md).
- Long-lived caches (explorer pages, dashboard history, poster lookups) persist to
  localStorage with TTLs and versioned keys; bump the key version when the cached
  shape changes.

## Adding a new module

1. Create `public/modules/<feature>.js` with named ES exports.
2. Add `<link rel="modulepreload" href="/modules/<feature>.js" />` to `index.html`.
3. Import it in `app.js` (or the owning module) and, if it needs app-level functions,
   give it an `init<Feature>(callbacks)` entry point.
4. Update the module table in [`../CLAUDE.md`](../CLAUDE.md) and the file map in
   [architecture.md](architecture.md).
