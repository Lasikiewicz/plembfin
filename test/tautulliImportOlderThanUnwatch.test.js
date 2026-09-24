import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-tautulli-unwatch-test-");

const { commitTautulliImport } = await import("../server/src/utils/tautulliImport.js");
const { batchInsertWatchRecords } = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");

test.after(() => db.close());

const OPTIONS = { userId: "7", userName: "Alex", selectedTargets: ["plex", "emby", "jellyfin"] };

function tautulliEpisode(episode, stoppedIso) {
  return {
    media_type: "episode",
    watched_status: 1,
    user_id: 7,
    grandparent_title: "A Thousand Blows",
    title: `Episode ${episode}`,
    parent_media_index: 1,
    media_index: episode,
    grandparent_guid: "plex://show/5d9c0874ffd9ef001e99e5d5",
    stopped: Math.floor(Date.parse(stoppedIso) / 1000),
  };
}

function rowsFor(episode) {
  return db.prepare(
    "SELECT sync_action, source, watched_at, sync_dispatch_telemetry FROM watch_history WHERE show_title = ? AND season = 1 AND episode = ? ORDER BY created_at",
  ).all("A Thousand Blows", episode);
}

function playstateFor(episode) {
  return db.prepare("SELECT state, last_source FROM playstate WHERE season = 1 AND episode = ? AND title LIKE 'A Thousand Blows%'").all(episode);
}

// 17 September 2026: the import re-inserted January plays for episodes the
// user had unwatched on 15 September, writing a watched playstate newer than
// the unwatch and queueing the play for Plex, Emby and Jellyfin.
test("a Tautulli play older than the item's newest unwatch does not re-watch it", async () => {
  await batchInsertWatchRecords([{
    title: "A Thousand Blows - S01E01",
    show_title: "A Thousand Blows",
    media_type: "episode",
    season: 1,
    episode: 1,
    imdb_id: "tt21874900",
    watched_at: new Date(Date.now() - 60_000).toISOString(),
    sync_action: "unwatched",
    source: "manual",
  }], { source: "manual", prefetch: false });
  const playstateBefore = playstateFor(1);

  const result = await commitTautulliImport([tautulliEpisode(1, "2026-01-04T15:07:48.000Z")], OPTIONS);

  assert.equal(result.inserted, 0);
  assert.equal(result.new, 0);
  assert.equal(result.skipped_newer_unwatch, 1);
  assert.equal(result.items[0].status, "skipped_newer_unwatch");
  const rows = rowsFor(1);
  assert.deepEqual(rows.map((row) => row.sync_action), ["unwatched"], "no watched history row, so nothing is dispatched");
  assert.deepEqual(playstateFor(1), playstateBefore, "playstate keeps the unwatch");
  assert.ok(playstateFor(1).every((row) => row.state !== "watched"));
});

test("a Tautulli play newer than the unwatch is still imported", async () => {
  await batchInsertWatchRecords([{
    title: "A Thousand Blows - S01E02",
    show_title: "A Thousand Blows",
    media_type: "episode",
    season: 1,
    episode: 2,
    imdb_id: "tt21874900",
    watched_at: "2026-01-05T10:00:00.000Z",
    sync_action: "unwatched",
    source: "manual",
  }], { source: "manual", prefetch: false });
  // Date the unwatch itself to 5 January, so a February play is a real rewatch.
  db.prepare("UPDATE watch_history SET created_at = ? WHERE season = 1 AND episode = 2 AND sync_action = 'unwatched'")
    .run(Date.parse("2026-01-05T10:00:00.000Z"));

  const result = await commitTautulliImport([tautulliEpisode(2, "2026-02-01T11:12:24.000Z")], OPTIONS);

  assert.equal(result.inserted, 1);
  assert.equal(result.skipped_newer_unwatch, 0);
  assert.deepEqual(rowsFor(2).map((row) => row.sync_action), ["unwatched", "watched"]);
  assert.ok(playstateFor(2).some((row) => row.state === "watched"));
});

// 24 September 2026: a show-level IMDb id on every episode let one episode's
// play match another episode's row, so the import skipped a real play as a
// duplicate. Same day, same show id, different episodes: both must import.
test("a shared show-level id does not make two episodes the same play", async () => {
  const showRow = (episode, stoppedIso) => ({
    media_type: "episode",
    watched_status: 1,
    user_id: 7,
    grandparent_title: "Coordinates Show",
    title: `Episode ${episode}`,
    parent_media_index: 1,
    media_index: episode,
    imdb_id: "tt9990001",
    stopped: Math.floor(Date.parse(stoppedIso) / 1000),
  });
  const first = await commitTautulliImport([showRow(1, "2026-03-01T20:00:00.000Z")], OPTIONS);
  assert.equal(first.inserted, 1);
  const second = await commitTautulliImport([showRow(2, "2026-03-01T21:00:00.000Z")], OPTIONS);
  assert.equal(second.inserted, 1, "S01E02 on the same day is not a duplicate of S01E01");
  const rows = db.prepare("SELECT episode FROM watch_history WHERE show_title = ? AND sync_action = 'watched' ORDER BY episode").all("Coordinates Show");
  assert.deepEqual(rows.map((row) => row.episode), [1, 2]);
});

test("an unwatch of a different episode does not block the play", async () => {
  const result = await commitTautulliImport([tautulliEpisode(3, "2026-01-12T15:49:26.000Z")], OPTIONS);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped_newer_unwatch, 0);
});
