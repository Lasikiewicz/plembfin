# Scheduled Sync

The elected background worker runs `runScheduledTick()` **every minute**. In the
default `ROLE=all` deployment this is the same server process as the UI. A SQLite
lease ensures only one `all` or `worker` process runs scheduler work and the Plex
notification listener. The lease is renewed every 10 seconds and expires after 60.
The existing per-process overlap guard remains in place.

The lease prevents concurrent scheduler ownership. A process crash during an
already-issued media-server API call cannot make that remote call exactly-once;
Plembfin's persisted loop detection and idempotent watched/unwatched writes provide
recovery protection.

The same logic runs on demand via:
- `GET /api/cron-sync/status` - returns the last cron trigger/result as JSON for
  automation that needs a reliable success/failure signal after a streamed run.
- `POST /api/cron-sync` - `handleCronSync` (streams a text log back, auth by API key
  or session cookie).
- `POST /api/force-sync` - queues durable worker work for the dashboard to poll;
  `POST /api/stop-force-sync` cancels queued or running work.
- `POST /api/force-sync/media` - an authenticated, title-scoped detail-page action.
  Its `mode` is `full`, `push`, or `pull`; `push_to` and `pull_from` optionally
  select one of Plex, Emby, or Jellyfin. The response returns an operation id,
  and `GET /api/force-sync/media/status?id=...` exposes live log lines and the
  final result for the popup terminal.

Manual cron and force-sync requests are stored in `background_jobs`; their ordered
logs live in `background_job_logs`. The web process relays logs while the leaseholder
executes the job, so disconnecting a browser does not stop it.

Force Sync also supports an opt-in read-only preview. `POST /api/force-sync/plan` queues
the preview and returns a job id. Once the job result contains a `planId`,
`GET /api/force-sync/plan/:id` returns the summary and paged action details, while
`POST /api/force-sync/plan/:id` confirms a draft. Plans expire after 15 minutes and a
plan over its configured maximum-change limit cannot be confirmed. A preview with
an incomplete server scan is also blocked: an unavailable server is never treated
as an empty library and cannot become a write target. The normal and preview-backed
paths share the same operation lock, role-aware destination filtering, and
restart-safe cancellation behavior.

After confirmation, `POST /api/force-sync` with `{ "planId": "..." }` rechecks the
server fingerprints and configuration revision. Any drift expires the plan before writes.
Destructive plans create and checksum-verify a local Plembfin watch-history snapshot first;
snapshot failure blocks execution. This snapshot covers Plembfin watch history, playstate,
and resume progress, not the databases owned by Plex, Emby, or Jellyfin.

Force Sync is a canonical replay from Plembfin history. It never imports a watched item
that exists only on a connected server, and it never writes to a server whose watched
library scan failed. Source-only and monitor-only sync roles are scanned for information
but are excluded from outbound writes. Force Sync, Full Sync Watchstates, backup restore,
and rebuild operations use one owner-scoped SQLite operation marker, so they cannot run
concurrently. Inbound callbacks received during an authoritative operation are suppressed
as echoes; scheduled-sync callbacks remain eligible for normal echo-ledger checks. Delayed
unplayed callbacks are additionally matched against a 14-day outbound unmark ledger.

The detail-page endpoint is deliberately separate from that library-wide policy. It is a
user-requested repair for one title: Full Sync queries configured servers for that title,
imports any watched movie or episode found there into Plembfin, and propagates the
imported state canonically. Pull mode performs only the import, while Push mode replays
Plembfin's existing canonical state to the selected destination(s). It does not change
the behavior or safety guarantees of the library-wide `/api/force-sync` planner and
executor. Jellyfin episode lookups return every matching season/episode item so duplicate
quality copies are marked consistently.

## One canonical state, input from every connected service

Plembfin stores the canonical `playstate`/watch-history decision, but accepts explicit
watched and unwatched actions from Plembfin, Plex, Emby, Jellyfin, and a connected Trakt
account. Each accepted transition is committed locally and distributed to every other
eligible destination. Trakt is read as a complete snapshot each minute: additions become
watches, removals become unwatches, and a changed watched timestamp becomes a rewatch.
Persisted tracker state and echo markers prevent Plembfin's own outbound write from being
read back as a second user action.

An explicit unplayed webhook/notification or Trakt snapshot removal changes the canonical
state to unwatched and propagates it. Plex show and season notifications are expanded into
their episodes so bulk library actions follow the same transition path. Polling remains
conservative when a server scan is unavailable or incomplete: absence from a failed/partial
scan is never interpreted as an unwatch.

