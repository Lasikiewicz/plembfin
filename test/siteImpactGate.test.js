import test from "node:test";
import assert from "node:assert/strict";

import {
  computeWebsiteContentImpact,
  formatWebsiteContentImpactFailure,
  parseSiteImpactTrailer,
} from "../scripts/site-impact.js";

const surfaces = [
  {
    id: "sync-tuning",
    label: "Sync tuning",
    docSlug: "sync-tuning",
    sourcePaths: ["public/modules/tracker-settings.js", "public/index.html"],
  },
  {
    id: "dashboard",
    label: "Dashboard",
    docSlug: "dashboard",
    sourcePaths: ["public/modules/dashboard.js", "public/index.html"],
  },
];

const SYNC_GUIDE = "website/src/content/docs/sync-tuning.mdx";
const DASHBOARD_GUIDE = "website/src/content/docs/dashboard.mdx";

test("parseSiteImpactTrailer reads a none decision, case-insensitively", () => {
  assert.deepEqual(parseSiteImpactTrailer("fix: x\n\nsite-impact: none"), { kind: "none", raw: "none" });
  assert.deepEqual(parseSiteImpactTrailer("fix: x\n\nSite-Impact: NONE"), { kind: "none", raw: "NONE" });
});

test("parseSiteImpactTrailer reads one or several guides", () => {
  assert.deepEqual(parseSiteImpactTrailer("feat: x\n\nsite-impact: sync-tuning"), { kind: "target", docSlugs: ["sync-tuning"], raw: "sync-tuning" });
  assert.deepEqual(parseSiteImpactTrailer("feat: x\n\nsite-impact: sync-tuning, Dashboard"), { kind: "target", docSlugs: ["sync-tuning", "dashboard"], raw: "sync-tuning, Dashboard" });
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

test("a mapped change passes once its guide differs in the released website tree", () => {
  const commits = [{ id: "abc1234", message: "feat: retune sync thresholds", files: ["public/modules/tracker-settings.js"] }];
  const report = computeWebsiteContentImpact({ commits, updatedFiles: [SYNC_GUIDE], surfaces });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.requiredGuides, ["sync-tuning"]);
});

test("a mapped change fails while its guide is not updated", () => {
  const commits = [{ id: "abc1234", message: "feat: retune sync thresholds", files: ["public/modules/tracker-settings.js"] }];
  const { failures } = computeWebsiteContentImpact({ commits, updatedFiles: [], surfaces });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].docSlug, "sync-tuning");
  assert.equal(failures[0].kind, "not-updated");
  assert.deepEqual(failures[0].commits, ["abc1234"]);
  assert.deepEqual(failures[0].files, ["public/modules/tracker-settings.js"]);
});

test("the guide update does not need to be in the release commits", () => {
  // Force to main stages develop's website/ tree on top of alpha's commits.
  const commits = [{ id: "abc1234", message: "feat: new dashboard rail", files: ["public/modules/dashboard.js"] }];
  assert.deepEqual(computeWebsiteContentImpact({ commits, updatedFiles: [DASHBOARD_GUIDE], surfaces }).failures, []);
});

test("a guide the release review found still accurate passes without an edit", () => {
  const commits = [{ id: "abc1234", message: "feat: retune sync thresholds", files: ["public/modules/tracker-settings.js"] }];
  assert.deepEqual(computeWebsiteContentImpact({ commits, updatedFiles: [], reviewedUnchanged: ["sync-tuning"], surfaces }).failures, []);
});

test("site-impact: none needs no guide", () => {
  const commits = [{ id: "abc1234", message: "fix: internal off-by-one\n\nsite-impact: none", files: ["public/modules/tracker-settings.js"] }];
  const report = computeWebsiteContentImpact({ commits, updatedFiles: [], surfaces });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.requiredGuides, []);
});

test("a site-impact note replaces the file mapping for its commit", () => {
  // public/index.html maps to both guides; the note says only the dashboard changed.
  const commits = [{ id: "abc1234", message: "feat: dashboard tweak\n\nsite-impact: dashboard", files: ["public/index.html"] }];
  const report = computeWebsiteContentImpact({ commits, updatedFiles: [DASHBOARD_GUIDE], surfaces });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.requiredGuides, ["dashboard"]);
});

test("a guide named by a note must be updated even with no mapped file", () => {
  const commits = [{ id: "abc1234", message: "fix: sync engine\n\nsite-impact: sync-tuning", files: ["server/src/utils/engine.js"] }];
  const { failures } = computeWebsiteContentImpact({ commits, updatedFiles: [], surfaces });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].docSlug, "sync-tuning");
});

test("a note naming an unknown guide fails", () => {
  const commits = [{ id: "abc1234", message: "feat: x\n\nsite-impact: dashbord", files: ["public/modules/dashboard.js"] }];
  const { failures } = computeWebsiteContentImpact({ commits, updatedFiles: [DASHBOARD_GUIDE], surfaces });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "unknown-slug");
  assert.equal(failures[0].docSlug, "dashbord");
});

test("a later none note does not cancel an earlier commit's need", () => {
  const commits = [
    { id: "aaa1111", message: "feat: retune sync thresholds", files: ["public/modules/tracker-settings.js"] },
    { id: "bbb2222", message: "fix: typo\n\nsite-impact: none", files: ["public/modules/tracker-settings.js"] },
  ];
  const { failures } = computeWebsiteContentImpact({ commits, updatedFiles: [], surfaces });
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].commits, ["aaa1111"]);
});

test("an uncatalogued app path with no note is listed for review, not failed", () => {
  const commits = [{ id: "abc1234", message: "feat: add a new settings tool", files: ["server/src/routes/newTool.js"] }];
  const report = computeWebsiteContentImpact({ commits, updatedFiles: [], surfaces });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.review, [{ file: "server/src/routes/newTool.js", commits: ["abc1234"] }]);
});

test("release bookkeeping and website-only infrastructure changes are out of scope", () => {
  const commits = [{ id: "abc1234", message: "chore: bump version", files: ["package.json", "README.md", "website/src/layouts/SiteLayout.astro"] }];
  const report = computeWebsiteContentImpact({ commits, updatedFiles: [], surfaces });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.review, []);
});

test("release-bookkeeping commits are excluded from the walk entirely", () => {
  const commits = [{
    id: "abc1234",
    message: "chore: promote alpha to main v1.2.2",
    files: ["public/modules/tracker-settings.js", "public/modules/dashboard.js", "server/server.js"],
  }];
  assert.deepEqual(computeWebsiteContentImpact({ commits, updatedFiles: [], surfaces }).failures, []);
});

test("formatWebsiteContentImpactFailure names the guide, commit, and files", () => {
  const text = formatWebsiteContentImpactFailure({
    docSlug: "sync-tuning",
    kind: "not-updated",
    commits: ["abc1234"],
    files: ["public/modules/tracker-settings.js"],
  });
  assert.match(text, /sync-tuning\.mdx/);
  assert.match(text, /abc1234/);
  assert.match(text, /tracker-settings\.js/);
});
