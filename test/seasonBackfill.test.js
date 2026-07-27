import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-season-backfill-");

const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");

async function insertEpisodeWithoutSeason(title, episode, tvdbId) {
  const result = await repo.insertWatchRecord({
    title,
    media_type: "episode",
    episode,
    watched_at: "2026-05-01T20:00:00.000Z",
    source: "trakt_import",
    tvdb_id: tvdbId,
  });
  await result.assetPrefetch;
  // Season 0 specials arrive with the season missing even though the title
  // carries it; force that shape rather than trusting the insert path.
  db.prepare("UPDATE watch_history SET season = NULL WHERE id = ?").run(result.id);
  return result.id;
}

test("a season number missing from the row is recovered from the title", async () => {
  const id = await insertEpisodeWithoutSeason("The Curse of Oak Island - S00E13", 13, "tvdb-oak");

  const before = repo.watchHistoryQualityCounts();
  assert.ok(before.nullSeasonEpisodeRows > 0, "the fixture must start with a missing season");

  const fixed = await repo.backfillMissingEpisodeSeasons();
  assert.equal(fixed, 1);

  const row = await repo.getWatchRecordById(id);
  assert.equal(Number(row.season), 0, "S00 in the title means season 0, not null");
  assert.match(row.media_key, /^episode:0:13:/, "the key is rebuilt around the recovered season");
  assert.equal(repo.watchHistoryQualityCounts().nullSeasonEpisodeRows, 0);
});

test("watched state follows the rebuilt key", async () => {
  const id = await insertEpisodeWithoutSeason("Sons of Anarchy - S00E04", 4, "tvdb-soa");
  const row = await repo.getWatchRecordById(id);

  await repo.upsertPlaystateForMedia(
    { title: row.title, type: "episode", season: null, episode: 4, ids: { tvdb: "tvdb-soa" }, isValid: true },
    "watched",
    row.watched_at,
  );

  await repo.backfillMissingEpisodeSeasons();

  const playstate = await repo.getPlaystateForMedia({
    title: row.title,
    type: "episode",
    season: 0,
    episode: 4,
    ids: { tvdb: "tvdb-soa" },
  });
  assert.equal(playstate?.state, "watched", "the playstate row moves to the rebuilt key");
});

test("a title with no season marker is left alone", async () => {
  const result = await repo.insertWatchRecord({
    title: "Nameless Coordinates",
    media_type: "episode",
    episode: 2,
    watched_at: "2026-05-02T20:00:00.000Z",
    source: "trakt_import",
    tvdb_id: "tvdb-nameless",
  });
  await result.assetPrefetch;
  // The insert path appends "SxxEyy" to episode titles, so strip it back off as
  // well as clearing the column - this is the only shape where the season is
  // genuinely unrecoverable, and the backfill must not invent one.
  db.prepare("UPDATE watch_history SET season = NULL, title = ? WHERE id = ?")
    .run("Nameless Coordinates", result.id);

  const fixed = await repo.backfillMissingEpisodeSeasons();
  assert.equal(fixed, 0, "nothing is invented when the title carries no season");

  const row = await repo.getWatchRecordById(result.id);
  assert.equal(row.season, null);
});
