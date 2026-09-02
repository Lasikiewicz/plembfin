import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-poster-route-");

const { AUTH } = await import("../server/src/appConfig.js");
const { handlePoster } = await import("../server/src/routes/metadata.js");
const { cachePosterFromUrl } = await import("../server/src/utils/posterCache.js");
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
