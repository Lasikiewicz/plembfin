import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { paginationItems, compareSyncActivityGroups } = await import("../public/modules/sync-activity.js");

test("sync activity pagination shows a compact window around the current page", () => {
  assert.deepEqual(paginationItems(1, 3), [1, 2, 3]);
  assert.deepEqual(paginationItems(1, 10), [1, 2, 3, 4, "ellipsis", 10]);
  assert.deepEqual(paginationItems(5, 10), [1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
  assert.deepEqual(paginationItems(10, 10), [1, "ellipsis", 7, 8, 9, 10]);
});

test("sync activity groups sort newest-first with an id tie-breaker", () => {
  const groups = [
    { groupKey: "older", timestamp: 100, latest: { id: "4", timestamp: 100 } },
    { groupKey: "newest", timestamp: 200, latest: { id: "2", timestamp: 200 } },
    { groupKey: "same-time-later-write", timestamp: 100, latest: { id: "9", timestamp: 100 } },
  ];

  groups.sort(compareSyncActivityGroups);

  assert.deepEqual(groups.map((group) => group.groupKey), ["newest", "same-time-later-write", "older"]);
});

test("sync activity groups use the newest nested event when the envelope is stale", () => {
  const groups = [
    { groupKey: "stale-envelope", timestamp: 100, latest: { id: "5", timestamp: 300 } },
    { groupKey: "newer-envelope", timestamp: 200, latest: { id: "8", timestamp: 200 } },
  ];

  groups.sort(compareSyncActivityGroups);

  assert.deepEqual(groups.map((group) => group.groupKey), ["stale-envelope", "newer-envelope"]);
});
