# Personal Rating Sync

Personal ratings are a separate synchronization domain from watched state, play
history, resume positions, and custom lists. Plembfin's local `personal_ratings`
table remains the canonical store. Remote work is optional and is delivered through
its own durable queue and scheduler cadence.

## Settings

Open **Settings → Sync → Sync Tools → Personal Rating Sync**. It is disabled by
default. When enabled, each provider can independently use one of these directions:

- **Off** - keep ratings local only.
- **Send local ratings** - queue Plembfin changes for that provider.
- **Receive remote ratings** - import that provider's ratings into Plembfin.
- **Two-way sync** - receive remote changes and send canonical changes back out.

The first snapshot uses **Baseline** by default. Baseline records the provider's
current ratings without changing local ratings; choose **Import** when the provider
should seed Plembfin. Later complete snapshots reconcile additions and removals. A
partial or failed snapshot cannot clear local ratings through missing rows.

`local_wins` keeps a newer local rating when a remote observation conflicts with it;
`remote_wins` applies the remote observation. Outbound intent markers suppress an
echo of a change Plembfin just sent.

## Local writes and queue behavior

Rating and remove-rating actions commit Plembfin's canonical value first. If rating
sync is enabled, the same SQLite transaction upserts one queue item per enabled send
provider. A later edit or removal replaces the pending item for that provider, so a
stale rating cannot be delivered after a newer intent.

The request that saves a local rating does not call Plex, Emby, Jellyfin, or Trakt.
The queue worker leases items, retries transient failures with backoff, records
`not_found` and `reauth_required` states, and preserves failed work for a manual
retry. A provider outage therefore does not roll back the local rating or affect the
watched-state synchronizer.

## Identity and episodes

Movies and shows use their own provider identity. An episode uses its parent show
identity plus season and episode coordinates in `media_key`; episode-level TMDB,
TVDB, IMDb, and provider item IDs are stored separately for remote writes. This
prevents an episode's leaf ID from fragmenting the show's episode rating record.

## Manual actions and API

The Settings panel can run a complete rating snapshot or push local ratings. The
title Force Sync modal also has a **Push Personal Rating** row for the currently
open title. Both actions target one provider or all enabled send providers and do
not enter the watched-state Force Sync activity or operation lock.

The authenticated endpoints are:

- `GET /api/rating-sync/status`
- `POST /api/rating-sync/run`
- `POST /api/rating-sync/push`
- `POST /api/rating-sync/retry`

Trakt is a selectable target for both watched-state Push and personal-rating Push.
Watched-state Pull remains media-server-only because the existing pull operation
imports watched state from Plex, Emby, or Jellyfin; it is not a personal-rating
operation.

## Storage

Migration 20 adds episode identity and origin metadata to `personal_ratings` and
creates:

- `personal_rating_sources` - the last provider observation, snapshot generation,
  conflict status, and outbound echo markers.
- `personal_rating_sync_queue` - one durable latest-intent row per provider/media key,
  with lease, retry, and result state.
- `personal_rating_sync_runs` - per-provider baseline/import generation and counts.

See [sqlite-schema.md](sqlite-schema.md) for the table reference and
[scheduled-sync.md](scheduled-sync.md) for scheduler ownership and cadence.
