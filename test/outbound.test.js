import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeOutboundUrl,
  createUpstreamTimeoutError,
  fetchWithTimeout,
} from "../server/src/utils/outbound.js";
import { applyTuningConfig, resetTuningForTests } from "../server/src/utils/tuning.js";

test("upstream timeouts map to HTTP 504 errors", () => {
  const error = createUpstreamTimeoutError(2500);
  assert.equal(error.status, 504);
  assert.equal(error.code, "UPSTREAM_TIMEOUT");
  assert.match(error.message, /2500ms/);
});

test("outbound URLs reject unsafe schemes, credentials, and metadata endpoints", () => {
  assert.throws(() => assertSafeOutboundUrl("file:///etc/passwd"), /must use http or https/);
  assert.throws(() => assertSafeOutboundUrl("https://user:pass@example.com"), /embedded credentials/);
  assert.throws(() => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data"), /blocked metadata endpoint/);
  assert.equal(assertSafeOutboundUrl("http://192.168.1.20:32400").hostname, "192.168.1.20");
});

test("fetchWithTimeout rejects an unsafe initial URL before fetching", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(fetchWithTimeout("http://169.254.169.254/latest/meta-data"), /blocked metadata endpoint/);
  assert.equal(fetchCalls, 0);
});

test("fetchWithTimeout validates redirects and does not forward credentials across origins", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: new Headers(options.headers) });
    if (requests.length === 1) {
      return new Response(null, { status: 302, headers: { Location: "https://cdn.example.test/image.jpg" } });
    }
    return new Response("ok", { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await fetchWithTimeout("https://media.example.test/image.jpg", {
    headers: { Accept: "image/*", "X-Api-Key": "secret" },
  });
  assert.equal(await response.text(), "ok");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.get("accept"), "image/*");
  assert.equal(requests[1].headers.has("x-api-key"), false);
});

test("fetchWithTimeout falls back to the tunable default when no explicit timeout is given", async (t) => {
  t.after(() => resetTuningForTests());
  applyTuningConfig({ outboundTimeoutSec: 2 }); // clamp minimum, 2000ms

  const originalFetch = globalThis.fetch;
  // Never resolves on its own, but rejects when the internal AbortController
  // fires — matching real fetch()'s abort-signal contract.
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal.reason));
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchWithTimeout("https://media.example.test/image.jpg"),
    (error) => {
      assert.equal(error.status, 504);
      assert.match(error.message, /2000ms/);
      return true;
    },
  );
});

test("fetchWithTimeout honors an explicit timeoutMs override regardless of tuning", async (t) => {
  t.after(() => resetTuningForTests());
  applyTuningConfig({ outboundTimeoutSec: 60 });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal.reason));
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchWithTimeout("https://media.example.test/image.jpg", {}, 200),
    (error) => {
      assert.equal(error.status, 504);
      assert.match(error.message, /200ms/);
      return true;
    },
  );
});

test("fetchWithTimeout blocks redirects to metadata endpoints", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(fetchWithTimeout("https://media.example.test/image.jpg"), /blocked metadata endpoint/);
  assert.equal(fetchCalls, 1);
});
