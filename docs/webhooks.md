# Webhooks

## Authentication

The webhook endpoint is at `/api/webhook` and requires the webhook secret. Media servers commonly use the compatibility query-token URL:

```
POST /api/webhook?token=<webhookSecret>
```

Header auth is preferred for custom automation clients that can set request headers:

```
POST /api/webhook
X-Plembfin-Webhook-Secret: <webhookSecret>
```

`Authorization: Bearer <webhookSecret>` is also accepted. Plex, Emby, and Jellyfin
setups can continue using the query-token URL above when custom headers are not
available; access logs redact sensitive query parameters before writing to disk.

`webhookSecret` is generated on first boot and stored in `data/config.json`. Copy the
full URL (including token) from **Settings → Webhooks** in the dashboard. You can
rotate it independently via the "Rotate Secret" button without affecting the admin
password or API key.

> The `?token=` approach mirrors Sonarr/Radarr/Overseerr and remains the compatibility
> method for webhook senders such as Plex, Emby, and Jellyfin when they cannot set
> custom HTTP headers on outbound notifications.

## Normalization → phases

`handleWebhook` calls `normalizeWebhook()` (`server/src/utils/parsers.js`) to parse
Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom JSON into a unified `media`
object. The crucial output is `media.phase`, derived per platform by
`phaseFromPlexEvent` / `phaseFromEmbyEvent` / `phaseFromJellyfinEvent`:

| phase | Meaning | What `handleWebhook` does |
| --- | --- | --- |
| `active` | Currently playing (play/resume/progress) | `upsertActiveSession()` → writes `active_sessions` row (5-minute TTL by default), bumps `runtimeState.nowPlayingRefresh`. **No history insert.** |
| `completed` | Watched (scrobble, mark-played, or stop at the watched threshold, 90% by default) | Inserts/updates a `watch_history` record + propagates *watched* to the other platforms. |
| `ended` | Stopped below the watched threshold | Deletes active session; if resume is actionable, stores/propagates resume progress to `playback_progress`. |
| `unplayed` | Marked unwatched/unplayed | Deletes active session, deletes the watch record, inserts an `unwatched` row, and propagates *unwatched* to the other platforms. An item already recorded as unwatched is left alone and nothing is propagated. |
| `added` | New item appeared in a library (`library.new`, `item.added`, `ItemAdded`) | Looks for an existing watched record for that media. If one exists, marks the item watched **on that server only**; writes no history. Nothing happens when there is no watched record. |
| `ignored` | Not actionable | Dropped early. |

Phase determination highlights:
- **Plex**: `media.stop` → `completed` if progress ≥ 90 else `ended`; configured
  "active" events → `active`; "complete" events → `completed`.
- **Emby/Jellyfin**: `markplayed` / `userdata saved with played=true` →
  `completed`; `markunplayed` / `played=false` → `unplayed`; `playbackstop` →
  `completed` if ≥ 90 else `ended`; progress events → `active`.

For Emby, enable **Send All Properties** on the webhook. Without the full item
payload, Plembfin may receive an event without enough title/type/progress data to
record a watched item.

## Propagation (sync)

For watched/unwatched events, `syncMediaPlaystate()` (and the unplayed/progress
variants) in `server/src/utils/syncOrchestrator.js` propagate the change to the
**other two** platforms via their clients (`plexClient.js`, `embyClient.js`,
`jellyfinClient.js`).

**Loop detection:** when Plembfin writes a state to (say) Emby, Emby fires its own
webhook back. `loopStore` (`server/src/utils/loopStore.js`) tracks
recently-dispatched events keyed by platform + media identifier in the SQLite
`loop_keys` table (a key/value store with per-row TTL, see `schema.sql`); an
incoming webhook matching a recent dispatch is detected as an echo and dropped
before it can trigger another round.

> `loop_keys` rows are persisted in the database, so loop detection survives a
> process restart. The check-then-claim step (`checkAndClaim`) runs the read and
> the write inside a single SQLite transaction, so a concurrent claim for the
> same key cannot slip in between the check and the write.

Each media item claims a key per provider id it carries **and** a key derived
from its title and episode coordinates. Both forms are needed because the two
directions of a round trip identify the same item differently: a record Plembfin
holds no provider ids for dispatches under its title key, while the echo the
target server sends back carries that server's own imdb/tmdb/tvdb ids. Sharing
the title key is what lets the second half of that trip recognise the first.

Unwatch handling is also idempotent as a second line of defence. Marking an item
unwatched when it is already recorded that way changes nothing, so the record is
left as it stands and no propagation is dispatched — an echo that outlives the
loop window cannot restart the cycle.

## Catching up newly added media

An outbound sync can only mark an item a server actually holds. When a watch is
recorded for media one of your servers is missing, that server is simply skipped
with "no matching item found" and the watch stays correct in Plembfin.

The `added` phase closes that gap. When a server announces new content and
Plembfin already holds a watched record for it, the item is marked watched on
that server as it arrives, without waiting for a Force Sync. The rules are
deliberately tight:

