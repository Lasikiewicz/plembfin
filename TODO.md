# TODO / Feature Backlog

Tracked ideas for future work. Not scheduled - pick up when ready.

## 1. Additional import sources (Simkl, etc.)

Expand import beyond the current Trakt/CSV import (`public/modules/tools.js`) to more services (e.g. Simkl).

- Status: not started
- Watch history merge/import logic needs to be verified first - must handle clashes (duplicate records, conflicting watch dates/ids) cleanly rather than duplicating entries.
- Take an automatic backup (existing backup system - see `docs/backups.md`, `public/modules/tools-backups.js`) immediately before any merge/import runs, so a bad merge can be rolled back.

## 2. Trakt-alternative tracker sync (Letterboxd, Simkl, etc.)

Support additional two-way watch-tracking services beyond Trakt, such as Letterboxd and Simkl. Requested via Reddit (r/jellyfin, 2026-08-27).

- Status: not started
- Distinct from the one-time import work in item 1: this is live two-way sync (webhooks/polling, canonical state, loop/echo detection) comparable to the existing Trakt integration in `server/src/utils/syncOrchestrator.js` and `loopStore.js`, not a one-off import.
- Each new tracker needs its own connection settings, auth flow, and echo-loop handling before it can safely participate in the same canonical playstate as Plex/Emby/Jellyfin/Trakt.

## 3. mdblist metadata source

Add mdblist as an additional metadata source alongside TMDB, TheTVDB, Fanart.tv, and OMDb. Requested via Reddit (r/jellyfin, 2026-08-27).

- Status: not started



