import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const {
  hasRetryableActivityTarget,
  isFailedSyncActivityEntry,
  isRetryableActivity,
  isTraktNotFoundMatchIssue,
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
