# Watch History Backup Plan

## Goal

Create small, automatic backups containing only the data needed to restore watch
state. Artwork, TMDB caches, active sessions, logs, credentials, and media-server
configuration are deliberately excluded.

The first release should back up:

- `watch_history`
- `playstate`
- `playback_progress`
- A manifest containing schema version, app version, creation time, row counts,
  checksum, and source instance ID

## Backup Format

Use a versioned JSON document compressed with gzip:

`plembfin-watch-history-2026-06-15T120000Z.json.gz`

The export should use the existing portable field names from
`server/src/utils/backup.js`, but expose a separate watch-history-only format.
Do not include poster URLs because they are derived data and may contain expired
remote tokens.

Restores should support:

- **Merge**: add missing records and keep the newest state for conflicts.
- **Replace**: clear the three watch-state tables before importing.
- **Dry run**: validate format, checksum, schema compatibility, and report the
  expected inserts/updates without writing.

## Local Scheduling

Add a backup worker to the existing in-process scheduler rather than creating a
second timer. Store its configuration and last-run state in `settings` and
`runtime_state`.

Recommended defaults:

- Disabled until configured
- Daily at 03:00 in the configured local timezone
- Run once after startup if the scheduled time was missed
- Keep 7 daily, 4 weekly, and 12 monthly backups
- Always write to `data/backups/watch-history/` first
- Write to a temporary file, verify its checksum, then rename atomically
- Never delete the last known-good backup

## Destination Adapters

Use one internal interface for every destination:

```text
upload(localPath, remoteName)
list(prefix)
delete(remoteName)
testConnection()
```

Implement destinations incrementally:

1. **Local folder**: required baseline and useful for mounted NAS storage.
2. **WebDAV**: covers many self-hosted and hosted storage services with one
   adapter.
3. **Dropbox**: OAuth connection and an app-specific Plembfin folder.
4. **OneDrive**: OAuth connection and an app-specific Plembfin folder.
5. **S3-compatible storage**: optional adapter for AWS S3, Backblaze B2, MinIO,
   and similar services.

Each remote upload happens after the verified local backup is complete. A remote
failure must not invalidate or delete the local backup. Record per-destination
status, duration, uploaded bytes, and error detail.

## Credentials And Encryption

- Store OAuth refresh tokens or storage credentials in `data/config.json`, never
  in the backup file or browser storage.
- Redact credentials from logs and API responses.
- Request the narrowest provider permissions available for the configured app
  folder.
- Offer optional AES-256-GCM encryption before upload. The encryption password
  must not be stored unless the user explicitly chooses to persist it.
- A restore must authenticate, decrypt if needed, verify the checksum, and
  validate the schema before changing SQLite.

## Settings UI

Use **Settings → Data & Backup → Backups** for automatic watch-history backups:

- Enable automatic backups
- Schedule and timezone
- Local retention policy
- Destination type and connection controls
- Optional encryption
- Test connection
- Back up now
- Last successful backup, next run, file size, and destination status
- Restore browser with dry-run, merge, and replace actions

## Delivery Stages

1. Add watch-history-only export/import services and local scheduled backups.
2. Add retention, status history, manual backup, and restore UI.
3. Add WebDAV and S3-compatible adapters.
4. Add Dropbox and OneDrive OAuth adapters.
5. Add optional encryption and restore disaster-recovery documentation.

The local-only stage should ship first. It proves the backup and restore format
before OAuth, remote retention, and provider failure modes are introduced.

## Implementation Status

Stage 1 is implemented under **Settings → Data & Backup**, with local gzip
files, daily scheduling, retention, authenticated downloads, checksum validation,
and dry-run, merge, or replace restores.

Remote destination adapters are now implemented under
`server/src/utils/backupDestinations/` (WebDAV, S3-compatible, OneDrive, Dropbox),
all sharing the `testConnection / upload / list / delete` contract. The local backup
is always written and verified first; each enabled remote is then mirrored
best-effort, with per-destination status recorded in the backup runtime and remote
retention ordered by the sortable backup filename. A remote failure never
invalidates or deletes the local backup. Credentials live server-side in the
`watchBackupDestinations` settings row and are redacted to "is-set" flags in every
API response. OneDrive uses the Microsoft device-code flow (user supplies an Azure
app client ID); Dropbox uses the manual no-redirect OAuth code flow; both store a
refresh token. Optional AES-256-GCM encryption (stage 5) is still pending.
