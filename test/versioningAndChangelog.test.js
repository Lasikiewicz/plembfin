import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import "./domStubs.js";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-versioning-");

const { categorizeEntries, simplifyEntries } = await import("../scripts/promote-develop-to-alpha.js");
const { bumpPatchVersion } = await import("../scripts/promote-alpha-to-main.js");
const { buildDevelopEntry, validateDevelopChangelog } = await import("../scripts/rebuild-develop-changelog.js");
const { describePendingDevelopBuild, describePendingAlphaBuild, handleChangelog } = await import("../server/src/routes/maintenance.js");

test("simplifyEntries classifies and deduplicates features and fixes", () => {
  const entries = [
    {
      message: "feat: Feature - add real-time websocket and SSE notifications",
      details: [
        "feat: add event listeners on client",
        "fix: Fix - resolve connection drop on page unload",
        "fix: resolve connection drop on page unload", // duplicate
        "internal cleanup of unused imports",
      ],
    },
    {
      message: "fix: prevent memory leak on timer loop",
      details: [
        "fix: clear interval on socket termination",
        "✨ Feature: configurable reconnect cadence",
      ],
    },
  ];

  const simplified = simplifyEntries(entries);

  assert.ok(simplified.some((line) => line === "Feature: Add real-time websocket and SSE notifications"));
  assert.ok(simplified.some((line) => line === "Feature: Configurable reconnect cadence"));
  assert.ok(simplified.some((line) => line === "Fix: Resolve connection drop on page unload"));
  assert.ok(simplified.some((line) => line === "Fix: Prevent memory leak on timer loop"));
  assert.ok(simplified.some((line) => line === "Fix: Clear interval on socket termination"));
  assert.ok(simplified.some((line) => line === "Tweak: Internal cleanup of unused imports"));

  // Verify duplicates and duplicate prefix labels are removed and no icons are present
  assert.ok(!simplified.some((line) => /Feature:\s*(Feature|Feat)\b/i.test(line)), "No duplicate Feature: Feature prefixes");
  assert.ok(!simplified.some((line) => /Fix:\s*Fix\b/i.test(line)), "No duplicate Fix: Fix prefixes");
  const connectionDropFixes = simplified.filter((line) => line.includes("Resolve connection drop on page unload"));
  assert.equal(connectionDropFixes.length, 1);
  assert.ok(!simplified.some((line) => /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu.test(line)), "No icons/emojis should be present in changelog");
});

test("categorizeEntries preserves features, major fixes, and tweaks as separate sections", () => {
  const sections = categorizeEntries([
    { message: "feat: add guided onboarding", details: ["Add a resumable setup wizard"] },
    { message: "fix: prevent stale refreshes", details: ["Keep the current grid position"] },
    { message: "docs: update setup guide", details: ["Explain the new wizard"] },
  ]);

  assert.deepEqual(sections, {
    newFeatures: ["Add guided onboarding", "Add a resumable setup wizard"],
    majorBugFixes: ["Prevent stale refreshes", "Keep the current grid position"],
    tweaks: ["Update setup guide", "Explain the new wizard"],
  });
});

test("categorizeEntries drops changelog-process entries and bullets during promotion", () => {
  const sections = categorizeEntries([
    {
      message: "fix: TV show detail and grid bulk-watch fixes",
      details: [
        "Restore the missing three-dot overflow menu on TV Shows grid cards",
        "Trimmed the alpha build 1 changelog entry down to the actual TV show detail and grid bulk-watch fixes, dropping unrelated changelog-process bullets that had been folded in",
      ],
    },
    {
      message: "docs: consolidate v0.12.11 changelog entry into higher-level bullets",
      details: ["Consolidate changelog entries at every promotion stage"],
    },
    {
      message: "chore: reset develop build counter after promotion to alpha",
      details: ["Reset develop build counter after promotion to alpha"],
    },
  ]);

  assert.deepEqual(sections, {
    newFeatures: [],
    majorBugFixes: ["TV show detail and grid bulk-watch fixes", "Restore the missing three-dot overflow menu on TV Shows grid cards"],
    tweaks: [],
  });
  assert.deepEqual(simplifyEntries([
    {
      message: "fix: TV show detail and grid bulk-watch fixes",
      details: [
        "Restore the missing three-dot overflow menu on TV Shows grid cards",
        "Trimmed the alpha build 1 changelog entry down to the actual TV show detail and grid bulk-watch fixes, dropping unrelated changelog-process bullets that had been folded in",
      ],
    },
    { message: "docs: consolidate v0.12.11 changelog entry into higher-level bullets" },
    { message: "chore: reset develop build counter after promotion to alpha" },
  ]), [
    "Fix: TV show detail and grid bulk-watch fixes",
    "Fix: Restore the missing three-dot overflow menu on TV Shows grid cards",
  ]);
});

test("bumpPatchVersion increments only the patch (3rd segment)", () => {
  assert.equal(bumpPatchVersion("0.8.6"), "0.8.7");
  assert.equal(bumpPatchVersion("0.8.6.0.0"), "0.8.7");
  assert.equal(bumpPatchVersion("1.2.9"), "1.2.10");
});

