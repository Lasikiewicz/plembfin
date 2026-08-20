import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import "./domStubs.js";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-versioning-");

const { simplifyEntries } = await import("../scripts/promote-develop-to-alpha.js");
const { bumpPatchVersion } = await import("../scripts/promote-alpha-to-main.js");
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

  // Verify duplicates and duplicate prefix labels are removed and no icons are present
  assert.ok(!simplified.some((line) => /Feature:\s*(Feature|Feat)\b/i.test(line)), "No duplicate Feature: Feature prefixes");
  assert.ok(!simplified.some((line) => /Fix:\s*Fix\b/i.test(line)), "No duplicate Fix: Fix prefixes");
  const connectionDropFixes = simplified.filter((line) => line.includes("Resolve connection drop on page unload"));
  assert.equal(connectionDropFixes.length, 1);
  assert.ok(!simplified.some((line) => /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu.test(line)), "No icons/emojis should be present in changelog");
});

test("bumpPatchVersion increments only the patch (3rd segment)", () => {
  assert.equal(bumpPatchVersion("0.8.6"), "0.8.7");
  assert.equal(bumpPatchVersion("0.8.6.0.0"), "0.8.7");
  assert.equal(bumpPatchVersion("1.2.9"), "1.2.10");
});

test("describePendingDevelopBuild identifies newer builds", () => {
  const local = { baseVersion: "0.8.6.7", build: 2 };
  const remote = {
    baseVersion: "0.8.6.7",
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

test("describePendingDevelopBuild treats baseVersion mismatch as full reset", () => {
  const local = { baseVersion: "0.8.6.7", build: 5 };
  const remote = {
    baseVersion: "0.8.6.8",
    build: 1,
    entries: [
      { build: 1, message: "New cycle build 1" },
    ],
  };

  const pending = describePendingDevelopBuild(local, remote);
  assert.equal(pending.newerBuildAvailable, true);
  assert.equal(pending.pendingEntries.length, 1);
});

test("handleChangelog returns channel metadata properly", async () => {
  const prevChannel = process.env.BUILD_CHANNEL;
  process.env.BUILD_CHANNEL = "develop";

  try {
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
    if (jsonBody.developBuild) {
      assert.equal(jsonBody.channel, "develop");
      assert.ok(/^\d+\.\d+\.\d+\.\d+\.\d+$/.test(jsonBody.developBuild.version), `Version should be 5-segment version, got ${jsonBody.developBuild.version}`);
    } else if (jsonBody.alphaBuild) {
      assert.equal(jsonBody.channel, "alpha");
      assert.ok(jsonBody.alphaBuild.build >= 0, "alphaBuild should have build number");
    }
  } finally {
    process.env.BUILD_CHANNEL = prevChannel;
  }
});
