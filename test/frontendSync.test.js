import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { telemetryTargetStates, targetStateUnavailable, categorizeIssues } = await import("../public/modules/sync.js");

// These strings intentionally mirror syncMatchReport.test.js so frontend and
// backend parsing stay locked to the same scheduler/webhook telemetry formats.
const FIXTURES = {
  successAll: ["Origin: plex", "Dispatch status: success", "Target emby status: success", "Target jellyfin status: success"].join("\n"),
  embyNotFound: ["Origin: plex", "Dispatch status: partial", "Target emby status: skipped - No matching item found", "Target jellyfin status: success"].join("\n"),
  webhookFormatJellyfinNotFound: ["Origin: emby", "Dispatch status: partial", "Plex status: success", "Jellyfin status: skipped - No matching item found"].join("\n"),
  allNotFound: ["Origin: jellyfin", "Dispatch status: skipped", "Target plex status: skipped - No matching item found", "Target emby status: skipped - No matching item found"].join("\n"),
  progressNotFound: ["Origin: plex", "Dispatch status: partial", "Target emby progress status: skipped - No matching item found", "Target jellyfin progress status: success"].join("\n"),
  forceSyncResolved: ["Origin: plex", "Dispatch status: partial", "Target emby status: skipped - No matching item found", "Force Sync resolved status to success"].join("\n"),
  legacyPlaceholder: ["Origin: plex_initial_sync", "Loop-check: Pending", "Dispatch status: pending", "Details: Awaiting outbound sync telemetry"].join("\n"),
};

test("telemetryTargetStates parses scheduler, webhook, and progress target lines", () => {
  assert.deepEqual(telemetryTargetStates(FIXTURES.progressNotFound), [
    { target: "emby", status: "skipped", rawStatus: "skipped", detail: "No matching item found" },
    { target: "jellyfin", status: "success", rawStatus: "success", detail: "" },
  ]);
  assert.deepEqual(telemetryTargetStates(FIXTURES.webhookFormatJellyfinNotFound).map((state) => state.target), ["plex", "jellyfin"]);
  assert.equal(telemetryTargetStates(FIXTURES.legacyPlaceholder).length, 0);
});

test("targetStateUnavailable recognizes every not-found spelling used by telemetry", () => {
  assert.equal(targetStateUnavailable({ detail: "No matching item found" }), true);
  assert.equal(targetStateUnavailable({ rawStatus: "not_found" }), true);
  assert.equal(targetStateUnavailable({ status: "unavailable" }), true);
  assert.equal(targetStateUnavailable({ status: "success" }), false);
});

test("categorizeIssues preserves the existing Sync Issues buckets", () => {
  const jobs = [
    { id: "empty", sync_dispatch_telemetry: "" },
    { id: "plex", sync_dispatch_telemetry: FIXTURES.embyNotFound },
    { id: "none", sync_dispatch_telemetry: "Origin: emby\nSynced to no targets" },
    { id: "other", sync_dispatch_telemetry: FIXTURES.successAll },
  ];
  const categories = categorizeIssues(jobs);
  assert.deepEqual(categories.missingTelemetry.map((job) => job.id), ["empty"]);
  assert.deepEqual(categories.plexMismatch.map((job) => job.id), ["plex"]);
  assert.deepEqual(categories.targetMismatch.map((job) => job.id), ["none"]);
  assert.deepEqual(categories.otherIssues.map((job) => job.id), ["other"]);
});
