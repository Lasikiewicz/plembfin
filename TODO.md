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

## 4. Faster Now Playing detection

Now Playing used to be bounded by the once-a-minute scheduler poll of `/status/sessions`
(`fetchLiveSessions`) - a new play or a session ending could take up to 60s to show up
or clear from the dashboard.

- Status: near-term piece done; Emby/Jellyfin stretch goal below not started
- Done: `server/src/utils/liveSessionPoller.js` now polls Plex/Emby/Jellyfin sessions on
  its own timer, independent of the once-a-minute scheduler tick, activity-adaptive (10s
  while something's playing, 45s while idle - close to the old baseline, so idle load
  doesn't meaningfully increase). Plex's existing notification WebSocket
  (`plexNotificationListener.js`) now also parses the `playing` frame type it previously
  ignored and pokes the poller to refresh immediately on it, giving Plex near-instant
  detection with no new connections. `handleNowPlaying` also pokes the poller when a
  viewer request arrives more than 20s after the last one, so a freshly opened or
  refocused tab doesn't wait out the poller's own interval. Also fixed a pre-existing
  false-stop bug this faster polling would otherwise have made more likely to trigger: a
  single failed poll to a platform, or a Plex session-id change on a transcode/quality
  switch, used to be read as "everything stopped playing" and could drop a still-playing
  item to a partial-watch/resume record. `fetchLiveSessions()` now reports which platform
  it couldn't reach so a failed poll isn't treated as an empty result, and a session must
  be missing across two consecutive successful polls before it's treated as stopped. See
  [docs/now-playing.md](docs/now-playing.md) and [docs/plex.md](docs/plex.md).
- Stretch/speculative, larger effort, not started: Emby and Jellyfin both expose a session-push
  WebSocket (`SessionsStart` subscription) that could replace polling for them the same
  way, and would also remove the manual webhook-plugin setup step for new users. Before
  committing to this: confirm it actually reports watched/unwatched changes made *outside*
  an active session (e.g. "Mark Played" in the UI) - Emby/Jellyfin webhooks already cover
  that case today, and losing it would recreate the exact gap Plex has without webhooks.
  Also expect real hardening cost per platform (reconnect/backoff, idle-socket detection
  behind reverse proxies) similar to what `plexNotificationListener.js` already needed for
  Plex, and this would not remove the need for backstop polling, only add a faster layer
  on top of it.