Implementation lives in `server/src/scheduled.js`.

## What it does each run

1. **Live session tracking** (this feeds Now Playing) - **runs every minute**:
   - `fetchLiveSessions(config)` polls the configured servers for what's playing now.
   - `buildCacheRow()` shapes each session; `upsertLiveTrackingCache()` writes them
     to the `live_tracking_cache` SQLite table.
   - Reconciles against the previously-cached rows: a cached session that is **no
     longer playing** and had `last_progress >= 90` is treated as a **completed
     watch** (`processCompletedSession` → inserts history + propagates). Sessions
     that vanish below the threshold are marked/cleared as stale.
2. **Manual dispatch queue** - **runs every minute**:
   - `syncPendingManualDispatches` processes anything queued by the UI or an import
     (manual mark-watched, Trakt history, retries).
   - Records whose targets keep failing are retried with **exponential backoff**
     (1 m → 5 m → 15 m → 1 h → 6 h, tracked in the `sync_retry_count` /
     `sync_next_retry_at` columns on `watch_history`). After 10 failed attempts a
     record becomes terminal - its telemetry says automatic retries are exhausted
     and only a manual **Retry Sync** (which resets the counters) re-queues it.
     A `sync_history` row is only written when the outcome changes (first
     failure, success, or giving up), not on every identical failed attempt.
     Targets that answer "No matching item found" are recorded in the row's
     telemetry and aggregated per platform by the Cross-Platform Match Report
     (Settings → Sync → Sync Issues, backed by `GET /api/sync-match-report`).
3. **Trakt snapshot sync** - **runs every minute when connected**:
   - Refreshes OAuth tokens when required and reads every watched movie and episode page.
   - Applies additions, removals, and rewatch timestamp changes with bounded concurrency.
   - **Sync Now** also reconciles unchanged Trakt watches against Plembfin's current
     canonical state, so it repairs drift that predates the connection baseline.
     The connection card shows an in-progress indicator while the complete snapshot
     is read, then reports the number of Trakt items checked and changes applied.
   - Episode writes resolve series-level provider IDs before calling Trakt. This avoids
     sending episode-level Plex/Emby/Jellyfin IDs in the show slot and lets identity-poor
     catch-up rows use the show's cached metadata.
   - Dispatches accepted transitions to media servers and signals the authenticated
     browser update stream after each committed item.
4. **Catch-up library sync** - **runs every 15 minutes** (configurable via `CATCHUP_SYNC_INTERVAL_MS` env variable) to avoid heavy redundant API queries:
   - Pulls recently-watched and continue-watching (resumable) items from each active server: `syncRecentlyWatchedFromPlex`/`syncRecentlyResumableFromPlex` (and Emby/Jellyfin equivalents) in `scheduled.js`.
   - A recently-watched row counts in Plembfin's visible history and show progress only
     when it carries the configured source user and an explicit server played timestamp.
     Unscoped library scans remain diagnostic evidence rather than asserted watches.
   - Emby/Jellyfin episode resume rows retain series provider IDs so the corresponding SxxExx item can be found on another server. Resume and playstate records sharing any IMDb, TMDB, or TVDB ID are treated as one media item even when app titles differ.
   - Propagates playstate changes that were missed by webhooks. A server-side unwatch
     that conflicts with Plembfin's watched state is repaired instead of imported as a
     local unwatch. Each platform check is wrapped in try/catch so one failure doesn't
     abort the run.
   - **Unwatched reconciliation** - `checkPlexUnwatchedStatus` re-checks up to 30
     recently-tracked, platform-confirmed-watched records per minute against Plex's current
     played state (a single cheap lookup per item), repairing an unwatch that the
     notification WebSocket missed - Plex's webhook cannot report unwatch at all, so this
     poll is a primary detection path, not just a backstop. `checkEmbyUnwatchedStatus` and
     `checkJellyfinUnwatchedStatus` do the same for a much smaller batch (5 records) every
     5 minutes instead of every 1: their webhooks natively report unwatch, so these polls
     only backstop a missed or misconfigured webhook, and their per-item lookup
     (`findEpisode`: several sequential provider-ID/fallback/episode-fetch requests) is
     expensive enough on both platforms that a Plex-sized batch at a one-minute cadence
     was overwhelming the process. A record more than ~100 tracked watches old (or, for
     Emby/Jellyfin, outside the smaller batch) ages out of this window and is only caught
     by a manual
     Force Sync (`docs/media-detail.md`).

