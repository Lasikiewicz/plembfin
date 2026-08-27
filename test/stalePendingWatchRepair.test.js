import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-stale-pending-watch-");

const repo = await import("../server/src/utils/dataRepo.js");

// General form of the Trakt play-history import repair: any code path that
// replays canonical state for an *existing* watch_history row (e.g.
// propagateWatchDateRemoval in routes/media.js) without writing the result
// back onto that row can leave it with NULL telemetry, or with a retry count
// that the scheduler's own manual-dispatch sweep already gave up on - in
// either case nothing retries it again on its own.
test("auditStalePendingWatchRows finds rows with no telemetry regardless of source", async () => {
  const stale = await repo.insertWatchRecord({
    title: "The 'Burbs - S01E01", show_title: "The 'Burbs", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-07-30T20:13:38.090Z", source: "manual", tmdb_id: "270600",
  });
  const settled = await repo.insertWatchRecord({
    title: "The 'Burbs - S01E02", show_title: "The 'Burbs", media_type: "episode", season: 1, episode: 2,
    watched_at: "2026-07-30T21:00:00.000Z", source: "manual", tmdb_id: "270600",
    sync_dispatch_telemetry: "Origin: manual\nDispatch status: success\nTarget plex status: success - 200 OK",
  });

  const audit = repo.auditStalePendingWatchRows();
  const ids = audit.sample.map((row) => row.id);
  assert.ok(ids.includes(stale.id));
  assert.ok(!ids.includes(settled.id));
});

test("auditStalePendingWatchRows finds a row whose retries are already exhausted", async () => {
  const exhausted = await repo.insertWatchRecord({
    title: "Silo - S03E08", show_title: "Silo", media_type: "episode", season: 3, episode: 8,
    watched_at: "2026-08-10T10:00:00.000Z", source: "plex",
    sync_dispatch_telemetry: "Origin: plex\nDispatch status: error\nTarget emby status: error - timeout\nRetry: automatic retries exhausted after 10 attempts; use Retry Sync to try again.",
  });
  await repo.updateWatchSyncRetry(exhausted.id, 10, 0);

  const stillRetrying = await repo.insertWatchRecord({
    title: "Silo - S03E09", show_title: "Silo", media_type: "episode", season: 3, episode: 9,
    watched_at: "2026-08-10T11:00:00.000Z", source: "plex",
    sync_dispatch_telemetry: "Origin: plex\nDispatch status: error\nTarget emby status: error - timeout\nRetry: attempt 3 of 10; next automatic retry in 15m.",
  });
  await repo.updateWatchSyncRetry(stillRetrying.id, 3, Date.now() + 15 * 60_000);

  const audit = repo.auditStalePendingWatchRows();
  const ids = audit.sample.map((row) => row.id);
  assert.ok(ids.includes(exhausted.id));
  assert.ok(!ids.includes(stillRetrying.id));
});

test("repairStalePendingWatchRows resets retry bookkeeping without touching a row's own telemetry text", async () => {
  const stale = await repo.insertWatchRecord({
    title: "The 'Burbs - S01E01", show_title: "The 'Burbs", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-07-30T20:13:38.090Z", source: "manual", tmdb_id: "270600",
  });
  const exhausted = await repo.insertWatchRecord({
    title: "Silo - S03E08", show_title: "Silo", media_type: "episode", season: 3, episode: 8,
    watched_at: "2026-08-10T10:00:00.000Z", source: "plex",
    sync_dispatch_telemetry: "Origin: plex\nDispatch status: error\nRetry: automatic retries exhausted after 10 attempts; use Retry Sync to try again.",
  });
  await repo.updateWatchSyncRetry(exhausted.id, 10, Date.now() + 60 * 60_000);
  const untouched = await repo.insertWatchRecord({
    title: "The 'Burbs - S01E02", show_title: "The 'Burbs", media_type: "episode", season: 1, episode: 2,
    watched_at: "2026-07-30T21:00:00.000Z", source: "manual", tmdb_id: "270600",
    sync_dispatch_telemetry: "Origin: manual\nDispatch status: success\nTarget plex status: success - 200 OK",
  });

  // Earlier tests in this file leave their own stale rows behind in the
  // shared temp database (makeTempDataDir sets up one DB per file, not per
  // test), so only assert that repair swept at least these two rather than
  // an exact total.
  const result = repo.repairStalePendingWatchRows();
  assert.ok(result.repaired >= 2);

  const db = repo.requireDb();
  const staleRow = db.prepare("SELECT sync_retry_count, sync_next_retry_at, sync_dispatch_telemetry FROM watch_history WHERE id = ?").get(stale.id);
  assert.equal(staleRow.sync_retry_count, 0);
  assert.equal(staleRow.sync_next_retry_at, 0);
  assert.equal(staleRow.sync_dispatch_telemetry, null, "telemetry text is left for a real dispatch to fill in, not fabricated");

  const exhaustedRow = db.prepare("SELECT sync_retry_count, sync_next_retry_at FROM watch_history WHERE id = ?").get(exhausted.id);
  assert.equal(exhaustedRow.sync_retry_count, 0);
  assert.equal(exhaustedRow.sync_next_retry_at, 0);

  const untouchedRow = db.prepare("SELECT sync_retry_count, sync_dispatch_telemetry FROM watch_history WHERE id = ?").get(untouched.id);
  assert.equal(untouchedRow.sync_dispatch_telemetry, "Origin: manual\nDispatch status: success\nTarget plex status: success - 200 OK");

  // The repair only resets retry bookkeeping - it never fabricates telemetry -
  // so a NULL-telemetry row keeps showing up in the audit until a real
  // dispatch (the scheduler's manual-dispatch sweep, on its next tick) writes
  // an actual result. Only the retry-exhausted row, whose own telemetry was
  // never NULL, drops out of the audit once its retry count is reset.
  const afterIds = repo.auditStalePendingWatchRows().sample.map((row) => row.id);
  assert.ok(afterIds.includes(stale.id));
  assert.ok(!afterIds.includes(exhausted.id));
});
