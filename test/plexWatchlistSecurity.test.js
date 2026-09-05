import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-plex-rss-test-"));

const { fetchPlexWatchlistRss } = await import("../server/src/utils/plexWatchlistClient.js");

test("Plex RSS decoding does not double-unescape encoded entities", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "<rss><channel><item><title>&amp;quot;Encoded&amp;quot;</title><guid>tmdb://123</guid><mediaType>movie</mediaType></item></channel></rss>",
  });

  try {
    const result = await fetchPlexWatchlistRss({ rssUrl: "https://plex.example.test/watchlist.xml", token: "test-token" });
    assert.equal(result.items[0]?.remote_item?.title, "&quot;Encoded&quot;");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
