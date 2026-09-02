import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-tvdb-match-test-"));
process.env.DATA_DIR = dataDir;

const { selectTvdbSeriesMatch, tvdbSeriesTitleMatches } = await import("../server/src/utils/tvdbGateway.js");

test("TVDB title matching ignores ranked distractors but requires an exact unique series", () => {
  const result = selectTvdbSeriesMatch([
    { id: "900", name: "The Office: Extras", year: "2007" },
    { id: "123", name: "The Office", year: "2005" },
  ], "The Office");

  assert.deepEqual(result, { tvdb_id: "123", name: "The Office", year: "2005" });
  assert.equal(selectTvdbSeriesMatch([
    { id: "123", name: "The Office", year: "2005" },
    { id: "456", name: "The Office", year: "2020" },
  ], "The Office"), null);
  assert.equal(selectTvdbSeriesMatch([
    { id: "123", name: "The Office: Extras", year: "2005" },
  ], "The Office"), null);
});

test("TVDB title matching can disambiguate a year-qualified title", () => {
  const result = selectTvdbSeriesMatch([
    { id: "123", name: "The Office", year: "2005" },
    { id: "456", name: "The Office", year: "2020" },
  ], "The Office (2020)");

  assert.equal(result?.tvdb_id, "456");
});

test("TVDB series verification accepts the canonical name and aliases only", () => {
  const details = {
    name: "The Office",
    aliases: [{ name: "The Office (US)" }],
  };

  assert.equal(tvdbSeriesTitleMatches("The Office", details), true);
  assert.equal(tvdbSeriesTitleMatches("The Office (US)", details), true);
  assert.equal(tvdbSeriesTitleMatches("The Office (UK)", details), false);
});
