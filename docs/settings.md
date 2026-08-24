# Settings

Settings is a hierarchical, task-oriented administration area modeled on Sonarr. The
sidebar groups related sections under a bold parent heading; clicking a parent or a
child scrolls to that section on the parent's own aggregated page rather than opening a
separate screen. `/settings` itself shows a plain overview list grouped the same way.
Desktop renders the grouped sidebar; mobile uses the **Settings section** select control
(a flat list of options under `<optgroup>` headings matching the sidebar groups).

| Group (parent) | Child sections | Navigation route(s) |
| --- | --- | --- |
| General | Account, System Integrity Check, Storage & Cache | `/settings/general#account`, `/settings/general#health`, `/settings/general#storage` |
| Media Servers | Media Servers, Seerr, Webhooks | `/settings/media-servers#media-servers`, `/settings/media-servers#seerr`, `/settings/media-servers#webhooks` |
| Connections | Trakt | `/settings/import` |
| Metadata | Metadata Providers, Refresh Metadata (TMDB, TVDB) | `/settings/metadata#metadata-providers`, `/settings/metadata#refresh-metadata` |
| Sync | Sync Tuning, Sync Tools (Repair Recent Items, Full Sync Watchstates, Force Sync), Sync Issues, Sync History | `/settings/sync#sync-tuning`, `/settings/sync#sync-tools`, `/settings/sync#sync-issues`, `/settings/sync#sync-history` |
| Backup / Restore | Backup Settings (Local, Remote), Restore (Local, Remote) | `/settings/backup-restore#backups`, `/settings/backup-restore#restore` |
| Tools | Database Repairs, Library Rebuilds and Backfills | `/settings/tools#database-repairs`, `/settings/tools#library-rebuilds` |
| Logs | Logs | `/settings/logs` |
| About | About | `/settings/about` |

The left sidebar navigation displays parent menu groups by default, collapsing child sections and sub-sections until that parent section page is active. Every child section is display-only: its sidebar button navigates to the parent group's path with the section id appended as a URL hash (`#health`), then scrolls that specific section into view. The parent's page always renders every child's content stacked together - clicking a child is a same-page jump, not a different screen. Logs is a single-child group of its own (promoted to a top-level sidebar entry, since its content shares no panel with Health or Storage & Cache). Use the parent-and-hash routes above when documenting or linking to a child tool; for example, Full Sync Watchstates is `/settings/sync#full-sync-watchstates`.

The Import page also owns the live bidirectional Trakt connection. Plembfin ships a
device application in the same model as the Jellyfin Trakt plugin, so the normal flow
asks only for the initial-sync policy and then displays a Trakt authorization code.
`TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` can override the bundled application for
rotation or a private deployment. The advanced personal-app fields remain a fallback
for Trakt VIP developers and their values are encrypted at rest.

Media Servers uses account setup by default and keeps manual credentials as an optional
fallback. Plex signs in through Plex, verifies the selected server, and maintains an
encrypted account/server token pair. Emby exchanges a server URL, username, and password
for an encrypted user-scoped token without storing the password. Jellyfin prefers Quick
Connect and also supports a one-time username/password exchange when Quick Connect is
disabled. Manual mode accepts the traditional token/API-key fields. Each provider has
exactly one active mode: completing account setup removes its stored manual secret, and
saving manual setup changes that provider back to manual mode.

After its initial baseline or full-history import, the Trakt connection reads the complete
watched snapshot every minute. Added watches, timestamp changes (rewatches), and removed
watches enter the same synchronization pipeline as media-server and Plembfin actions, so
watched and unwatched state converges everywhere. Emby and Jellyfin Trakt plugins should
be disabled to keep Plembfin as the sole Trakt bridge. The browser subscribes to an
authenticated update stream and refreshes the active page as imported changes commit.

