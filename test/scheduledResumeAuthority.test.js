import test from "node:test";
import assert from "node:assert/strict";

import {
  resumeProgressAuthorityTimestamp,
  resumeProgressBlockedByPlaystate,
} from "../server/src/scheduled.js";

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

test("an unchanged timestamp-less server acknowledgement inherits the stored progress time", () => {
  const existingProgress = {
    position_ms: 970_000,
    duration_ms: 2_492_490,
    progress: 38.9169,
    updated_at: 3_000,
  };
  const acknowledgement = {
    positionMs: 970_000,
    durationMs: 2_492_490,
    progress: 38.9169,
    updatedAt: 0,
  };

  const effectiveTimestamp = resumeProgressAuthorityTimestamp(existingProgress, acknowledgement);
  assert.equal(effectiveTimestamp, 3_000);
  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "unwatched", updated_at: 2_000 }, effectiveTimestamp),
    "",
  );
});

test("a newer explicit unwatch still beats an unchanged timestamp-less acknowledgement", () => {
  const effectiveTimestamp = resumeProgressAuthorityTimestamp(
    { position_ms: 970_000, duration_ms: 2_492_490, progress: 38.9169, updated_at: 3_000 },
    { positionMs: 970_000, durationMs: 2_492_490, progress: 38.9169, updatedAt: 0 },
  );

  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "unwatched", updated_at: 4_000 }, effectiveTimestamp),
    "item is unwatched",
  );
});

test("a different timestamp-less position cannot borrow stored progress authority", () => {
  assert.equal(
    resumeProgressAuthorityTimestamp(
      { position_ms: 970_000, duration_ms: 2_492_490, progress: 38.9169, updated_at: 3_000 },
      { positionMs: 900_000, durationMs: 2_492_490, progress: 36.109, updatedAt: 0 },
    ),
    0,
  );
});

test("an explicit incoming resume timestamp remains authoritative", () => {
  assert.equal(
    resumeProgressAuthorityTimestamp(
      { position_ms: 970_000, duration_ms: 2_492_490, progress: 38.9169, updated_at: 3_000 },
      { positionMs: 900_000, durationMs: 2_492_490, progress: 36.109, updatedAt: 4_000 },
    ),
    4_000,
  );
});
