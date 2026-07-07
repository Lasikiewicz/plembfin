# Backups

Plembfin has **three backup subsystems** plus a set of pluggable remote destinations.
All are managed from **Settings → Backups** (UI in `public/modules/tools.js`).

| Subsystem | What it saves | Format | Files |
| --- | --- | --- | --- |
| Watch-history backups | `watch_history`, `playstate`, `playback_progress` + manifest | gzip JSON (`plembfin-watch-history-<stamp>.json.gz`) | `server/src/utils/watchHistoryBackups.js` |
| Encrypted full backups | Every portable collection (history, playstate, progress, sessions, sync history, settings, runtime state, loop keys) | AES-256-GCM encrypted JSON (`plembfin-backup-<stamp>.encrypted.json`) | `server/src/utils/plembfinBackups.js` |
| Full export/import | Same portable collections, plain JSON, paged over the API | `plembfin-backup` v1 document | `server/src/utils/backup.js` |

Artwork binaries, poster cache rows, and TMDB metadata cache rows are never included —
they are derived data that rebuilds itself.

The original design document for the watch-history subsystem is
[watch-history-backups.md](watch-history-backups.md); this doc describes the current
implementation.

## Watch-history backups (`watchHistoryBackups.js`)

Small, automatic backups of just the data needed to restore watch state.

- **Contents** — the three watch-state tables plus a manifest (format/version, app
  version, creation time, row counts, checksum). Poster URLs are excluded (derived
  data, may embed expired tokens).
- **Scheduling** — the in-process scheduler runs `runScheduledWatchBackup()` once per
  tick; it fires daily at the configured time (default 03:00), catching up if the
  scheduled time was missed. Config (`enabled`, `time`, `retention`) lives in the
  `settings` row `watchHistoryBackups`; run state in `runtime_state`
  (`watchHistoryBackups`).
- **Storage** — always written to `data/backups/watch-history/` first: temp file →
  checksum verify → atomic rename. Retention (default 14, max 365) prunes oldest.
- **Restore** — `restoreWatchHistoryBackup(filename, { mode, dryRun })` supports
  **merge** (add missing, newest state wins on conflict), **replace** (clear the three
  tables first), and **dry run** (validate + report expected changes without writing).
  Uploaded files restore via `importWatchHistoryBackupFile`. Restores pause the cron
  sync (`pauseCronSync`, default 10 minutes) so the catch-up sync can't fight the
  restore, and stamp `lastRestoreAt`.
- **API** — everything multiplexes through `GET/POST /api/watch-backups`
  (`handleWatchBackups` in `index.js`): status, list, create, download, upload,
  restore, destination CRUD, destination test, remote list/pull.

### Remote destinations (`backupDestinations/`)

Each enabled destination mirrors the verified local backup best-effort — a remote
failure never invalidates or deletes the local file. Per-destination status (last
attempt/success, bytes, duration, error) is recorded in the backup runtime; remote
retention is ordered by the sortable filename.

All adapters implement the same contract (`index.js` in the folder):
`testConnection() / upload(localPath, remoteName) / list() / download(remoteName) /
delete(remoteName)`.

| Type | Adapter | Auth |
| --- | --- | --- |
| `folder` | `folder.js` | none — local path (useful for mounted NAS storage) |
| `webdav` | `webdav.js` | basic auth |
| `s3` / `backblaze` | `s3.js` | access key + secret, built-in SigV4 signer (AWS S3, Backblaze B2, MinIO…) |
| `onedrive` | `onedrive.js` | Microsoft device-code OAuth (user supplies an Azure app client ID; app-folder scope; refresh token persisted via `persistSecrets`) |
| `dropbox` | `dropbox.js` | manual no-redirect OAuth code flow; refresh token persisted |

Destination records (`{ id, type, label, settings, secrets }`) live in the settings row
`watchBackupDestinations`. Secret fields (`password`, `secretAccessKey`, `appSecret`,
`refreshToken`) never reach the browser — every API response redacts them to "is-set"
flags (`loadBackupDestinationsRedacted`). Backup transfers use a 60-second outbound
timeout (vs the 10s default).

## Encrypted full backups (`plembfinBackups.js`)

Nightly encrypted snapshots of the entire portable backup document.

- **Encryption** — AES-256-GCM, key derived with PBKDF2 (SHA-256, 100k iterations);
  passphrase must be ≥ 12 characters and is required — there is no plaintext mode.
- **Passphrase storage** - manual backups can use a one-time passphrase that is never
  persisted. Scheduled local or remote encrypted backups require "remember passphrase"
  to be enabled; existing stored passphrases are treated as remembered for backward
  compatibility and can be removed by unchecking the remember option and saving.
- **Scheduling** — `runScheduledPlembfinBackup()` runs from the same scheduler tick,
  daily at the configured time; retention default 7 (max 365). Config lives in the
  settings row `plembfinBackups`.
- **Remote mirroring** — optional; reuses `pushBackupToRemotes` from the watch-history
  subsystem, so the same destination list applies.
- **Storage** — `data/backups/plembfin/`. **Warning:** these backups contain
  media-server URLs, usernames, tokens, and API keys (that's what the encryption is
  for).
- **API** — `GET/POST /api/plembfin-backups` (`handlePlembfinBackups`): status, list,
  create, download, delete, restore-from-server, save settings.

## Full export/import (`backup.js`)

The portable-format engine the other subsystems build on, also exposed directly:

- `GET /api/backup/export` (`handleBackupExport`) — pages collections out via
  `exportCollectionPage` (cursor + limit ≤ 500) so the browser can assemble a full
  plain-JSON backup for download (Settings → Backups → Export).
- `POST /api/backup/import` (`handleBackupImport`) — imports batches via
  `importCollectionBatch` (≤ 250 documents per batch, optional per-collection reset).
  Importing watch-state collections bumps `dataVersion` so derived caches reload.
- The `portableValue`/`reviveValue` helpers keep timestamps portable, and the format
  also revives `_seconds`-style timestamps found in old exports.

## Watch-history importer (Settings → Tools)

Separate from backups: `POST /api/import` (`handleImport`) ingests watch records from
CSV/JSON files (e.g. Trakt exports, `scripts/exportPlexHistory.js` output). Frontend
flow in `tools.js` (`parseSelectedFiles`, `renderImportPreview`, `startImport`) parses
files in the browser and posts records in batches.

## Frontend (`public/modules/tools.js`)

Settings → Backups renders: schedule/retention settings, destination cards
(add/save/test/remove/connect OAuth/list remote files/restore from remote), backup-now
buttons, backup file lists with download/delete/restore, dry-run/merge/replace restore
choices, and transfer status (`setBackupTransferState`). State lives in
`state.watchBackups`, `state.remoteBackupFiles`, `state.backupImport`,
`state.activeBackupsTab`.

## Disaster recovery without the app

Everything lives under `data/`: `plembfin.db` (SQLite), `media/` (artwork),
`config.json` (credentials/secrets). Copying that directory and restarting is a
complete manual backup/restore — see the Backups section of
[hardening.md](hardening.md).