Full Sync Watchstates replays Plembfin's canonical watched and resume rows in two phases. It takes a fixed snapshot for each phase, temporarily suppresses inbound media-server callbacks and scheduled catch-up work, and shows rows processed, throughput, and an estimated remaining time. The shared sync-operation lock prevents it from overlapping Force Sync or a backup restore. The Stop Restore control cancels future batches; already completed batches remain applied. Reset Restore Lock is an administrator-confirmed recovery action for a run abandoned by a browser or server restart; it stops any in-flight restore before allowing another run to start.

Force Sync contains the same two controls and live activity terminal used by media detail
pages. The controls stay inline in the Force Sync box. Each action asks for confirmation
before it starts, and the activity header exposes **Cancel operation** while a run is in
progress. A confirmed plan's actions run with bounded concurrency (independent library
items in flight together, capped per destination server by the outbound pacing profile so
it speeds up a large plan without sending more simultaneous requests to any one server).
Cancellation stops any items that have not yet started; items already in flight finish and
their writes remain applied.
**Set Plembfin as Source of Truth** replays Plembfin's watched playstate (and saved resume
positions) to one destination or all destinations, overwriting whatever they currently
show - it does not check their current state first.
**Import Watched Status** scans the configured Plex, Emby, and Jellyfin libraries for
watched items and adds anything Plembfin doesn't already have, without sending anything
back out or removing anything.
Both operations are library-wide, and status is polled through the shared Force Sync
activity ledger until each completes.

## Multi-view aggregation

A parent group's page can pull content from more than one underlying panel or backup
tab. Each group definition in `settings-shell.js` carries a `views` array (or, for
single-panel groups, a flat `panel`/`subPanels`/`backupTab` that `sectionRoute()`
wraps into a one-item `views` array automatically):

| Group | Views |
| --- | --- |
| General | `general` panel's Account, System Integrity (`tools-diagnostics`), and Image Cache (`cache`) rows |
| Media Servers | `apps` panel's Media Servers and Seerr sections, then the `general` panel's `general-endpoints` row (Webhooks) |
| Backup / Restore | `backups` panel's `settings` tab, then its `restore` tab |

`applySettingsRoute()` iterates every view in the route and reveals each one's panel,
sub-panel rows, and (for the backups panel) accumulates every requested `backupTab`
into a set before hiding any backup panel not in that set - so Backup and Restore can
be shown together without either one clobbering the other's visibility. Post-route
data loaders in `app.js` (media-server cards, sync jobs/history, watch backups, cache
stats, logs, changelog) check membership across the whole `route.views` list, not just
the route's primary panel, so a loader for a panel that only appears as a secondary
view (e.g. the `cache` panel inside Advanced) still runs.

## Section-scoped scrolling

Clicking a child section calls `scrollToSettingsSection(sectionId)`
(`settings-shell.js`), which resolves the section to a DOM element and calls
`scrollIntoView({ behavior: "smooth", block: "start" })` on it:

- If the section's first sub-panel is wrapped in a `<details class="settings-disclosure">`
  accordion (Database Repairs / Library Rebuilds inside the Tools panel), the *disclosure
  wrapper* is the scroll target, not the bare row - otherwise the scroll would land past
  the section's own heading (the heading lives in the synthetic `<summary>`, not the row).
- Otherwise it falls back to the `[data-sub-panel]` row, the backup-tab-qualified panel,
  or the plain panel element, in that order.

`.settings-pane`, `.settings-row`, and `.settings-disclosure` all carry
`scroll-margin-top: calc(var(--right-topbar-height) + var(--space-3))` so the sticky
`.page-topbar` (which sits at `position: sticky; top: 0` inside the scrolling
`.page-shell` container) never covers the section that was just scrolled to.

Navigating to a genuinely different settings path (not just a same-page hash jump)
resets `.page-shell`'s scroll position to the top - this targets the actual scrolling
viewport (`.page-shell`, `overflow-y: auto`), not `window`/`body`, since the app shell
itself never scrolls.

## Card and modal workflows

