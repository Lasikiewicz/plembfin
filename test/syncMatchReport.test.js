import test from "node:test";
import assert from "node:assert/strict";

import { buildSyncMatchReport, parseTelemetryTargetStates } from "../server/src/utils/syncMatchReport.js";

// Fixture telemetry strings mirror the two formats the app writes:
// "Target plex status: ..." (scheduler/cron) and "Plex status: ..." (webhook).
export const FIXTURES = {
  successAll: [
    "Origin: plex",
    "Dispatch status: success",
    "Target emby status: success",
    "Target jellyfin status: success",
  ].join("\n"),
  embyNotFound: [
    "Origin: plex",
    "Dispatch status: partial",
    "Target emby status: skipped - No matching item found",
    "Target jellyfin status: success",
  ].join("\n"),
  webhookFormatJellyfinNotFound: [
    "Origin: emby",
    "Dispatch status: partial",
    "Plex status: success",
    "Jellyfin status: skipped - No matching item found",
  ].join("\n"),
  allNotFound: [
    "Origin: jellyfin",
    "Dispatch status: skipped",
    "Target plex status: skipped - No matching item found",
    "Target emby status: skipped - No matching item found",
  ].join("\n"),
  progressNotFound: [
    "Origin: plex",
    "Dispatch status: partial",
    "Target emby progress status: skipped - No matching item found",
    "Target jellyfin progress status: success",
  ].join("\n"),
  forceSyncResolved: [
    "Origin: plex",
    "Dispatch status: partial",
    "Target emby status: skipped - No matching item found",
    "Force Sync resolved status to success",
  ].join("\n"),
  legacyPlaceholder: [
    "Origin: plex_initial_sync",
    "Loop-check: Pending",
    "Dispatch status: pending",
    "Details: Awaiting outbound sync telemetry",
  ].join("\n"),
};

function row(overrides = {}) {
  return {
    id: "row-1",
    title: "Signal Drift",
    media_type: "movie",
    watched_at: "2026-07-01T20:00:00.000Z",
    media_key: "movie|signal-drift",
    sync_dispatch_telemetry: FIXTURES.successAll,
    ...overrides,
  };
}

test("parseTelemetryTargetStates reads both telemetry formats and progress lines", () => {
  const states = parseTelemetryTargetStates([
    "Target plex status: success",
    "Emby status: skipped - No matching item found",
    "Target jellyfin progress status: error - HTTP 500",
  ].join("\n"));
  assert.deepEqual(states, [
    { target: "plex", status: "success", detail: "" },
    { target: "emby", status: "skipped", detail: "No matching item found" },
    { target: "jellyfin", status: "error", detail: "HTTP 500" },
  ]);
});

test("success-only telemetry produces an empty report", () => {
  const report = buildSyncMatchReport([row()]);
  assert.equal(report.scannedRows, 1);
  assert.equal(report.totalUnmatchedRows, 0);
  for (const platform of ["plex", "emby", "jellyfin"]) {
    assert.equal(report.platforms[platform].rowCount, 0);
    assert.equal(report.platforms[platform].uniqueMediaCount, 0);
  }
});

test("single-platform not-found is attributed to that platform only", () => {
  const report = buildSyncMatchReport([row({ sync_dispatch_telemetry: FIXTURES.embyNotFound })]);
  assert.equal(report.totalUnmatchedRows, 1);
  assert.equal(report.platforms.emby.rowCount, 1);
  assert.equal(report.platforms.emby.uniqueMediaCount, 1);
  assert.equal(report.platforms.emby.movies, 1);
  assert.equal(report.platforms.emby.episodes, 0);
  assert.equal(report.platforms.emby.samples[0].title, "Signal Drift");
  assert.equal(report.platforms.emby.samples[0].detail, "No matching item found");
  assert.equal(report.platforms.plex.rowCount, 0);
  assert.equal(report.platforms.jellyfin.rowCount, 0);
});

test("webhook-format target lines are counted", () => {
  const report = buildSyncMatchReport([row({ sync_dispatch_telemetry: FIXTURES.webhookFormatJellyfinNotFound })]);
  assert.equal(report.platforms.jellyfin.rowCount, 1);
  assert.equal(report.platforms.plex.rowCount, 0);
});

test("all-not-found rows count on every reporting platform", () => {
  const report = buildSyncMatchReport([row({ sync_dispatch_telemetry: FIXTURES.allNotFound })]);
  assert.equal(report.platforms.plex.rowCount, 1);
  assert.equal(report.platforms.emby.rowCount, 1);
  assert.equal(report.platforms.jellyfin.rowCount, 0);
  assert.equal(report.totalUnmatchedRows, 2);
});

test("progress status lines are counted", () => {
  const report = buildSyncMatchReport([row({ sync_dispatch_telemetry: FIXTURES.progressNotFound })]);
  assert.equal(report.platforms.emby.rowCount, 1);
  assert.equal(report.platforms.jellyfin.rowCount, 0);
});

test("Force-Sync-resolved rows are skipped", () => {
  const report = buildSyncMatchReport([row({ sync_dispatch_telemetry: FIXTURES.forceSyncResolved })]);
  assert.equal(report.totalUnmatchedRows, 0);
  assert.equal(report.scannedRows, 1);
});

test("legacy initial-sync placeholder rows are skipped", () => {
  const report = buildSyncMatchReport([row({ sync_dispatch_telemetry: FIXTURES.legacyPlaceholder })]);
  assert.equal(report.totalUnmatchedRows, 0);
});

test("empty telemetry rows are ignored and not scanned", () => {
  const report = buildSyncMatchReport([
    row({ sync_dispatch_telemetry: "" }),
    row({ id: "row-2", sync_dispatch_telemetry: null }),
  ]);
  assert.equal(report.scannedRows, 0);
  assert.equal(report.totalUnmatchedRows, 0);
});

test("duplicate plays of one media_key dedupe into one unique item", () => {
  const report = buildSyncMatchReport([
    row({ id: "row-1", sync_dispatch_telemetry: FIXTURES.embyNotFound }),
    row({ id: "row-2", watched_at: "2026-07-02T20:00:00.000Z", sync_dispatch_telemetry: FIXTURES.embyNotFound }),
  ]);
  assert.equal(report.platforms.emby.rowCount, 2);
  assert.equal(report.platforms.emby.uniqueMediaCount, 1);
  assert.equal(report.platforms.emby.samples.length, 1);
  assert.equal(report.platforms.emby.samples[0].rowCount, 2);
});

test("episodes are split from movies in unique-media counts", () => {
  const report = buildSyncMatchReport([
    row({ sync_dispatch_telemetry: FIXTURES.embyNotFound }),
    row({
      id: "row-2",
      title: "Harbor Nine - Low Tide",
      show_title: "Harbor Nine",
      media_type: "episode",
      season: 1,
      episode: 2,
      media_key: "episode|harbor-nine|1|2",
      sync_dispatch_telemetry: FIXTURES.embyNotFound,
    }),
  ]);
  assert.equal(report.platforms.emby.uniqueMediaCount, 2);
  assert.equal(report.platforms.emby.movies, 1);
  assert.equal(report.platforms.emby.episodes, 1);
});
