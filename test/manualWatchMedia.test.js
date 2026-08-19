import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-manual-watch-media-");

const { manualWatchMediaFromRecord } = await import("../server/src/routes/sync.js");

// Regression: manualWatchMediaFromRecord used to drop watched_at entirely,
// so a manual "mark watched" with an explicit historical date (e.g. "on
// release day") reached outbound dispatch with no watched_at at all.
// traktClient.js's syncPayload falls back to Date.now() whenever
// media.watched_at is missing, so the historical date the user picked in
// Plembfin got silently replaced with "right now" on Trakt specifically -
// Plex/Emby/Jellyfin's mark-played APIs don't take a date at all, so this
// only ever showed up on Trakt.
test("manualWatchMediaFromRecord carries the record's watched_at through to outbound dispatch", () => {
  const media = manualWatchMediaFromRecord({
    title: "Trying - S05E06",
    media_type: "episode",
    season: 5,
    episode: 6,
    tmdb_id: "38772847",
    watched_at: "2026-08-12T12:00:00.000Z",
  });
  assert.equal(media.watched_at, "2026-08-12T12:00:00.000Z");
});

test("manualWatchMediaFromRecord leaves watched_at undefined (not null or empty) when the record has none", () => {
  const media = manualWatchMediaFromRecord({ title: "Some Movie", media_type: "movie", tmdb_id: "1" });
  assert.equal(media.watched_at, undefined);
});
