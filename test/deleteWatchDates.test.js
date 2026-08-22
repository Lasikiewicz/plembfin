import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-delete-watch-dates-");

const repo = await import("../server/src/utils/dataRepo.js");

test("deleteWatchDates removes the given rows and rolls playstate back to the newest survivor", async () => {
  const media = { title: "Duplicate Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "dup-1" }, isValid: true };
  const oldest = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "dup-1", watched_at: "2020-01-01T00:00:00.000Z", source: "trakt_import" });
  const middle = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "dup-1", watched_at: "2021-01-01T00:00:00.000Z", source: "trakt_import" });
  const newest = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "dup-1", watched_at: "2022-01-01T00:00:00.000Z", source: "trakt_import" });
  await repo.upsertPlaystateForMedia(media, "watched", newest.record.watched_at);

  const result = await repo.deleteWatchDates([middle.id, newest.id]);
  assert.deepEqual(result.deleted.sort(), [middle.id, newest.id].sort());
  assert.equal(result.notFound.length, 0);

  const mediaKey = repo.mediaKeyFor(media);
  assert.equal(await repo.findExistingWatch(mediaKey, oldest.record.watched_at).then((r) => Boolean(r)), true);
  assert.equal(await repo.findExistingWatch(mediaKey, middle.record.watched_at).then((r) => Boolean(r)), false);

  // Only the oldest row survives, so playstate must roll back to it rather
  // than staying pinned at the deleted "newest" timestamp.
  const state = await repo.getPlaystateForMedia(media);
  assert.equal(state?.watched_at, oldest.record.watched_at);
});

test("deleteWatchDates reports unknown ids without touching anything else", async () => {
  const media = { title: "Solo Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "solo-1" }, isValid: true };
  const only = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "solo-1", watched_at: "2020-06-01T00:00:00.000Z", source: "plex" });

  const result = await repo.deleteWatchDates(["does-not-exist", only.id]);
  assert.deepEqual(result.notFound, ["does-not-exist"]);
  assert.deepEqual(result.deleted, [only.id]);
});

test("deleteWatchDates clears playstate entirely when every watch for a media_key is removed", async () => {
  const media = { title: "Emptied Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "empty-1" }, isValid: true };
  const row = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "empty-1", watched_at: "2020-06-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(media, "watched", row.record.watched_at);

  await repo.deleteWatchDates([row.id]);
  const state = await repo.getPlaystateForMedia(media);
  assert.equal(state, null);
});

// The Edit Watch Date dialog only ever shows the earliest row of a same-event
// echo chain (rows within SAME_EVENT_WINDOW_MS of each other - see
// filterSameEventDuplicateRows). Deleting that visible row must also delete
// its hidden echo, otherwise the echo resurfaces as a "new" watch date.
test("deleteWatchDate removes an echoed duplicate chained within the same-event window", async () => {
  const media = { title: "Echoed Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "echo-1" }, isValid: true };
  const visible = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "echo-1", watched_at: "2023-01-01T00:00:00.000Z", source: "plex" });
  const echo = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "echo-1", watched_at: "2023-01-01T00:03:00.000Z", source: "emby" });
  await repo.upsertPlaystateForMedia(media, "watched", echo.record.watched_at);

  const result = await repo.deleteWatchDate(visible.id);
  assert.equal(result.ok, true);

  assert.equal(await repo.findExistingWatch(repo.mediaKeyFor(media), visible.record.watched_at).then((r) => Boolean(r)), false);
  assert.equal(await repo.findExistingWatch(repo.mediaKeyFor(media), echo.record.watched_at).then((r) => Boolean(r)), false);

  const state = await repo.getPlaystateForMedia(media);
  assert.equal(state, null);
});

test("deleteWatchDate leaves an independent rewatch outside the same-event window alone", async () => {
  const media = { title: "Rewatched Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "rewatch-1" }, isValid: true };
  const first = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "rewatch-1", watched_at: "2023-01-01T00:00:00.000Z", source: "plex" });
  const later = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "rewatch-1", watched_at: "2023-06-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(media, "watched", later.record.watched_at);

  const result = await repo.deleteWatchDate(first.id);
  assert.equal(result.ok, true);

  assert.equal(await repo.findExistingWatch(repo.mediaKeyFor(media), first.record.watched_at).then((r) => Boolean(r)), false);
  assert.equal(await repo.findExistingWatch(repo.mediaKeyFor(media), later.record.watched_at).then((r) => Boolean(r)), true);
});

// routes/media.js decides whether to propagate a rolled-back "watched" date
// or a full "unwatched" state to Plex/Emby/Jellyfin/Trakt purely from these
// return values (remainingRow / deletedRow) - without them, a deleted watch
// date's old dispatched state is never corrected on those platforms, and
// their own next catch-up scan can re-import it as a phantom watch.
test("deleteWatchDate reports the surviving row so the caller can propagate the rolled-back date", async () => {
  const media = { title: "Survivor Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "survivor-1" }, isValid: true };
  const older = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "survivor-1", watched_at: "2023-01-01T00:00:00.000Z", source: "plex" });
  const newer = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "survivor-1", watched_at: "2023-06-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(media, "watched", newer.record.watched_at);

  const result = await repo.deleteWatchDate(newer.id);
  assert.equal(result.ok, true);
  assert.equal(result.remainingRow?.id, older.id);
  assert.equal(result.deletedRow?.id, newer.id);
});

