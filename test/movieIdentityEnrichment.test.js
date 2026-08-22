import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-movie-identity-enrichment-");

const { db, toJson } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { trackerMediaWithMovieIds } = await import("../server/src/utils/trackerDispatcher.js");
const { queuedWatchRecordToSyncActivity } = await import("../server/src/routes/sync.js");

test("queued watch records are shaped as Sync Activity entries", () => {
  const entry = queuedWatchRecordToSyncActivity({
    id: "watch-1",
    title: "Toy Story 5",
    media_type: "movie",
    source: "plex",
    sync_action: "unwatched",
    tmdb_id: "1084244",
    sync_dispatch_telemetry: [
      "Origin: plex",
      "Dispatch status: pending",
      "Details: Outbound synchronization queued.",
      "Trakt status: pending - Waiting for provider ids",
    ].join("\n"),
    updated_at: 1_755_875_420_000,
    watch_provenance: { event: "notification.viewstate" },
  });

  assert.equal(entry.id, "queued:watch-1");
  assert.equal(entry.status, "pending");
  assert.equal(entry.action, "unwatched");
  assert.deepEqual(entry.rawPayloadDebug.ids, { imdb: "", tmdb: "1084244", tvdb: "" });
  assert.deepEqual(entry.targetStates, [{ target: "trakt", status: "pending", detail: "Waiting for provider ids" }]);
});

test("movie tracker hydration fills missing provider ids without replacing an existing id", () => {
  const media = trackerMediaWithMovieIds({
    title: "Toy Story 5",
    type: "movie",
    ids: { tmdb: "1084244" },
  }, {
    id: 1084244,
    external_ids: { imdb_id: "tt29355505", tvdb_id: "toy-story-5-tvdb" },
  });

  assert.deepEqual(media.ids, {
    tmdb: "1084244",
    imdb: "tt29355505",
    tvdb: "toy-story-5-tvdb",
  });
});

test("adding a movie persists TMDB, IMDb and TVDB ids without resetting dispatch telemetry", async () => {
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "movie_1084244",
    "1084244",
    "movie",
    "Toy Story 5",
    toJson({
      id: 1084244,
      title: "Toy Story 5",
      status: "Released",
      external_ids: { imdb_id: "tt29355505", tvdb_id: "toy-story-5-tvdb" },
    }),
    9999,
    Date.now(),
  );

  const inserted = await repo.insertWatchRecord({
    title: "Toy Story 5",
    media_type: "movie",
    tmdb_id: "1084244",
    source: "plex",
    watched_at: "2026-08-22T16:30:20.114Z",
    sync_dispatch_telemetry: "Origin: plex\nDispatch status: success\nDetails: Already synced.",
  });
  await inserted.assetPrefetch;

  const stored = await repo.getWatchRecordByIdLight(inserted.id);
  assert.equal(stored.imdb_id, "tt29355505");
  assert.equal(stored.tmdb_id, "1084244");
  assert.equal(stored.tvdb_id, "toy-story-5-tvdb");
  assert.equal(stored.sync_dispatch_telemetry, "Origin: plex\nDispatch status: success\nDetails: Already synced.");
});
