import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-key-test-"));
process.env.DATA_DIR = dataDir;

const { canonicalTitleKey, mediaKeyFor, normalizeWatchRecord } = await import(`../server/src/utils/dataRepo.js?test=${Date.now()}`);
const { db } = await import("../server/src/db.js");

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("canonicalTitleKey has stable golden values", () => {
  assert.equal(canonicalTitleKey("The Lord of the Rings: The Fellowship of the Ring"), "the-lord-of-the-rings-the-fellowship-of-the-ring");
  assert.equal(canonicalTitleKey("Tom &amp; Jerry"), "tom-jerry");
  assert.equal(canonicalTitleKey(" Spider-Man: Across the Spider-Verse "), "spider-man-across-the-spider-verse");
});

test("mediaKeyFor has stable golden values", () => {
  assert.equal(
    mediaKeyFor({ media_type: "movie", title: "Arrival", tmdb_id: "329865" }),
    "movie:none:none:tmdb:329865",
  );
  assert.equal(
    mediaKeyFor({ mediaType: "episode", title: "Example Show - S01E02", season: 1, episode: 2, ids: { tvdb: "12345" } }),
    "episode:1:2:tvdb:12345",
  );
  assert.equal(
    mediaKeyFor({ mediaType: "episode", title: "Example Show - S00E02", season: 0, episode: 2, ids: { tvdb: "12345" } }),
    "episode:0:2:tvdb:12345",
  );
  assert.equal(
    mediaKeyFor({ type: "movie", title: "Spider-Man: Across the Spider-Verse" }),
    "movie:none:none:title:spider-man:-across-the-spider-verse",
  );
});

test("normalizeWatchRecord preserves specials season zero", () => {
  const normalized = normalizeWatchRecord({
    title: "Example Show - S00E02 - Bonus",
    media_type: "episode",
    watched_at: "2026-01-01T12:00:00.000Z",
    source: "manual",
    tmdb_id: "999",
    season: 0,
    episode: 2,
  }, "manual");

  assert.equal(normalized.season, 0);
  assert.equal(normalized.episode, 2);
  assert.equal(normalized.title, "Example Show - S00E02");
});

test("normalizeWatchRecord recovers specials coordinates from title", () => {
  const normalized = normalizeWatchRecord({
    title: "Example Show - S00E03 - Deleted Scene",
    media_type: "episode",
    watched_at: "2026-01-01T12:00:00.000Z",
    source: "plex",
    tvdb_id: "12345",
  }, "plex");

  assert.equal(normalized.season, 0);
  assert.equal(normalized.episode, 3);
});

test("normalizeWatchRecord repairs legacy malformed specials codes", () => {
  const normalized = normalizeWatchRecord({
    title: "Example Show - S0?E03 - Deleted Scene",
    media_type: "episode",
    watched_at: "2026-01-01T12:00:00.000Z",
    source: "plex_initial_sync",
    tvdb_id: "12345",
  }, "plex_initial_sync");

  assert.equal(normalized.season, 0);
  assert.equal(normalized.episode, 3);
  assert.equal(normalized.title, "Example Show - S00E03 - Deleted Scene");
});
