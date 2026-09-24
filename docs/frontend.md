# Frontend Architecture

The UI is a plain ES-module SPA served straight from `public/` - no framework, no
bundler, no TypeScript, no build step. This doc covers structure, routing, state, and
the module rules. Feature-specific behavior lives in the per-feature docs
([dashboard.md](dashboard.md), [movies.md](movies.md), [tv-shows.md](tv-shows.md),
[media-detail.md](media-detail.md), [history-search.md](history-search.md),
[stats.md](stats.md), [settings.md](settings.md), [personal-ratings.md](personal-ratings.md)).

## Structure

- **`public/index.html`** - the single shell: nav tabs, one `view-panel` section per
  view (`data-view-panel="dashboard|history|stats|explorer|upcoming|discover|personal-media|settings|search"`),
  every modal/dialog, and `modulepreload` links for each module. All element IDs the JS
  uses are defined here and bound once by `bindElements()` in `app.js`.
- **`public/app.js`** - orchestrator only (hard rule: stays under 3,000 lines):
  startup, theme, backend warm-up ping, element binding, routing, auth wiring, and the
  callback objects passed to each module's `init*(callbacks)` function. Modules never
  import from `app.js` - dependencies flow one way, and cross-module calls that would
  point "upward" go through those init callbacks instead.

- **`public/modules/*.js`** - feature modules with named ES exports (soft limit 1,200
  lines, hard limit 1,500). The module ownership rules in this document and the file map
  in [architecture.md](architecture.md) are authoritative.
- **`public/modules/settings-ui.js`** - reusable settings card-grid, picker, and edit
  dialog primitives. `settings-services.js` owns media-server/metadata behavior, while
  `tools-backups.js` consumes the same primitives for remote destinations.
- **`public/styles.css`** - all styling, including the ≤ 760px mobile rules. Any
  layout/appearance change must be verified on mobile.

### Core graph and route modules

`app.js` statically imports only the core graph needed for the first paint: auth,
state, utils, images, logs, settings shell, sync,
live updates, the small appearance, status-indicator, media-routing, and cast-disclosure
helpers, and `route-modules.js`. Dashboard, Up Next, backup tools, the metadata helper,
shared detail renderer, and the full status pages are registered route modules, so
their graphs load only when the relevant route or action needs them. The `modulepreload`
links in `index.html` cover the remaining core graph only.

Everything else is a **route module**, registered in `public/modules/route-modules.js` and
loaded on demand with native `import()`:

- **Shell modules** (`SHELL_ROUTE_MODULES`) load right after the first paint on every page:
  `app-events.js` (the document-wide click and change wiring). The changelog helper is
  Settings-scoped, while detail event wiring is route-scoped with the detail group and
  Settings explicitly loads it for the library Force Sync panel. The tracker, rating-sync,
  watchlist-sync, and Tautulli modules are Settings-only and load with that route, after
  the saved config has been fetched. So does `settings-events.js`, which holds the Settings
  page's own handlers (logs, admin login, import, backups, maintenance tools, sync controls);
  `app-events.js` initializes it through `onRouteModuleLoaded()`.
- **Status modules** (`STATUS_ROUTE_MODULES`: sync activity and manual watch review) load only
  when their pages are opened. The small `status-indicators.js` core helper keeps the sidebar
  sync progress, attention, and Manual Watch review count live and polls their compact summaries
  after sign-in. Poster-card menus are route work and load only for library, dashboard,
  discovery, upcoming, personal-media, and detail views.
- The onboarding wizard is also route-scoped: its large setup/claim module loads only for
  `/setup`, a claim-required session, or when the deferred `/api/setup/status` check for a
  signed-in account finds something for it to show (setup unfinished and not dismissed, or a
  non-empty dashboard checklist). A finished install never downloads it, and the dashboard
  renders its checklist through `ifLoaded("onboarding", ...)`.
- The Settings service renderer (`settings-services.js`, with its `settings-ui.js` and
  `help-content.js` dependencies) is route-scoped as well. Direct Settings routes initialize
  it before applying saved config; Dashboard reaches it only through the onboarding checklist
  dependency. Help-content is therefore absent from the global shell and loaded when Settings
  or onboarding needs its guides.
- **Route groups** load when their route is opened: `routeModulesForState()` in `app.js`
  maps each view to its modules (Dashboard and Up Next, Explorer/History/Search, Stats, Upcoming, Discover and the
  personal-media pages, Settings/Tools/Backups, Sync Activity, Manual Watch Review, and the detail
  group for movie, show, and person pages). `handleRouting()` and `applyActiveView()` render
  the core parts immediately and replay once the route's modules arrive; a newer navigation
  supersedes a pending replay.

