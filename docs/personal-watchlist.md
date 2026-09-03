# Personal Watchlist Sync

Plembfin stores the personal watchlist locally as the canonical present-set. A local
watchlist add or removal commits to SQLite first and creates durable provider work; the
browser does not wait for Plex, Emby, or Jellyfin.

## Provider projections

Watchlist sync is disabled by default and has one control in Settings → Sync Tools →
Personal Watchlist Sync: on or off. Enabling it includes every connected writable media
server on a five-minute cadence. Plex uses the account-level Universal Watchlist;
Emby and Jellyfin use a dedicated `Plembfin Watchlist` playlist.

The first sync takes a safe union of Plembfin and provider lists. Provider-only entries
are imported into Plembfin and fanned out to the other connected providers. Later
complete snapshots reconcile additions and removals; incomplete snapshots cannot delete
canonical entries.

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

`GET /api/watchlist-sync/status` returns an `issues` array, both per provider and for the
whole queue. Each entry groups the stuck queue rows by provider and state and carries the
count, up to three affected titles, the redacted provider error, the highest attempt count,
and the next scheduled retry time. The Personal Watchlist Sync panel in Settings renders one
card per group, so a service that refuses a change explains what it reported and what to do:

- `reauth_required` names the service whose stored sign-in was refused and offers a button
  that opens Settings → Media Servers to reconnect it.
- `failed` shows the error the service returned, the failed attempt count, and when the next
  automatic attempt is due.
- `not_available` explains that the entry has nowhere to go on that service yet. It stays on
  the Plembfin list and is added automatically once the service can hold it.

A provider whose last snapshot run failed gets its own card, built from `providers[].lastRun`
rather than the queue. Nothing can be queued against a list Plembfin could not read, so that
failure is otherwise invisible: the provider row still reports its configured capability. That
read is also the only path by which an addition made in the provider becomes a canonical
Plembfin watchlist entry (`recordProviderSnapshot` applies unmatched remote items with reason
`provider_added`), so a failed run stops imports in both directions.

A **Retry queued changes** button on that panel posts `{"action":"retry"}` to
`/api/watchlist-sync/run`, which resets failed, unavailable, and reauthentication rows back
to pending and immediately runs a reconcile pass. Because `retry` mode deliberately skips the
provider snapshot, the button follows it with a plain `run` whenever a run failure is on
screen, so a failed read is actually re-attempted. The panel header reads `Needs attention`
only for failed or reauthentication rows.

## Whether an item must exist in the connected library

This depends on how each service represents a watchlist, and the two cases are different:

- **Plex** has a real, account-scoped Universal Watchlist covering the whole Plex catalog, so
  an item does not need to be on your Plex server to be added to it. Plembfin sends these
  writes to the Plex account service, never to the selected Plex Media Server.
- **Emby and Jellyfin** have no watchlist concept. Plembfin represents one as a playlist
  (or favorites), and both can only contain items that already exist in that library. A
  title you want to watch but do not own therefore has nowhere to go on those services.

That makes `not_available` on Emby or Jellyfin the expected state for an unowned title, not a
failure. The canonical Plembfin list keeps the entry, the queue row stays eligible for the
next reconcile pass, and the item is added to that service on its own once the library
contains it. The panel header reports this as `Synced · <n> not in library` rather than
`Needs attention`, and the per-provider row reads `<n> not in library`.

On Plex the same state means something else: Plembfin could not identify the title in the
Plex catalog, which usually indicates the watchlist entry is missing the provider IDs Plex
matches on.

Full Plembfin backup/export includes the canonical watchlist and its non-secret sync state.
Restoring it invalidates remote observations and forces another safe-union snapshot before
delivery resumes. Watch-history-only backups do not include personal watchlist data.

The authenticated API surface is:

- `GET /api/watchlist-sync/status`
- `POST /api/watchlist-sync/preview`
- `POST /api/watchlist-sync/run`
- `GET /api/watchlist-sync/activity`

All provider credentials remain server-side. The scheduler runs the watchlist worker under
the shared SQLite leadership lease with its own queue and time budget, independently of
watched-state and personal-rating synchronization.
