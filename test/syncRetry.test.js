import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// All imports below open the SQLite database, so DATA_DIR must point at a
// temp directory before any server module loads (same pattern as the
// loopStore test in syncOrchestrator.test.js).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-sync-retry-test-"));
process.env.DATA_DIR = dataDir;

const {
  mediaFromEmbyLikeResumableItem,
  syncRetryDelayMs,
  syncRetryEligible,
  SYNC_RETRY_MAX_ATTEMPTS,
} = await import("../server/src/scheduled.js");
const { appendSyncHistory, pruneSyncHistory, getSyncHistory } = await import("../server/src/utils/configStore.js");
const {
  getPlaybackProgressForMedia,
  getPlaystateForMedia,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
} = await import("../server/src/utils/dataRepo.js");
const { normalizeProviderIds } = await import("../server/src/utils/parsers.js");
const { db } = await import("../server/src/db.js");

test("syncRetryDelayMs follows the backoff schedule and repeats the last step", () => {
  assert.equal(syncRetryDelayMs(1), 60_000);
  assert.equal(syncRetryDelayMs(2), 5 * 60_000);
  assert.equal(syncRetryDelayMs(3), 15 * 60_000);
  assert.equal(syncRetryDelayMs(4), 60 * 60_000);
  assert.equal(syncRetryDelayMs(5), 6 * 60 * 60_000);
  assert.equal(syncRetryDelayMs(6), 6 * 60 * 60_000);
  assert.equal(syncRetryDelayMs(SYNC_RETRY_MAX_ATTEMPTS), 6 * 60 * 60_000);
  // Defensive: a zero/garbage count behaves like the first attempt.
  assert.equal(syncRetryDelayMs(0), 60_000);
  assert.equal(syncRetryDelayMs(undefined), 60_000);
});

test("syncRetryEligible respects backoff windows and the terminal attempt cap", () => {
  const now = 1_000_000;
  // Fresh record: no retry state yet.
  assert.equal(syncRetryEligible({}, now), true);
  assert.equal(syncRetryEligible({ sync_retry_count: 0, sync_next_retry_at: 0 }, now), true);
  // Still inside the backoff window.
  assert.equal(syncRetryEligible({ sync_retry_count: 2, sync_next_retry_at: now + 1 }, now), false);
  // Backoff window has passed.
  assert.equal(syncRetryEligible({ sync_retry_count: 2, sync_next_retry_at: now }, now), true);
  assert.equal(syncRetryEligible({ sync_retry_count: 2, sync_next_retry_at: now - 1 }, now), true);
  // Terminal: retry budget exhausted, never eligible regardless of timestamp.
  assert.equal(syncRetryEligible({ sync_retry_count: SYNC_RETRY_MAX_ATTEMPTS, sync_next_retry_at: 0 }, now), false);
  assert.equal(syncRetryEligible({ sync_retry_count: SYNC_RETRY_MAX_ATTEMPTS + 5, sync_next_retry_at: 0 }, now), false);
});

