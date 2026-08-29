import test from "node:test";
import assert from "node:assert/strict";

import {
  bulletPointsFrom,
  changelogEntryProcessViolations,
  filterChangelogDetails,
  filterChangelogEntries,
  formatChangelogMessage,
  isChangelogProcessMessage,
  isChangelogProcessText,
  isNoiseCommitMessage,
  isReleaseTypeCommitMessage,
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

test("bulletPointsFrom converts escaped newline bullets", () => {
  assert.deepEqual(bulletPointsFrom("docs: summary\\n- First detail\\n- Second detail"), [
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

test("isNoiseCommitMessage flags CI plumbing commits", () => {
  assert.equal(isNoiseCommitMessage("chore: bump alpha build for 2ad814a"), true);
  assert.equal(isNoiseCommitMessage("chore: bump develop build for 2ad814a"), true);
  assert.equal(isNoiseCommitMessage("chore: update changelog for c678878"), true);
  assert.equal(isNoiseCommitMessage("chore: reset develop build counter after promotion to alpha"), true);
  assert.equal(isNoiseCommitMessage("Merge branch 'alpha' of https://github.com/Lasikiewicz/plembfin into alpha"), true);
  assert.equal(isNoiseCommitMessage("Merge pull request #12 from foo/bar"), true);
  assert.equal(isNoiseCommitMessage("fix: keep controls visible"), false);
  assert.equal(isNoiseCommitMessage("chore: bump version to 0.8.0"), false);
});

test("filters changelog-process notes while retaining user-visible release details", () => {
  const processNote = "Trimmed the alpha build 1 changelog entry down to the actual TV show detail and grid bulk-watch fixes, dropping unrelated changelog-process bullets that had been folded in";
  const userDetail = "Season list rows now show Saving while a bulk watch action is in progress";

  assert.equal(isChangelogProcessText(processNote), true);
  assert.equal(isChangelogProcessText(userDetail), false);
  assert.equal(isChangelogProcessMessage("docs: consolidate v0.12.11 changelog entry into higher-level bullets"), true);
  assert.equal(isChangelogProcessMessage("chore: reset develop build counter after promotion to alpha"), true);
  assert.equal(isChangelogProcessMessage("fix: improve changelog entry rendering in Settings"), false);

  assert.deepEqual(filterChangelogDetails([processNote, userDetail]), [userDetail]);
  assert.deepEqual(
    filterChangelogEntries([
      { message: "chore: reset develop build counter after promotion to alpha", details: [processNote] },
      { message: "fix: TV show detail and grid bulk-watch fixes", details: [processNote, userDetail] },
    ]),
    [{ message: "fix: TV show detail and grid bulk-watch fixes", details: [userDetail] }],
  );
});

test("changelog entry guard reports process notes in messages, details, and sections", () => {
  const violations = changelogEntryProcessViolations({
    message: "Fix - TV show detail and grid bulk-watch fixes",
    details: ["Consolidate changelog entries at every promotion stage"],
    sections: { tweaks: ["Reset develop build counter after promotion to alpha"] },
  });

  assert.equal(violations.length, 2);
  assert.ok(violations.some((line) => line.startsWith("details:")));
  assert.ok(violations.some((line) => line.startsWith("sections.tweaks:")));
});

test("isReleaseTypeCommitMessage only accepts user-facing commit types", () => {
  assert.equal(isReleaseTypeCommitMessage("fix: keep controls visible"), true);
  assert.equal(isReleaseTypeCommitMessage("feat(stats): add comparisons"), true);
  assert.equal(isReleaseTypeCommitMessage("security: rotate secrets"), true);
  assert.equal(isReleaseTypeCommitMessage("docs: update readme"), true);
  assert.equal(isReleaseTypeCommitMessage("test: update Force Sync request tests"), false);
  assert.equal(isReleaseTypeCommitMessage("chore: add one-off diagnostic endpoint"), false);
  assert.equal(isReleaseTypeCommitMessage("refactor: extract helper"), false);
  assert.equal(isReleaseTypeCommitMessage("Merge branch 'alpha' into alpha"), false);
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
