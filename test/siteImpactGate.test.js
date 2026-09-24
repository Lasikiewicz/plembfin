import test from "node:test";
import assert from "node:assert/strict";

import {
  computeWebsiteContentImpactFailures,
  formatWebsiteContentImpactFailure,
  parseSiteImpactTrailer,
} from "../scripts/site-impact.js";

const surfaces = [
  {
    id: "sync-tuning",
    label: "Sync tuning",
    docSlug: "sync-tuning",
    sourcePaths: ["public/modules/tracker-settings.js"],
  },
  {
    id: "dashboard",
    label: "Dashboard",
    docSlug: "dashboard",
    sourcePaths: ["public/modules/dashboard.js"],
  },
];

test("parseSiteImpactTrailer reads a none decision, case-insensitively", () => {
  assert.deepEqual(parseSiteImpactTrailer("fix: x\n\nsite-impact: none"), { kind: "none", raw: "none" });
  assert.deepEqual(parseSiteImpactTrailer("fix: x\n\nSite-Impact: NONE"), { kind: "none", raw: "NONE" });
});

test("parseSiteImpactTrailer reads a target decision", () => {
  assert.deepEqual(parseSiteImpactTrailer("feat: x\n\nsite-impact: sync-tuning"), { kind: "target", docSlug: "sync-tuning", raw: "sync-tuning" });
});

test("parseSiteImpactTrailer returns null when absent", () => {
  assert.equal(parseSiteImpactTrailer("fix: x\n\nNo trailer here."), null);
});

test("parseSiteImpactTrailer takes the last occurrence when a line is corrected", () => {
  assert.deepEqual(
    parseSiteImpactTrailer("fix: x\n\nsite-impact: wrong-slug\nsite-impact: none"),
    { kind: "none", raw: "none" },
  );
});

test("a mapped target with its guide updated in range has no failure", () => {
  const commits = [{
    id: "abc1234",
    message: "feat: retune sync thresholds",
    files: ["public/modules/tracker-settings.js", "website/src/content/docs/sync-tuning.mdx"],
  }];
  assert.deepEqual(computeWebsiteContentImpactFailures({ commits, surfaces }), []);
});

test("a mapped target changed without its guide and without a decision fails", () => {
  const commits = [{
    id: "abc1234",
    message: "feat: retune sync thresholds",
    files: ["public/modules/tracker-settings.js"],
  }];
  const failures = computeWebsiteContentImpactFailures({ commits, surfaces });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].file, "public/modules/tracker-settings.js");
  assert.equal(failures[0].docSlug, "sync-tuning");
  assert.deepEqual(failures[0].commits, ["abc1234"]);
});

test("site-impact: none excuses a mapped target's source change", () => {
  const commits = [{
    id: "abc1234",
    message: "fix: correct an internal off-by-one\n\nsite-impact: none",
    files: ["public/modules/tracker-settings.js"],
  }];
  assert.deepEqual(computeWebsiteContentImpactFailures({ commits, surfaces }), []);
});

test("site-impact naming the wrong slug does not excuse a mapped target", () => {
  const commits = [{
    id: "abc1234",
    message: "feat: retune sync thresholds\n\nsite-impact: dashboard",
    files: ["public/modules/tracker-settings.js"],
  }];
  const failures = computeWebsiteContentImpactFailures({ commits, surfaces });
  assert.equal(failures.length, 1);
});

test("every commit touching the file must carry a decision, not just one of them", () => {
  const commits = [
    { id: "aaa1111", message: "feat: retune sync thresholds", files: ["public/modules/tracker-settings.js"] },
    { id: "bbb2222", message: "fix: typo\n\nsite-impact: none", files: ["public/modules/tracker-settings.js"] },
  ];
  const failures = computeWebsiteContentImpactFailures({ commits, surfaces });
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].commits, ["aaa1111", "bbb2222"]);
});

test("a fully uncatalogued app path fails without a decision", () => {
  const commits = [{
    id: "abc1234",
    message: "feat: add a new settings tool",
    files: ["server/src/routes/newTool.js"],
  }];
  const failures = computeWebsiteContentImpactFailures({ commits, surfaces });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].docSlug, "");
});

test("site-impact: none excuses a fully uncatalogued app path", () => {
  const commits = [{
    id: "abc1234",
    message: "fix: internal refactor\n\nsite-impact: none",
    files: ["server/src/routes/newTool.js"],
  }];
  assert.deepEqual(computeWebsiteContentImpactFailures({ commits, surfaces }), []);
});

test("naming any real target excuses a fully uncatalogued app path", () => {
  const commits = [{
    id: "abc1234",
    message: "feat: small addition covered elsewhere\n\nsite-impact: dashboard",
    files: ["server/src/routes/newTool.js"],
  }];
  assert.deepEqual(computeWebsiteContentImpactFailures({ commits, surfaces }), []);
});

test("release bookkeeping and website-only infrastructure changes are out of scope", () => {
  const commits = [{
    id: "abc1234",
    message: "chore: bump version",
    files: ["package.json", "README.md", "website/src/layouts/SiteLayout.astro"],
  }];
  assert.deepEqual(computeWebsiteContentImpactFailures({ commits, surfaces }), []);
});

test("release-bookkeeping commits are excluded from the walk entirely", () => {
  const commits = [{
    id: "abc1234",
    message: "chore: promote alpha to main v1.2.2",
    files: ["public/modules/tracker-settings.js", "public/modules/dashboard.js", "server/server.js"],
  }];
  assert.deepEqual(computeWebsiteContentImpactFailures({ commits, surfaces }), []);
});

test("formatWebsiteContentImpactFailure names the file and the missing guide", () => {
  const text = formatWebsiteContentImpactFailure({
    file: "public/modules/tracker-settings.js",
    docSlug: "sync-tuning",
    label: "Sync tuning",
    commits: ["abc1234"],
  });
  assert.match(text, /tracker-settings\.js/);
  assert.match(text, /sync-tuning\.mdx/);
  assert.match(text, /abc1234/);
});
