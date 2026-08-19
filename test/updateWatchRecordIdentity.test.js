import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-update-watch-record-identity-");

const repo = await import("../server/src/utils/dataRepo.js");

// Fix Match corrects a watch row's provider ids in place. If media_key never
// moved to match, the corrected row stayed grouped under its old (often
// title-only) key forever - split from any other row for the same item, with
// playstate, the edit-date list, and the history-audit trail all still keyed
// by the stale identity. This is exactly what let a whitespace-variant title
// mismatch (see sameEventChainIdsFor tests) create an unmerged duplicate.
test("updateWatchRecord moves the row's media_key when its identity changes and merges playstate into the new key", async () => {
  const correct = { title: "A Quiet Place: Day One", type: "movie", ids: { imdb: "tt13433802", tmdb: "762441" }, isValid: true };
  const orphan = { title: "A Quiet Place: Day One", type: "movie", ids: {}, isValid: true };

  const correctRow = await repo.insertWatchRecord({ title: correct.title, media_type: "movie", imdb_id: "tt13433802", tmdb_id: "762441", watched_at: "2026-06-05T15:50:00.000Z", source: "trakt_import" });
  const orphanRow = await repo.insertWatchRecord({ title: orphan.title, media_type: "movie", watched_at: "2026-08-19T14:14:48.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(correct, "watched", correctRow.record.watched_at);
  await repo.upsertPlaystateForMedia(orphan, "watched", orphanRow.record.watched_at);

  const correctKey = repo.mediaKeyFor(correct);
  const orphanKey = repo.mediaKeyFor(orphan);
  assert.notEqual(correctKey, orphanKey);

  const result = await repo.updateWatchRecord(orphanRow.id, { imdb_id: "tt13433802", tmdb_id: "762441" });
  assert.equal(result.ok, true);

  // The corrected row now lives under the same media_key as the original.
  const migrated = await repo.getWatchRecordByIdLight(orphanRow.id);
  assert.equal(migrated.media_key, correctKey);

  // Both watches now show up together under the one true identity.
  const merged = await repo.getWatchDatesForRecord(correctRow.id);
  assert.equal(merged.rows.length, 2);

  // Looking the item up by either identity now agrees on the same, current
  // truth - the newer (moved-in) watch - instead of the old key still
  // reporting a stale or orphaned playstate.
  const newPlaystate = await repo.getPlaystateForMedia(correct);
  assert.equal(newPlaystate?.watched_at, orphanRow.record.watched_at);
  const viaOldIdentity = await repo.getPlaystateForMedia(orphan);
  assert.equal(viaOldIdentity?.watched_at, orphanRow.record.watched_at);
});

test("updateWatchRecord rolls the old media_key's playstate back to a survivor instead of deleting it", async () => {
  const correct = { title: "Rebalanced Movie", type: "movie", ids: { imdb: "tt99900011" }, isValid: true };
  const orphan = { title: "Rebalanced Movie", type: "movie", ids: {}, isValid: true };

  const correctRow = await repo.insertWatchRecord({ title: correct.title, media_type: "movie", imdb_id: "tt99900011", watched_at: "2026-01-01T00:00:00.000Z", source: "trakt_import" });
  const orphanOlder = await repo.insertWatchRecord({ title: orphan.title, media_type: "movie", watched_at: "2026-02-01T00:00:00.000Z", source: "plex" });
  const orphanNewer = await repo.insertWatchRecord({ title: orphan.title, media_type: "movie", watched_at: "2026-03-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(orphan, "watched", orphanNewer.record.watched_at);

  // Only the newer orphan row gets corrected; the older one is left behind
  // under the stale title-only key and must keep a valid playstate.
  await repo.updateWatchRecord(orphanNewer.id, { imdb_id: "tt99900011" });

  const oldPlaystate = await repo.getPlaystateForMedia(orphan);
  assert.equal(oldPlaystate?.watched_at, orphanOlder.record.watched_at);
});