test("buildDevelopEntry consolidates every real commit since the reset anchor into one entry", () => {
  const commits = [
    { id: "c1", message: "feat: add filters\n\n- Filter by watch status" },
    { id: "c2", message: "chore: bump develop build for c1" }, // noise - excluded
    { id: "c3", message: "test: cover the new filter" }, // non-release-type - excluded
    { id: "c4", message: "fix: resolve crash on empty list\n\n- No longer crashes with zero results" },
  ];

  const entry = buildDevelopEntry({
    commits,
    headCommit: "c4",
    date: "2026-01-01T00:00:00.000Z",
    author: "Someone",
    nextBuild: 3,
  });

  assert.equal(entry.build, 3);
  assert.equal(entry.commit, "c4");
  // Headline comes from the most recent (last, since commits are oldest..newest) real commit
  assert.equal(entry.message, "Fix - Resolve crash on empty list");
  assert.deepEqual(entry.details, ["Filter by watch status", "No longer crashes with zero results"]);
});

test("buildDevelopEntry returns null when nothing in range is user-facing", () => {
  const commits = [
    { id: "c1", message: "chore: bump alpha build for abc123" },
    { id: "c2", message: "Merge branch 'main' into develop" },
    { id: "c3", message: "test: fix flaky assertion" },
  ];

  const entry = buildDevelopEntry({ commits, headCommit: "c3", date: "2026-01-01T00:00:00.000Z", author: "Someone", nextBuild: 1 });
  assert.equal(entry, null);
});

test("buildDevelopEntry rejects a release-type commit with no bullet body", () => {
  const commits = [{ id: "c1", message: "fix: keep controls visible" }];
  assert.throws(
    () => buildDevelopEntry({ commits, headCommit: "c1", date: "2026-01-01T00:00:00.000Z", author: "Someone", nextBuild: 1 }),
    /Refusing to rebuild/,
  );
});

test("validateDevelopChangelog accepts a committed entry that covers the release commits", () => {
  const commits = [
    { id: "product", message: "fix: keep watch dates in episode order\n\n- Space bulk watch dates by runtime" },
    { id: "changelog", message: "chore: rebuild develop changelog" },
  ];
  const changelog = {
    build: 7,
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [{
      build: 7,
      date: "2026-01-01T00:00:00.000Z",
      commit: "product",
      message: "Fix - Keep watch dates in episode order",
      details: ["Space bulk watch dates by runtime"],
    }],
  };

  assert.doesNotThrow(() => validateDevelopChangelog({ changelog, commits, headCommit: "changelog" }));
});

test("validateDevelopChangelog rejects a stale or empty committed entry", () => {
  const commits = [{ id: "product", message: "fix: keep watch dates in episode order\n\n- Space bulk watch dates by runtime" }];
  assert.throws(
    () => validateDevelopChangelog({
      changelog: { build: 7, updatedAt: "2026-01-01T00:00:00.000Z", entries: [] },
      commits,
      headCommit: "product",
    }),
    /Develop changelog is stale/,
  );
});

test("describePendingDevelopBuild identifies newer builds", () => {
  const local = { build: 2 };
  const remote = {
    build: 4,
    entries: [
      { build: 4, message: "Build 4" },
      { build: 3, message: "Build 3" },
      { build: 2, message: "Build 2" },
      { build: 1, message: "Build 1" },
    ],
  };

  const pending = describePendingDevelopBuild(local, remote);
  assert.equal(pending.newerBuildAvailable, true);
  assert.equal(pending.latestBuild, 4);
  assert.equal(pending.pendingEntries.length, 2);
  assert.deepEqual(pending.pendingEntries.map((e) => e.build), [4, 3]);
});

test("describePendingDevelopBuild never regresses just because entries were cleared after a promotion", () => {
  // develop's build counter is standalone and never reset (see
  // rebuild-develop-changelog.js) - a promotion only clears the entries list,
  // so a local build higher than or equal to remote must never report pending.
  const local = { build: 5 };
  const remote = { build: 1, entries: [{ build: 1, message: "New cycle build 1" }] };

  const pending = describePendingDevelopBuild(local, remote);
  assert.equal(pending.newerBuildAvailable, false);
  assert.deepEqual(pending.pendingEntries, []);
});

test("handleChangelog returns channel metadata properly", async () => {
  const prevChannel = process.env.BUILD_CHANNEL;

  try {
    // 1. Test develop
    process.env.BUILD_CHANNEL = "develop";
    let statusCode = 200;
    let jsonBody = null;
    const req = {
      method: "GET",
      query: {},
      get: () => "",
    };
    const res = {
      status(code) { statusCode = code; return this; },
      set() { return this; },
      send(body) { jsonBody = typeof body === "string" ? JSON.parse(body) : body; return this; },
      json(body) { return this.send(body); },
    };

    await handleChangelog(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.channel, "develop");
    if (jsonBody.developBuild) {
      assert.equal(typeof jsonBody.developBuild.build, "number");
    }

    // 2. Test release
    process.env.BUILD_CHANNEL = "release";
    await handleChangelog(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.channel, "release");

    // 3. Test latest
    process.env.BUILD_CHANNEL = "latest";
    await handleChangelog(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.channel, "release");

    // 4. Test stable
    process.env.BUILD_CHANNEL = "stable";
    await handleChangelog(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.channel, "release");
  } finally {
    process.env.BUILD_CHANNEL = prevChannel;
  }
});
