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
full URL (including token) from **Settings → API Endpoints** in the dashboard. You can
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
| `active` | Currently playing (play/resume/progress) | `upsertActiveSession()` → writes `active_sessions` row (5-min TTL), bumps `runtimeState.nowPlayingRefresh`. **No history insert.** |
| `completed` | Watched (scrobble, mark-played, or stop ≥ 90%) | Inserts/updates a `watch_history` record + propagates *watched* to the other platforms. |
| `ended` | Stopped below the watched threshold | Deletes active session; if resume is actionable, stores/propagates resume progress to `playback_progress`. |
| `unplayed` | Marked unwatched/unplayed | Deletes active session, deletes the watch record, inserts an `unwatched` row, and propagates *unwatched* to the other platforms. |
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
webhook back. The in-memory `loopStore` map tracks recently-dispatched events keyed
by platform + media identifier; an incoming webhook matching a recent dispatch is
detected as an echo and dropped before it can trigger another round.

> `loopStore` is in-memory per process. Because Plembfin is a single long-running
> process, this works reliably — echoes arrive within seconds and are always caught.

Results are written back as `sync_dispatch_telemetry` on the watch record and into
the `sync_history` SQLite table.

## Resume / playback progress

On `ended` (and via the scheduled poller), if resume is actionable
(`shouldSyncResumeProgress`), a record goes into `playback_progress` keyed by
`media_key`, and `syncMediaProgress()` pushes the resume position to the other
platforms.

## Plex specifics worth remembering

- Native Plex webhooks only fire on **state changes** (play/pause/resume/stop/
  scrobble) — there is **no heartbeat**. So a single `media.play` creates an
  `active_sessions` row that **expires after 5 minutes** unless another event
  arrives. Continuous "still playing" tracking for Plex comes from the
  in-process scheduler (→ `live_tracking_cache`), not from native webhooks.
- Plex does **not** send unwatched (unscrobble) events. Plembfin compensates via
  the built-in Plex WebSocket notification listener, which connects automatically
  using the configured Plex URL and token.
- The in-app Settings → Apps webhook setup guide documents per-server configuration.
