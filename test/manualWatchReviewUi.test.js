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

const { groupManualWatchReviews, orderManualWatchReviewGroups } = await import("../public/modules/manual-watch-review.js");

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
