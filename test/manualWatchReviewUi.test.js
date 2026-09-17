import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.history = { state: {} };
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {} };

const {
  groupManualWatchReviews,
  groupReviewsByEpisode,
  groupReviewsBySeason,
  orderManualWatchReviewGroups,
  reviewActionScopeLabel,
  manualWatchReviewConfirmation,
} = await import("../public/modules/manual-watch-review.js");

test("manual watch review groups preserve newest incoming order and sort episodes within a show", () => {
  const reviews = [
    { id: "zeta-2", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 2 },
    { id: "alpha-1", media_type: "episode", show_title: "Alpha Show", season: 1, episode: 1 },
    { id: "zeta-1", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 1 },
  ];

  const groups = groupManualWatchReviews(reviews);

  assert.deepEqual(groups.map((group) => group.title), ["Zeta Show", "Alpha Show"]);
  assert.deepEqual(groups[0].reviews.map((review) => review.episode), [1, 2]);
});

test("manual watch review keeps a show in place after removing its first episode", () => {
  const reviews = [
    { id: "zeta-2", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 2 },
    { id: "alpha-1", media_type: "episode", show_title: "Alpha Show", season: 1, episode: 1 },
    { id: "zeta-1", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 1 },
  ];
  const initialGroups = groupManualWatchReviews(reviews);
  const afterRemoval = groupManualWatchReviews(reviews.filter((review) => review.id !== "zeta-2"));

  const stableGroups = orderManualWatchReviewGroups(
    afterRemoval,
    initialGroups.map((group) => group.key),
  );

  assert.deepEqual(stableGroups.map((group) => group.title), ["Zeta Show", "Alpha Show"]);
});

test("manual watch review separates season groups and names their action scope", () => {
  const seasons = groupReviewsBySeason([
    { id: "s2e1", media_type: "episode", season: 2, episode: 1 },
    { id: "s1e2", media_type: "episode", season: 1, episode: 2 },
    { id: "s1e1", media_type: "episode", season: 1, episode: 1 },
  ]);

  assert.deepEqual(seasons.map((season) => [season.title, season.reviews.length]), [
    ["Season 2", 1],
    ["Season 1", 2],
  ]);
  assert.equal(reviewActionScopeLabel("show", "now"), "Mark all show watched now");
  assert.equal(reviewActionScopeLabel("season", "dismiss", "Emby", "Season 2"), "Mark Season 2 unwatched");
});

test("manual watch review combines provider records for the same episode", () => {
  const episodes = groupReviewsByEpisode([
    { id: "emby-s12e3", media_type: "episode", season: 12, episode: 3, episode_title: "Course", source: "emby" },
    { id: "plex-s12e3", media_type: "episode", season: 12, episode: 3, episode_title: "Course", source: "plex" },
  ]);

  assert.equal(episodes.length, 1);
  assert.deepEqual(episodes[0].sources, ["Emby", "Plex"]);
  assert.deepEqual(episodes[0].reviews.map((review) => review.id), ["emby-s12e3", "plex-s12e3"]);
});

test("manual watch review confirmation protects single-item unwatched decisions", () => {
  assert.deepEqual(manualWatchReviewConfirmation({
    action: "dismiss",
    title: "Lioness - S03E07",
    source: "Plex",
  }), {
    title: "Dismiss manual watch review?",
    body: "This will dismiss “Lioness - S03E07” and mark it unwatched across connected media apps. The unwatched state will be queued for sync.",
    confirmLabel: "Dismiss & mark unwatched",
    danger: true,
  });
});

test("manual watch review confirmation describes grouped watch decisions", () => {
  const prompt = manualWatchReviewConfirmation({
    action: "approve",
    mode: "episode_timing",
    title: "Lioness",
    count: 3,
  });

  assert.equal(prompt.title, "Confirm manual watch decisions");
  assert.match(prompt.body, /3 episodes from “Lioness”/);
  assert.match(prompt.body, /episode timing date/);
  assert.equal(prompt.confirmLabel, "Confirm all decisions");
  assert.equal(prompt.danger, false);
});
