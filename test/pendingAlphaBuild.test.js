import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-pending-alpha-build-");

const { describePendingAlphaBuild } = await import("../server/src/routes/maintenance.js");

test("no newer build reports nothing pending", () => {
  const local = { baseVersion: "0.8.3", build: 2 };
  const remote = { baseVersion: "0.8.3", build: 2, entries: [{ build: 1 }, { build: 2 }] };
  const result = describePendingAlphaBuild(local, remote);
  assert.equal(result.newerBuildAvailable, false);
  assert.deepEqual(result.pendingEntries, []);
  assert.equal(result.latestBuild, 2);
});

test("a newer build on the same base only surfaces entries past the local build", () => {
  const local = { baseVersion: "0.8.3", build: 1 };
  const remote = {
    baseVersion: "0.8.3",
    build: 3,
    entries: [{ build: 1, message: "already installed" }, { build: 2, message: "new" }, { build: 3, message: "newer" }],
  };
  const result = describePendingAlphaBuild(local, remote);
  assert.equal(result.newerBuildAvailable, true);
  assert.equal(result.latestBuild, 3);
  assert.deepEqual(result.pendingEntries.map((entry) => entry.build), [2, 3]);
});

test("a changed baseVersion (alpha reset by a merge) treats every remote entry as pending", () => {
  const local = { baseVersion: "0.8.3", build: 5 };
  const remote = {
    baseVersion: "0.8.4",
    build: 1,
    entries: [{ build: 1, message: "first build on the new base" }],
  };
  const result = describePendingAlphaBuild(local, remote);
  assert.equal(result.newerBuildAvailable, true);
  assert.deepEqual(result.pendingEntries.map((entry) => entry.build), [1]);
});

test("missing or malformed remote data degrades to no update rather than throwing", () => {
  const local = { baseVersion: "0.8.3", build: 1 };
  assert.deepEqual(describePendingAlphaBuild(local, null), { latestBuild: 0, newerBuildAvailable: false, pendingEntries: [] });
  assert.deepEqual(describePendingAlphaBuild(local, {}), { latestBuild: 0, newerBuildAvailable: false, pendingEntries: [] });
});
