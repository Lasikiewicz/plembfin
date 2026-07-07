import test from "node:test";
import assert from "node:assert/strict";

process.env.PLEX_URL = "http://plex.example";
process.env.PLEX_TOKEN = "test-token";
process.env.API_KEY = "test-api-key";

const { episodeRecord } = await import(`../scripts/exportPlexHistory.js?test=${Date.now()}`);

test("episodeRecord preserves Plex specials season zero", () => {
  const record = episodeRecord({
    type: "episode",
    grandparentTitle: "Letterkenny",
    title: "Episode 1",
    parentIndex: 0,
    index: 1,
    viewedAt: 1783379340,
    Guid: [{ id: "tvdb://12345" }],
  });

  assert.equal(record.title, "Letterkenny - S00E01");
  assert.equal(record.season, 0);
  assert.equal(record.episode, 1);
});
