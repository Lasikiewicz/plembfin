# Settings

Settings is a flat, task-oriented administration area modeled on Sonarr. `/settings`
shows a plain list of sections with a title and one-line description; it does not run
external diagnostics or preload status summaries. Desktop renders the same sections in
the settings sidebar, while mobile uses the **Settings section** select control.

| Section | Canonical route | Responsibility |
| --- | --- | --- |
| Media Servers | `/settings/media-servers` | Plex, Emby, Jellyfin, and Seerr connections |
| Metadata | `/settings/metadata` | TMDB, YouTube, Fanart.tv, TheTVDB, and OMDb keys |
| Webhooks | `/settings/webhooks` | Webhook listener URL, secret rotation, and scheduler endpoint |
| Account & Security | `/settings/account` | Administrator credentials and sessions |
| Backups | `/settings/backups` | Local schedules and remote destinations |
| Restore | `/settings/restore` | Local/uploaded/remote watch-history restore and full encrypted restore |
| Import | `/settings/import` | Trakt and CSV watch-history import |
| Sync | `/settings/sync` | Unresolved issues, sync history, force sync, and repair tools |
| Health | `/settings/health` | Database and media-server diagnostics |
| Logs | `/settings/logs` | Browser and server diagnostic logs |
| Storage & Cache | `/settings/storage` | Artwork and metadata cache usage |
| Advanced | `/settings/advanced` | Database repair, rebuild, rematch, and backfill tools |
| About | `/settings/about` | Version and changelog |

## Card and modal workflows

Media servers and metadata providers use card grids. Configured or previously touched
services appear as cards with status badges; the trailing **+** card opens a provider
picker. Selecting a card opens an edit dialog with aligned label/control rows, inline
help, and Save/Cancel actions. Media-server dialogs also provide **Test** and an Enable
switch. Fixed services can be disabled but not deleted because the config API has no
credential-clear operation.

Remote backup destinations use the same card and modal primitives. The Backblaze B2
dialog edits its name, enabled state, region/endpoint, bucket, key ID, optional prefix,
and application key. Save and Test persist the destination before refreshing status;
Delete removes the destination record after confirmation without deleting remote files.

Dialogs are singletons, close on Escape/backdrop/close button, keep their header and
footer visible while the body scrolls, and collapse to stacked fields on mobile.

## Frontend ownership

| File | Role |
| --- | --- |
| `public/modules/settings-shell.js` | Flat route registry, legacy aliases, landing list, sidebar, mobile selector, panel visibility, and advanced disclosures |
| `public/modules/settings-ui.js` | Shared edit modal, picker modal, and service-card grid primitives |
| `public/modules/settings-services.js` | Media-server and metadata definitions, config saves, connection tests, cards, and dialogs |
| `public/modules/settings.js` | Shared connection-label formatting |
| `public/modules/tools.js` | Trakt import and compatibility exports for backup and maintenance behavior |
| `public/modules/tools-backups.js` | Backup schedules, restore, destination cards/dialogs, and appearance behavior |
| `public/modules/tools-maintenance.js` | Diagnostics, repairs, backfills, and cache behavior |
| `public/modules/help-content.js` | Credential, webhook, migration, and account setup guides |
| `public/modules/logs.js` / `public/modules/sync.js` | Logs and sync rendering/loaders |
| `public/app.js` | SPA routing, data loading, element binding, and module callback injection |

## Route compatibility

Old bookmarks are normalized with `history.replaceState`:

| Previous route | Canonical route |
| --- | --- |
| `/settings/general`, `/settings/account/login` | `/settings/account` |
| `/settings/apps`, `/settings/connections`, `/settings/connections/:provider` | `/settings/media-servers` |
| `/settings/api-keys`, `/settings/metadata/:provider` | `/settings/metadata` |
| `/settings/connections/webhooks` | `/settings/webhooks` |
| `/settings/backups`, `/settings/data`, `/settings/data/backups` | `/settings/backups` |
| `/settings/data/restore` | `/settings/restore` |
| `/settings/data/import` | `/settings/import` |
| `/settings/sync`, `/settings/system/sync`, `/sync` | `/settings/sync` |
| `/settings/logs`, `/settings/system/logs`, `/logs` | `/settings/logs` |
| `/settings/cache`, `/settings/system/storage` | `/settings/storage` |
| `/settings/changelog`, `/settings/system/about` | `/settings/about` |
| `/settings/tools`, `/settings/system/advanced` | `/settings/advanced` |
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

## Maintenance disposition

- Health runs the integrity, database, webhook, scheduler, and media-server checks.
- Sync combines unresolved jobs, history, repair-recent, force, stop/reset, and refresh.
- Storage displays and clears image cache categories.
- Advanced retains history repair, deduplication, full watch-state sync, metadata refresh,
  TV rematching, and Trakt poster backfill with their confirmations and logs.
- Import owns the Trakt/CSV importer; Backups and Restore own their respective workflows.

No maintenance API or stored media configuration format changes are introduced by the
settings shell.
