import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-auto-sync-");

const { db } = await import("../server/src/db.js");
const {
  requestUpNextAutoSync,
  runAutomaticUpNextSync,
  upNextQueueFingerprint,
} = await import("../server/src/utils/upNextAutoSync.js");

test("Up Next fingerprints ignore observation timestamps but track queue content and order", () => {
  const first = [{
    id: "episode:show:s3:e7",
    title: "Episode 7",
    media_type: "episode",
    position_ms: 6000,
    provider_items: { emby: ["episode-2", "episode-1"] },
    observed_at: 1000,
    source_updated_at: 1100,
  }];
  const sameContent = [{
    id: "episode:show:s3:e7",
    title: "Episode 7",
    media_type: "episode",
    position_ms: 6000,
    provider_items: { emby: ["episode-1", "episode-2"] },
    observed_at: 2000,
    source_updated_at: 2100,
  }];
  const changed = [{ ...sameContent[0], position_ms: 12_000 }];
  const reordered = [{ id: "episode:show:s3:e8", title: "Episode 8" }, first[0]];

  assert.equal(upNextQueueFingerprint(first), upNextQueueFingerprint(sameContent));
  assert.notEqual(upNextQueueFingerprint(first), upNextQueueFingerprint(changed));
  assert.notEqual(upNextQueueFingerprint(first), upNextQueueFingerprint(reordered));
});

test("automatic Up Next requests coalesce into one durable background job", async () => {
  const first = await requestUpNextAutoSync("first queue change");
  const second = await requestUpNextAutoSync("second queue change");

  assert.equal(first.queued, true);
  assert.equal(second.coalesced, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE type='up_next_sync' AND status='queued'").get().count, 1);
  assert.deepEqual(db.prepare("SELECT payload FROM background_jobs WHERE type='up_next_sync'").get(), {
    payload: JSON.stringify({ reason: "first queue change" }),
  });
});

test("automatic Up Next sync skips cleanly when no provider is configured", async () => {
  const result = await runAutomaticUpNextSync();
  assert.deepEqual(result, { status: "skipped", reason: "no-configured-providers" });
});

