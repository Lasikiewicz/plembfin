import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-same-event-dupes-");

const repo = await import("../server/src/utils/dataRepo.js");

async function insertPlay(title, watchedAt, source, tmdbId) {
  const result = await repo.insertWatchRecord({
    title,
    media_type: "movie",
    watched_at: watchedAt,
    source,
    tmdb_id: tmdbId,
  });
  await result.assetPrefetch;
  return result.id;
}

test("a watch propagated across servers collapses to one viewing", async () => {
  // The real signature: the same play written down by each server in turn,
  // fractions of a second apart. An exact-timestamp match finds none of these.
  const first = await insertPlay("Echoed Movie", "2026-06-22T08:30:43.397Z", "plex", "tt-echo");
  const second = await insertPlay("Echoed Movie", "2026-06-22T08:30:43.648Z", "jellyfin", "tt-echo");
  const third = await insertPlay("Echoed Movie", "2026-06-22T08:32:51.000Z", "plex", "tt-echo");

  const duplicates = repo.sameEventDuplicateIds();
  assert.ok(duplicates.includes(second), "the second server's copy is a duplicate");
  assert.ok(duplicates.includes(third), "a copy two minutes later is still the same viewing");
  assert.ok(!duplicates.includes(first), "the earliest row is the one kept");
});

test("genuine rewatches are never collapsed", async () => {
  const day1 = await insertPlay("Rewatched Movie", "2026-06-01T20:00:00.000Z", "plex", "tt-rewatch");
  const day2 = await insertPlay("Rewatched Movie", "2026-06-08T20:00:00.000Z", "plex", "tt-rewatch");
  // Just outside the window — still two viewings.
  const later = await insertPlay("Rewatched Movie", "2026-06-08T20:11:00.000Z", "plex", "tt-rewatch");

  const duplicates = repo.sameEventDuplicateIds();
  for (const id of [day1, day2, later]) {
    assert.ok(!duplicates.includes(id), "watches further apart than the window are separate viewings");
  }
});

test("plays chain into a single viewing while each is inside the window", async () => {
  // 0, +8min, +16min: the last is 16 minutes from the first but only 8 from its
  // predecessor, so it belongs to the same unbroken viewing.
  const a = await insertPlay("Chained Movie", "2026-06-10T10:00:00.000Z", "plex", "tt-chain");
  const b = await insertPlay("Chained Movie", "2026-06-10T10:08:00.000Z", "emby", "tt-chain");
  const c = await insertPlay("Chained Movie", "2026-06-10T10:16:00.000Z", "jellyfin", "tt-chain");

  const duplicates = repo.sameEventDuplicateIds();
  assert.ok(!duplicates.includes(a));
  assert.ok(duplicates.includes(b));
  assert.ok(duplicates.includes(c));
});

test("the reported duplicate count matches what the cleanup would remove", async () => {
  const counts = repo.watchHistoryQualityCounts();
  assert.equal(counts.sameEventDuplicateRows, repo.sameEventDuplicateIds().length);
  assert.ok(counts.sameEventDuplicateRows > 0, "the fixtures above are duplicates and must be reported");
});

test("a custom window changes what counts as one viewing", async () => {
  // Under a one-minute window the +8min and +16min chained plays are separate.
  const tight = repo.sameEventDuplicateIds(60 * 1000);
  const normal = repo.sameEventDuplicateIds();
  assert.ok(tight.length < normal.length, "a narrower window reports fewer duplicates");
});
