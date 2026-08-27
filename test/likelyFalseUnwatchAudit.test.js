import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-likely-false-unwatch-");

const repo = await import("../server/src/utils/dataRepo.js");

// Reproduces the real incidents (The 'Burbs S01E01, Silo S03E02): the mass
// false-unwatch burst left some episodes with NO surviving watched row at
// all - every remaining row reads sync_action='unwatched' - so
// auditSplitIdentityUnwatches (which requires a watched row to shadow)
// never finds them, even though the episode genuinely was watched.
test("auditLikelyFalseUnwatches flags an episode with a single automatic-sourced unwatched row and no watched row", async () => {
  await repo.insertWatchRecord({
    title: "The 'Burbs - S01E01", show_title: "The 'Burbs", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-07-30T20:13:38.090Z", source: "jellyfin", sync_action: "unwatched",
  });

  const audit = repo.auditLikelyFalseUnwatches();
  const finding = audit.sample.find((entry) => entry.show === "The 'Burbs" && entry.season === 1 && entry.episode === 1);
  assert.ok(finding, "expected the fully-unwatched episode to be flagged");
  assert.equal(finding.rows.length, 1);
});

test("auditLikelyFalseUnwatches flags an episode with two automatic-sourced unwatched rows from different platforms", async () => {
  const older = await repo.insertWatchRecord({
    title: "Silo - S03E02", show_title: "Silo", media_type: "episode", season: 3, episode: 2,
    watched_at: "2026-07-04T15:35:47.192Z", source: "emby", sync_action: "unwatched",
  });
  await repo.insertWatchRecord({
    title: "Silo - S03E02", show_title: "Silo", media_type: "episode", season: 3, episode: 2,
    watched_at: "2026-08-21T16:56:58.238Z", source: "jellyfin", sync_action: "unwatched",
  });

  const audit = repo.auditLikelyFalseUnwatches();
  const finding = audit.sample.find((entry) => entry.show === "Silo" && entry.season === 3 && entry.episode === 2);
  assert.ok(finding, "expected the episode to be flagged");
  assert.equal(finding.rows.length, 2);
  // The oldest watched_at across the group is the best evidence of the
  // genuine original watch, regardless of which row currently holds it.
  assert.equal(finding.restoreUsing.id, older.id);
  assert.equal(finding.restoreUsing.watchedAt, "2026-07-04T15:35:47.192Z");
});

test("auditLikelyFalseUnwatches ignores an episode that still has a watched row", async () => {
  await repo.insertWatchRecord({
    title: "Normal Show - S01E01", show_title: "Normal Show", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-01-01T00:00:00.000Z", source: "manual", sync_action: "watched",
  });
  await repo.insertWatchRecord({
    title: "Normal Show - S01E01", show_title: "Normal Show", media_type: "episode", season: 1, episode: 1,
    watched_at: "2025-06-01T00:00:00.000Z", source: "jellyfin", sync_action: "unwatched",
  });

  const audit = repo.auditLikelyFalseUnwatches();
  assert.ok(!audit.sample.some((entry) => entry.show === "Normal Show"));
});

test("auditLikelyFalseUnwatches ignores a genuine manual-only unwatch with no automatic source involved", async () => {
  await repo.insertWatchRecord({
    title: "Deliberate Show - S01E01", show_title: "Deliberate Show", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-01-01T00:00:00.000Z", source: "manual", sync_action: "unwatched",
  });

  const audit = repo.auditLikelyFalseUnwatches();
  assert.ok(!audit.sample.some((entry) => entry.show === "Deliberate Show"), "a manual-only unwatch must never be flagged");
});

test("repairLikelyFalseUnwatches consolidates stale rows into one fresh watched record", async () => {
  const showTitle = "Consolidate Show";
  const rowA = await repo.insertWatchRecord({
    title: `${showTitle} - S01E01`, show_title: showTitle, media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-02-01T00:00:00.000Z", source: "emby", sync_action: "unwatched",
  });
  const rowB = await repo.insertWatchRecord({
    title: `${showTitle} - S01E01`, show_title: showTitle, media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-05-01T00:00:00.000Z", source: "jellyfin", sync_action: "unwatched",
  });

  const result = await repo.repairLikelyFalseUnwatches();
  const restored = result.media.find((m) => m.show_title === showTitle);
  assert.ok(restored, "expected a restored media object for this show");
  assert.equal(restored.watched_at, "2026-02-01T00:00:00.000Z");
  assert.equal(restored.source, "manual");

  assert.equal(await repo.getWatchRecordByIdLight(rowA.id), null, "the old stale rows must be deleted");
  assert.equal(await repo.getWatchRecordByIdLight(rowB.id), null, "the old stale rows must be deleted");

  const state = await repo.getPlaystateForMedia({ title: `${showTitle} - S01E01`, type: "episode", show_title: showTitle, season: 1, episode: 1, isValid: true });
  assert.equal(state?.state, "watched");

  assert.ok(!repo.auditLikelyFalseUnwatches().sample.some((entry) => entry.show === showTitle));
});
