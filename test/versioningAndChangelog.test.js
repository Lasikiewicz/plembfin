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
      message: "feat: add real-time websocket and SSE notifications",
      details: [
        "feat: add event listeners on client",
        "fix: resolve connection drop on page unload",
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

  assert.ok(simplified.some((line) => line.includes("Feature:") && line.includes("add real-time websocket and SSE notifications")));
  assert.ok(simplified.some((line) => line.includes("Feature:") && line.includes("configurable reconnect cadence")));
  assert.ok(simplified.some((line) => line.includes("Fix:") && line.includes("resolve connection drop on page unload")));
  assert.ok(simplified.some((line) => line.includes("Fix:") && line.includes("prevent memory leak on timer loop")));
  assert.ok(simplified.some((line) => line.includes("Fix:") && line.includes("clear interval on socket termination")));

  // Verify duplicates are removed
  const connectionDropFixes = simplified.filter((line) => line.includes("resolve connection drop on page unload"));
  assert.equal(connectionDropFixes.length, 1);
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

test("handleChangelog returns develop metadata when BUILD_CHANNEL=develop", async () => {
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
    assert.equal(jsonBody.channel, "develop");
    assert.ok(jsonBody.developBuild !== null, "developBuild should be populated");
    assert.ok(jsonBody.developBuild.version.startsWith("0.8.6.7"), `Version should be 0.8.6.7.x, got ${jsonBody.developBuild.version}`);
  } finally {
    process.env.BUILD_CHANNEL = prevChannel;
  }
});
