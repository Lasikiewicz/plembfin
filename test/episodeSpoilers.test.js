import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

test("episode spoilers are hidden by default", async () => {
  localStorage.clear();
  const { state } = await import("../public/modules/state.js?spoilers-default");
  assert.equal(state.hideEpisodeSpoilers, true);
});

test("a saved spoiler preference can reveal unwatched episode details", async () => {
  localStorage.setItem("plembfin:hideEpisodeSpoilers", "false");
  const { state } = await import("../public/modules/state.js?spoilers-visible");
  assert.equal(state.hideEpisodeSpoilers, false);
});
