import assert from "node:assert/strict";
import test from "node:test";
import { buildUpdatesModel, buildUpdatesMarkdown, mapWebsiteTargets } from "../scripts/update-local-updates.js";

const surfaces = [
  {
    id: "manual-watch-review",
    label: "Manual Watch review",
    docSlug: "manual-watch-review",
    sourcePaths: ["public/modules/manual-watch-review.js", "server/src/utils/manualWatchReview.js"],
  },
  {
    id: "manual-watch-review-secondary",
    label: "Manual Watch guide duplicate surface",
    docSlug: "manual-watch-review",
    sourcePaths: ["public/index.html"],
  },
  {
    id: "sync-activity",
    label: "Sync Activity",
    docSlug: "sync-tools",
    sourcePaths: ["public/modules/sync-activity.js"],
  },
];

test("website targets are grouped by guide when several surfaces share a doc", () => {
  const targets = mapWebsiteTargets([
    "public/modules/manual-watch-review.js",
    "public/index.html",
    "website/src/content/docs/manual-watch-review.mdx",
  ], surfaces);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].docSlug, "manual-watch-review");
  assert.deepEqual(targets[0].files, [
    "public/index.html",
    "public/modules/manual-watch-review.js",
    "website/src/content/docs/manual-watch-review.mdx",
  ]);
  assert.deepEqual(targets[0].labels, ["Manual Watch review", "Manual Watch guide duplicate surface"]);
});

test("rebuilding the ledger updates an existing target without duplicating its guide or bullets", () => {
  const model = buildUpdatesModel({
    baseline: { ref: "origin/main", sha: "base-commit" },
    head: "head-commit",
    generatedAt: "2026-09-21T12:00:00.000Z",
    surfaces,
    commits: [
      {
        id: "1111111111111111111111111111111111111111",
        date: "2026-09-20T10:00:00+01:00",
        message: "fix: improve manual review\n\n- Keep provider decisions visible until confirmed",
        files: ["public/modules/manual-watch-review.js"],
      },
      {
        id: "2222222222222222222222222222222222222222",
        date: "2026-09-21T10:00:00+01:00",
        message: "fix: refine manual review\n\n- Keep provider decisions visible until confirmed\n- Explain which connected app reported the item",
        files: ["public/modules/manual-watch-review.js", "server/src/utils/manualWatchReview.js"],
      },
    ],
  });

  assert.equal(model.targets.length, 1);
  assert.deepEqual(model.targets[0].commits, ["1111111", "2222222"]);
  assert.deepEqual(model.changelogChanges.map((change) => change.text), [
    "Keep provider decisions visible until confirmed",
    "Explain which connected app reported the item",
  ]);

  const markdown = buildUpdatesMarkdown(model);
  assert.equal((markdown.match(/^### Manual Watch review/gm) || []).length, 1);
  assert.equal(model.targets[0].changes.filter((change) => change.text === "Keep provider decisions visible until confirmed").length, 1);
  assert.match(markdown, /Manual Watch review.*website guide/);
  assert.match(markdown, /\[1111111, 2222222\]/);
});

test("tooling commits stay in the inventory but do not become changelog-ready app changes", () => {
  const model = buildUpdatesModel({
    baseline: { ref: "origin/main", sha: "base-commit" },
    head: "head-commit",
    generatedAt: "2026-09-21T12:00:00.000Z",
    surfaces,
    commits: [{
      id: "3333333333333333333333333333333333333333",
      date: "2026-09-21T11:00:00+01:00",
      message: "chore: refresh local release planning ledger",
      files: ["scripts/update-local-updates.js"],
    }],
  });

  assert.equal(model.commits.length, 1);
  assert.equal(model.changelogChanges.length, 0);
  assert.match(buildUpdatesMarkdown(model), /refresh local release planning ledger/);
});

test("the ledger lists website images whose catalogued sources changed, in every view, with their commits", () => {
  const catalogue = {
    variants: { dark: { style: "classic" }, light: { style: "classic" }, "modern-dark": { style: "modern" }, "modern-light": { style: "modern" } },
    commonSources: { all: ["public/styles.css"], modern: ["public/styles-modern.css"] },
    images: {
      stats: { variants: ["dark", "light", "modern-dark", "modern-light"], sources: ["public/modules/stats.js"] },
      upcoming: { variants: ["dark", "light", "modern-dark", "modern-light"], sources: ["public/modules/upcoming.js"] },
    },
  };
  const model = buildUpdatesModel({
    baseline: { ref: "origin/main", sha: "base-commit" },
    head: "head-commit",
    generatedAt: "2026-10-01T12:00:00.000Z",
    surfaces,
    catalogue,
    commits: [
      { id: "4444444444444444444444444444444444444444", date: "2026-10-01T11:00:00+01:00", message: "fix: stats totals", files: ["public/modules/stats.js"] },
      { id: "5555555555555555555555555555555555555555", date: "2026-10-01T11:30:00+01:00", message: "fix: modern card spacing", files: ["public/styles-modern.css"] },
    ],
  });

  assert.deepEqual(model.captures.images.map((image) => [image.id, image.variants.length, image.commits]), [
    ["stats", 4, ["4444444", "5555555"]],
    ["upcoming", 2, ["5555555"]],
  ]);
  const markdown = buildUpdatesMarkdown(model);
  assert.match(markdown, /## Website images to retake/);
  assert.match(markdown, /`stats` \(dark, light, modern-dark, modern-light\) \[4444444, 5555555\]: `public\/modules\/stats.js`/);
  assert.match(markdown, /captures:retake -- stats`/);
  assert.match(markdown, /captures:retake -- --variant=modern-dark,modern-light upcoming`/);
});
