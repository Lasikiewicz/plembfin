# TODO / Feature Backlog

Tracked ideas for future work. Not scheduled — pick up when ready.

## 1. Additional import sources (Simkl, etc.)

Expand import beyond the current Trakt/CSV import (`public/modules/tools.js`) to more services (e.g. Simkl).

- Status: not started
- Watch history merge/import logic needs to be verified first — must handle clashes (duplicate records, conflicting watch dates/ids) cleanly rather than duplicating entries.
- Take an automatic backup (existing backup system — see `docs/backups.md`, `public/modules/tools-backups.js`) immediately before any merge/import runs, so a bad merge can be rolled back.

## 2. Onboarding

First-run / onboarding experience for new users.

- Status: not started
- Currently a fresh install just generates an admin password to the console log and drops the user straight into a bare login screen, with no guided setup for connecting Plex/Emby/Jellyfin, TMDB keys, etc.

## 3. Identify and trim unparsed webhook traffic

Media servers are posting events Plembfin cannot parse. They are harmless — the request
is refused before it can record anything — but they fill Sync History with noise.

- Status: not started
- Rejected requests appear in Sync History as `Unsupported webhook content type`. Each one
  records `contentType`, `userAgent`, and the first 300 bytes of the body in
  `rawPayloadDebug` (`normalizeWebhook` in `server/src/routes/sync.js`), which identifies
  the sender.
- Read one of those entries first, then untick the unused event categories on that server.
  The minimal event sets are listed in `docs/webhooks.md` and in Settings → Webhooks.
- A Jellyfin generic destination using a custom template must set its content type to
  `application/json`; anything else is refused.

## 4. Investigate delayed webhook delivery from Emby

Emby has been observed queuing playback events and delivering them in a burst many hours
later — on 2026-07-26 an evening's watches arrived together the following late morning.

- Status: not started
- Late delivery no longer corrupts history (see `docs/scheduled-sync.md#echo-suppression`),
  so this is an Emby-side reliability question rather than a data-integrity one.
- A server that stalls webhook delivery for hours will also delay Now Playing and resume
  sync, so it is worth finding the cause in Emby's own logs.

## 5. Resolve cross-platform match failures

Around 60 watch records per platform report `No matching item found` when syncing, so their
watched state never propagates.

- Status: not started
- As of 2026-07-26: Plex 60 rows (55 episodes, 5 movies), Emby 63, Jellyfin 63.
- `GET /api/health/sync` reports these under `matchFailures`, grouped by target platform with
  samples. Settings → Sync Issues renders the same data as the Cross-Platform Match Report.
- Each row is either genuinely absent from that library or carries provider ids that do not
  match the copy held there. The two cases need different fixes, so classify before acting.

## 6. Repair episode rows with missing season numbers and opaque show titles

Two metadata defects leave rows that cannot be matched or grouped reliably.

- Status: not started
- As of 2026-07-26: `nullSeasonEpisodeRows` 43, `opaqueShowTitleRows` 10, both reported by
  `GET /api/health/sync` under `dataQuality`.
- Episode rows with no season number cannot match reliably for sync and do not count toward
  show progress. Rows storing a provider URI (`plex://…`) in `show_title` cannot resolve
  episode totals, and group under a placeholder show route.
- `backfillUnknownShowTitles` (run at boot from `server.js`) already repairs some of these
  once a better title is known; a targeted repair tool would cover the rest.

## 7. Update `media_key` when Fix Match repoints a show

Fix Match rewrites a show's identity and name across its episodes but leaves each row's
`media_key` as it was.

- Status: not started
- `rematchShowWatchRecords` (`server/src/utils/dataRepo.js`) sets `tvdb_id`, clears `tmdb_id`,
  and updates `title`/`show_title`, but does not recompute `media_key`. A key derived from the
  old title therefore still encodes the previous name.
- `playstate` rows are keyed by `media_key`, so the two must be migrated together — rewriting
  one without the other breaks watched-state lookups. That coupling is why it was left out of
  the rename change rather than added quietly.

## 8. Verify watch-history backups restore cleanly

Backups are created and listed, but a restore has not been exercised end to end.

- Status: not started
- Plembfin writes watched state to three media servers, so a restore is the only route back
  from a bad merge, import, or cleanup. Confirm it works before relying on it.
- `POST /api/watch-backups` with `action: "restore"` supports `dryRun` for a non-destructive
  rehearsal — see `docs/backups.md`.

## 9. Review imported Trakt watch clusters

Four items carry four or five plays inside a single day, all originating from imports rather
than live sync.

- Status: not started
- The Office S03E12 (5 plays / 17.1h), Shōgun S01E02 (4 / 19.3h), Treasure Quest: Snake Island
  S02E07 (4 / 5.2h), The Office S04E09 (4 / 9.8h); 13 redundant rows in total.
- Sources are `trakt_import` and `plex_initial_sync`, so these predate live syncing and are
  most likely faithful copies of Trakt's own records. Confirm against Trakt before removing
  anything — they are deliberately excluded from the duplicate cleanup, which only collapses
  plays within ten minutes of each other.
