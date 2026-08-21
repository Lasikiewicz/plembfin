import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-canonical-watch-state-");

const repo = await import("../server/src/utils/dataRepo.js");
const runtime = await import("../server/src/utils/configStore.js");
const { applyWatchedStateToNewItem } = await import("../server/src/routes/sync.js");
const { trackerMediaWithSeriesIds } = await import("../server/src/utils/trackerDispatcher.js");
const { selectTraktWatchedTransitions } = await import("../server/src/utils/trackerSync.js");

test("a rematched episode with new provider ids is still recognized as already watched via the show title", async () => {
  // Simulates a row recorded before insert-time show-title normalization
  // stripped trailing years (real historical rows like this exist - normal
  // inserts today already strip the year, so this has to be written directly
  // rather than through insertWatchRecord to reproduce the legacy shape).
  const db = repo.requireDb();
  const rowId = "legacy-ludwig-row";
  db.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tvdb_id, season, episode, sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
    VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'emby', '435298', 1, 1, 'watched', @media_key, @show_title, @show_title_lower, @now, @now)`).run({
    id: rowId,
    title: "Ludwig (2024) - S01E01",
    title_lower: "ludwig (2024) - s01e01",
    watched_at: "2026-07-01T20:00:00.000Z",
    media_key: "episode:1:1:tvdb:435298",
    show_title: "Ludwig (2024)",
    show_title_lower: "ludwig (2024)",
    now: Date.now(),
  });

  // A later metadata rematch swapped this episode onto entirely new provider
  // ids and dropped the year from both the show title and the full title -
  // neither the id-based keys nor either exact-string fallback can match
  // this against the row above; only normalized show-title matching can.
  const rematched = {
    title: "Ludwig - S01E01",
    show_title: "Ludwig",
    type: "episode",
    media_type: "episode",
    season: 1,
    episode: 1,
    ids: { imdb: "tt99999901" },
  };

  const found = await repo.findWatchedByAnyMediaKey(rematched);
  assert.ok(found, "the coordinate fallback should still find the pre-rematch row by normalized show title");
  assert.equal(found.id, rowId);
});

test("playstate lookup also survives the same legacy show-title mismatch", async () => {
  const db = repo.requireDb();
  const mediaKey = "episode:1:2:tvdb:435298";
  db.prepare(`INSERT INTO playstate
    (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, tvdb_id, season, episode, updated_at)
    VALUES (@media_key, @title, @title_lower, 'episode', 'watched', @watched_at, 'emby', '["emby"]', '435298', 1, 2, @now)`).run({
    media_key: mediaKey,
    title: "Ludwig (2024) - S01E02",
    title_lower: "ludwig (2024) - s01e02",
    watched_at: "2026-07-01T20:05:00.000Z",
    now: Date.now(),
  });

  const state = await repo.getPlaystateForMedia({
    title: "Ludwig - S01E02",
    type: "episode",
    season: 1,
    episode: 2,
    ids: { imdb: "tt99999902" },
    isValid: true,
  });
  assert.equal(state?.state, "watched");
  assert.equal(state?.media_key, mediaKey);
});

test("two unrelated shows sharing a season/episode number are not conflated", async () => {
  const inserted = await repo.insertWatchRecord({
    title: "Show One - S01E01",
    show_title: "Show One",
    media_type: "episode",
    season: 1,
    episode: 1,
    watched_at: "2026-07-01T20:00:00.000Z",
    source: "plex",
  });

  const other = {
    title: "Show Two - S01E01",
    show_title: "Show Two",
    type: "episode",
    media_type: "episode",
    season: 1,
    episode: 1,
    ids: {},
  };

  assert.equal(await repo.findWatchedByAnyMediaKey(other), null);
  // Sanity check the fixture itself is still found under its own identity.
  const same = await repo.findWatchedByAnyMediaKey({ title: "Show One - S01E01", show_title: "Show One", type: "episode", season: 1, episode: 1, ids: {} });
  assert.equal(same.id, inserted.id);
});

test("imported watched records become canonical playstate and remain queued for app sync", async () => {
  const result = await repo.batchInsertWatchRecords([{
    title: "Fallout - S01E01",
    media_type: "episode",
    season: 1,
    episode: 1,
    watched_at: "2026-07-18T12:00:00.000Z",
    tmdb_id: "106379",
  }]);

  assert.equal(result.inserted, 1);
  const row = (await repo.getCachedHistory()).find((item) => item.title.includes("Fallout"));
  assert.ok(row);
  assert.match(row.sync_dispatch_telemetry, /Dispatch status: pending/);

  const media = {
    title: row.title,
    type: row.media_type,
    season: row.season,
    episode: row.episode,
    ids: { tmdb: row.tmdb_id },
  };
  const playstate = await repo.getPlaystateForMedia(media);
  assert.equal(playstate?.state, "watched");
  assert.equal(await repo.getCanonicalWatchState(media), "watched");
});

test("an explicit Plembfin unwatch remains canonical over an older watched record", async () => {
  const media = {
    title: "Canonical Unwatch Movie",
    type: "movie",
    ids: { tmdb: "canonical-unwatch" },
    isValid: true,
  };
  const inserted = await repo.insertWatchRecord({
    title: media.title,
    media_type: "movie",
    tmdb_id: "canonical-unwatch",
    watched_at: "2026-07-17T12:00:00.000Z",
    source: "trakt_import",
  });
  await repo.upsertPlaystateForMedia(media, "watched", inserted.record.watched_at);
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-07-18T12:00:00.000Z");

  assert.equal(await repo.getCanonicalWatchState(media), "unwatched");
  // This is the exact gap that let detail-page Force Sync -> Import Watched
  // Status silently no-op on a show whose display was stuck unwatched behind
  // a later (possibly stale/erroneous) unwatch: findWatchedByAnyMediaKey
  // still finds the dormant older watched row, so a check of "!record" alone
  // wrongly concludes there's nothing to do. forceSyncMediaState now checks
  // getCanonicalWatchState instead, specifically to see through this gap.
  assert.ok(await repo.findWatchedByAnyMediaKey(media), "the old watched row is still on file and would satisfy a naive !record check");
});

test("a delayed library-added event cannot revive older watched history after an unwatch", async () => {
  const media = {
    title: "Canonical Unwatch Show - S04E16",
    showTitle: "Canonical Unwatch Show",
    type: "episode",
    season: 4,
    episode: 16,
    ids: { tvdb: "canonical-unwatch-episode" },
    isValid: true,
  };
  const inserted = await repo.insertWatchRecord({
    title: media.title,
    show_title: media.showTitle,
    media_type: "episode",
    season: media.season,
    episode: media.episode,
    tvdb_id: media.ids.tvdb,
    watched_at: "2026-07-17T12:00:00.000Z",
    source: "plex",
  });
  await repo.upsertPlaystateForMedia(media, "watched", inserted.record.watched_at);
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-07-18T12:00:00.000Z");

  const result = await applyWatchedStateToNewItem({ ...media, source: "emby", itemId: "new-emby-item" }, {});

  assert.equal(result.applied, false);
  assert.match(result.reason, /canonical state is unwatched/i);
  assert.equal(await repo.getCanonicalWatchState(media), "unwatched");
});

test("user-scoped scheduled history is visible while unscoped scan evidence stays hidden", async () => {
  await repo.insertWatchRecord({
    title: "Trying - S05E05",
    media_type: "episode",
    season: 5,
    episode: 5,
    watched_at: "2026-08-17T08:14:00.000Z",
    source: "plex",
    sync_dispatch_telemetry: "Details: Watch event fetched from Plex library history; sync completed.",
    watch_provenance: {
      source: "plex",
      ingest_path: "plex_scheduled_library_history",
      event: "library_history",
      phase: "completed",
      user: "configured-user",
      source_timestamp: "2026-08-17T08:14:00.000Z",
      captured_at: "2026-08-17T08:15:00.000Z",
    },
  });
  await repo.insertWatchRecord({
    title: "Untrusted Scan - S01E01",
    media_type: "episode",
    season: 1,
    episode: 1,
    watched_at: "2026-08-17T08:14:00.000Z",
    source: "plex",
    sync_dispatch_telemetry: "Details: Watch event fetched from Plex library history; sync completed.",
    watch_provenance: {
      source: "plex",
      ingest_path: "plex_scheduled_library_history",
      event: "library_history",
      phase: "completed",
      source_timestamp: "2026-08-17T08:14:00.000Z",
      captured_at: "2026-08-17T08:15:00.000Z",
    },
  });

  const trying = await repo.queryShowDetail({ title: "Trying" });
  assert.equal(trying?.episode_count, 1);
  assert.equal(trying?.representative_episode?.episode, 5);
  assert.equal(await repo.queryShowDetail({ title: "Untrusted Scan" }), null);
});

// A stored id on the episode is a known-correct identity for that exact row
// (from the media server or an import). A title search against TMDB can
// resolve to the wrong series for a short or common show title, so it must
// only ever fill in ids the episode doesn't already have - never replace
// ones that are already there. This is what let a bad TMDB title match for
// "G'wed" silently overwrite its correct TVDB id on every Trakt dispatch.
test("Trakt episode dispatch keeps the episode's own IDs instead of replacing them", () => {
  const media = trackerMediaWithSeriesIds({
    title: "Trying - S05E05",
    type: "episode",
    season: 5,
    episode: 5,
    ids: { tmdb: "episode-tmdb", tvdb: "episode-tvdb", imdb: "episode-imdb" },
  }, {
    id: 98177,
    external_ids: { tvdb_id: 375903, imdb_id: "tt10982034" },
  });

  assert.equal(media.showTitle, "Trying");
  assert.deepEqual(media.ids, { tmdb: "episode-tmdb", tvdb: "episode-tvdb", imdb: "episode-imdb" });
});

test("Trakt episode dispatch fills in only the IDs an episode is missing", () => {
  const media = trackerMediaWithSeriesIds({
    title: "Trying - S05E05",
    type: "episode",
    season: 5,
    episode: 5,
    ids: { tmdb: "episode-tmdb" },
  }, {
    id: 98177,
    external_ids: { tvdb_id: 375903, imdb_id: "tt10982034" },
  });

  assert.equal(media.showTitle, "Trying");
  assert.deepEqual(media.ids, { tmdb: "episode-tmdb", tvdb: "375903", imdb: "tt10982034" });
});

test("manual Trakt reconciliation replays an unchanged remote watch over local drift", () => {
  const item = { mediaKey: "episode:tmdb:98177:s5e6", watchedAt: 100, media: { title: "Trying - S05E06" } };
  const previous = [{ ...item, remoteWatchedAt: 100, lastOutboundState: "", lastOutboundAt: 0 }];

  assert.deepEqual(selectTraktWatchedTransitions({ snapshot: [item], previous, baseline: true }), []);
  assert.deepEqual(selectTraktWatchedTransitions({
    snapshot: [item],
    previous,
    baseline: true,
    reconcileKeys: new Set([item.mediaKey]),
  }), [item]);
});

test("watchstate replay snapshots exclude rows written after the run began", async () => {
  const firstMedia = {
    title: "Replay Snapshot First",
    type: "movie",
    ids: { tmdb: "replay-snapshot-first" },
    isValid: true,
  };
  const secondMedia = {
    title: "Replay Snapshot Later",
    type: "movie",
    ids: { tmdb: "replay-snapshot-later" },
    isValid: true,
  };

  const firstRecord = await repo.insertWatchRecord({
    title: firstMedia.title,
    media_type: "movie",
    tmdb_id: firstMedia.ids.tmdb,
    watched_at: "2026-07-19T12:00:00.000Z",
    source: "trakt_import",
  });
  await repo.upsertPlaystateForMedia(firstMedia, "watched", firstRecord.record.watched_at);
  const firstPlaystate = await repo.getPlaystateForMedia(firstMedia);
  const snapshotAt = firstPlaystate.updated_at;

  await new Promise((resolve) => setTimeout(resolve, 3));
  const secondRecord = await repo.insertWatchRecord({
    title: secondMedia.title,
    media_type: "movie",
    tmdb_id: secondMedia.ids.tmdb,
    watched_at: "2026-07-19T12:01:00.000Z",
    source: "trakt_import",
  });
  await repo.upsertPlaystateForMedia(secondMedia, "watched", secondRecord.record.watched_at);

  const rows = await repo.listWatchedPlaystateRowsForReplay({ limit: 100, snapshotAt });
  const keys = new Set(rows.map((row) => row.media_key));
  assert.ok(keys.has(firstPlaystate.media_key));
  assert.ok(!keys.has((await repo.getPlaystateForMedia(secondMedia)).media_key));
});

test("restore lock reset cancels an orphaned full-sync owner without clearing backup restores", async () => {
  await runtime.setRuntimeState({
    restoreSyncActive: true,
    restoreSyncRunId: "orphan-full-sync",
    restoreSyncKind: runtime.RESTORE_KIND_FULL_SYNC,
    restoreSyncCancelRequested: false,
  });

  const cleared = await runtime.clearRestoreSyncState({ reason: "test reset" });
  assert.equal(cleared.reset, true);
  let state = await runtime.loadRuntimeState();
  assert.equal(state.restoreSyncActive, false);
  assert.equal(state.restoreSyncRunId, "");
  assert.equal(state.restoreSyncCancelRequested, true);
  assert.equal(state.restoreSyncResult.reason, "test reset");

  await runtime.setRuntimeState({
    restoreSyncActive: true,
    restoreSyncRunId: "backup-restore",
    restoreSyncKind: runtime.RESTORE_KIND_BACKUP,
    restoreSyncCancelRequested: false,
  });
  const skipped = await runtime.clearRestoreSyncState({ expectedKind: runtime.RESTORE_KIND_FULL_SYNC });
  assert.equal(skipped.reset, false);
  assert.equal(skipped.skipped, true);
  state = await runtime.loadRuntimeState();
  assert.equal(state.restoreSyncActive, true);
  assert.equal(state.restoreSyncKind, runtime.RESTORE_KIND_BACKUP);
  await runtime.clearRestoreSyncState({ reason: "test cleanup" });
});
