import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-rematch-show-");

const repo = await import("../server/src/utils/dataRepo.js");

async function insertEpisode(title, season, episode) {
  const result = await repo.insertWatchRecord({
    title,
    media_type: "episode",
    season,
    episode,
    watched_at: `2026-07-2${episode}T20:00:00.000Z`,
    source: "plex",
  });
  await result.assetPrefetch;
  return result.id;
}

test("Fix Match renames an unidentified show onto the matched series", async () => {
  const first = await insertEpisode("Unknown Show - S01E01", 1, 1);
  const second = await insertEpisode("Unknown Show - S01E02 - The Cheesecake", 1, 2);

  const result = await repo.rematchShowWatchRecords({
    id: first,
    tvdbId: "417909",
    newShowTitle: "Platonic",
  });

  assert.equal(result.ok, true);
  assert.equal(result.renamed, true, "a different show name counts as a rename");
  assert.equal(result.showTitle, "Platonic");
  assert.equal(result.previousShowTitle, "Unknown Show");
  assert.equal(result.updatedRows, 2, "every episode of the show is rematched, not just the anchor");

  const firstRow = await repo.getWatchRecordById(first);
  assert.equal(firstRow.show_title, "Platonic");
  assert.equal(firstRow.title, "Platonic - S01E01");
  assert.equal(firstRow.tvdb_id, "417909");

  // The episode name after the coordinates has to survive the swap.
  const secondRow = await repo.getWatchRecordById(second);
  assert.equal(secondRow.show_title, "Platonic");
  assert.equal(secondRow.title, "Platonic - S01E02 - The Cheesecake");

  // The show is keyed by its name, so the route key moves with the rename.
  assert.equal(repo.canonicalTitleKey(secondRow.show_title), repo.canonicalTitleKey("Platonic"));
});

test("Fix Match onto the same show corrects ids without renaming", async () => {
  const id = await insertEpisode("Silo - S03E04", 3, 4);

  const result = await repo.rematchShowWatchRecords({
    id,
    tvdbId: "362302",
    newShowTitle: "Silo",
  });

  assert.equal(result.ok, true);
  assert.equal(result.renamed, false);
  assert.equal(result.showTitle, "Silo");

  const row = await repo.getWatchRecordById(id);
  assert.equal(row.title, "Silo - S03E04", "an unchanged name leaves the title alone");
  assert.equal(row.show_title, "Silo");
  assert.equal(row.tvdb_id, "362302");
});

test("Fix Match without a new name still repoints the ids", async () => {
  const id = await insertEpisode("Mystery Show - S02E05", 2, 5);

  const result = await repo.rematchShowWatchRecords({ id, tvdbId: "999111" });

  assert.equal(result.ok, true);
  assert.equal(result.renamed, false);

  const row = await repo.getWatchRecordById(id);
  assert.equal(row.title, "Mystery Show - S02E05");
  assert.equal(row.tvdb_id, "999111");
});

test("Fix Match rebuilds the media key and moves playstate with it", async () => {
  const id = await insertEpisode("Mis-Matched Show - S01E01", 1, 1);

  const before = await repo.getWatchRecordById(id);
  await repo.upsertPlaystateForMedia(
    {
      title: before.title,
      type: "episode",
      season: 1,
      episode: 1,
      ids: { tvdb: before.tvdb_id || undefined },
      isValid: true,
    },
    "watched",
    before.watched_at,
  );
  const beforeKey = before.media_key;

  await repo.rematchShowWatchRecords({ id, tvdbId: "424242", newShowTitle: "Correct Show" });

  const after = await repo.getWatchRecordById(id);
  assert.notEqual(after.media_key, beforeKey, "the key must follow the new identity");
  assert.match(after.media_key, /tvdb:424242/, "the rebuilt key uses the show that was picked");
  assert.equal(after.tmdb_id || "", "", "ids from the wrong match are cleared");
  assert.equal(after.imdb_id || "", "");

  // The watched state has to be findable under the new key, not stranded on the old one.
  const playstate = await repo.getPlaystateForMedia({
    title: after.title,
    type: "episode",
    season: 1,
    episode: 1,
    ids: { tvdb: "424242" },
  });
  assert.equal(playstate?.state, "watched", "playstate follows the key migration");
});
