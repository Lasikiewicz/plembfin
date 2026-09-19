import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const {
  hasRetryableActivityTarget,
  isFailedSyncActivityEntry,
  isRetryableActivity,
  isTraktNotFoundMatchIssue,
  syncActivityIssueMarkup,
  targetResults,
} = await import("../public/modules/sync-activity.js");

test("library no-match skips are not failures or retryable activity", () => {
  const entry = {
    status: "partial",
    targetStates: [
      { target: "plex", status: "skipped", detail: "No matching item found" },
      { target: "emby", status: "not_found", detail: "No matching item found" },
    ],
  };

  assert.equal(hasRetryableActivityTarget(entry), false);
  assert.equal(isFailedSyncActivityEntry(entry), false);
  assert.equal(isRetryableActivity(entry), false);
  assert.match(targetResults(entry, { failedOnly: true }), /No failed target response/);
});

test("a real Trakt failure remains visible when another target has no match", () => {
  const entry = {
    status: "partial",
    targetStates: [
      { target: "plex", status: "skipped", detail: "No matching item found" },
      { target: "trakt", status: "error", detail: "HTTP 503" },
    ],
  };

  assert.equal(hasRetryableActivityTarget(entry), true);
  assert.equal(isFailedSyncActivityEntry(entry), true);
  assert.equal(isRetryableActivity(entry), true);
  const failedMarkup = targetResults(entry, { failedOnly: true });
  assert.match(failedMarkup, /Trakt/);
  assert.doesNotMatch(failedMarkup, /Plex/);
});

test("Trakt not_found episode failures offer a show-match repair", () => {
  const entry = {
    mediaType: "episode",
    isLatestForItem: true,
    targetStates: [
      { target: "plex", status: "success" },
      { target: "trakt", status: "error", detail: "Trakt could not match this item (not_found)" },
    ],
  };

  assert.equal(isTraktNotFoundMatchIssue(entry), true);
  assert.equal(isTraktNotFoundMatchIssue({ ...entry, isLatestForItem: false }), false);
  assert.equal(isTraktNotFoundMatchIssue({ ...entry, mediaType: "movie" }), false);
  assert.equal(isTraktNotFoundMatchIssue({
    ...entry,
    targetStates: [{ target: "trakt", status: "error", detail: "HTTP 503" }],
  }), false);
});

test("current issue markup shows every destination response and targeted Trakt actions", () => {
  const markup = syncActivityIssueMarkup({
    id: "activity-1",
    mediaType: "episode",
    title: "Black Sails - S04E02",
    status: "partial",
    action: "unwatched",
    timestamp: Date.parse("2026-09-17T18:30:00.000Z"),
    isLatestForItem: true,
    rawPayloadDebug: { ids: { tvdb: "5944779" }, season: 4, episode: 2 },
    targetStates: [
      { target: "plex", status: "success", detail: "200 OK" },
      { target: "emby", status: "success", detail: "200 OK" },
      { target: "jellyfin", status: "success", detail: "200 OK" },
      { target: "trakt", status: "error", detail: 'Trakt could not match this item to mark it unwatched (not_found: {"shows":[]})' },
    ],
  }, "show:black-sails");

  assert.match(markup, /Marked Unwatched Failed/);
  assert.match(markup, /Black Sails - S04E02/);
  assert.match(markup, /Plex:<\/span><\/span><span class="sync-activity-target-status">success/);
  assert.match(markup, /Emby:<\/span><\/span><span class="sync-activity-target-status">success/);
  assert.match(markup, /Jellyfin:<\/span><\/span><span class="sync-activity-target-status">success/);
  assert.match(markup, /Trakt:<\/span><\/span><span class="sync-activity-target-status">error/);
  assert.match(markup, /Trakt could not match this item to mark it unwatched/);
  assert.match(markup, /Fix show match/);
  assert.match(markup, /Dismiss Trakt error/);
  assert.doesNotMatch(markup, /data-sync-activity-retry/);
});