Media servers and metadata providers use card grids. Configured services appear as cards
with status badges; the trailing **+** card opens a provider
picker. Selecting a card opens an edit dialog with aligned label/control rows, inline
help, and Save/Cancel actions. Media-server dialogs also provide **Test** and an Enable
switch. Fixed services can be disabled but not deleted because the config API has no
credential-clear operation.

**Sync Tuning is the one exception**: its four numeric fields (watched threshold,
minimum resume position, active-session TTL, outbound timeout) plus the Fast
Local-Network Sync checkbox render directly inline on the Sync page in a plain form
with its own Save button - not behind a card + edit modal - since there's only ever
one instance to edit and no add/remove/test workflow.

Media Servers is rendered as a boxed settings section with a separate boxed Seerr
subsection and its own left-menu link; its edit modal keeps provider setup help visible
beside the fields on wider screens.
Webhooks shows the current secret, complete webhook URL, and separate Plex, Emby, and
Jellyfin setup guides.

Remote backup destinations use the same card and modal primitives. The Backblaze B2
dialog edits its name, enabled state, region/endpoint, bucket, key ID, optional prefix,
and application key. Save and Test persist the destination before refreshing status;
Delete removes the destination record after confirmation without deleting remote files.

Dialogs are singletons, close on Escape/backdrop/close button, keep their header and
footer visible while the body scrolls, and collapse to stacked fields on mobile.

## Frontend ownership

| File | Role |
| --- | --- |
| `public/modules/settings-shell.js` | Hierarchical section/group registry, multi-view aggregation, legacy aliases, landing list, sidebar, mobile selector, panel visibility, section-scoped scrolling, and tools disclosures |
| `public/modules/settings-ui.js` | Shared edit modal, picker modal, service-card grid, and the `renderFieldRow`/`collectFieldValues` primitives reused by both modal and inline forms |
| `public/modules/settings-services.js` | Media-server and metadata definitions, config saves, connection tests, cards/dialogs, and the inline Sync Tuning form |
| `public/modules/settings.js` | Shared connection-label formatting |
| `public/modules/tools.js` | Trakt import and compatibility exports for backup and maintenance behavior |
| `public/modules/tools-backups.js` | Backup schedules, restore, destination cards/dialogs, and appearance behavior |
| `public/modules/tools-maintenance.js` | Diagnostics, cross-platform match reporting, repairs, backfills, and cache behavior |
| `public/modules/help-content.js` | Credential, webhook, migration, and account setup guides |
| `public/modules/logs.js` / `public/modules/sync.js` | Logs and sync rendering/loaders |
| `public/app.js` | SPA routing, per-view data-loader gating across `route.views`, element binding, and module callback injection |

## Route compatibility

Old bookmarks are normalized with `history.replaceState`:

| Previous route | Canonical route |
| --- | --- |
| `/settings/account/login` | `/settings/account` (UI: `/settings/general#account`) |
| `/settings/apps`, `/settings/connections`, `/settings/connections/:provider` | `/settings/media-servers` |
| `/settings/api-keys`, `/settings/metadata/:provider` | `/settings/metadata` |
| `/settings/connections/webhooks` | `/settings/webhooks` (UI: `/settings/media-servers#webhooks`) |
| `/settings/data`, `/settings/data/backups` | `/settings/backups` (UI: `/settings/backup-restore#backups`) |
| `/settings/data/restore` | `/settings/restore` (UI: `/settings/backup-restore#restore`) |
| `/settings/data/import` | `/settings/import` |
| `/settings/system`, `/settings/system/health` | `/settings/health` (UI: `/settings/advanced#health`) |
| `/settings/system/advanced` | `/settings/database-repairs` (UI: `/settings/tools#database-repairs`) |
| `/sync`, `/settings/sync/issues`, `/settings/system/sync` | `/settings/sync-issues` (UI: `/settings/sync#sync-issues`) |
| `/settings/sync/history` | `/settings/sync-history` (UI: `/settings/sync#sync-history`) |
| `/settings/sync/tuning` | `/settings/sync-tuning` (UI: `/settings/sync#sync-tuning`) |
| `/logs`, `/settings/system/logs` | `/settings/logs` |
| `/settings/cache`, `/settings/system/storage` | `/settings/storage` |
| `/settings/changelog`, `/settings/system/about` | `/settings/about` |

