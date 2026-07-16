# Settings

Settings is a task-oriented administration area. `/settings` shows connection,
metadata, backup, and sync summaries without running external diagnostics. Five groups
lead to focused configuration and maintenance tasks:

| Group | Routes and responsibilities |
| --- | --- |
| Account & Security | `/settings/account/login` — administrator credentials and session revocation |
| Connections | `/settings/connections/:provider` — Plex, Emby, Jellyfin, Seerr, webhooks, and scheduler endpoints |
| Metadata | `/settings/metadata/:provider` — TMDB, YouTube, Fanart.tv, TheTVDB, and OMDb keys |
| Data & Backup | `/settings/data/:task` — local/remote backups, restore, and Trakt import |
| System | `/settings/system/:task` — health, sync, logs, cache storage, version information, and advanced maintenance |

Desktop keeps the five groups in the sidebar. Mobile uses a section picker and a
horizontally scrollable task navigator. Each task has one main content column; setup
guides are collapsed until requested. Database repairs and full-library rebuilds are
collapsed under **System → Advanced**.

## Frontend ownership

| File | Role |
| --- | --- |
| `public/modules/settings-shell.js` | Route registry, legacy aliases, overview status derivation, focused task visibility, help disclosures, and advanced disclosures |
| `public/modules/settings.js` | Connection test payload helpers |
| `public/modules/tools.js` | Trakt import and compatibility exports for backup and maintenance behavior |
| `public/modules/tools-backups.js` | Backup, restore, destination, and appearance behavior |
| `public/modules/tools-maintenance.js` | Diagnostics, repairs, backfills, and cache behavior |
| `public/modules/help-content.js` | Credential and webhook setup guides inserted into the expandable help areas |
| `public/modules/logs.js` / `public/modules/sync.js` | Logs and sync rendering/loaders |
| `public/app.js` | SPA routing, data loading, form saves, and compatibility navigation |

## Route compatibility

Old bookmarks are normalized with `history.replaceState`:

| Previous route | Current route |
| --- | --- |
| `/settings/general` | `/settings/account/login` |
| `/settings/apps` | `/settings/connections/plex` |
| `/settings/api-keys` | `/settings/metadata/tmdb` |
| `/settings/backups` | `/settings/data/backups` |
| `/settings/tools` | `/settings/system/advanced` |
| `/settings/sync` or `/sync` | `/settings/system/sync` |
| `/settings/logs` or `/logs` | `/settings/system/logs` |
| `/settings/cache` | `/settings/system/storage` |
| `/settings/changelog` | `/settings/system/about` |

The forced-password-change state always resolves to `/settings/account/login`.

## Configuration and secrets

Connection forms continue to post to `POST /api/config`. The server merges the incoming
section over the stored configuration. Blank secret fields keep the saved credential
because browser-safe config responses expose only `configured` booleans. URLs are
restricted to HTTP/HTTPS, embedded credentials and cloud-metadata hosts are rejected,
and saved values take precedence over environment defaults.

Provider forms retain independent save and connection-test feedback. The overview uses
existing config, backup, runtime, and sync loaders; a value that has not loaded is shown
as **Unknown**, never as healthy.

## Maintenance disposition

- System health runs the existing integrity and media-server reachability checks.
- Sync combines unresolved jobs, history, repair-recent, force, stop/reset, and refresh.
- Storage displays and clears image cache categories.
- Advanced retains history repair, deduplication, full watch-state sync, metadata refresh,
  TV rematching, and Trakt poster backfill with their existing confirmations and logs.
- Data & Backup owns Trakt import plus all local/remote backup and restore workflows.

No maintenance API or stored configuration format changes as part of the settings shell.
