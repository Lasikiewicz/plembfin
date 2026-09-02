import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-personal-watchlist-repository-");

const { db } = await import("../server/src/db.js");
const {
  applyWatchlistMutation,
  getCanonicalWatchlist,
  getLatestWatchlistMutation,
  getWatchlistRestoreState,
  getWatchlistRevision,
  listWatchlistActivity,
  listWatchlistMutations,
  listWatchlistProviderItems,
  listWatchlistQueue,
  markWatchlistRestorePending,
  recordProviderWatchlistRemoval,
  removeWatchlistAfterCompletedWatch,
  upsertProviderWatchlistItem,
  clearWatchlistRestorePending,
} = await import("../server/src/utils/personalWatchlistRepository.js");
const {
  normalizePersonalWatchlistMedia,
  personalWatchlistMediaAliases,
} = await import("../server/src/utils/personalWatchlistIdentity.js");

const config = {
  watchlistSync: {
    enabled: true,
    providers: {
      plex: { enabled: true, representation: "native", writeEnabled: true, publishConfirmedAt: 1 },
      emby: { enabled: true, representation: "playlist", publishConfirmedAt: 1 },
      jellyfin: { enabled: false, representation: "playlist", publishConfirmedAt: 0 },
    },
  },
};

test.after(() => db.close());

test("watchlist identity is canonical across provider ids and title aliases", () => {
  const media = normalizePersonalWatchlistMedia({
    type: "series",
    title: "The Example Show",
    tmdbId: "101",
    year: 2024,
  });
  assert.equal(media.media_type, "tv");
  assert.equal(media.media_key, "tv:tmdb:101");
  assert.ok(personalWatchlistMediaAliases(media).includes("tv:tmdb:101"));
  assert.ok(personalWatchlistMediaAliases({ type: "tv", title: "The Example Show", tmdb_id: "101" }).includes("tv:tmdb:101"));
});

test("local mutations are append-only, idempotent, and collapse provider delivery to the newest intent", () => {
  const media = normalizePersonalWatchlistMedia({ type: "movie", title: "Queue Isolation", tmdb_id: "201" });
  const added = applyWatchlistMutation(media, "present", {
    config,
    origin: "local",
    reason: "manual_add",
    eventId: "add-201",
    timestamp: 1000,
  });
  assert.equal(added.queued.length, 2);
  assert.equal(getCanonicalWatchlist(media).media_key, "movie:tmdb:201");
  const revisionAfterAdd = getWatchlistRevision();

  const duplicate = applyWatchlistMutation(media, "present", {
    config,
    origin: "local",
    reason: "manual_add",
    eventId: "add-201",
    timestamp: 1100,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(getWatchlistRevision(), revisionAfterAdd);

  applyWatchlistMutation(media, "absent", {
    config,
    origin: "local",
    reason: "manual_remove",
    eventId: "remove-201",
    timestamp: 1200,
  });
  assert.equal(getCanonicalWatchlist(media), null);
  assert.deepEqual(
    listWatchlistQueue({ provider: "plex" }).map((row) => ({ state: row.desired_state, status: row.status })),
    [{ state: "absent", status: "pending" }],
  );

  applyWatchlistMutation(media, "present", {
    config,
    origin: "local",
    reason: "manual_add",
    eventId: "add-again-201",
    timestamp: 1300,
  });
  assert.equal(getLatestWatchlistMutation(media.media_key).desired_state, "present");
  assert.equal(listWatchlistQueue({ provider: "plex" })[0].desired_state, "present");
  assert.equal(listWatchlistMutations({ mediaKey: media.media_key }).length, 3);
  assert.ok(listWatchlistActivity({ limit: 10 }).length >= 3);
});

test("provider removals and watched completion respect stale and show-level guards", () => {
  const movie = normalizePersonalWatchlistMedia({ type: "movie", title: "Stale Provider Event", tmdb_id: "202" });
  applyWatchlistMutation(movie, "present", { config, origin: "local", eventId: "add-202", timestamp: 2000 });
  const stale = recordProviderWatchlistRemoval(movie, {
    provider: "plex",
    config,
    eventFingerprint: "plex-removal-old-202",
    eventAt: 1900,
    timestamp: 2100,
  });
  assert.equal(stale.removed, false);
  assert.equal(stale.stale, true);
  assert.equal(getCanonicalWatchlist(movie).media_key, movie.media_key);

  const removed = recordProviderWatchlistRemoval(movie, {
    provider: "plex",
    config,
    eventFingerprint: "plex-removal-new-202",
    eventAt: 2200,
    timestamp: 2200,
  });
  assert.equal(removed.removed, true);
  assert.equal(getCanonicalWatchlist(movie), null);

  const show = normalizePersonalWatchlistMedia({ type: "tv", title: "Completion Guard", tmdb_id: "203" });
  applyWatchlistMutation(show, "present", { config, origin: "local", eventId: "add-203", timestamp: 3000 });
  const episode = { type: "episode", show_title: show.title, show_tmdb_id: show.tmdb_id, season: 1, episode: 1 };
  assert.equal(removeWatchlistAfterCompletedWatch(episode, { config, timestamp: 3100 }).removed, false);
  assert.equal(getCanonicalWatchlist(show).media_key, show.media_key);
  assert.equal(removeWatchlistAfterCompletedWatch({ ...episode, showCompleted: true }, { config, eventId: "show-complete-203", timestamp: 3200 }).removed, true);
  assert.equal(getCanonicalWatchlist(show), null);
});

test("provider ledger preserves playlist entry ids and restore state is explicit", () => {
  const media = normalizePersonalWatchlistMedia({ type: "movie", title: "Ledger Item", tmdb_id: "204" });
  upsertProviderWatchlistItem({
    provider: "emby",
    connectionId: "emby-1",
    remoteScopeKey: "server:user",
    representation: "playlist",
    media,
    providerItemId: "item-204",
    providerIds: { playlist_entry_id: "entry-204" },
    containerId: "playlist-1",
    managedByPlembfin: true,
    timestamp: 4000,
  });
  const ledger = listWatchlistProviderItems({ provider: "emby", connectionId: "emby-1", mediaKey: media.media_key });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].provider_ids.playlist_entry_id, "entry-204");
  const restore = markWatchlistRestorePending({ restoreId: "restore-204", timestamp: 4100 });
  assert.equal(restore.pending, true);
  assert.deepEqual(getWatchlistRestoreState(), { pending: true, restoreId: "restore-204", createdAt: 4100 });
  clearWatchlistRestorePending({ timestamp: 4200 });
  assert.equal(getWatchlistRestoreState().pending, false);
});