The forced-password-change state always resolves to the Account section (`/settings/account`; the normal sidebar path is `/settings/general#account`).

## Configuration and secrets

Service dialogs post one section at a time to `POST /api/config`. The server merges the
incoming section over stored configuration. Browser-safe responses expose only a
`configured` boolean for secrets, so secret inputs are always blank. A configured field
shows a replacement placeholder; saving or testing with it blank keeps and uses the
stored credential. Seerr and destination secrets are omitted from payloads when blank.

URLs are restricted to HTTP/HTTPS, embedded credentials and cloud-metadata hosts are
rejected, and saved values take precedence over environment defaults. Connection tests
fall back to stored credentials when the modal secret field is blank.

The **Sync Tuning** form (on the Sync page) exposes four optional numeric settings:
watched threshold, minimum resume position, active-session TTL, and outbound request
timeout. Blank fields inherit the matching environment variable or built-in default;
saved values take precedence. The defaults remain 90%, 60 seconds, 5 minutes, and 10
seconds respectively.

The same form's **Fast Local-Network Sync** checkbox controls the outbound pacing
governor's profile (`server/src/utils/outboundGovernor.js`), stored as `pacing.profile`
("standard" or "fast"; also settable via the `OUTBOUND_PACING_PROFILE` environment
variable). It is unchecked by default. Checking it raises the per-destination-server
concurrency limit and removes the delay between requests for Force Sync, Full Sync
Watchstates, and other bulk sync operations, which finishes them much faster - but it
is only safe when Plex, Emby, and Jellyfin are all self-hosted on the same trusted
local network as Plembfin, since it removes most of the throttling that protects a
server reached over the public internet from being overwhelmed by a large sync.

## Maintenance disposition

- System Integrity Check runs the integrity, database, webhook, scheduler, media-server, and
  cross-platform library matching checks.
