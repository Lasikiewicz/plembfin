import test from "node:test";
import assert from "node:assert/strict";

const { traktSyncCompletionMessage } = await import("../public/modules/tracker-settings.js");

test("Trakt Sync Now completion copy reports checked items and applied changes", () => {
  assert.equal(
    traktSyncCompletionMessage({ remoteItems: 842, watched: 2, unwatched: 1 }),
    "Trakt sync complete: 842 items checked; 2 watched and 1 unwatched changes applied.",
  );
  assert.equal(
    traktSyncCompletionMessage({ remoteItems: 1, watched: 1, unwatched: 0 }),
    "Trakt sync complete: 1 item checked; 1 watched and 0 unwatched change applied.",
  );
  assert.equal(
    traktSyncCompletionMessage({ remoteItems: 8, watched: 0, unwatched: 0, deferredWatched: 1, deferredUnwatched: 2 }),
    "Trakt sync complete: 8 items checked; 0 watched and 0 unwatched changes applied. 3 changes held for re-check.",
  );
});
