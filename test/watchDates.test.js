import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlexWatchDate, watchedAtForEmbyLikeItem, watchedAtForPlexItem } from "../server/src/utils/watchDates.js";

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

test("treats an explicit zero play count as marked over the API, not a data gap", () => {
  assert.deepEqual(
    watchedAtForEmbyLikeItem({ UserData: { Played: true, PlayCount: 0 } }),
    { watchedAt: "", reason: "marked without playback" },
  );
});

test("a real play count with a lost date stays a reportable data gap", () => {
  assert.deepEqual(
    watchedAtForEmbyLikeItem({ UserData: { Played: true, PlayCount: 3 } }),
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

test("uses the release day for a Plex manual watched flag", () => {
  assert.deepEqual(
    resolvePlexWatchDate({
      lastViewedAt: 1787424000,
      originallyAvailableAt: "2026-06-19",
    }),
    {
      watchedAt: "2026-06-19T00:00:00.000Z",
      manualMark: true,
      sourceTimestamp: "",
      note: "Plex reported a watched library flag without a recent threshold-reaching playback session; the release date was used instead of the manual mark time.",
    },
  );
});

test("keeps Plex's viewed timestamp when threshold playback is confirmed", () => {
  assert.deepEqual(
    resolvePlexWatchDate({
      lastViewedAt: 1783379340,
      originallyAvailableAt: "2026-06-19",
    }, { hasPlaybackEvidence: true }),
    {
      watchedAt: "2026-07-06T23:09:00.000Z",
      manualMark: false,
      sourceTimestamp: "2026-07-06T23:09:00.000Z",
      note: "",
    },
  );
});
