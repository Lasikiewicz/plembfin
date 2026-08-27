import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-trakt-dispatch-progress-");

const repo = await import("../server/src/utils/dataRepo.js");

async function add(title, telemetry, retryAt = 0) {
  const result = await repo.insertWatchRecord({
    title,
    media_type: "movie",
    watched_at: "2026-01-01T12:00:00.000Z",
    source: "trakt_import",
    sync_dispatch_telemetry: telemetry,
  });
  await result.assetPrefetch;
  if (retryAt) await repo.updateWatchSyncRetry(result.id, 1, retryAt);
}

test("Trakt dispatch progress excludes terminal partial and skipped outcomes", async () => {
  await add("Not started", null);
  await add("Queued", "Dispatch status: pending");
  await add("No library match", "Dispatch status: partial\nTarget plex status: skipped - No matching item found");
  await add("Skipped", "Dispatch status: skipped\nDetails: No eligible targets");
  await add("Succeeded", "Dispatch status: success");
  await add("Retrying", "Dispatch status: error", Date.now() + 60_000);
  await add("Exhausted", "Dispatch status: error");
  await add("Historical play", "Dispatch status: skipped\nDetails: Historical import; not re-propagated");

  assert.deepEqual(repo.countTraktImportPendingDispatch(), { total: 7, pending: 3 });
});