Rules that keep this correct:

- Each registry entry lists the registered modules it imports statically (`deps`), so they
  load and initialize first. `test/routeModules.test.js` checks this against the real
  import lines, and fails if a shell module or the core graph statically imports a route
  module (that would pull the route's whole graph onto every page).
- `app-events.js` and the route-scoped `media-detail-events.js` reach route modules only through
  `lazyExport()` (actions: loads the module on first use) and `ifLoaded()` (renders and
  cleanups: never triggers a load). A synchronous read of another module (for example the
  watch-date reference or edit-date options) must `await loadRouteModules([...])` first.
  `media-detail-events.js` also owns the watch-date prompt's click and change handlers, so
  `watch-action` lists it as a dependency: a prompt opened from a dashboard card menu would
  otherwise have a dead X and dead date presets.
- Each route-module export used by `app.js` is a `let` holding a no-op placeholder until its
  module loads. **Never hand one to another module by value**: that module keeps the
  placeholder forever. Pass `live(() => name)` for renders or `viaModule(key, () => name)`
  for actions. A placeholder whose result is chained with `.then`/`.catch` must be
  `lazyNoopAsync`. `test/frontendLazyGraph.test.js` enforces all three.
- Each route module is initialized once, by its entry in `ROUTE_MODULE_INITIALIZERS`.
  `loadSavedConfig()` waits for the document-wide shell modules; Settings-only initializers
  apply the already-fetched config when that route is opened, so other routes do not download
  or poll those controls.
- Until the shell modules are ready, `installEarlyActivationCapture()` (in
  `route-modules.js`, next to `ensureShellModules()`) holds the last click
  or form submit and replays it afterwards. It never lets a form fall back to a native GET
  submit.
- The theme is applied before first paint by `theme-boot.js`, a blocking classic script in
  `<head>`. Header logos (`img[data-theme-logo]`) have no `src` in `index.html`; the boot
  script assigns the variant for the saved or system theme as each one is parsed, so a load
  requests exactly one logo whatever the combination of saved theme and system preference.
  The two logo URLs and the fonts are versioned (`?v=`) like other assets, so production
  caches them immutably and a theme toggle is served from cache.
- Every dynamic import carries the canonical `?v=` token. `assets:check` fails an unstamped
  or stale one (`test/assetVersionDynamicImports.test.js`).
- Detail pages mark `plembfin:detail-primary-ready` (`markDetailPrimaryReady()` in
  `media-detail-shared.js`) when title, artwork, synopsis, watch state, and primary actions
  are rendered from real data. The application-speed benchmark reads it.

## State

One global `state` object (`modules/state.js`) holds everything: active view, auth
state, loaded data (history, movies, shows, stats, sessions), paging offsets, caches
(poster lookups, TMDB details, explorer pages), UI toggles, and timers. The `elements`
object holds the DOM references bound at startup. Nothing is reactive - rendering is
manual: change state, call the relevant `renderX()`.

Preferences persist in localStorage under `plembfin:*` keys (view modes, sort orders,
filters, theme, cached pages); the constants at the top of `state.js` list them all.

Two of those caches exist to stop one page load asking for the same thing repeatedly.
`state.showDetailCache`/`showDetailAliases` index a resolved show under every
identifier it is known by, so the detail page's separate lookups by TMDB id, TVDB id
and title share one `/api/show` answer. Both are short-lived and cleared by
`clearDerivedUiCaches()`, because that response carries authoritative watch state.

Explorer paging appends only the newly loaded cards rather than re-rendering the whole
accumulated list, guarded by a check that the grid on screen still matches the prefix
already rendered; anything else (sort, view change, refresh) falls back to a full
redraw.

## Routing

SPA navigation via `history.pushState`:

- `navigateTo(url)` - pushes state, resets the shell and nested view scroll positions,
  then routes so every page entry starts with fresh controls and a clean viewport.
  The shell reset is repeated after the active view paints and after any lazy route
  modules replay the route, so replacing a page cannot restore the previous page's
  scroll offset. Explicit hash anchors and Upcoming's current-week anchor keep their
  intentional destinations.
- `handleRouting(path)` (`app.js`) - parses the URL into `state.activeView` (+ mode/
  detail state) and calls the right opener. Routes:

| URL | View |
| --- | --- |
| `/`, `/dashboard` | Dashboard |
| `/movies`, `/tvshows` | Explorer in movies/shows mode |
| `/upcoming` | Upcoming TV episode calendar |
| `/discover` | Deterministic TMDB discovery feeds |
| `/watchlist`, `/ratings`, `/custom-lists` | Personal watchlist, ratings, and custom lists |
| `/history`, `/stats`, `/search?q=` | History / Stats / Search |
| `/sync-activity` | Sync Activity: per-media sync rows, newest first |
| `/settings`, `/settings/:section` | Settings landing list and parent-group administration sections; child sections use `#hash` anchors |
| `/sync`, `/logs`, retired grouped `/settings/*` URLs | Compatibility aliases normalized to supported settings sections |
| `/movie/:idOrSlug`, `/movie/tmdb/:id(-slug)` | Movie detail (inline in explorer) |
| `/tvshow/:key(/season/:n(/episode/:n))`, `/tvshow/tmdb/:id(-slug)`, `/tvshow/tvdb/:id(-slug)` | Show detail, with season/episode deep links (legacy `#seasonNepM` hash also parsed). The `tvdb` form addresses series TMDB has no record of |
| `/person/:id` | Person profile |
| anything else | Dashboard |

The optional `-slug` after a `tmdb`/`tvdb` route's numeric id (e.g.
`tmdb/202555-daredevil-born-again`) is purely decorative, generated by
`tvShowTmdbHref()` / `tvShowTvdbHref()` / `movieTmdbHref()` in `modules/utils.js`
wherever such a link is built - the id alone resolves the route, so old links without
one still work. It's never treated as identity on its own, so two different real
titles that happen to collide (a reboot sharing a name with its original) can't be
confused. `/tvshow/:key` resolves the same way it always has (matching a locally
known show, then falling back through `/api/show`), but once it has a provider id it
delegates into the same TMDB/TVDB fetch-and-render pipeline the `tmdb`/`tvdb` routes
use, instead of a separate lighter render that never fetched season-level episode
metadata - so all three routes load identical data for the same show, they just
differ in which id (if any) is already known when the page opens. `state.activeShowModalKey`
stays set to the slug throughout, so the address bar keeps the `/tvshow/:key` form.