This is how a play that finishes without a final scrobble webhook still gets
recorded: the poller sees it hit the watched threshold (90% by default), then
disappear, and completes it.

5. **TV next-airing cache** - `runScheduledTick()` maintains
   `data/next-airing-cache.json`. To prevent timing out, the cache is
   built and refreshed in small batches (default 40 shows per 30-minute tick)
   sorted by the oldest update times. Each show is looked up through the regular
   `getTmdbDetails` cache layer (no forced refetch), so a refresh cycle only
   reaches TMDB/TVDB when a show's cached details have actually expired. This
   allows the TV Shows page to sort by upcoming episode date without querying
   TMDB for every row, while avoiding timeouts on large libraries.

6. **Upcoming calendar cache** - every 10 minutes the scheduler processes one month
   in `data/upcoming-calendar-cache.json`. It builds the previous 24 months once and
   checks the current month plus the next 12 months every 6 hours. Future checks only
   rewrite stored data when episode results changed; historical months are not refreshed.
   Newly tracked shows are merged into cached months on the next calendar request.

## Echo suppression

Marking an item played on a media server bumps that server's own "last played"
timestamp. That makes Plembfin's own outbound write indistinguishable from a user's
play the next time the same server is read back - through library polling, the Plex
notification listener, or a delayed webhook. Left unchecked it records a watch that
never happened, and each phantom re-propagates and produces another one.

Three mechanisms keep inbound state honest:

- **Outbound mark ledger** - every successful played-mark is recorded per target in
  `loop_keys` under a `mark:` prefix with a 14-day TTL
  (`recordOutboundPlayedMarks` / `lastOutboundPlayedMarkAt` in `syncOrchestrator.js`).
  The Plex notification listener consults it: a view timestamp within 10 minutes of
  a mark Plembfin wrote is treated as its own echo, not a new play. This outlives the
  15-second loop-detection window, which only breaks immediate ping-pong.
- **Existing-record guard** - the Plex, Emby, and Jellyfin library pollers record a
  watch only for an item with no watch record at all. When a record exists but the
  playstate has drifted, the poller repairs the playstate instead of filing a second
  watch for the same play.
- **Played-flag rule** - a bare "marked played" webhook never opens a rewatch for an
  item already watched; see [webhooks.md](webhooks.md#rewatch-detection).
- **Canonical unwatch handling** - an explicit Plembfin unwatch is propagated and an
  echo that arrives after the 15-second loop window closes is already represented as
  unwatched, so it is a no-op. An explicit unwatched event from an eligible platform
  supersedes the watched state and propagates to the other configured destinations.

Full Sync Watchstates uses a separate `restoreSyncKind` marker and heartbeat in the
shared runtime state. A server restart cannot resume its browser-driven batch, so a
startup clears a tagged Full Sync lock and marks it cancelled. The **Reset Restore
Lock** control under **Settings → Sync → Sync Tools → Full Sync Watchstates** handles
older or untagged locks and stops an in-flight request before it can send another
batch. Backup restores use a different restore kind and are not cleared by this
control.

Completed sessions flushed from `live_tracking_cache` are dated from when the session
was last seen playing, not from the tick that noticed it had gone, so a session that
lingered through a restart is not backdated to the restart time.

## Why it matters for Now Playing

`live_tracking_cache` is the **primary** source for Now Playing (see
[now-playing.md](now-playing.md)). If the poller can't reach the media servers,
`live_tracking_cache` goes empty and Now Playing shows idle - even though the UI and
webhooks are fine.

**Reachability:** the poller runs on the same machine as the Plembfin server process.
It can reach any URL that machine can reach - including `localhost`, LAN IPs, and VPN
addresses.

## Debugging

- Trigger it manually and watch the log: `POST /api/cron-sync` with your API key
  (the response streams a line-by-line log identical to what the scheduler runs).
- Or watch the server process stdout. A background tick that changed nothing logs
  nothing, so silence between ticks is normal - errors and completed work still log.
- Set `LOG_VERBOSE=true` to add the per-phase narration, including
  `"live sessions: N, cached sessions in tracking: M"`, which tells you whether the
  poller is seeing anything. A user-triggered catch-up run logs those phases to its
  job log regardless of the flag.
- Repeated per-item outcomes are condensed: skipped watched items are reported once
  per run with a count, and a resume-progress item that keeps producing the same
  outcome is logged only when that outcome changes.
- Force sync from the dashboard: **Settings → Sync → Sync Tools → Force Full Sync**
  (`/settings/sync#sync-tools-force`) streams the same log in-browser and shows
  per-platform status.
