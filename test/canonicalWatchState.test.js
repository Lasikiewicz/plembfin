import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-canonical-watch-state-");

const repo = await import("../server/src/utils/dataRepo.js");

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