- `applyActiveView()` toggles the `view-panel` sections, triggers each view's loader,
  and resyncs the topbar (title, back button, and which control group is mounted) so a
  view reached through `popstate` gets the same chrome as one reached through a nav tab;
  `selectView(view)` is the nav-tab entry point (and enforces the forced-password-change
  pin to Settings).
- Detail pages record `state.mediaDetailReturnView` and
  `state.mediaDetailReturnExplorerMode` so closing returns to where the user came from.
  The return library follows the route type: a `/tvshow/…` URL returns to the shows
  library and a `/movie/…` URL to the movies library, so a detail page opened from a
  direct URL still returns to the matching grid. Closing navigates rather than only
  re-rendering, which keeps the address bar and the topbar controls in step with the
  view. `state.internalHistoryCount` tracks how deep in-app history goes so back-button
  behavior stays sane.
- `modules/settings-shell.js` is the settings route registry. It resolves flat sections
  and legacy aliases, renders the landing list/sidebar/mobile selector, and applies
  focused panel visibility.
- `popstate` re-runs `handleRouting` for browser back/forward; direct URL loads hydrate
  the same UI (the server falls back to `index.html` for any non-API path).
- `modules/live-updates.js` coordinates its streaming `/api/live-updates` request with
  the browser Web Locks API, so only one Plembfin tab holds the long-lived HTTP
  connection. Other tabs load through the normal connection pool and automatically
  take ownership when the stream-owning tab closes or becomes unavailable.

## Startup sequence (`app.js` bottom + `init` functions)

1. Theme applied from `plembfin:theme` (or `prefers-color-scheme`); warm-up ping to
   `/api/ping`.
2. `bindElements()` populates `elements`.
3. Each module's `init*(callbacks)` is called, handing it the app-level functions it
   may call (`navigateTo`, `setMessage`, `renderExplorer`, …).
4. `initAppEvents` (`modules/app-events.js`) binds the delegated global handlers
  (nav clicks, form submits, search inputs, keyboard shortcuts). Sync Activity's
  pause, refresh, retry-all, failed-only, search, paging, retry, match-fix, dismiss, log, and row-keyboard handlers are
   initialized by `sync-activity.js` only when that route module loads. Explorer/History
   controls and Stats filters/link handlers are initialized by their owning route modules.
5. `onAuthChange` checks `/api/auth/status`; on success the shell shows,
   `handleRouting(location.pathname)` runs, and the active view loads.

