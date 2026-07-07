# Settings

The `/settings/:tab` views and the configuration plumbing behind them. Settings tabs
(`SETTINGS_TABS` in `public/modules/state.js`): **general, apps, api-keys, tools,
backups, sync, logs, changelog, cache**.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/configStore.js` | The `settings` SQLite row: load/merge/validate/save connection config; `publicMediaConfig` (browser-safe shape); runtime state + sync history |
| `server/src/index.js` | `handleConfig` (`GET/POST /api/config`), `handleAppearance`, `handleTestConnection`, `handleCacheStats`/`handleClearCache`, `handleDiagnosticLogs`, `handleChangelog` |
| `public/modules/settings.js` | Builds config payloads from form inputs |
| `public/modules/tools.js` | Tools + Backups + Appearance panels |
| `public/modules/tools-maintenance.js` | Maintenance/diagnostic actions (integrity check, repair, dedup, cache panel) |
| `public/modules/help-content.js` | Inline help blocks + setup guides rendered inside settings panels |
| `public/modules/logs.js` + `modules/sync.js` | Logs tab and Sync tab data |
| `public/app.js` | Tab routing, form wiring, save flows |

## Tab-by-tab

### General
Admin username/password change (`POST /api/auth/credentials`), session revocation
(`POST /api/auth/sessions/revoke-all`) — see [auth.md](auth.md). A forced-password-change
state (`state.mustChangePassword`) pins the user to this tab when the default password
is still active.

### Apps
Connection settings for Plex ([plex.md](plex.md)), Emby ([emby.md](emby.md)),
Jellyfin ([jellyfin.md](jellyfin.md)), and Jellyseerr/Overseerr, each with an
enable/disable toggle, test button (`POST /api/test-connection` — validates URL scheme
and blocks metadata endpoints before fetching), and per-platform webhook setup guides
(`plexWebhookSetup()` etc. from `help-content.js`).

### API Keys
TMDB, TheTVDB, Fanart.tv, YouTube, OMDb keys — see [metadata.md](metadata.md).
Also the **API Endpoints** panel: the integration API key (fetched on demand via
`GET /api/auth/apikey`, never persisted client-side), the webhook URL with its secret
token, and the webhook-secret rotate button.

### Tools
Full export/import, the watch-history importer, appearance preferences
(`GET/POST /api/appearance`, applied by `applyAppearanceToBody`), and the maintenance
actions from `tools-maintenance.js`:

| Action | Endpoint |
| --- | --- |
| System Integrity Check | probes each configured server + the Plex WebSocket (`/api/test-connection`, `/api/test-plex-notifications`) |
| Force Sync / Stop | `POST /api/force-sync`, `POST /api/stop-force-sync` (progress polled from `runtime_state`) |
| Deduplicate history | `POST /api/dedup-history` (streamed log) |
| Full watchstate sync | `POST /api/full-sync-watchstates` |
| Trakt poster backfill | `POST /api/admin-backfill-trakt`, status via `/api/admin-backfill-status` |
| Fix history records | `POST /api/admin-fix-history` |
| Re-match TV shows | `POST /api/rematch-tv-shows` |
| Clear missing-telemetry flags | `POST /api/clear-missing-telemetry` |

### Backups
See [backups.md](backups.md).

### Sync
Sync jobs (outstanding/failed propagations, `GET /api/sync-jobs`) with retry
(`POST /api/retry-sync`), and the sync history log (`GET /api/sync-history`). Rendering
in `public/modules/sync.js` (`renderSyncJobs`, `renderSyncHistory`,
`categorizeIssues`).

### Logs
Frontend debug logs (localStorage ring buffer, `modules/logs.js`) and backend
diagnostic logs (`GET /api/diagnostic-logs` — the in-memory capture from
`diagnosticLogger.js`, secrets redacted), with clear buttons.

### Changelog
Version list + update check via `GET /api/changelog` — see the changelog section of
[architecture.md](architecture.md).

### Cache
Cache statistics and clearing (`GET /api/cache-stats`, `POST /api/clear-cache`),
rendered by `renderCachePanel` in `tools-maintenance.js`.

## How connection config persists

1. The form posts to `POST /api/config`; `handleConfig` merges it over the stored
   config with `mergeIncomingConfig` — **blank secret fields mean "keep the stored
   credential"**, because the browser never receives secrets back
   (`publicMediaConfig` returns `configured` booleans instead).
2. `validateConfig` enforces required fields per enabled platform and URL safety
   (http/https only, no embedded credentials, no cloud-metadata hosts).
3. `saveMediaConfig` writes the normalized result to the `settings` row.
4. Env vars (`PLEX_SERVER_URL`, `EMBY_API_KEY`, …) act as **defaults** — merged in on
   load (`mergeEnvDefaults`), always losing to explicitly saved values.

## In-app help

`help-content.js` owns every static guide (credentials, webhooks, cron, admin token)
plus `renderSettingsInlineHelp()`, which injects contextual help into each settings
panel. When settings behavior changes, update these too — the "Push to git" workflow in
[`../CLAUDE.md`](../CLAUDE.md) has the checklist.
