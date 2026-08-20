import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-plex-adaptive-poller-");

const { createPlexAdaptivePoller } = await import("../server/src/utils/plexAdaptivePoller.js");

test("createPlexAdaptivePoller detects newly watched items and passes them to onLibraryItemChange", async () => {
  const events = [];
  let pollCount = 0;

  const mockConfig = {
    baseUrl: "http://127.0.0.1:32400",
    token: "mock-token",
    disabled: false,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/status/sessions/history/all")) {
      pollCount++;
      if (pollCount === 1) {
        // Initial tick - seeds the cursor
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                { ratingKey: "101", title: "Show S01E01", type: "episode", viewedAt: 1700000000 },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second tick - new watch event
      return new Response(
        JSON.stringify({
          MediaContainer: {
            Metadata: [
              { ratingKey: "102", title: "Show S01E02", type: "episode", viewedAt: 1700000050 },
              { ratingKey: "101", title: "Show S01E01", type: "episode", viewedAt: 1700000000 },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("/library/sections")) {
      return new Response(
        JSON.stringify({
          MediaContainer: {
            Directory: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const poller = createPlexAdaptivePoller({
      getPlexConfig: async () => mockConfig,
      onLibraryItemChange: async (ratingKey, item) => {
        events.push({ ratingKey, title: item.title });
      },
      activeIntervalMs: 20,
      idleIntervalMs: 100,
      idleThresholdMs: 500,
    });

    poller.start();

    // Wait for initial tick and subsequent tick
    await new Promise((resolve) => setTimeout(resolve, 200));
    poller.stop();

    assert.equal(events.length, 1);
    assert.equal(events[0].ratingKey, "102");
    assert.equal(events[0].title, "Show S01E02");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createPlexAdaptivePoller triggers checkUnwatched and handles unwatch callback", async () => {
  let unwatchCalls = 0;
  const mockConfig = {
    baseUrl: "http://127.0.0.1:32400",
    token: "mock-token",
    disabled: false,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ MediaContainer: { Metadata: [], Directory: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const poller = createPlexAdaptivePoller({
      getPlexConfig: async () => mockConfig,
      onLibraryItemChange: async () => {},
      checkUnwatched: async () => {
        unwatchCalls++;
        return true;
      },
      activeIntervalMs: 20,
      unwatchIntervalMs: 20,
      idleIntervalMs: 100,
      idleThresholdMs: 500,
    });

    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    poller.stop();

    assert.ok(unwatchCalls >= 1, "checkUnwatched should have been called at least once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
