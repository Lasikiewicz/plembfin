# Troubleshooting (symptom-first)

Start here. Find the symptom, follow the pointer.

## "Now Playing is empty or stale"

Causes, in order of likelihood:

1. **Scheduler isn't reaching the media servers.** The poller runs on the Plembfin
   server machine. If that machine can't reach the configured Plex/Emby/Jellyfin
   URLs, `live_tracking_cache` stays empty. The browser-side local probe compensates
   for display but the scheduler's completion/catch-up logic won't run. Check the
   server logs and Settings → System → Health.
2. **Database is stale.** Check via SQLite directly:
   ```sh
   sqlite3 data/plembfin.db "SELECT title, last_progress, completed_at FROM live_tracking_cache ORDER BY updated_at DESC LIMIT 10;"
   ```
3. **Frontend render bug.** `/api/now-playing` returns sessions but the grid stays
   empty → bug in `renderNowPlaying`/`setActiveSessions` (`public/app.js`).

See [now-playing.md](now-playing.md) for full diagnosis steps.

## "A watched event didn't record"

- Confirm the webhook reached Plembfin with the correct `?token=` secret. The server
  logs every incoming webhook attempt and whether auth passed.
- Check `media.phase` was `completed` — a Plex `media.stop` below 90% becomes
  `ended`, not `completed`. See the phase table in [webhooks.md](webhooks.md).
- Check `sync_history` and the watch record's `sync_dispatch_telemetry` for errors.

## "A watched item recorded but didn't sync to the other platforms"

- Look at `sync_history` and the record's `sync_dispatch_telemetry`.
  ```sh
  sqlite3 data/plembfin.db "SELECT * FROM sync_history ORDER BY created_at DESC LIMIT 10;"
  ```
- Check the target platform's client credentials (URL / API key / user ID).
- Errors reading `Request timed out after 10000ms` mean the target server accepted
  the connection but did not answer within the outbound timeout — check that the
  media server is responsive and reachable from the Plembfin host (backup
  destinations use a 60-second budget for uploads/downloads).
- Echo suppression: `loopStore` drops events that look like echoes of a recent
  dispatch — usually correct. If sync is double-firing, check loop keys:
  ```sh
  sqlite3 data/plembfin.db "SELECT * FROM loop_keys WHERE expires_at > unixepoch('now', 'subsec') * 1000;"
  ```

## "Resume position didn't carry over"

Triggered on `ended` when `shouldSyncResumeProgress` is true and the source
provided `viewOffset`/`duration`. Check that Plex is sending lifecycle events
(`media.pause`, `media.stop`) with `viewOffset` and `duration` populated, and that
the position is over one minute (sub-minute positions are ignored to avoid noise).

## "Posters are missing / wrong"

Two-tier: frontend renders a `poster-fallback` then calls
`/api/poster?id=<watchRecordId>`. Backend tries candidates in order — stored URL →
configured server URL (Plex/Emby/Jellyfin) → TMDB — resizes with sharp, writes the
winner to `data/media/posters` or `data/media/backdrops`, and records metadata in
`poster_cache`.

Only `/media/posters/` and `/media/backdrops/` URLs are treated as "cached"
(`isCachedStorageImageUrl`); `image.tmdb.org` URLs are not.

## "Can't sign in / 401s everywhere"

- Verify credentials: `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars, or `data/config.json`.
- The session cookie `plembfin_session` must be present and unexpired (7-day TTL).
- If `COOKIE_SECURE=true` is set, the cookie is only sent over HTTPS. Accessing the
  app over HTTP will silently drop it.
- API key is shown after sign-in via Settings → Connections → Webhooks (click the eye icon
  if present) or from `GET /api/auth/apikey` with a valid session.
- If all sessions appear invalid, `sessionSecret` may have rotated (e.g. after
  "Revoke All Sessions"). Sign in again.

## "Webhook returns 401"

- The webhook secret is missing or wrong. Media-server setup usually uses the
  `?token=` URL from **Settings → Connections → Webhooks**; automation can send
  `X-Plembfin-Webhook-Secret` or `Authorization: Bearer <secret>`.
- If you rotated the webhook secret ("Rotate Secret" button), all media servers need
  to be updated with the new URL or header value.

## "Scheduler / background sync not running"

- The scheduler runs inside the server process. Confirm the server is running:
  check `GET /api/ping` (returns `{"ok":true}` with no auth).
- Trigger it manually: `POST /api/cron-sync` with your API key — the response
  streams a line-by-line log.
- Watch the server stdout for `[cron]` log lines.

## "Settings or config not saving"

- Confirm `DATA_DIR` (`data/` by default) is writable.
- In Docker, confirm the volume is mounted: `docker exec plembfin ls /data`.
- `data/config.json` must be writable for credential/secret persistence.

## General: where do I look?

| Need | Place |
| --- | --- |
| What route handles X | `dispatch()` in `server/src/index.js` |
| Live server logs | stdout of `node server/server.js` (or `docker logs plembfin`) |
| Database inspection | `sqlite3 data/plembfin.db` |
| Run the background worker on demand | `POST /api/cron-sync` (streams a log) |
| Frontend debug logs | `logDebug(...)` calls throughout `public/app.js` (and the in-app Logs panel) |
| Which file owns a feature | The file map and task router in [architecture.md](architecture.md) |
| Security remediation history | [security-checklist.md](security-checklist.md) |
