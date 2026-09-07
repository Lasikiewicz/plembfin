import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-poster-route-");

const { AUTH } = await import("../server/src/appConfig.js");
const { handlePoster, handlePosterBatch } = await import("../server/src/routes/metadata.js");
const { cachePosterFromUrl } = await import("../server/src/utils/posterCache.js");
const { enqueueManualWatchReview } = await import("../server/src/utils/manualWatchReview.js");
const { getActiveUpNextProviderItemById, recordUpNextProviderFeed } = await import("../server/src/utils/upNextRepository.js");

function request(format = "") {
  return {
    method: "GET",
    query: { id: "poster-route-item", provider: "emby", ...(format ? { format } : {}) },
    cookies: {},
    get(name) {
      return String(name || "").toLowerCase() === "x-api-key" ? AUTH.apiKey : "";
    },
  };
}

function responseCapture() {
  const capture = { body: null, headers: {}, redirect: null, status: 200 };
  return {
    capture,
    status(code) {
      capture.status = code;
      return this;
    },
    set(headers) {
      Object.assign(capture.headers, headers);
      return this;
    },
    send(body) {
      capture.body = body;
      return this;
    },
    redirect(status, location) {
      capture.status = status;
      capture.redirect = location;
      return this;
    },
  };
}

test("poster image mode redirects to cached artwork while JSON mode stays compatible", async () => {
  recordUpNextProviderFeed("emby", "next_up", [{
    Id: "poster-route-item",
    Type: "Movie",
    Name: "Poster Route Test",
  }], { now: 10_000 });
  const row = getActiveUpNextProviderItemById("emby", "poster-route-item");
  assert.ok(row);

  const cached = await cachePosterFromUrl(
    row.media_key,
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "test",
  );
  assert.ok(cached?.url);

  const imageResponse = responseCapture();
  await handlePoster(request("image"), imageResponse);
  assert.equal(imageResponse.capture.status, 302);
  assert.equal(imageResponse.capture.redirect, cached.url);

  const jsonResponse = responseCapture();
  await handlePoster(request(), jsonResponse);
  assert.equal(jsonResponse.capture.status, 200);
  assert.deepEqual(JSON.parse(jsonResponse.capture.body), {
    url: cached.url,
    cached: true,
    source: "test",
  });
});

function batchRequest(items, { authorized = true } = {}) {
  return {
    method: "POST",
    query: {},
    cookies: {},
    body: { items },
    get(name) {
      if (String(name || "").toLowerCase() !== "x-api-key") return "";
      return authorized ? AUTH.apiKey : "";
    },
  };
}

function jsonCapture() {
  const capture = { body: null, headers: {}, status: 200 };
  return {
    capture,
    status(code) { capture.status = code; return this; },
    set(headers) { Object.assign(capture.headers, headers); return this; },
    send(body) { capture.body = body; return this; },
    redirect(status, location) { capture.status = status; capture.redirect = location; return this; },
  };
}

// A library page coalesces a viewport's poster lookups into one request. The
// batch must answer per input position so the client can map results back.
test("poster batch returns one result per requested id", async () => {
  const response = jsonCapture();
  await handlePosterBatch(batchRequest([{ id: "poster-route-item" }, { id: "no-such-id" }]), response);
  assert.equal(response.capture.status, 200);
  const body = JSON.parse(response.capture.body);
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].id, "poster-route-item");
  assert.ok(body.results[0].payload);
  assert.equal(body.results[1].id, "no-such-id");
});

test("poster batch resolves a pending manual review id from its media cache", async () => {
  const queued = enqueueManualWatchReview({
    title: "Manual Review Poster Show - S01E01",
    showTitle: "Manual Review Poster Show",
    type: "episode",
    source: "plex",
    season: 1,
    episode: 1,
    ids: { tvdb: "manual-review-poster-tvdb" },
  }, { sourceFingerprint: "poster-route-manual-review" });
  assert.ok(queued.review?.id);

  const cached = await cachePosterFromUrl(
    queued.review.media_key,
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "manual-review-test",
  );
  assert.ok(cached?.url);

  const response = jsonCapture();
  await handlePosterBatch(batchRequest([{ id: queued.review.id }]), response);
  const body = JSON.parse(response.capture.body);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].id, queued.review.id);
  assert.equal(body.results[0].payload.url, cached.url);
});

// Same size cap as the tmdb-details-batch convention it mirrors: an unbounded
// list would let one request fan out into arbitrarily many lookups.
test("poster batch caps the number of items it will resolve", async () => {
  const response = jsonCapture();
  const items = Array.from({ length: 300 }, (_, index) => ({ id: `bulk-${index}` }));
  await handlePosterBatch(batchRequest(items), response);
  const body = JSON.parse(response.capture.body);
  assert.equal(body.results.length, 240);
});

// The batch resolves posters, so it must not be reachable without admin auth.
test("poster batch requires admin authentication", async () => {
  const response = jsonCapture();
  let unauthorized = false;
  const res = { ...response, status(code) { if (code === 401) unauthorized = true; response.capture.status = code; return this; } };
  await handlePosterBatch(batchRequest([{ id: "poster-route-item" }], { authorized: false }), res);
  assert.ok(unauthorized || response.capture.status === 401, "unauthenticated batch must be rejected");
});
