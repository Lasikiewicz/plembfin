import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-one-card-");
const { collapseUncertainEpisodeQueues } = await import("../server/src/utils/upNextService.js");

const episode = (overrides) => ({
  media_type: "episode",
  show_title: "Ted Lasso",
  season: 4,
  updated_at: 1_000,
  ...overrides,
});

// Ted Lasso S04E04 part-watched at 7% sat beside its S04E05 next-up card.
test("a part-watched episode replaces the show's next-up card", () => {
  const items = collapseUncertainEpisodeQueues([
    episode({ id: "e4", episode: 4, queue_kind: "resume", progress: 7 }),
    episode({ id: "e5", episode: 5, queue_kind: "next_up" }),
    episode({ id: "m5", show_title: "Marshals", season: 1, episode: 5, queue_kind: "next_up" }),
  ]);
  assert.deepEqual(items.map((item) => item.id).sort(), ["e4", "m5"]);
});

test("several part-watched episodes of one show keep the latest", () => {
  const items = collapseUncertainEpisodeQueues([
    episode({ id: "e2", episode: 2, queue_kind: "resume", updated_at: 2_000 }),
    episode({ id: "e4", episode: 4, queue_kind: "resume", updated_at: 1_000 }),
  ]);
  assert.deepEqual(items.map((item) => item.id), ["e2"]);
});
