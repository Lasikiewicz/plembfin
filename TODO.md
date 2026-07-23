# TODO / Feature Backlog

Tracked ideas for future work. Not scheduled — pick up when ready.

## 1. Multiple watch tracking

Track re-watches of a movie or TV episode instead of only watched/unwatched.

- Status: not started
- Must not misclassify a pause/resume as a new watch — needs to key off the existing webhook `active`/`ended`/progress-event flow (`server/src/routes/sync.js`) rather than just counting "watched" events.
- Should likely disallow counting a second watch of the same item within the same calendar day, to filter out re-reporting/noise from Plex/Emby/Jellyfin.

## 2. Additional import sources (Simkl, etc.)

Expand import beyond the current Trakt/CSV import (`public/modules/tools.js`) to more services (e.g. Simkl).

- Status: not started
- Watch history merge/import logic needs to be verified first — must handle clashes (duplicate records, conflicting watch dates/ids) cleanly rather than duplicating entries.
- Take an automatic backup (existing backup system — see `docs/backups.md`, `public/modules/tools-backups.js`) immediately before any merge/import runs, so a bad merge can be rolled back.

## 3. Onboarding

First-run / onboarding experience for new users.

- Status: not started
- Currently a fresh install just generates an admin password to the console log and drops the user straight into a bare login screen, with no guided setup for connecting Plex/Emby/Jellyfin, TMDB keys, etc.
