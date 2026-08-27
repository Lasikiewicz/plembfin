import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { paginationItems } = await import("../public/modules/sync-activity.js");

test("sync activity pagination shows a compact window around the current page", () => {
  assert.deepEqual(paginationItems(1, 3), [1, 2, 3]);
  assert.deepEqual(paginationItems(1, 10), [1, 2, 3, 4, "ellipsis", 10]);
  assert.deepEqual(paginationItems(5, 10), [1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
  assert.deepEqual(paginationItems(10, 10), [1, "ellipsis", 7, 8, 9, 10]);
});
