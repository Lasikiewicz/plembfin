import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];

const { withoutNowPlaying } = await import("../public/modules/up-next-shared.js");

const tedLasso = { id: "ted", media_type: "episode", show_title: "Ted Lasso", season: 4, episode: 4 };
const scrubs = { id: "scrubs", media_type: "episode", show_title: "Scrubs", season: 1, episode: 2 };
const quietPlace = { id: "quiet", media_type: "movie", title: "A Quiet Place" };

test("Up Next hides the episode that is playing", () => {
  const sessions = [{ mediaType: "episode", title: "Ted Lasso (2020) - S04E04", season: 4, episode: 4 }];
  assert.deepEqual(withoutNowPlaying([tedLasso, scrubs], sessions).map((item) => item.id), ["scrubs"]);
});

test("Up Next keeps a different episode of the playing show", () => {
  const sessions = [{ mediaType: "episode", title: "Ted Lasso - S04E03", season: 4, episode: 3 }];
  assert.deepEqual(withoutNowPlaying([tedLasso, scrubs], sessions).map((item) => item.id), ["ted", "scrubs"]);
});

test("Up Next hides the movie that is playing", () => {
  const sessions = [{ mediaType: "movie", title: "A Quiet Place" }];
  assert.deepEqual(withoutNowPlaying([tedLasso, quietPlace], sessions).map((item) => item.id), ["ted"]);
});

test("Up Next is unchanged with nothing playing", () => {
  const items = [tedLasso, scrubs];
  assert.equal(withoutNowPlaying(items, []), items);
});
