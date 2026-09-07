import test from "node:test";
import assert from "node:assert/strict";
import {
  episodeTimingWatchDate,
  resolvePlexWatchDate,
  resolveWatchImportDate,
  runtimeMinutesForSourceItem,
  watchedAtForEmbyLikeItem,
  watchedAtForPlexItem,
} from "../server/src/utils/watchDates.js";

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

test("the default watch-import policy requires review for an app-marked item", () => {
  const now = Date.parse("2026-09-06T12:34:56.000Z");
  assert.deepEqual(
    resolveWatchImportDate({
      manualMark: true,
      releaseDate: "2026-09-01",
      now,
    }),
    {
      watchedAt: "2026-09-01T00:00:00.000Z",
      previewWatchedAt: "2026-09-01T00:00:00.000Z",
      requiresReview: true,
      reason: "manual flag requires review",
    },
  );
});

test("watch-import release-day and review policies are explicit", () => {
  const options = {
    manualMark: true,
    releaseDate: "2026-09-01T18:00:00Z",
    now: Date.parse("2026-09-06T12:34:56.000Z"),
  };
  assert.equal(resolveWatchImportDate({ ...options, mode: "release_day" }).watchedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(resolveWatchImportDate({ ...options, mode: "review" }).requiresReview, true);
  assert.equal(resolveWatchImportDate({ ...options, mode: "review" }).watchedAt, "2026-09-01T00:00:00.000Z");
});

test("episode timing uses the nearest same-season episode like the media page", () => {
  const media = {
    title: "Ted - S02E01",
    type: "episode",
    season: 2,
    episode: 1,
    runtimeMinutes: 24,
  };
  const next = {
    title: "Ted - S02E02",
    show_title: "Ted",
    media_type: "episode",
    season: 2,
    episode: 2,
    runtime_minutes: 25,
    watched_at: "2026-09-06T12:00:00.000Z",
    sync_action: "watched",
  };
  assert.equal(
    episodeTimingWatchDate(media, [next], "2026-09-01T00:00:00Z"),
    "2026-09-06T11:34:00.000Z",
  );
  assert.equal(
    resolveWatchImportDate({
      mode: "episode_timing",
      manualMark: true,
      media,
      historyRows: [next],
      releaseDate: "2026-09-01",
      now: Date.parse("2026-09-06T12:34:56.000Z"),
    }).watchedAt,
    "2026-09-06T11:34:00.000Z",
  );
});

test("source runtimes normalize Plex milliseconds and Emby ticks", () => {
  assert.equal(runtimeMinutesForSourceItem({ duration: 1_440_000 }, "plex"), 24);
  assert.equal(runtimeMinutesForSourceItem({ durationMs: 1_440_000 }, "emby"), 24);
  assert.equal(runtimeMinutesForSourceItem({ RunTimeTicks: 14_400_000_000 }, "emby"), 24);
});