## Data-loading conventions

- Loaders are idempotent and guarded (`state.xLoading`, `state.xLoaded`,
  `{ force }` options) so view switches don't stampede the API.
- Personal Rating Sync is an authenticated settings module with its own status
  polling and queue feedback; it does not reuse the watched-state sync activity
  indicator or Force Sync operation state.
- Infinite scroll uses IntersectionObserver sentinels (1200px rootMargin, 240-item
  pages) for vertical views; the mobile History card rail loads its next page when
  the user reaches the right edge so horizontal layout does not eagerly fetch the
  complete log.
- Poster hydration is observer-gated and cached - see
  [posters-artwork.md](posters-artwork.md).
- Now Playing polls only while the dashboard is visible - see
  [now-playing.md](now-playing.md).
- Upcoming loads one month at a time through `/api/upcoming`, growing the rendered range
  by a month as the user scrolls toward either end; server-side month results persist
  locally across restarts, while search can prefetch the next 12 months to list matches
  outside the visible range - see [upcoming.md](upcoming.md).
- Up Next loads through `/api/up-next` only while the dashboard is visible, hydrates a
24-hour `plembfin:upNextCache:v6` localStorage snapshot for instant first paint, and
  uses a durable mixed movie/episode server snapshot with stale-while-revalidate. Resume
  cards are ordered by canonical progress updates and released provider/local `next_up`
  cards follow a stable order; a matching resume/next-up observation renders once. A
  changed Up Next snapshot announces its generation on `/api/live-updates`, and feed
  failures/partial refreshes expose source status while retaining the last good rows.
  Watch-state history events refresh the rail after the authoritative history snapshot
  arrives. Only the dashboard's first paint of a page load sends `allowStale=1`, which may
  return a snapshot built before the latest watch history. The server always queues a
  rebuild in that case (bypassing its 10-minute provider-feed throttle), and the client asks
  once more about 2.5 s later without `allowStale`, so a stale first paint is always replaced
  by the authoritative rail. Discover loads cached TMDB feeds and a bounded rolling-12-month watch-history recommendation rail
  through `/api/discover` with type/genre filters and a longer TTL, hydrates the selected rail
  set from a bounded localStorage cache for the first paint, then reconciles it with the server
  cache. Watched titles are removed from every rail using provider identity and title fallback.
  A stale server snapshot is served immediately and refreshed in the background; changed
  snapshots announce a Discover version on `/api/live-updates`, while watch-state events
  refresh the personalized rail without clearing the rendered cards. Both modules preserve
  rendered data while a refresh is in flight and expose loading, empty, stale, and error states.
- Long-lived caches (explorer pages, dashboard history, Up Next, poster lookups, and
  Discover rail snapshots) persist to localStorage with TTLs and versioned keys; bump the
  key version when the cached shape changes.
- `modules/live-updates.js` keeps an authenticated streaming `fetch` open to
  `/api/live-updates`. A shared SQLite data version lets web and worker processes
  announce committed watch-state and personal-media changes, while separate Discover
  and Up Next cache generations announce changed derived snapshots. The client debounces
  bursts and reloads the affected active view in place, then reconnects after a dropped
  stream.
- Watchlist mutations are local-first: the Watchlist page and detail cards update after
  the local transaction and show `Saved locally` or provider queue feedback without
  waiting on a remote API call. The same live refresh path reloads Watchlist cards when
  a provider-originated removal or a completed watch changes the canonical list.

### Personal media organization

The personal media module backs the Watchlist, Ratings, and Custom Lists pages, as well
as the personal actions on movie and TV show detail pages. Watchlist and custom-list
membership use provider identity when available, with normalized title/year matching as
a fallback. Detail-page actions update their labels immediately after a successful
change; an existing watchlist item offers removal, while the custom-list chooser marks
each list that already contains the title as **Added**. Custom Lists renders every named
collection as its own horizontal media rail, keeps up to four rails in the desktop viewport,
and places additional rails below. Vertical mouse-wheel input enters a rail only after the
pointer has stopped over it, preserving normal page scrolling while the pointer is moving.

Movie and TV ratings use their provider identity. An episode rating originates from
the episode row on the show detail page and is keyed by the parent show's identity
plus its season and episode number. The Ratings page consumes the canonical server
record, while the client also collapses any legacy aliases defensively. Episode
artwork remains independent from the show's poster.

### Plex Watchlist Sync settings

