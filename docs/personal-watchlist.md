# Personal Watchlist Sync

Plembfin stores the personal watchlist locally as the canonical present-set. A local
watchlist add or removal commits to SQLite first and creates durable provider work; the
browser does not wait for Plex, Emby, or Jellyfin.

## Provider projections

Watchlist sync is disabled by default and must be enabled globally and per provider in
Settings → Sync Tools → Personal Watchlist Sync. Plex uses the account-level Universal
Watchlist adapter or a read-only RSS representation. Emby and Jellyfin use a dedicated
`Plembfin Watchlist` playlist by default, with Favorites available as an ownership-tracked
compatibility mode. Plex writes require the explicit account-write setting.

The first publish is previewed and confirmed. Provider-only entries are not imported. A
dedicated playlist or Plembfin-owned Favorite may be cleaned up during reconciliation;
unmanaged Favorites and account-level Plex entries are preserved.

## Completion and removal

Completed movies and explicitly completed TV shows create a durable local removal tombstone
with origin `watched`, then fan out removal work to every enabled provider. Watching one
episode of an incomplete show does not remove the show. A confirmed removal from a managed
provider representation becomes a canonical local removal with origin `provider_removed`.
An explicit local re-add creates a newer revision, so an older completion or provider event
cannot immediately undo it.

## Recovery and status

The queue, provider ownership ledger, snapshot generations, mutation history, and activity
events live in separate SQLite tables. A provider outage, incomplete snapshot, ambiguous
match, or unavailable library item never deletes the canonical local row. Status exposes
pending, unavailable, reauthentication, and failure states, with retry actions in Settings.

Full Plembfin backup/export includes the canonical watchlist and its non-secret sync state.
Restoring it invalidates remote observations and pauses delivery until **Publish local list**
is explicitly confirmed. Watch-history-only backups do not include personal watchlist data.

The authenticated API surface is:

- `GET /api/watchlist-sync/status`
- `POST /api/watchlist-sync/preview`
- `POST /api/watchlist-sync/run`
- `GET /api/watchlist-sync/activity`

All provider credentials remain server-side. The scheduler runs the watchlist worker under
the shared SQLite leadership lease with its own queue and time budget, independently of
watched-state and personal-rating synchronization.
