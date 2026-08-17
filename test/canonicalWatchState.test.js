import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-canonical-watch-state-");

const repo = await import("../server/src/utils/dataRepo.js");
const runtime = await import("../server/src/utils/configStore.js");
const { applyWatchedStateToNewItem } = await import("../server/src/routes/sync.js");
const { trackerMediaWithSeriesIds } = await import("../server/src/utils/trackerDispatcher.js");
const { selectTraktWatchedTransitions } = await import("../server/src/utils/trackerSync.js");

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

test("Trakt episode dispatch replaces episode IDs with series IDs", () => {
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
  assert.deepEqual(media.ids, { tmdb: "98177", tvdb: "375903", imdb: "tt10982034" });
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
