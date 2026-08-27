import test from "node:test";
import assert from "node:assert/strict";

import {
  mediaFromEmbyLikeResumableItem,
  resumeProgressAuthorityTimestamp,
  resumeProgressBlockedByPlaystate,
} from "../server/src/scheduled.js";
import {
  playstateBlocksStoredResumeProgress,
  resumeProgressEventTimestamp,
  resumeWebhookPhaseForPlaystate,
} from "../server/src/utils/resumeAuthority.js";

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

test("an unchanged acknowledgement with an older source date keeps the fresh stored progress authority", () => {
  const existingProgress = {
    position_ms: 970_000,
    duration_ms: 2_492_490,
    progress: 38.9169,
    updated_at: 3_000,
  };
  const staleAcknowledgement = {
    positionMs: 970_000,
    durationMs: 2_492_490,
    progress: 38.9169,
    updatedAt: 1_000,
  };

  const effectiveTimestamp = resumeProgressAuthorityTimestamp(existingProgress, staleAcknowledgement);
  assert.equal(effectiveTimestamp, 3_000);
  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "unwatched", updated_at: 2_000 }, effectiveTimestamp),
    "",
  );
});

test("a newer explicit unwatch still clears progress after a stale matching acknowledgement", () => {
  const effectiveTimestamp = resumeProgressAuthorityTimestamp(
    { position_ms: 970_000, duration_ms: 2_492_490, progress: 38.9169, updated_at: 3_000 },
    { positionMs: 970_000, durationMs: 2_492_490, progress: 38.9169, updatedAt: 1_000 },
  );

  assert.equal(
    resumeProgressBlockedByPlaystate({ state: "unwatched", updated_at: 4_000 }, effectiveTimestamp),
    "item is unwatched",
  );
});

test("a blocked stale different position cannot erase newer stored progress", () => {
  const storedProgress = {
    position_ms: 970_000,
    duration_ms: 2_492_490,
    progress: 38.9169,
    updated_at: 3_000,
  };
  const staleDifferentPosition = {
    positionMs: 800_000,
    durationMs: 2_492_490,
    progress: 32.0965,
    updatedAt: 1_000,
  };
  const oldUnwatch = { state: "unwatched", updated_at: 2_000 };

  const candidateTimestamp = resumeProgressAuthorityTimestamp(storedProgress, staleDifferentPosition);
  assert.equal(resumeProgressBlockedByPlaystate(oldUnwatch, candidateTimestamp), "item is unwatched");
  assert.equal(playstateBlocksStoredResumeProgress(oldUnwatch, storedProgress), false);
});

test("a newer explicit unwatch is allowed to clear stored progress", () => {
  assert.equal(
    playstateBlocksStoredResumeProgress(
      { state: "unwatched", updated_at: 4_000 },
      { updated_at: 3_000 },
    ),
    true,
  );
});

test("generic UserData callbacks do not gain receipt-time authority", () => {
  assert.equal(
    resumeProgressEventTimestamp({ event: "UserDataSaved", playedAt: "" }, 5_000),
    0,
  );
  assert.equal(
    resumeProgressEventTimestamp({ event: "PlaybackStop", playedAt: "" }, 5_000),
    5_000,
  );
  assert.equal(
    resumeProgressEventTimestamp({ event: "UserDataSaved", playedAt: "1970-01-01T00:00:01.000Z" }, 5_000),
    1_000,
  );
});

test("a watched item changing to Played=false remains an authoritative unwatch", () => {
  const ambiguousUserData = {
    source: "jellyfin",
    event: "UserDataSaved",
    phase: "ended",
    playedFlagOnly: true,
  };

  assert.equal(
    resumeWebhookPhaseForPlaystate(ambiguousUserData, { state: "watched", updated_at: 3_000 }),
    "unplayed",
  );
  assert.equal(
    resumeWebhookPhaseForPlaystate(ambiguousUserData, { state: "unwatched", updated_at: 3_000 }),
    "ended",
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

test("Emby-like item metadata dates are not mistaken for resume authority", () => {
  const media = mediaFromEmbyLikeResumableItem({
    Type: "Episode",
    Name: "Episode 1",
    SeriesName: "Ted Lasso",
    ParentIndexNumber: 4,
    IndexNumber: 1,
    RunTimeTicks: 24_924_900_000,
    DateCreated: "2025-01-01T00:00:00.000Z",
    DateLastSaved: "2026-08-23T20:00:00.000Z",
    UserData: { Played: false, PlaybackPositionTicks: 9_870_000_000 },
  });

  assert.equal(media.updatedAt, 0);
  assert.equal(media.positionMs, 987_000);
});
