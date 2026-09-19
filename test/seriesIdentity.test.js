import test from "node:test";
import assert from "node:assert/strict";

const { resetSeriesIdentityCache, resolveSeriesIds, withSeriesIdentity } = await import("../server/src/utils/seriesIdentity.js");

test("series identity lookup tolerates an unavailable provider and preserves the episode payload", async () => {
  resetSeriesIdentityCache();

  const media = {
    title: "Ted Lasso - S04E03",
    type: "episode",
    source: "emby",
    ids: { tvdb: "11767183" },
    season: 4,
    episode: 3,
    seriesItemId: "10678",
  };
  const config = { emby: { baseUrl: "", userId: "", apiKey: "" } };

  assert.equal(await resolveSeriesIds("emby", "10678", config.emby), null);
  assert.deepEqual(await withSeriesIdentity(media, config), media);
});
