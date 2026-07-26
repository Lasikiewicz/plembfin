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

## 3. Resolve watch records that match on no platform

Around 60 watch records fail to match on every configured platform, so their watched state
never propagates. The health report counts them once per target, which makes the total look
roughly three times larger than the number of affected rows.

- Status: not started
- As of 2026-07-26: 59 rows fail on every platform (58 of them `source: manual`), and 2 fail
  on Plex alone. `GET /api/health/sync` lists them under `matchFailures`; Settings → Sync
  Issues renders the same data.
- The rows that fail everywhere carry only a series-level provider id (for example
  `episode:1:3:tmdb:245312`, where the id is the show). Episodes of the same shows that
  arrived from webhooks match normally, so the content is present and the lookup is what
  falls short.
- The 2 Plex-only failures are a genuine library gap (*Wake Up Dead Man*), not a matching
  problem, and need no code change.

## 4. Recover show names for provider-URI rows

Ten episode rows store a Plex season GUID where the show name belongs, so they group under a
placeholder route and cannot resolve episode totals.

- Status: not started
- As of 2026-07-26: 10 rows across 2 shows, all `source: plex_initial_sync`, titled
  `plex://season/<guid> - SxxEyy`. Reported by `GET /api/health/sync` as
  `dataQuality.opaqueShowTitleRows`.
- These rows carry no imdb, tmdb, or tvdb id at all, so there is nothing to resolve a name
  from locally — `backfillUnknownShowTitles` cannot help. The options are to look the GUID up
  against the Plex server, or to use Fix Match on each of the two shows, which now renames
  every episode onto the series that is picked.

## 5. Investigate delayed webhook delivery from Emby

Emby has been observed queuing playback events and delivering them in a burst many hours
later — on 2026-07-26 an evening's watches arrived together the following late morning.

- Status: not started; one confirmed occurrence
- Late delivery no longer corrupts history (see `docs/scheduled-sync.md#echo-suppression`),
  so this is an Emby-side reliability question rather than a data-integrity one.
- `sync_history` retains a limited window, so it cannot show whether the lag recurs. Deciding
  that needs either observation over time or Emby's own server logs.
- A server that stalls webhook delivery for hours will also delay Now Playing and resume sync.

## 6. Exercise a real backup restore

Restore has been verified as far as a dry run, which is not the same as proving the write
path works.

- Status: partially verified
- `POST /api/watch-backups` with `action: "restore"` and `dryRun: true` reads the archive,
  validates it, and reports the counts it would write. Confirmed against a live backup on
  2026-07-26.
- A dry run does not exercise the destructive replace. Prove that on a scratch `DATA_DIR`
  rather than a live database — Plembfin writes watched state to three media servers, so a
  restore is the only route back from a bad merge, import, or cleanup.

## 7. Review imported Trakt watch clusters

Four items carry four or five plays inside a single day, all originating from imports rather
than live sync.

- Status: not started
- The Office S03E12 (5 plays / 17.1h), Shōgun S01E02 (4 / 19.3h), Treasure Quest: Snake Island
  S02E07 (4 / 5.2h), The Office S04E09 (4 / 9.8h); 13 redundant rows in total.
- Sources are `trakt_import` and `plex_initial_sync`, so these predate live syncing and are
  most likely faithful copies of Trakt's own records. Confirming that needs the Trakt account
  itself. They are deliberately excluded from the duplicate cleanup, which only collapses
  plays within ten minutes of each other.
