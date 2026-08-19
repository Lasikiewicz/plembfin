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