- Sync combines unresolved jobs, history, repair-recent, force, stop/reset, and refresh.
  The Sync Issues panel also contains the Cross-Platform Match Report (backed by the
  admin-guarded `GET /api/sync-match-report` endpoint), which groups every
  "no matching item found" sync result by platform with per-platform unique-media
  counts, movie/episode splits, and sample rows. See
  [Cross-Platform Match Report](#cross-platform-match-report) for what the two
  failure kinds mean and what each button does.
- Storage & Cache (under Advanced) displays and clears image cache categories.
- Tools retains history repair, deduplication, full watch-state sync, metadata refresh,
  TV rematching, and Trakt poster backfill with their confirmations and logs, split
  across the Database Repairs and Library Rebuilds and Backfills accordions.
- Import owns the Trakt/CSV importer; Backup Settings and Restore own their respective workflows.

No maintenance API or stored media configuration format changes are introduced by the
settings shell.

## Cross-Platform Match Report

The panel lists media Plembfin could not identify - records carrying no IMDB,
TMDB, or TVDB id, where nothing reliable was ever resolved. Picking the right
title fixes these, and the row leaves the list once an id is stamped on it. The
classification reads the record's ids rather than its media key, because the key
is written when the row is created and is not rebuilt when a later Fix Match
resolves an id.

Records that *are* identified and still report "no matching item found" are not
listed. That result means the platform has no copy of the media, which is a
difference between your libraries rather than a fault, and no action in this
panel can change it. Those items need nothing: the watch is recorded correctly in
Plembfin, and if the media is later added to that server it is marked watched
automatically (see [Catching up newly added media](webhooks.md#catching-up-newly-added-media)).
The unfiltered per-platform totals are still returned by
`GET /api/sync-match-report` and reported by Sync Health.

Rows are built from each record's stored `sync_dispatch_telemetry`, so a row only
leaves the report once that record has been dispatched again and reported a
match. Two buttons act on the list:

- **Rescan** re-runs the sync for every listed item and rebuilds the report from
  the results, reporting how many now match. Media a library genuinely does not
  hold stays listed, because that is still true afterwards.
- **Fix All Matches** re-runs the sync first, then queues the still-unmatched
  items for manual matching one at a time. Only unidentified items are queued; an
  item that already knows what it is cannot be repaired by choosing a search
  result, so those are counted in the summary instead of being asked about.

## Server Logs

The **Server Logs** panel (`/settings/logs`) displays real-time and historical diagnostic logs captured by the server alongside browser output. Logs are automatically categorized and can be filtered using interactive tabs:

- **All Logs**: Complete chronological event stream.
- **⚡ Plex WebSockets**: WebSocket connection lifecycle, incoming timeline events, ratingKey extraction, and handler triggers.
- **🔄 Outbound Sync**: Real-time playstate dispatches, watch record insertions, and manual watch/unwatch propagation.
- **⏱️ Scheduled Polls**: Periodic background catch-up library checks, session tracking, and scheduled sync cycles.
- **🖥️ System Logs**: General administrative, startup, and system events.

Log entries feature human-readable timestamps (`YYYY-MM-DD HH:MM:SS`), color-coded category badges (`[PLEX]`, `[SYNC]`, `[POLL]`, `[SYSTEM]`, `[ERROR]`), a live pulsing activity indicator, and glassmorphic styling compatible with both Dark and Light appearance modes. Routine keep-alive recycling and 0-item background sync ticks are filtered out before they are stored, to ensure a high-signal log stream.

Entries are served from the `diagnostic_log` table, so the panel merges output from the web and worker processes and reads at a fixed cost no matter how long the server has been running. The table is a bounded ring buffer; **Clear Logs** empties it. Per-request tracing is off unless `LOG_VERBOSE` is set - see [troubleshooting.md](troubleshooting.md) for what that adds. On-disk JSONL copies under `data/logs` are a crash-forensics archive only, pruned automatically on start.

The panel also appends a browser-side debug log trail below the server entries. That trail has no category of its own, so it only appears under **All Logs** and **System Logs** - the other three tabs show only the matching server-categorized entries, so each tab's content is distinct.

## Settings Layout & Card Standards

All settings pages follow the standard layout established on `/settings/metadata`:

1. **Section Heading Structure (`sync-static-heading`)**:
   - Every settings card uses `<div class="section-heading sync-static-heading"><div><div><p style="margin: 0;">[Title]</p></div><span>[Description]</span></div></div>`.
   - Title is rendered bold on the left (`font-weight: 850; font-size: 0.95rem;`).
   - Description is right-aligned on the right side of the card header (`color: var(--muted); font-size: 0.78rem; text-align: right; flex: 0 1 auto;`).

2. **Card Inner Spacing & Layout**:
   - `.settings-pane` and `.settings-content` use `gap: var(--space-5);` (1.5rem / 24px) vertical spacing between stacked settings rows.
   - All settings cards (`.settings-card`, `.tool-section-card`, `.settings-row-help > article`) use `gap: var(--space-5) !important;` (1.5rem / 24px) inner spacing between title and card content.
   - Card content elements have `margin-top: 0 !important;` to avoid doubling the flex gap.

3. **Help Card Height Constraint (`prepareHelpReadMore`)**:
   - `.settings-row` uses `align-items: flex-start;` so main sections and help boxes size tightly to content without creating empty vertical space.
   - `prepareHelpReadMore()` measures the height of `.settings-row-main` on the left. If the right help box (`.settings-row-help > article`) exceeds the main card height, it auto-collapses with `max-height: ${mainCardHeight}px` and appends a "Read more" toggle button.
   - A `ResizeObserver` monitors main card height changes and updates help box collapse states dynamically.
