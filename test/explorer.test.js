import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { shouldHideWatchedShows, isAlphabeticalExplorerSort } = await import("../public/modules/explorer.js");

test("show searches include fully watched shows even when the filter is enabled", () => {
  assert.equal(shouldHideWatchedShows("", true), true);
  assert.equal(shouldHideWatchedShows("   ", true), true);
  assert.equal(shouldHideWatchedShows("Clarkson's Farm", true), false);
  assert.equal(shouldHideWatchedShows("Clarkson's Farm", false), false);
});

test("A-Z navigation is reserved for alphabetical explorer sorts", () => {
  assert.equal(isAlphabeticalExplorerSort("title_asc"), true);
  assert.equal(isAlphabeticalExplorerSort("title_desc"), true);
  assert.equal(isAlphabeticalExplorerSort("watched_desc"), false);
  assert.equal(isAlphabeticalExplorerSort("watched_asc"), false);
  assert.equal(isAlphabeticalExplorerSort("next_air_asc"), false);
});
