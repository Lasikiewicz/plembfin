import test from "node:test";
import assert from "node:assert/strict";
import { groupTraktProviderOverrideRows, reconcileTraktProviderOverrides, seasonContainsEpisodes } from "../server/src/utils/traktProviderReconciliation.js";

function overrideRow(id, episode, { season = 7, tvdb = "314087", tmdb = "329471" } = {}) {
  return {
    id,
    media_type: "episode",
    tvdb_id: tvdb,
    season,
    episode,
    provider_overrides: { trakt: { tmdb_id: tmdb, season: 1, episode } },
  };
}

test("Trakt provider reconciliation clears an override only after identity and local season agree", async () => {
  const rows = [overrideRow("one", 1), overrideRow("two", 2)];
  const cleared = [];
  const result = await reconcileTraktProviderOverrides({
    connection: { status: "connected" },
    rows,
    lookupShow: async (_connection, provider, id) => {
      assert.equal(provider, "tvdb");
      assert.equal(id, "314087");
      return { ids: { trakt: "trakt-show", tvdb: "314087", tmdb: "329471" } };
    },
    lookupSeason: async (_connection, showId, season) => {
      assert.equal(showId, "trakt-show");
      assert.equal(season, 7);
      return [{ number: 1 }, { number: 2 }];
    },
    clearOverrides: async (groupRows) => {
      cleared.push(groupRows.map((row) => row.id));
      return { updatedRows: groupRows.length };
    },
  });

  assert.equal(result.checked, 1);
  assert.equal(result.changed, 2);
  assert.deepEqual(cleared, [["one", "two"]]);
});

test("Trakt provider reconciliation leaves a split mapping when the canonical season is absent", async () => {
  const rows = [overrideRow("one", 1)];
  let cleared = false;
  const result = await reconcileTraktProviderOverrides({
    connection: { status: "connected" },
    rows,
    lookupShow: async (_connection, provider) => provider === "tvdb"
      ? { ids: { trakt: "old-show", tvdb: "314087", tmdb: "314087" } }
      : { ids: { trakt: "split-show", tvdb: "314087", tmdb: "329471" } },
    lookupSeason: async () => [],
    clearOverrides: async () => { cleared = true; return { updatedRows: 1 }; },
  });

  assert.equal(result.checked, 1);
  assert.equal(result.changed, 0);
  assert.equal(cleared, false);
});

test("seasonContainsEpisodes requires every locally overridden episode", () => {
  assert.equal(seasonContainsEpisodes([{ number: 1 }, { number: 2 }], new Set([1, 2])), true);
  assert.equal(seasonContainsEpisodes([{ number: 1 }], new Set([1, 2])), false);
});

test("rows without a canonical TVDB identity are never considered for reconciliation", async () => {
  const result = await reconcileTraktProviderOverrides({
    connection: { status: "connected" },
    rows: [{ ...overrideRow("title-only", 1), tvdb_id: null }],
  });
  assert.equal(result.checked, 0);
  assert.equal(result.changed, 0);
});