- Only the server that reported the addition is touched. Other platforms are not
  re-dispatched, because nothing about them changed.
- No watch history is ever written. A library scan cannot manufacture a play —
  only an already-recorded watch is applied.
- An item with no watched record, or one explicitly marked unwatched, is left
  alone.
- The server's own sync role still applies: a platform not configured to receive
  watched state is skipped.
- The outbound mark is written to the loop ledger, so the played event the server
  fires back is recognised as Plembfin's own write rather than a new play.

Enable the library-add notification in each server's webhook configuration for
this to fire: **library.new** on Plex, **library.new** / **item.added** on Emby,
and **ItemAdded** on Jellyfin.

**Record identity across an unwatch:** the `unwatched` row that supersedes a
watched one inherits the replaced row's id rather than being created under a new
one. Watch records are addressed by id throughout the app, so a queued manual
match or an open edit dialog still resolves to the record after an unwatch event
rewrites it.

Results are written back as `sync_dispatch_telemetry` on the watch record and into
the `sync_history` SQLite table.

**Content type is not trusted.** `normalizeWebhook` routes multipart and form-encoded
bodies to the Plex parser, and everything else is judged by whether the body parses as
JSON — not by the declared content type. Jellyfin's webhook plugin posts valid JSON
labelled `text/plain`, so a header-based check would drop every event it sends,
including the mark-played and mark-unplayed events unwatch propagation depends on. A
body that *declares* `application/json` and is malformed is still a 400, because that is
a genuine client error rather than an unrecognised sender.

**Rejected requests:** a body that is not JSON at all is recorded in `sync_history` as
`Unsupported webhook content type` with its `contentType`, `userAgent`, and the first
300 bytes of the body in `rawPayloadDebug` — enough to identify which server sent it and
why it was refused.

## Rewatch detection

A `completed` event for an item whose `playstate` is already `watched` is not
always a duplicate: media servers can report an item as played without an actual
new play, but a real rewatch produces a `completed` event too. `handleWebhook`
(`server/src/routes/sync.js`) tells them apart by what kind of event arrived,
not by when it arrived.

Emby and Jellyfin emit a **played-flag event** (`item.markplayed`, or a
userdata-saved event carrying `Played=true`) whenever anything sets the played
flag — including Plembfin's own outbound sync — and they can deliver it hours
after the fact. The parser marks these with `playedFlagOnly` on the normalized
payload. They carry no playback evidence, so:

- **A played-flag event for an item already marked watched** is dropped: no new
  `watch_history` row, no re-propagation. The calendar day it lands on is
  meaningless, because delivery time says nothing about when the play happened.
- **A played-flag event for an item not yet watched** is recorded, dated from the
  server's own `LastPlayedDate` rather than the arrival time. This is the path a
  manual "mark as played" in Emby takes.
- **A playback event** (`media.scrobble`, `playback.stop` past the watched
  threshold) is real evidence of a play. For an item already watched, one on a
  later UTC day is recorded as a genuine rewatch: a new `watch_history` row is
  inserted and `playstate.watched_at` advances. Pause/resume events never reach
  this check at all — they're routed through the `active`/`ended` phases above.

The same principle applies to inbound state read from library polling and from
the Plex notification listener, so a played flag Plembfin itself wrote is never
read back as a new watch. See [scheduled-sync.md](scheduled-sync.md#echo-suppression).

Every watch of the same movie/episode collapses into one card everywhere the UI
lists history (`dedupeHistory` / `collapseMovieCluster` in
`server/src/utils/dataRepo.js`), carrying a `playHistory` array of
`{ id, watched_at, source }` for each individual play — this is what powers the
"Watch History" list and rewatch counts described in [media-detail.md](media-detail.md).

## Resume / playback progress

On `ended` (and via the scheduled poller), if resume is actionable
(`shouldSyncResumeProgress`), a record goes into `playback_progress` keyed by
`media_key`, and `syncMediaProgress()` pushes the resume position to the other
platforms. When position and duration are available, Plembfin derives the percentage
from those timing fields instead of trusting a conflicting percentage supplied by the
webhook. This keeps stop-phase classification, stored progress, and the dashboard in
agreement with the resume position written to each media server.

## Plex specifics worth remembering

- Native Plex webhooks only fire on **state changes** (play/pause/resume/stop/
  scrobble) — there is **no heartbeat**. So a single `media.play` creates an
  `active_sessions` row that **expires after the active-session TTL (5 minutes by
  default)** unless another event
  arrives. Continuous "still playing" tracking for Plex comes from the
  elected scheduler worker (→ `live_tracking_cache`), not from native webhooks.
- Plex does **not** send unwatched (unscrobble) events. Plembfin compensates via
  the built-in Plex WebSocket notification listener, which connects automatically
  using the configured Plex URL and token.
- The setup help in each card under Settings → Media Servers documents per-server webhook configuration.
