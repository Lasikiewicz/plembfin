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
- **`public/modules/settings-ui.js`** — reusable settings card-grid, picker, and edit
  dialog primitives. `settings-services.js` owns media-server/metadata behavior, while
  `tools-backups.js` consumes the same primitives for remote destinations.
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
| `/settings`, `/settings/:section` | Settings landing list and flat administration sections |
| `/sync`, `/logs`, retired grouped `/settings/*` URLs | Compatibility aliases normalized to canonical flat sections |
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
- `modules/settings-shell.js` is the settings route registry. It resolves flat sections
  and legacy aliases, renders the landing list/sidebar/mobile selector, and applies
  focused panel visibility.
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
- Upcoming loads one month at a time through `/api/upcoming`, growing the rendered range
  by a month as the user scrolls toward either end; server-side month results persist
  locally across restarts, while search can prefetch the next 12 months to list matches
  outside the visible range — see [upcoming.md](upcoming.md).
- Long-lived caches (explorer pages, dashboard history, poster lookups) persist to
  localStorage with TTLs and versioned keys; bump the key version when the cached
  shape changes.

## Settings Layout & Design Standards

These are canonical values for the settings UI — do not change them without explicit user instruction.

### Spacing Token Reference (`styles.css` `:root`)

| Variable | Value | Pixels |
|---|---|---|
| `--space-1` | 0.25rem | 4px |
| `--space-2` | 0.5rem | 8px |
| `--space-3` | 0.75rem | 12px |
| `--space-4` | 1rem | 16px |
| `--space-5` | 1.5rem | 24px |
| `--space-6` | 2rem | 32px |

### Canonical Settings Gaps

All of the following must stay consistent — do not change one without updating the others.

| Element | Property | Value | Notes |
|---|---|---|---|
| `.app-shell` | `gap` | `var(--space-3)` | Gap between topbar and view content |
| `.page-topbar + .view-panel` | `padding-top` | `var(--space-2)` | Extra breathing room below topbar |
| `.settings-content` | `gap` | `var(--space-3)` | Gap between settings panes when stacked |
| `.settings-pane` | `gap` | `var(--space-3)` | Gap between `.settings-row` elements |
| `.settings-row` | `gap` | `var(--space-3)` | Gap between left (main) and right (help) columns — **must equal the topbar gap** |
| `.settings-row-main` | `gap` | `var(--space-3)` | Gap between stacked cards inside main column |
| `.settings-row-help` | `gap` | `var(--space-3)` | Gap between stacked cards inside help column |
| `.settings-card` | `padding` | `1.5rem` | Internal card padding (all sides) |

### Spacing Rules

1. **Every structural layout gap in the settings shell uses `var(--space-3)` = 0.75rem.** This applies to `.settings-content`, `.settings-pane`, `.settings-row`, `.settings-row-main`, and `.settings-row-help` — all must use the same token so topbar gap, horizontal gap, and vertical section gaps are visually identical.
2. **Card internal padding is `1.5rem` on all sides**, set via `padding: 1.5rem !important` on `.settings-card` (the `!important` exists to override the base `.glass-panel` / `.p-section` rules). This is content padding, not layout spacing — do not equate it with the layout gap.
3. **Never add per-panel margin or gap overrides** (e.g. `margin-top` on a specific `settings-pane[data-settings-panel]` selector). All spacing must come from the flex gap alone.
4. **Do not merge `.app-shell` into a shared selector with `.view-panel`** — `.app-shell` needs `gap: var(--space-3)` while `.view-panel` needs `gap: 0`. Merging them collapses the topbar into the page content.

### Settings Navigation Rules

5. **All settings navigation links** (sidebar buttons, overview link rows, section-select dropdown options) must navigate to the **parent group path** (e.g. `/settings/media-servers`), never to a child `#hash` anchor. Hash anchors cause the page to auto-scroll past the top padding.
6. **`focusSettingsRoute`** must scroll the container to the top (`window.scrollTo(0, 0)`) on every navigation, not `scrollIntoView` to a child element.

## Adding a new module

1. Create `public/modules/<feature>.js` with named ES exports.
2. Add `<link rel="modulepreload" href="/modules/<feature>.js" />` to `index.html`.
3. Import it in `app.js` (or the owning module) and, if it needs app-level functions,
   give it an `init<Feature>(callbacks)` entry point.
4. Update the module table in [`../CLAUDE.md`](../CLAUDE.md) and the file map in
   [architecture.md](architecture.md).
