import test from "node:test";
import assert from "node:assert/strict";
import { watchedAtForEmbyLikeItem, watchedAtForPlexItem } from "../server/src/utils/watchDates.js";

test("uses Emby's real played timestamp when present", () => {
  assert.deepEqual(
    watchedAtForEmbyLikeItem({ UserData: { Played: true, LastPlayedDate: "2026-07-23T21:15:00Z" } }),
    { watchedAt: "2026-07-23T21:15:00.000Z", reason: "played" },
  );
});

test("does not turn a timestamp-less played item into a new watch", () => {
  assert.deepEqual(
    watchedAtForEmbyLikeItem({ UserData: { Played: true } }),
    { watchedAt: "", reason: "missing played date" },
  );
});

test("does not report an unplayed item as watched", () => {
  assert.deepEqual(
    watchedAtForEmbyLikeItem({ UserData: { Played: false } }),
    { watchedAt: "", reason: "" },
  );
});

test("uses Plex's real viewed timestamp when present", () => {
  assert.deepEqual(
    watchedAtForPlexItem({ lastViewedAt: 1783379340 }),
    { watchedAt: "2026-07-06T23:09:00.000Z", reason: "viewed" },
  );
});

test("does not turn a timestamp-less Plex refresh item into a new watch", () => {
  assert.deepEqual(
    watchedAtForPlexItem({ viewCount: 3 }),
    { watchedAt: "", reason: "missing viewed date" },
  );
});