test("watch_history carries sync retry columns with zero defaults", () => {
  const cols = db.pragma("table_info(watch_history)").map((c) => c.name);
  assert.ok(cols.includes("sync_retry_count"));
  assert.ok(cols.includes("sync_next_retry_at"));
  db.prepare(
    "INSERT INTO watch_history (id, title, media_type, watched_at, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("retry-test-1", "Arrival", "movie", new Date().toISOString(), "plex", Date.now(), Date.now());
  const row = db.prepare("SELECT sync_retry_count, sync_next_retry_at FROM watch_history WHERE id = ?").get("retry-test-1");
  assert.equal(Number(row.sync_retry_count || 0), 0);
  assert.equal(Number(row.sync_next_retry_at || 0), 0);
});

test("Emby-like resumable episodes use series provider IDs for cross-server matching", () => {
  const media = mediaFromEmbyLikeResumableItem({
    Type: "Episode",
    Name: "Pilot",
    SeriesName: "Example Show",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    ProviderIds: { Tvdb: "episode-22" },
    SeriesProviderIds: { Tvdb: "series-11", Imdb: "tt-series" },
    UserData: { PlaybackPositionTicks: 900_000_000 },
    RunTimeTicks: 3_600_000_000,
  }, "emby", normalizeProviderIds);

  assert.deepEqual(media.ids, { imdb: "tt-series", tmdb: undefined, tvdb: "series-11" });
  assert.equal(media.positionMs, 90_000);
  assert.equal(media.progress, 25);
});

test("playback progress merges aliases that share any provider ID", async () => {
  db.prepare("DELETE FROM playback_progress").run();
  await upsertPlaybackProgress({
    title: "Gabriel's Redemption: Part I",
    type: "movie",
    source: "emby",
    ids: { tmdb: "12345" },
    positionMs: 120_000,
    durationMs: 1_200_000,
    updatedAt: 100,
  });
  await upsertPlaybackProgress({
    title: "Gabriel's Redemption: Part One",
    type: "movie",
    source: "plex",
    ids: { imdb: "tt123", tmdb: "12345" },
    positionMs: 180_000,
    durationMs: 1_200_000,
    updatedAt: 200,
  });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playback_progress").get().n, 1);
  const row = await getPlaybackProgressForMedia({
    title: "A third title alias",
    type: "movie",
    ids: { tmdb: "12345" },
  });
  assert.equal(row.position_ms, 180_000);
  assert.equal(row.source, "plex");
  assert.equal(row.imdb_id, "tt123");
});

test("playstate merges title aliases that share any provider ID", async () => {
  db.prepare("DELETE FROM playstate").run();
  await upsertPlaystateForMedia({
    title: "Gabriel's Redemption: Part I",
    type: "movie",
    source: "emby",
    ids: { tmdb: "12345" },
    isValid: true,
  }, "unwatched");
  await upsertPlaystateForMedia({
    title: "Gabriel's Redemption: Part One",
    type: "movie",
    source: "plex",
    ids: { imdb: "tt123", tmdb: "12345" },
    isValid: true,
  }, "watched");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playstate").get().n, 1);
  const row = await getPlaystateForMedia({
    title: "Another alias",
    type: "movie",
    source: "jellyfin",
    ids: { tmdb: "12345" },
  });
  assert.equal(row.state, "watched");
  assert.equal(row.source, "plex");
  assert.equal(row.imdb_id, "tt123");
});

test("pruneSyncHistory drops rows older than the retention window", async () => {
  const insert = db.prepare(
    `INSERT INTO sync_history (timestamp, media_type, title, source, status, details, action, target_states, raw_payload_debug, created_at)
     VALUES (?, 'movie', ?, 'plex', 'error', '', 'watched', '[]', '{}', ?)`,
  );
  const now = Date.now();
  const ancient = now - 91 * 24 * 60 * 60 * 1000;
  insert.run(ancient, "Ancient Row", ancient);
  await appendSyncHistory({ mediaType: "movie", title: "Fresh Row", source: "plex", status: "success" });

  pruneSyncHistory({ force: true });

  const titles = (await getSyncHistory(200)).map((row) => row.title);
  assert.ok(titles.includes("Fresh Row"));
  assert.ok(!titles.includes("Ancient Row"));
});

test("pruneSyncHistory caps the table at the row limit, keeping the newest rows", () => {
  db.prepare("DELETE FROM sync_history").run();
  const insert = db.prepare(
    `INSERT INTO sync_history (timestamp, media_type, title, source, status, details, action, target_states, raw_payload_debug, created_at)
     VALUES (?, 'movie', ?, 'plex', 'error', '', 'watched', '[]', '{}', ?)`,
  );
  const base = Date.now();
  const total = 10_100;
  db.transaction(() => {
    for (let i = 0; i < total; i++) {
      insert.run(base - (total - i), `Row ${i}`, base);
    }
  })();

  pruneSyncHistory({ force: true });

  const count = db.prepare("SELECT COUNT(*) AS n FROM sync_history").get().n;
  assert.equal(count, 10_000);
  const newest = db.prepare("SELECT title FROM sync_history ORDER BY timestamp DESC LIMIT 1").get();
  assert.equal(newest.title, `Row ${total - 1}`);
});