The Plex Watchlist Sync panel lives in Settings → Sync → Sync Tools and is rendered by
`watchlist-sync-settings.js`. It exposes an on/off control, a read-only summary of the
Plex connection, and a **Sync now** button in the bottom right of the panel's action row
(the Personal Rating Sync panel above it carries the same control in the same place). Status polling reports the sync state and Plex
capability. Enabling it immediately starts a safe-union sync, so Plex-only additions are
imported without allowing an empty first snapshot to erase Plembfin.

The same `watchlistSync.enabled` flag has two other entry points, so all three stay in
step through the `plembfin:config-changed` event: the Plex card under Media Servers
(an `extraToggles` entry on `renderInlineServicePanel`, which saves on change because the
card's Save button only submits connection fields) and the Plex row of guided setup
(checked by default, applied when that step completes).

The panel writes its live one-line state to `#watchlistSyncSummary`, never to
`#watchlistSyncHelp` - the latter belongs to `renderSettingsInlineHelp`'s static guide, and
when both wrote to one element the 30-second status poll destroyed the guide every time.

At mobile widths, Discover, Watchlist, Ratings, Custom Lists, and History use the
dashboard's compact poster-first card geometry. Each feed or collection is a
horizontal rail that exposes the next card at the right edge, while the card's
metadata and actions remain below its poster inside the tile.

The mobile page topbar mounts only the active page's controls. Explorer and Upcoming
control groups keep their hidden state when they are moved into the shared topbar, so
their search/calendar controls cannot leak onto Discover, personal-media, History,
Stats, or Settings pages. Upcoming, Discover, Watchlist, Ratings, Custom Lists, History,
Stats, and Settings use the same media-detail-style icon/label action strip; secondary
filters, search, sizing, and settings-section controls live in a compact Options disclosure.
Calendar navigation remains visible for Upcoming, while the other page controls keep the
same compact action geometry without squeezing a full desktop form into the phone width.

## Settings Layout & Design Standards

These are canonical values for the settings UI - do not change them without explicit user instruction.

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

All of the following must stay consistent - do not change one without updating the others.

| Element | Property | Value | Notes |
|---|---|---|---|
| `.app-shell` | `gap` | `var(--space-3)` | Gap between topbar and view content |
| `.page-topbar + .view-panel` | `padding-top` | `var(--space-2)` | Extra breathing room below topbar |
| `.settings-content` | `gap` | `var(--space-3)` | Gap between settings panes when stacked |
| `.settings-pane` | `gap` | `var(--space-3)` | Gap between `.settings-row` elements |
| `.settings-row` | `gap` | `var(--space-3)` | Gap between left (main) and right (help) columns - **must equal the topbar gap** |
| `.settings-row-main` | `gap` | `var(--space-3)` | Gap between stacked cards inside main column |
| `.settings-row-help` | `gap` | `var(--space-3)` | Gap between stacked cards inside help column |
| `.settings-card` | `padding` | `1.5rem` (help column) / `0` (main column) | See "Settings Card Shell" below - the main-column value comes from a more specific override |

### Spacing Rules

1. **Every structural layout gap in the settings shell uses `var(--space-3)` = 0.75rem.** This applies to `.settings-content`, `.settings-pane`, `.settings-row`, `.settings-row-main`, and `.settings-row-help` - all must use the same token so topbar gap, horizontal gap, and vertical section gaps are visually identical.
2. **Card internal padding differs by column.** The base `.settings-card { padding: 1.5rem !important }` rule applies as written to help-column cards (`.settings-row-help > .settings-card`). Inside the main column, `.settings-pane .settings-row-main > :is(.settings-card, .sync-panel, .logs-panel, .backup-settings-panel)` is more specific and overrides it to `padding: 0 !important`, moving the padding onto the child `.section-heading` and content wrapper instead - see "Settings Card Shell" below for the full structure.
3. **Never add per-panel margin or gap overrides** (e.g. `margin-top` on a specific `settings-pane[data-settings-panel]` selector). All spacing must come from the flex gap alone.
4. **Do not merge `.app-shell` into a shared selector with `.view-panel`** - `.app-shell` needs `gap: var(--space-3)` while `.view-panel` needs `gap: 0`. Merging them collapses the topbar into the page content.

### Settings Card Shell

The Sync Tools section is the reference implementation for the primary settings card
shell in the main column. Sync Tuning, Sync Issues, and Sync History share the exact
same layout system, spacing, and styling rules, and the same shell applies across every
settings panel: Account, Media Servers, Seerr, Webhooks, Metadata Providers, Refresh
Metadata, System Integrity, Trakt, Database Repairs, Rebuilds, Backups, Restore, Sync
Tuning, Sync Tools, Sync Issues, Sync History, Server Logs, Changelog, and Image Cache.

Each settings page uses this canonical DOM hierarchy:

```html
<div class="settings-pane">
  <div class="settings-row" data-sub-panel="[panel-id]">
    <div class="settings-row-main">
      <article class="glass-panel p-section settings-card tool-section-card">
        <div class="section-heading sync-heading sync-static-heading">
          <div class="sync-heading-title">
            <p style="margin: 0;">[Title]</p>
            <!-- Optional status pill -->
            <span class="status-pill status-muted">Ready</span>
          </div>
          <span>[Description / Subtitle]</span>
        </div>
        <div class="media-force-sync-options sync-tools-content">
          <!-- Content rows / forms / action items -->
        </div>
      </article>
    </div>
    <div class="settings-row-help">
      <article class="glass-panel p-section settings-card">
        <div class="section-heading">
          <p>[Help Title]</p>
          <span>[Help Subtitle]</span>
        </div>
        <!-- Help sections -->
      </article>
    </div>
  </div>
</div>
```

The main column (`.settings-row-main`) is the primary working area (~2.2fr flex ratio).
The help column (`.settings-row-help`) explains the working area (~1fr flex ratio,
~320px fixed reference) and collapses below `900px`.

**Main settings card** - the primary card follows the canonical Sync Tools shell:

- Full-width `<article class="glass-panel p-section settings-card tool-section-card">` inside `.settings-row-main`.
- Outer card padding removed (`padding: 0 !important`) and `gap: 0 !important` so the heading and content form one continuous panel.
- `overflow: hidden` so the header border and rounded corners stay clean.
- `border: 1px solid var(--line-strong)` and `background: var(--panel)` for the outer card surface.
- `border-radius: var(--radius)` (8px default).

**Card heading** - the first direct child is the section heading:

- `<div class="section-heading sync-heading sync-static-heading">`.
- Title and optional status pill grouped on the left inside `<div class="sync-heading-title">`; supporting description `<span>` on the right.
- `padding: var(--space-3) !important` (16px / `1rem`), `margin: 0 !important`, bottom border `1px solid var(--line) !important`.
- Title text: `<p style="margin: 0;">` with `font-weight: 700`.
- Supporting subtitle `<span>`: `var(--muted)`, `0.78rem` (`font-weight: 500`), right-aligned on wide screens.
- Accordion header toggles (e.g. Sync History) use `<button class="section-heading sync-heading sync-static-heading accordion-header" type="button">` with `background: transparent; border: none; width: 100%; cursor: pointer;`.

**Card content** - every content wrapper immediately following the heading:

- `<div class="media-force-sync-options sync-tools-content">`.
- `padding: var(--space-3) !important` (16px); child rows use `gap: var(--space-2) !important` (12px).
- Content elements have `margin-top: 0 !important` to avoid doubling the flex gap.

**Action rows, fields, and controls** - action rows, tuning fields, issue items, match reports, and history cards use the standard Sync Tools treatment:

- Full border `1px solid var(--line)`, `border-radius: var(--radius)` (8px), `background: var(--panel-2)`, `padding: var(--space-3)` (16px).
- `:hover` and `:focus-within` change border to `var(--blue)` and background to `var(--panel-3)` with `transition: border-color 160ms ease, background 160ms ease`.
- Descriptions stay left-aligned and use the available width before wrapping.

Field layout and multi-line help formatting (Sync Tuning):

- Settings input fields use a 2-column CSS Grid: `display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 13rem); align-items: center; gap: var(--space-3);`, collapsing to a single column below `760px`.
- Field title: `color: var(--text)`, `font-weight: 700`.
- Field help text with a default/range uses explicit `<br>` line breaks and `helpIsHtml: true`:
  ```html
  <span class="settings-field-help">
    [Description].<br>
    Default: [default value]. Valid range: [min]-[max].
  </span>
  ```
  Color `var(--muted)`, `font-size: inherit`, `line-height: 1.45`, `max-width: none`.

Buttons (`.sync-tool-button`, `.button-primary`, `.button-ghost`, `.sync-action-btn`):

- `min-height: 2.05rem !important` (~33px), `padding: 0.45rem 0.72rem !important`.
- `font-size: 0.78rem !important`, `font-weight: 800 !important`, `letter-spacing: 0 !important`, `border-radius: 4px !important`, `box-shadow: none !important`.
- Primary actions use `.button-primary` (blue accent). Cancel/stop actions use `.sync-tools-cancel-button` or `.button-danger` with red OKLCH tinting: border `color-mix(in oklch, var(--red) 55%, var(--line-strong))`, background `color-mix(in oklch, var(--red) 14%, var(--panel-2))`, color `var(--red)`.

Responsive behavior:

- Below `900px`, `.settings-row-main` stacks above `.settings-row-help` at full width.
- Below `760px`: section headings stack (`flex-direction: column`, `align-items: flex-start`) with left-aligned subtitle text; action buttons stack full-width; grid rows (target rows, tuning fields) collapse to a single column.
- The same heading, border, background, and padding hierarchy is preserved in both dark and light themes.

**Implementation rule**: when adding or updating a settings page, use the shared main-card shell (`article.glass-panel.p-section.settings-card.tool-section-card`) and the Sync Tools structure first. Add a component-specific rule only when the content cannot fit the standard heading/content/action-row pattern, and document the exception beside the component styles.

### Settings Navigation Rules

5. **All settings navigation links** (sidebar buttons, overview link rows, section-select dropdown options) must navigate to the **parent group path**, with an optional child `#hash` anchor (for example `/settings/sync#full-sync-watchstates`). Child anchors identify the in-page section on the parent route.
6. **`focusSettingsRoute`** must scroll the `.page-shell` container to the selected section while respecting its scroll margin; a route without a hash should start at the top of the parent group page.

## Where new frontend code goes

Place new frontend code in the most specific existing module that owns its feature area.
The size limits and grandfathered files that constrain these modules are in `CLAUDE.md`
("Module discipline"); new code for an over-limit file goes into a sibling module instead.

| Feature area | Module |
| --- | --- |
| Formatting, string escaping, date helpers | `modules/utils.js` |
| Poster URLs, image caching, `posterMarkup` | `modules/images.js` |
| Static help/guide HTML | `modules/help-content.js` |
| Always-available appearance preferences | `modules/appearance.js` |
| Always-available sync/manual-review indicators and compact status summaries | `modules/status-indicators.js` |
| Core movie lookups and Now Playing route links | `modules/media-routing.js` |
| Core deferred cast disclosure markup and focus handling | `modules/cast-disclosure.js` |
| Sync status, sync history, now-playing polling | `modules/sync.js`, `modules/sync-preview.js` |
| Sync Activity page (`/sync-activity`), including its route-scoped action/event handlers | `modules/sync-activity.js` |
| Dashboard rendering | `modules/dashboard.js` |
| Shared media identity/deduplication | `modules/media-records.js` |
| Stats rendering | `modules/stats.js` |
| Explorer grid, history page, search page | `modules/explorer.js` |
| Upcoming page (scrolling month calendar of upcoming episode air dates) | `modules/upcoming.js` |
| Up Next rail, provider push, dismissed-items dialog | `modules/up-next.js` |
| Up Next show identity, same-title show veto, dismissal keys, and action markup | `modules/up-next-shared.js` |
| Personal ratings/watchlist/custom-list metadata fill (overview, release date) | `modules/personal-media-metadata.js` |
| Backup/restore tools (Settings route) | `modules/tools-backups.js` |
| Settings changelog renderer and Main/Alpha tabs (build-version display formatting is core, in `modules/utils.js`) | `modules/changelog-channels.js` |
| TV/movie detail entry points, lookups, modal-close routing | `modules/media-detail.js` |
| Detail-modal shell/context: callbacks, `authHeaders`, modal DOM root, render-token, debug modal | `modules/media-detail-context.js` |
| Detail-page watch and sync info summary rendering | `modules/media-info-summary.js` |
| Route-scoped shared TMDB/Seerr rendering fragments (cast, trailers, images, ratings, recommendations) | `modules/media-detail-shared.js` |
| TV show detail rendering (seasons, episodes, show modal) | `modules/media-detail-show.js` |
| Movie detail rendering | `modules/media-detail-movie.js` |
| Person profiles and filmography | `modules/media-person.js` |
| Edit dialogs and watched-date/image/match tools | `modules/edit-dialogs.js` |
| Manual watched/unwatched actions | `modules/watch-action.js` |
| Shared calendar/time picker (used by edit dialogs and mark-watched prompts) | `modules/calendar-picker.js` |
| TMDB detail/season/person enrichment helpers | `modules/tmdb.js` |
| Trailer playback and photo lightbox | `modules/media-lightbox.js` |
| Trakt/CSV import and settings tools bridge | `modules/tools.js` |
| Tautulli connection and one-time watch-history importer | `modules/settings-services.js`, `modules/tautulli-import.js` |
| Live Trakt connection and initial-sync controls | `modules/tracker-settings.js` |
| Authenticated live watch-state refresh stream | `modules/live-updates.js` |
| Backup tools and appearance save actions | `modules/tools-backups.js`; `modules/appearance.js` owns the always-available defaults/body/loading helper |
| Maintenance diagnostics, cache tools, sync repair tools, and sync health | `modules/tools-maintenance.js`, `modules/tools-health.js` |
| Library-wide duplicate-watch cleanup (Settings → Tools → Database Repairs) | `modules/tools-duplicates.js` |
| Watch-state aliases card: fold or dismiss unproven episode-id playstate rows (Settings → Tools → Database Repairs) | `modules/tools-playstate-aliases.js` |
| Wipe data (Settings → Tools → Wipe data): watch history, sync history/logs, and full factory reset | `modules/tools-wipe-data.js` |
| Auth, session, tokens | `modules/auth.js` |
| Guided first-run setup (`/setup`), account-claim form wiring, dashboard checklist, Settings resume banner | `modules/onboarding.js` |
| Debug/diagnostic logs & telemetry export | `modules/logs.js` (categorization, local time formatting, export) |
| Connection label formatting | `modules/settings.js` |
| Shared settings modal, picker, and card-grid primitives | `modules/settings-ui.js` |
| Media-server and metadata-provider settings cards/modals | `modules/settings-services.js` |
| Personal Rating Sync settings, provider directions, status polling, and manual actions | `modules/rating-sync-settings.js` |
| Flat settings routes, landing list, sidebar, help panels, and clean path routing (`/settings/media-servers`, `/settings/sync`, etc.) | `modules/settings-shell.js` |
| Shared `state` and `elements` objects | `modules/state.js` |
| Global app event wiring | `modules/app-events.js` |
| Settings-page event wiring (logs, admin login/webhook secret, import, backups, maintenance tools, sync controls), loaded with the Settings route | `modules/settings-events.js` |
| Media-detail modal click delegation (cast/trailers/poster edit/watch actions/card navigation) | `modules/media-detail-events.js` |
| Shared copy for the Plex historical watched-sync setting (setup wizard and Sync Tuning) | `modules/plex-history-policy.js` |
| Poster-card three-dot overflow menu (Mark Unwatched / Edit watch date / Fix match) outside the media detail pages | `modules/poster-menu.js` |
| Route-module registry: on-demand `import()` loaders, dependency order, `lazyExport`/`ifLoaded`, shell-module readiness and early click/submit hold-and-replay | `modules/route-modules.js` |
| App startup, routing, `bindElements` | `app.js` |

Create a new module only when the feature area fits none of these and would exceed 150
lines, then add it to this table.

## Adding a new module

1. Create `public/modules/<feature>.js` with named ES exports.
2. If the module is part of the core graph (needed for the first paint), add
   `<link rel="modulepreload" href="/modules/<feature>.js" />` to `index.html`. A route,
   dialog, or tool module is instead registered in `route-modules.js` (see "Core graph and
   route modules" above) and gets no preload.
3. Import it in `app.js` (or the owning module) and, if it needs app-level functions,
   give it an `init<Feature>(callbacks)` entry point.
4. Add the module to the file map in [architecture.md](architecture.md) and the relevant
   feature documentation.

### Cache-busting version strings

Every local bundle, stylesheet, icon, and manifest reference under `public/` carries the
same `?v=<package-version>` token. A module URL is a module identity to the browser: the
same file imported under two different suffixes is loaded and instantiated twice, so any
module-level state exists twice over. The `assets:check` build guard rejects both bare local
asset references and mismatched tokens, and it checks URLs assembled at runtime as well as
fully literal ones.

Build an icon URL through `platformIconUrl()` in `utils.js` rather than writing the path
inline, and never render an icon URL that arrived from the server or from a persisted cache.
Markup held in `localStorage` outlives the release that produced it, so a stored URL pins an
old asset version indefinitely; rebuilding the markup from the platform target keeps every
reference on the current one.

When the package version changes, run `npm run assets:update`. It rewrites every local
reference and its `modulepreload` link in `index.html` together, so the whole app keeps
referring to one URL per module. Do not hand-bump one import or preload in isolation.

The server compresses eligible API and static responses when the client requests gzip.
`index.html` and managed public assets use revalidation rather than a long-lived cache
policy, while the authenticated live-update stream remains uncompressed and carries
`Cache-Control: no-cache, no-transform`. A reverse proxy may be selected by the operator,
but it must not recompress an already encoded response or transform the live stream.
