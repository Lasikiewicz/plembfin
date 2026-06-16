# Webhooks

Media servers notify Plembfin of playback events by POSTing to
`<origin>/api/webhook`. The webhook URL the UI shows is
`${window.location.origin}/api/webhook` (`public/app.js`), so it differs per
environment:

- Emulator → `http://127.0.0.1:5000/api/webhook`
- Production → `https://plembfin.web.app/api/webhook`

> A webhook target is singular. If your servers point at the emulator, **only the
> emulator** gets the event; production stays empty (and vice versa). This is a
> common cause of "the live site is missing events."

## Normalization → phases

`handleWebhook` calls `normalizeWebhook()` (`functions/src/utils/parsers.js`) to
parse Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom JSON into a unified
`media` object. The crucial output is `media.phase`, derived per platform by
`phaseFromPlexEvent` / `phaseFromEmbyEvent` / `phaseFromJellyfinEvent`
(`functions/src/utils/parsers.js:178`+):

| phase | Meaning | What `handleWebhook` does (`functions/src/index.js`) |
| --- | --- | --- |
| `active` | Currently playing (play/resume/progress) | `upsertActiveSession()` → writes `activeSessions` (5-min TTL), bumps `runtimeState.nowPlayingRefresh`. **No history insert.** (`index.js:1041`) |
| `completed` | Watched (scrobble, mark-played, or stop ≥ 90%) | Inserts/updates a `watchHistory` record + propagates *watched* to the other platforms. |
| `ended` | Stopped below the watched threshold | `deleteActiveSession()`, and if resume is actionable, stores/propagates resume progress (`playbackProgress`). (`index.js:1047`) |
| `unplayed` | Marked unwatched/unplayed | `deleteActiveSession()`, deletes the watch record, inserts an `unwatched` record, and propagates *unwatched* to the other platforms. (`index.js:1076`) |
| `ignored` | Not actionable | Dropped early. |

Phase determination highlights:
- **Plex**: `media.stop` → `completed` if progress ≥ 90 else `ended`; configured
  "active" events → `active`; "complete" events → `completed`.
- **Emby/Jellyfin**: `item.markplayed`/`userdata saved with played=true` →
  `completed`; `markunplayed`/`played=false` → `unplayed`; `playbackstop` →
  `completed` if ≥ 90 else `ended`; configured progress events → `active`.

For Emby, enable **Send All Properties** on the webhook. Without the full item
payload, Plembfin may receive an event without enough title/type/progress data to
record a watched item.

## Propagation (sync)

For watched/unwatched events, `syncMediaPlaystate()` (and the unplayed/progress
variants) in `functions/src/utils/syncOrchestrator.js` propagate the change to the
**other two** platforms via their clients (`plexClient.js`, `embyClient.js`,
`jellyfinClient.js`).

**Loop detection:** when Plembfin writes a state to (say) Emby, Emby fires its own
webhook back. The in-memory `loopStore` map tracks recently-dispatched events keyed
by platform + media identifier; an incoming webhook matching a recent dispatch is
detected as an echo and dropped before it can trigger another round.

> `loopStore` is **in-memory per function instance**. Across cold starts or
> multiple instances it won't share state — generally fine because echoes arrive
> within seconds, but worth knowing if you debug a rare double-propagation.

Results are written back as `sync_dispatch_telemetry` on the watch record and into
the `syncHistory` collection.

## Resume / playback progress

On `ended` (and via the scheduled poller), if resume is actionable
(`shouldSyncResumeProgress`), a record goes into `playbackProgress` keyed by
`media_key`, and `syncMediaProgress()` pushes the resume position to the other
platforms.

## Plex specifics worth remembering

- Native Plex webhooks only fire on **state changes** (play/pause/resume/stop/
  scrobble) — there is **no heartbeat**. So a single `media.play` creates an
  `activeSessions` row that **expires after 5 minutes** unless another event
  arrives. Continuous "still playing" tracking for Plex comes from the
  `scheduledSync` poller (→ `liveTrackingCache`), not from native webhooks.
- Plex does **not** send unwatched (unscrobble) events. Unwatched sync for Plex is
  limited; Emby/Jellyfin do send mark-unplayed events.
- The in-app Help → "Webhook Setup" page documents per-server configuration
  (search `webhookWarning` / the `webhooks` help topic in `public/app.js`).
