// Five-segment build versions and the release-history guard.
//
// These cover the two things in the release flow that fail silently and ship to
// every user if they are wrong: version ordering (which drives the app's update
// indicator and the release-version decision) and release-history preservation
// (a truncated changelog cannot be recovered once users have pulled the image).
// See docs/decisions.md entry 18.

import test from "node:test";
import assert from "node:assert/strict";

const {
  parseBuildVersion,
  compareBuildVersions,
  formatBuildVersion,
  releaseVersionOf,
  buildVersion,
  bumpPatch,
} = await import("../scripts/version.js");

const { verifyReleaseHistory } = await import("../scripts/promote-alpha-to-main.js");

test("the full command ladder is strictly increasing", () => {
  const ladder = [
    "1.1.0.0.0", // release
    "1.1.0.0.1", // push to git
    "1.1.0.0.2",
    "1.1.0.0.3",
    "1.1.0.1.0", // force to alpha
    "1.1.0.1.1", // push to git
    "1.1.0.1.2",
    "1.1.0.2.0", // force to alpha
    "1.1.0.2.1", // push to git
    "1.1.1.0.0", // force to main
    "1.1.1.0.1", // push to git
  ];
  for (let i = 1; i < ladder.length; i++) {
    assert.equal(
      compareBuildVersions(ladder[i], ladder[i - 1]),
      1,
      `${ladder[i]} should sort after ${ladder[i - 1]}`,
    );
  }
});

test("a release outranks every pre-release build that preceded it", () => {
  assert.equal(compareBuildVersions("1.1.1.0.0", "1.1.0.9.9"), 1);
  assert.equal(compareBuildVersions("1.2.0.0.0", "1.1.9.9.9"), 1);
});

test("four-segment versions from before the change are not reinterpreted", () => {
  // The migration case. An alpha image already in the wild reports "1.0.2.1";
  // it must mean exactly what the new scheme would write for the same build.
  assert.equal(compareBuildVersions("1.0.2.1", "1.0.2.1.0"), 0);
  assert.deepEqual(parseBuildVersion("1.0.2.1"), [1, 0, 2, 1, 0]);
  assert.deepEqual(parseBuildVersion("1.1.0"), [1, 1, 0, 0, 0]);
  // And it still orders correctly against the release that follows it.
  assert.equal(compareBuildVersions("1.0.3.0.0", "1.0.2.1"), 1);
});

test("display trims trailing zeros only, and never below three segments", () => {
  assert.equal(formatBuildVersion("1.1.0.0.0"), "1.1.0");
  assert.equal(formatBuildVersion("1.1.0.1.0"), "1.1.0.1");
  assert.equal(formatBuildVersion("1.1.0.1.3"), "1.1.0.1.3");
  // Not a trailing zero: a develop build keeps the alpha segment's zero.
  assert.equal(formatBuildVersion("1.1.0.0.2"), "1.1.0.0.2");
  assert.equal(formatBuildVersion("1.1.0"), "1.1.0");
  assert.equal(formatBuildVersion("v1.1.0.2.0"), "1.1.0.2");
  // A release must never trim to two segments even when the patch is zero.
  assert.equal(formatBuildVersion("2.0.0.0.0"), "2.0.0");
});

test("unparseable and over-long versions never win a comparison", () => {
  assert.equal(parseBuildVersion("1.1.0.1.1.1"), null, "six segments is not a build version");
  assert.equal(parseBuildVersion("1.2.0-alpha.1"), null, "prerelease tags were rejected, see entry 18");
  assert.equal(parseBuildVersion(""), null);
  assert.equal(parseBuildVersion(null), null);
  // compareBuildVersions returns 0 rather than guessing, so an unreadable
  // version cannot present itself as newer than the installed one.
  assert.equal(compareBuildVersions("1.2.0-alpha.1", "1.1.0"), 0);
  assert.equal(compareBuildVersions("garbage", "1.1.0"), 0);
});

test("package.json only ever receives the three-segment release version", () => {
  // Five segments is not valid semver and npm rejects or mishandles it.
  assert.equal(releaseVersionOf("1.1.0.2.1"), "1.1.0");
  assert.equal(releaseVersionOf("1.1.0"), "1.1.0");
  assert.equal(buildVersion("1.1.0", 2, 1), "1.1.0.2.1");
  assert.equal(buildVersion("1.1.0"), "1.1.0.0.0");
  assert.equal(bumpPatch("1.1.0"), "1.1.1");
  assert.equal(bumpPatch("1.1.0.4.2"), "1.1.1", "a build version bumps on its release part");
});

test("the release-history gate accepts a correctly extended history", () => {
  assert.deepEqual(
    verifyReleaseHistory({
      priorVersions: ["1.1.0", "1.0.2", "1.0.1"],
      newVersions: ["1.1.1", "1.1.0", "1.0.2", "1.0.1"],
      newMainVersion: "1.1.1",
    }),
    [],
  );
});

test("the release-history gate refuses a truncated history", () => {
  // This is the compounding-loss case: the release is built from alpha's
  // checkout, which never saw main's history, so writing from the working tree
  // would publish a changelog containing only this release.
  const failures = verifyReleaseHistory({
    priorVersions: ["1.1.0", "1.0.2", "1.0.1"],
    newVersions: ["1.1.1"],
    newMainVersion: "1.1.1",
  });
  assert.ok(failures.length > 0, "a history with everything dropped must fail");
  assert.match(failures.join("\n"), /missing/);
  assert.match(failures.join("\n"), /1\.1\.0/);
});

test("the release-history gate refuses a single dropped release", () => {
  // The subtle version: only the most recent release is missing, which is
  // exactly what one un-synced cycle produces.
  const failures = verifyReleaseHistory({
    priorVersions: ["1.1.0", "1.0.2"],
    newVersions: ["1.1.1", "1.0.2"],
    newMainVersion: "1.1.1",
  });
  assert.ok(failures.length > 0);
  assert.match(failures.join("\n"), /1\.1\.0/);
});

test("the release-history gate refuses more or fewer than one new release", () => {
  const two = verifyReleaseHistory({
    priorVersions: ["1.0.2"],
    newVersions: ["1.1.1", "1.1.0", "1.0.2"],
    newMainVersion: "1.1.1",
  });
  assert.ok(two.length > 0, "two new releases in one promotion must fail");

  const none = verifyReleaseHistory({
    priorVersions: ["1.0.2"],
    newVersions: ["1.0.2"],
    newMainVersion: "1.1.1",
  });
  assert.ok(none.length > 0, "no new release must fail");
});

test("the release-history gate refuses a new release under the wrong version", () => {
  const failures = verifyReleaseHistory({
    priorVersions: ["1.1.0"],
    newVersions: ["1.2.0", "1.1.0"],
    newMainVersion: "1.1.1",
  });
  assert.ok(failures.length > 0);
  assert.match(failures.join("\n"), /expected 1\.1\.1/);
});