test("deleteWatchDate reports no surviving row when the last watch is removed", async () => {
  const media = { title: "Lone Watch Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "lone-1" }, isValid: true };
  const only = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "lone-1", watched_at: "2023-01-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(media, "watched", only.record.watched_at);

  const result = await repo.deleteWatchDate(only.id);
  assert.equal(result.ok, true);
  assert.equal(result.remainingRow, null);
  assert.equal(result.deletedRow?.id, only.id);
});

// Reproduces a real production bug: two watch rows for the same episode can
// carry different media_keys (e.g. one inserted with a tmdb id, the other
// with only an imdb id - the same identity split fixed elsewhere for
// playstate lookups). Recomputing "does anything remain" by exact media_key
// alone missed the surviving row and reported it as fully unwatched, even
// though a perfectly good watched row for the same episode still existed -
// which then wrongly propagated "unwatched" to every connected platform.
test("deleteWatchDate finds a surviving row even when it has a different media_key", async () => {
  const showTitle = "Cross-Key Show";
  const tmdbRow = await repo.insertWatchRecord({ title: `${showTitle} - S01E01`, media_type: "episode", show_title: showTitle, season: 1, episode: 1, tmdb_id: "crosskey-tmdb", watched_at: "2023-01-01T00:00:00.000Z", source: "jellyfin" });
  const imdbRow = await repo.insertWatchRecord({ title: `${showTitle} - S01E01`, media_type: "episode", show_title: showTitle, season: 1, episode: 1, imdb_id: "tt-crosskey", watched_at: "2023-06-01T00:00:00.000Z", source: "plex" });

  const result = await repo.deleteWatchDate(imdbRow.id);
  assert.equal(result.ok, true);
  assert.equal(result.remainingRow?.id, tmdbRow.id);

  const tmdbMediaKey = repo.mediaKeyFor({ media_type: "episode", season: 1, episode: 1, tmdb_id: "crosskey-tmdb" });
  assert.equal(await repo.findExistingWatch(tmdbMediaKey, tmdbRow.record.watched_at).then((r) => Boolean(r)), true);
});

test("deleteWatchDates reports affected media with surviving/deleted rows per media_key", async () => {
  const mediaA = { title: "Bulk A Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "bulk-a" }, isValid: true };
  const mediaB = { title: "Bulk B Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "bulk-b" }, isValid: true };
  const aOlder = await repo.insertWatchRecord({ title: mediaA.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "bulk-a", watched_at: "2023-01-01T00:00:00.000Z", source: "plex" });
  const aNewer = await repo.insertWatchRecord({ title: mediaA.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "bulk-a", watched_at: "2023-06-01T00:00:00.000Z", source: "plex" });
  const bOnly = await repo.insertWatchRecord({ title: mediaB.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "bulk-b", watched_at: "2023-01-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(mediaA, "watched", aNewer.record.watched_at);
  await repo.upsertPlaystateForMedia(mediaB, "watched", bOnly.record.watched_at);

  const result = await repo.deleteWatchDates([aNewer.id, bOnly.id]);
  assert.equal(result.affectedMedia.length, 2);

  const aEntry = result.affectedMedia.find((entry) => entry.deletedRow.id === aNewer.id);
  assert.equal(aEntry.remainingRow?.id, aOlder.id);

  const bEntry = result.affectedMedia.find((entry) => entry.deletedRow.id === bOnly.id);
  assert.equal(bEntry.remainingRow, null);
});

// Real production bug: marking an episode watched at the same time as another
// episode, then using the duplicate-watch cleanup to remove a genuine extra
// duplicate, wrongly deleted the just-added watched row too. deleteWatchDate
// (singular) intentionally chain-expands within SAME_EVENT_WINDOW_MS to catch
// hidden echo siblings of the one row it's asked to delete, but deleteWatchDates
// (bulk, used by the duplicate-watch cleanup) must not do that - the caller
// has already decided exactly which ids to remove and which to keep, and two
// unrelated watched rows for the SAME episode can legitimately land within
// that 10-minute window of each other.
test("deleteWatchDates does not sweep away a kept row sharing the same-event window with a removed one", async () => {
  const media = { title: "Same Time Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "same-time-1" }, isValid: true };
  const keep = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "same-time-1", watched_at: "2026-08-21T20:00:00.000Z", source: "manual" });
  const remove = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "same-time-1", watched_at: "2026-08-21T20:03:00.000Z", source: "manual" });
  await repo.upsertPlaystateForMedia(media, "watched", remove.record.watched_at);

  const result = await repo.deleteWatchDates([remove.id]);
  assert.deepEqual(result.deleted, [remove.id]);

  const mediaKey = repo.mediaKeyFor(media);
  assert.equal(await repo.findExistingWatch(mediaKey, keep.record.watched_at).then((r) => Boolean(r)), true, "the kept row must survive");
  assert.equal(await repo.findExistingWatch(mediaKey, remove.record.watched_at).then((r) => Boolean(r)), false);

  const state = await repo.getPlaystateForMedia(media);
  assert.equal(state?.state, "watched");
  assert.equal(state?.watched_at, keep.record.watched_at);
});
