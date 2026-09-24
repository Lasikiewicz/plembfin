import test from "node:test";
import assert from "node:assert/strict";
import { plexUnplayedHasWatchEvidence, shouldRepairRecentPlexUnwatch } from "../server/src/utils/plexWatchstate.js";

test("a positive-offset Plex rollback is repaired after recent threshold playback", () => {
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched" },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: true,
  }), true);
});

test("a rapid positive-offset rollback is repaired across threshold rounding", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched", updated_at: now - 3 * 60_000 },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: false,
    now,
  }), true);
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched", updated_at: now - 6 * 60_000 },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: false,
    now,
  }), false, "the grace expires so a later deliberate unwatch can propagate");
});

test("ordinary Plex unwatches are not hidden by the rollback guard", () => {
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched", updated_at: 1 },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: false,
    now: 1_800_000_000_000,
  }), false, "stale resume position alone is not enough");
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched" },
    viewOffset: 0,
    hasPlaybackEvidence: true,
  }), false, "a zero-position manual unwatch remains authoritative");
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "unwatched" },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: true,
  }), false, "the guard cannot revive an already-unwatched canonical state");
});

test("an unplayed Plex notification for a never-watched item is not an unwatch", () => {
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: null, watchedRecord: null }), false,
    "a newly added library item has nothing to unwatch");
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: { state: "unwatched" }, watchedRecord: null }), false,
    "an already-unwatched item has nothing to unwatch");
});

test("an unplayed Plex notification is an unwatch when Plembfin holds a watch", () => {
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: { state: "watched" } }), true);
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: null, watchedRecord: { id: "w1" } }), true,
    "a watched history row under a sibling key still counts");
});
