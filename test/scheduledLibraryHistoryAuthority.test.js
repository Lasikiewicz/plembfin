import test from "node:test";
import assert from "node:assert/strict";

import { shouldSkipLibraryHistoryImport } from "../server/src/scheduled.js";

test("a provider library snapshot cannot recreate a date removed from an already-watched item", () => {
  assert.equal(shouldSkipLibraryHistoryImport(null, { state: "watched" }), true);
});

test("library history can still add genuinely unknown watched items", () => {
  assert.equal(shouldSkipLibraryHistoryImport(null, null), false);
  assert.equal(shouldSkipLibraryHistoryImport(null, { state: "unwatched" }), false);
});

test("an existing matching watch remains an ordinary no-op", () => {
  assert.equal(shouldSkipLibraryHistoryImport({ id: "existing-watch" }, { state: "watched" }), false);
});
