import test from "node:test";
import assert from "node:assert/strict";

import { getTraksUpstreamUrl, resolveTraksCollectorOrigin } from "../server/src/utils/traksProxy.js";

test("resolveTraksCollectorOrigin normalizes the collector origin", () => {
  assert.equal(
    resolveTraksCollectorOrigin({ collectorOrigin: "https://analytics.example.workers.dev/" }),
    "https://analytics.example.workers.dev",
  );
  assert.equal(
    resolveTraksCollectorOrigin({ legacyScriptUrl: "https://analytics.example.workers.dev/t.js" }),
    "https://analytics.example.workers.dev",
  );
});

test("resolveTraksCollectorOrigin rejects unsafe collector configuration", () => {
  assert.throws(
    () => resolveTraksCollectorOrigin({ collectorOrigin: "http://analytics.example.workers.dev" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => resolveTraksCollectorOrigin({ collectorOrigin: "https://user:secret@analytics.example.workers.dev" }),
    /embedded credentials/,
  );
});

test("getTraksUpstreamUrl maps first-party routes to the collector endpoints", () => {
  assert.equal(
    getTraksUpstreamUrl("/t", "https://analytics.example.workers.dev", "?v=1").href,
    "https://analytics.example.workers.dev/t.js?v=1",
  );
  assert.equal(
    getTraksUpstreamUrl("/api/event", "https://analytics.example.workers.dev", "").href,
    "https://analytics.example.workers.dev/api/event",
  );
  assert.equal(getTraksUpstreamUrl("/t", "", ""), null);
});
