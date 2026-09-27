import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "./domStubs.js";

// images.js imports state.js with a version query; import the same specifier
// so the test sets the token on the module instance images.js actually reads.
const imagesSource = fs.readFileSync(new URL("../public/modules/images.js", import.meta.url), "utf8");
const stateSpecifier = imagesSource.match(/from "\.\/(state\.js[^"]*)"/)[1];
const { state } = await import(`../public/modules/${stateSpecifier}`);
const { batchedFallbackPosterUrl, cachedPosterLookup } = await import("../public/modules/images.js");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input), "http://localhost:5055");
    const request = { path: url.pathname, query: Object.fromEntries(url.searchParams), body: options.body ? JSON.parse(options.body) : null };
    requests.push(request);
    return handler(request);
  };
  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("failed grid images collected together are resolved by one fallback batch", async () => {
  state.token = "token";
  await withFetch((request) => {
    if (request.path === "/api/poster-batch") {
      return json({ results: request.body.items.map(({ id }) => ({ id, payload: { url: id === "b2" ? null : `/media/posters/${id}.webp` } })) });
    }
    return json({}, 500);
  }, async (requests) => {
    const urls = await Promise.all(["b1", "b2", "b3", "b1"].map((id) => batchedFallbackPosterUrl(id)));
    assert.deepEqual(urls, ["/media/posters/b1.webp", "", "/media/posters/b3.webp", "/media/posters/b1.webp"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/api/poster-batch");
    assert.deepEqual(requests[0].body.items, [{ id: "b1", fallback: true }, { id: "b2", fallback: true }, { id: "b3", fallback: true }]);
    assert.equal(cachedPosterLookup("b1"), "/media/posters/b1.webp");
    assert.equal(cachedPosterLookup("b2"), "", "a batch miss is remembered like a single fallback miss");
  });
});

test("a failed fallback batch falls back to one single lookup per poster", async () => {
  state.token = "token";
  await withFetch((request) => {
    if (request.path === "/api/poster-batch") return json({ error: "boom" }, 500);
    return json({ url: `/media/posters/${request.query.id}.webp` });
  }, async (requests) => {
    const urls = await Promise.all(["c1", "c2"].map((id) => batchedFallbackPosterUrl(id)));
    assert.deepEqual(urls, ["/media/posters/c1.webp", "/media/posters/c2.webp"]);
    const singles = requests.filter((request) => request.path === "/api/poster");
    assert.deepEqual(singles.map((request) => [request.query.id, request.query.fallback]), [["c1", "1"], ["c2", "1"]]);
  });
});

test("a lone failed image skips the batch and uses the single fallback lookup", async () => {
  state.token = "token";
  await withFetch((request) => json({ url: `/media/posters/${request.query.id}.webp` }), async (requests) => {
    assert.equal(await batchedFallbackPosterUrl("d1"), "/media/posters/d1.webp");
    assert.deepEqual(requests.map((request) => request.path), ["/api/poster"]);
  });
});

test("cache-only surfaces never queue a network fallback", async () => {
  state.token = "token";
  await withFetch(() => json({}, 500), async (requests) => {
    assert.equal(await batchedFallbackPosterUrl("e1", { allowNetwork: false }), "");
    assert.equal(requests.length, 0);
  });
});
