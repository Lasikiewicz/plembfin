import test from "node:test";
import assert from "node:assert/strict";

import {
  bulletPointsFrom,
  formatChangelogMessage,
  validateReleaseMessage,
} from "../scripts/changelog-message.js";

test("formatChangelogMessage formats conventional release subjects", () => {
  assert.equal(formatChangelogMessage("fix: keep controls visible"), "Fix - Keep controls visible");
  assert.equal(formatChangelogMessage("feat(stats): add comparisons"), "Feature - Add comparisons");
  assert.equal(formatChangelogMessage("perf: speed up page loading"), "Performance - Speed up page loading");
});

test("bulletPointsFrom extracts commit body bullets", () => {
  assert.deepEqual(bulletPointsFrom("fix: summary\n\n- First detail\n* Second detail"), [
    "First detail",
    "Second detail",
  ]);
});

test("validateReleaseMessage rejects title-only release commits", () => {
  assert.equal(validateReleaseMessage("fix: keep controls visible").length, 2);
  assert.equal(
    validateReleaseMessage("fix: keep controls visible\n\n- Fix - Keep controls visible").length,
    2,
  );
});

test("validateReleaseMessage accepts meaningful details and maintenance commits", () => {
  assert.deepEqual(
    validateReleaseMessage("fix: keep controls visible\n\n- Reflow filters on narrow screens"),
    [],
  );
  assert.deepEqual(
    validateReleaseMessage("perf: improve loading\n\n- Visible pages load earlier"),
    [],
  );
  assert.deepEqual(validateReleaseMessage("chore: update dependencies"), []);
});
