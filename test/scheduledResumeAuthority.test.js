import test from "node:test";
import assert from "node:assert/strict";

import { resumeProgressBlockedByPlaystate } from "../server/src/scheduled.js";

test("a newer partial play takes precedence over an older unwatched marker", () => {
  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "unwatched", updated_at: 1_000 }, 2_000),
    "",
  );
});

test("a newer explicit unwatched marker clears older resume progress", () => {
  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "unwatched", updated_at: 2_000 }, 1_000),
    "item is unwatched",
  );
});

test("an unwatched marker remains authoritative when resume time is unavailable", () => {
  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "unwatched", updated_at: 2_000 }, 0),
    "item is unwatched",
  );
});

test("watched state always suppresses partial-play progress", () => {
  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "watched", updated_at: 1_000 }, 2_000),
    "item is watched",
  );
});
