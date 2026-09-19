import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-title-key-memo-");
const { canonicalTitleKey, canonicalShowTitleKey, showTitleFrom } = await import("../server/src/utils/dataRepo.js");

// canonicalTitleKey and showTitleFrom are memoized because show lookups call
// them for every row. The cache must never change an answer.
test("memoized title normalisation returns the same result on every call", () => {
  const titles = [
    "Reacher (2022) - S03E03 - Number 2 with a Bullet",
    "Ludwig &amp; Co - Season 2",
    "  The   Office (US)  ",
    "Unknown",
    "",
  ];
  for (const title of titles) {
    const firstKey = canonicalTitleKey(title);
    const firstShow = showTitleFrom(title);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(canonicalTitleKey(title), firstKey);
      assert.equal(showTitleFrom(title), firstShow);
    }
  }
  assert.equal(showTitleFrom("Reacher (2022) - S03E03 - Number 2 with a Bullet"), "Reacher");
  assert.equal(canonicalTitleKey("Ludwig &amp; Co"), "ludwig-co");
  assert.equal(canonicalShowTitleKey("Reacher (2022)"), canonicalShowTitleKey("Reacher"));
});

test("non-string titles are normalised without being cached under a string key", () => {
  assert.equal(canonicalTitleKey(null), canonicalTitleKey(""));
  assert.equal(showTitleFrom(undefined), "Unknown Show");
  assert.equal(canonicalTitleKey(2024), "2024");
  assert.equal(canonicalTitleKey("2024"), "2024");
});
