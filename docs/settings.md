# Settings

Settings is a hierarchical, task-oriented administration area modeled on Sonarr. The
sidebar groups related sections under a bold parent heading; clicking a parent or a
child scrolls to that section on the parent's own aggregated page rather than opening a
separate screen. `/settings` itself shows a plain overview list grouped the same way.
Desktop renders the grouped sidebar; mobile uses the **Settings section** select control
(a flat list of options under `<optgroup>` headings matching the sidebar groups).

| Group (parent) | Child sections | Canonical child route(s) |
| --- | --- | --- |
| General | Account | `/settings/account` |
| Media Servers | Media Servers, Seerr, Webhooks | `/settings/media-servers`, `/settings/seerr`, `/settings/webhooks` |
| Metadata | Metadata Providers, Refresh Metadata (TMDB, TVDB) | `/settings/metadata-providers`, `/settings/refresh-metadata` |
| Sync | Sync Tuning, Sync Tools (Repair Recent Items, Full Sync Watchstates, Force Full Sync), Sync Issues, Sync History | `/settings/sync-tuning`, `/settings/sync-tools`, `/settings/sync-issues`, `/settings/sync-history` |
| Backup / Restore | Backup Settings (Local, Remote), Restore (Local, Remote) | `/settings/backups`, `/settings/restore` |
| Import | Trakt | `/settings/import` |
| Tools | Database Repairs, Library Rebuilds and Backfills | `/settings/database-repairs`, `/settings/library-rebuilds` |
| Advanced | System Integrity Check, Storage & Cache | `/settings/health`, `/settings/storage` |
| Logs | Logs | `/settings/logs` |
| About | About | `/settings/about` |

Every child section is display-only: its sidebar button navigates to the parent
group's own path (e.g. `/settings/advanced-group`) with the section id appended as a
URL hash (`#health`), then scrolls that specific section into view. The parent's page
always renders every child's content stacked together — clicking a child is a same-page
jump, not a different screen. Logs is a single-child group of its own (it used to sit
inside Advanced; it renders and behaves identically, just promoted to a top-level
sidebar entry, since its content shares no panel with Health or Storage & Cache).

## Multi-view aggregation

A parent group's page can pull content from more than one underlying panel or backup
tab. Each group definition in `settings-shell.js` carries a `views` array (or, for
single-panel groups, a flat `panel`/`subPanels`/`backupTab` that `sectionRoute()`
wraps into a one-item `views` array automatically):

| Group | Views |
| --- | --- |
| General | `general` panel's Account row |
| Media Servers | `apps` panel's Media Servers and Seerr sections, then the `general` panel's `general-endpoints` row (Webhooks) |
| Backup / Restore | `backups` panel's `settings` tab, then its `restore` tab |
| Advanced | `tools` panel's `tools-diagnostics` row (System Integrity Check), then the `cache` panel (Storage & Cache) |

`applySettingsRoute()` iterates every view in the route and reveals each one's panel,
sub-panel rows, and (for the backups panel) accumulates every requested `backupTab`
into a set before hiding any backup panel not in that set — so Backup and Restore can
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
  wrapper* is the scroll target, not the bare row — otherwise the scroll would land past
  the section's own heading (the heading lives in the synthetic `<summary>`, not the row).
- Otherwise it falls back to the `[data-sub-panel]` row, the backup-tab-qualified panel,
  or the plain panel element, in that order.

`.settings-pane`, `.settings-row`, and `.settings-disclosure` all carry
`scroll-margin-top: calc(var(--right-topbar-height) + var(--space-3))` so the sticky
`.page-topbar` (which sits at `position: sticky; top: 0` inside the scrolling
`.page-shell` container) never covers the section that was just scrolled to.

Navigating to a genuinely different settings path (not just a same-page hash jump)
resets `.page-shell`'s scroll position to the top — this targets the actual scrolling
viewport (`.page-shell`, `overflow-y: auto`), not `window`/`body`, since the app shell
itself never scrolls.

## Card and modal workflows

Media servers and metadata providers use card grids. Configured or previously touched
services appear as cards with status badges; the trailing **+** card opens a provider
picker. Selecting a card opens an edit dialog with aligned label/control rows, inline
help, and Save/Cancel actions. Media-server dialogs also provide **Test** and an Enable
switch. Fixed services can be disabled but not deleted because the config API has no
credential-clear operation.

**Sync Tuning is the one exception**: its four numeric fields (watched threshold,
minimum resume position, active-session TTL, outbound timeout) render directly inline
on the Sync page in a plain form with its own Save button — not behind a card + edit
modal — since there's only ever one instance to edit and no add/remove/test workflow.

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
| `/settings/account/login` | `/settings/account` |
| `/settings/apps`, `/settings/connections`, `/settings/connections/:provider` | `/settings/media-servers` |
| `/settings/api-keys`, `/settings/metadata/:provider` | `/settings/metadata` |
| `/settings/connections/webhooks` | `/settings/webhooks` |
| `/settings/data`, `/settings/data/backups` | `/settings/backups` |
| `/settings/data/restore` | `/settings/restore` |
| `/settings/data/import` | `/settings/import` |
| `/settings/tools`, `/settings/system/advanced`, `/settings/advanced` | `/settings/database-repairs` |
| `/sync`, `/settings/sync`, `/settings/sync/issues`, `/settings/system/sync` | `/settings/sync-issues` |
| `/settings/sync/history` | `/settings/sync-history` |
| `/settings/sync/tuning` | `/settings/sync-tuning` |
| `/logs`, `/settings/system/logs` | `/settings/logs` |
| `/settings/cache`, `/settings/system/storage` | `/settings/storage` |
| `/settings/changelog`, `/settings/system/about` | `/settings/about` |
| `/settings/system/health` | `/settings/health` |

The forced-password-change state always resolves to `/settings/account`.

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

## Maintenance disposition

- System Integrity Check runs the integrity, database, webhook, scheduler, media-server, and
  cross-platform library matching checks.
- Sync combines unresolved jobs, history, repair-recent, force, stop/reset, and refresh.
  The Sync Issues panel also contains the Cross-Platform Match Report (backed by the
  admin-guarded `GET /api/sync-match-report` endpoint), which groups every
  "no matching item found" sync result by platform with per-platform unique-media
  counts, movie/episode splits, and sample rows.
- Storage & Cache (under Advanced) displays and clears image cache categories.
- Tools retains history repair, deduplication, full watch-state sync, metadata refresh,
  TV rematching, and Trakt poster backfill with their confirmations and logs, split
  across the Database Repairs and Library Rebuilds and Backfills accordions.
- Import owns the Trakt/CSV importer; Backup Settings and Restore own their respective workflows.

No maintenance API or stored media configuration format changes are introduced by the
settings shell.
