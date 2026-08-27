import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-split-identity-unwatch-");

const repo = await import("../server/src/utils/dataRepo.js");
const db = repo.requireDb();

function backdateUpdatedAt(id, updatedAt) {
  db.prepare("UPDATE watch_history SET updated_at = ? WHERE id = ?").run(updatedAt, id);
}

// Reproduces the real incident: a genuine Jellyfin watch stored under one
// media_key, later shadowed by an unwatched row the automatic Jellyfin
// unwatched-fallback poll recorded under a *different* media_key for the same
// episode - the aftermath of the (now-fixed) deleteWatchDates media_key-split
// bug pushing a real "mark unplayed" to the external server, which the poll
// then faithfully observed and recorded back into Plembfin.
test("auditSplitIdentityUnwatches flags a watched row shadowed by a later unwatch under a different media_key", async () => {
  const watched = await repo.insertWatchRecord({
    title: "The 'Burbs - S01E01", show_title: "The 'Burbs", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-07-30T20:13:38.090Z", source: "jellyfin", tmdb_id: "270600", sync_action: "watched",
  });
  // insertWatchRecord kicks off a fire-and-forget TMDB asset prefetch for a
  // watched row with a tmdb_id, which can touch the row's own updated_at when
  // it finishes - await it first so it can't race with (and undo) the
  // backdate below.
  await watched.assetPrefetch;
  backdateUpdatedAt(watched.id, Date.parse("2026-07-30T20:13:38.090Z"));

  const unwatched = await repo.insertWatchRecord({
    title: "The 'Burbs - S01E01", show_title: "The 'Burbs", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-08-21T22:16:19.000Z", source: "jellyfin", imdb_id: "tt35670500", tvdb_id: "10678775",
    sync_action: "unwatched",
  });
  backdateUpdatedAt(unwatched.id, Date.parse("2026-08-21T22:16:19.000Z"));

  const audit = repo.auditSplitIdentityUnwatches();
  const finding = audit.sample.find((entry) => entry.watchedRow.id === watched.id);
  assert.ok(finding, "expected the shadowed watched row to be flagged");
  assert.equal(finding.show, "The 'Burbs");
  assert.equal(finding.season, 1);
  assert.equal(finding.episode, 1);
  assert.equal(finding.unwatchedRow.id, unwatched.id);
  assert.notEqual(finding.watchedRow.mediaKey, finding.unwatchedRow.mediaKey);
});

test("auditSplitIdentityUnwatches ignores a normal watch-then-unwatch under the same media_key", async () => {
  const watched = await repo.insertWatchRecord({
    title: "Silo - S01E01", show_title: "Silo", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-01-01T00:00:00.000Z", source: "plex", tmdb_id: "same-key-1", sync_action: "watched",
  });
  await watched.assetPrefetch;
  backdateUpdatedAt(watched.id, Date.parse("2026-01-01T00:00:00.000Z"));
  // A genuine unwatch of the same item reuses/targets the same media_key
  // (see applyUnwatchedTransition's findWatchedByAnyMediaKey + supersededId
  // handling) rather than leaving the old row behind under its own key.
  db.prepare("UPDATE watch_history SET sync_action = 'unwatched', updated_at = ? WHERE id = ?")
    .run(Date.parse("2026-01-02T00:00:00.000Z"), watched.id);

  const audit = repo.auditSplitIdentityUnwatches();
  assert.ok(!audit.sample.some((entry) => entry.watchedRow.id === watched.id || entry.unwatchedRow.id === watched.id));
});

test("auditSplitIdentityUnwatches ignores an unwatch that predates the watched row (not a shadowing case)", async () => {
  const unwatched = await repo.insertWatchRecord({
    title: "Reacher - S02E01", show_title: "Reacher", media_type: "episode", season: 2, episode: 1,
    watched_at: "2026-01-01T00:00:00.000Z", source: "emby", imdb_id: "tt-old", sync_action: "unwatched",
  });
  backdateUpdatedAt(unwatched.id, Date.parse("2026-01-01T00:00:00.000Z"));

  const watched = await repo.insertWatchRecord({
    title: "Reacher - S02E01", show_title: "Reacher", media_type: "episode", season: 2, episode: 1,
    watched_at: "2026-02-01T00:00:00.000Z", source: "emby", tmdb_id: "tt-new", sync_action: "watched",
  });
  await watched.assetPrefetch;
  backdateUpdatedAt(watched.id, Date.parse("2026-02-01T00:00:00.000Z"));

  const audit = repo.auditSplitIdentityUnwatches();
  assert.ok(!audit.sample.some((entry) => entry.watchedRow.id === watched.id));
});

test("repairSplitIdentityUnwatches deletes the shadowing row and restores playstate to watched", async () => {
  const watched = await repo.insertWatchRecord({
    title: "G'wed - S03E03", show_title: "G'wed", media_type: "episode", season: 3, episode: 3,
    watched_at: "2026-06-08T21:43:00.000Z", source: "manual", tmdb_id: "245412", sync_action: "watched",
  });
  await watched.assetPrefetch;
  backdateUpdatedAt(watched.id, Date.parse("2026-06-08T21:43:00.000Z"));

  const unwatched = await repo.insertWatchRecord({
    title: "G'wed - S03E03", show_title: "G'wed", media_type: "episode", season: 3, episode: 3,
    watched_at: "2026-08-21T17:25:11.818Z", source: "jellyfin", imdb_id: "tt28510783", sync_action: "unwatched",
  });
  backdateUpdatedAt(unwatched.id, Date.parse("2026-08-21T17:25:11.818Z"));

  const before = repo.auditSplitIdentityUnwatches();
  assert.ok(before.sample.some((entry) => entry.watchedRow.id === watched.id));

  const result = await repo.repairSplitIdentityUnwatches();
  assert.ok(result.repaired >= 1);
  const restoredMedia = result.media.find((m) => m.title === "G'wed - S03E03");
  assert.ok(restoredMedia, "expected the restored media object to be returned for outbound re-propagation");
  assert.equal(restoredMedia.source, "manual");
  assert.equal(restoredMedia.watched_at, "2026-06-08T21:43:00.000Z");

  // The shadowing unwatched row is gone...
  assert.equal(await repo.getWatchRecordByIdLight(unwatched.id), null);
  // ...and playstate for the surviving watched row's own key reads watched again.
  const state = await repo.getPlaystateForMedia({ type: "episode", show_title: "G'wed", season: 3, episode: 3, ids: { tmdb: "245412" }, isValid: true });
  assert.equal(state?.state, "watched");

  const after = repo.auditSplitIdentityUnwatches();
  assert.ok(!after.sample.some((entry) => entry.watchedRow.id === watched.id));
});
