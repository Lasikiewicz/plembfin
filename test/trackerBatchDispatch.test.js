import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-tracker-batch-dispatch-");

const { db } = await import("../server/src/db.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { dispatchTraktWatchStateBatch } = await import("../server/src/utils/trackerDispatcher.js");

function resetState() {
  db.prepare("DELETE FROM tracker_item_state").run();
  db.prepare("DELETE FROM tracker_connections").run();
}

function connectTrakt() {
  trackerConnectionRepo.saveTrackerConnection({
    provider: "trakt",
    status: "connected",
    remoteUserId: "user-1",
    remoteUsername: "tester",
    clientId: "client",
    clientSecret: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    initialSyncMode: "baseline",
    baselineComplete: true,
    lastValidatedAt: Date.now(),
  });
}

function episode(number) {
  return {
    isValid: true,
    source: "manual",
    type: "episode",
    mediaType: "episode",
    title: `Long Show - S02E${String(number).padStart(2, "0")}`,
    showTitle: "Long Show",
    season: 2,
    episode: number,
    ids: { tmdb: "long-show" },
    watched_at: `2026-08-${String(10 + number).padStart(2, "0")}T12:00:00.000Z`,
  };
}

test("bulk manual Trakt dispatch groups episodes and retries a rate-limited write", async () => {
  resetState();
  connectTrakt();

  const originalFetch = globalThis.fetch;
  const requests = [];
  let removeAttempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ href, body });
    if (href === "https://api.trakt.tv/sync/history/remove") {
      removeAttempts += 1;
      if (removeAttempts === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0.01" },
        });
      }
      return new Response(JSON.stringify({ deleted: { episodes: 3 }, not_found: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.trakt.tv/sync/history") {
      return new Response(JSON.stringify({ added: { episodes: 3 }, not_found: {} }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected Trakt request: ${href}`);
  };

  try {
    const result = await dispatchTraktWatchStateBatch([episode(1), episode(2), episode(3)], "watched", {
      canonicalReplay: true,
      batchSize: 100,
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.results.map((entry) => entry.status), ["success", "success", "success"]);
    assert.equal(requests.filter(({ href }) => href.endsWith("/sync/history/remove")).length, 2, "the first remove should be retried");
    assert.equal(requests.filter(({ href }) => href.endsWith("/sync/history") && !href.endsWith("/remove")).length, 1, "all episodes should share one add request");
    const add = requests.find(({ href }) => href === "https://api.trakt.tv/sync/history");
    assert.deepEqual(add.body.shows[0].seasons[0].episodes.map((item) => item.number), [1, 2, 3]);
    assert.deepEqual(add.body.shows[0].seasons[0].episodes.map((item) => item.watched_at), [
      "2026-08-11T12:00:00.000Z",
      "2026-08-12T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
