import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-watch-derived-fields-");
const { db } = await import("../server/src/db.js");
const { getWatchRecordByIdLight, insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
const { persistedWatchDerivedFields } = await import("../server/src/utils/watchDerivedFields.js");

test("persisted watch fields decode titles and repair legacy specials coordinates", async () => {
  const inserted = insertWatchRecordSync({
    title: "Tom &amp; Friends - S0?E03 - Deleted Scene",
    media_type: "episode",
    watched_at: "2026-01-01T12:00:00.000Z",
    source: "plex_initial_sync",
    tvdb_id: "12345",
  }, { id: "legacy-special" });

  const stored = db.prepare("SELECT title, title_lower, season, episode FROM watch_history WHERE id = ?").get(inserted.id);
  assert.deepEqual(stored, {
    title: "Tom & Friends - S00E03 - Deleted Scene",
    title_lower: "tom & friends - s00e03 - deleted scene",
    season: 0,
    episode: 3,
  });
  const mapped = await getWatchRecordByIdLight(inserted.id);
  assert.equal(mapped.title, stored.title);
  assert.equal(mapped.season, stored.season);
  assert.equal(mapped.episode, stored.episode);
});

test("persisted movie title projection matches the returned title", async () => {
  const projected = persistedWatchDerivedFields({ title: "Wallace &amp; Gromit", media_type: "movie" });
  assert.deepEqual(projected, {
    title: "Wallace & Gromit",
    title_lower: "wallace & gromit",
    season: null,
    episode: null,
  });

  const inserted = insertWatchRecordSync({
    title: "Wallace &amp; Gromit",
    media_type: "movie",
    watched_at: "2026-01-02T12:00:00.000Z",
    source: "manual",
  }, { id: "encoded-movie" });
  const stored = db.prepare("SELECT title FROM watch_history WHERE id = ?").get(inserted.id);
  const mapped = await getWatchRecordByIdLight(inserted.id);
  assert.equal(stored.title, "Wallace & Gromit");
  assert.equal(mapped.title, stored.title);
});
