import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { test } from "node:test";
import express from "express";
import {
  createCspImageOriginMemo,
  createResponseCompression,
  setPublicAssetCacheHeaders,
} from "../server/src/utils/httpPerformance.js";

function request(server, path, headers = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: address.address, port: address.port, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ response, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    return await callback(server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("CSP image origins are memoized until the settings revision changes", async () => {
  let revision = 1;
  let loads = 0;
  const memo = createCspImageOriginMemo({
    readRevision: () => revision,
    loadConfig: async () => {
      loads += 1;
      return {
        plex: { baseUrl: "http://plex.local:32400/path" },
        emby: { baseUrl: "http://plex.local:32400" },
        jellyfin: { baseUrl: "not a URL" },
        seerr: { baseUrl: "https://requests.example.test/" },
      };
    },
  });

  assert.deepEqual(await memo(), ["http://plex.local:32400", "https://requests.example.test"]);
  assert.deepEqual(await memo(), ["http://plex.local:32400", "https://requests.example.test"]);
  assert.equal(loads, 1);

  revision = 2;
  await memo();
  assert.equal(loads, 2);
});

test("ordinary responses are gzip-compressed while live updates are not", async () => {
  const app = express();
  app.use(createResponseCompression());
  app.get("/payload", (_req, res) => res.type("text/plain").send("payload ".repeat(1000)));
  app.get("/events", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.write("event: ping\\ndata: ok\\n\\n");
    res.end();
  });

  await withServer(app, async (server) => {
    const compressed = await request(server, "/payload", { "Accept-Encoding": "gzip" });
    assert.equal(compressed.response.headers["content-encoding"], "gzip");
    assert.match(String(compressed.response.headers.vary), /Accept-Encoding/i);
    assert.equal(zlib.gunzipSync(compressed.body).toString(), "payload ".repeat(1000));

    const events = await request(server, "/events", { "Accept-Encoding": "gzip" });
    assert.equal(events.response.headers["content-encoding"], undefined);
    assert.match(String(events.response.headers["cache-control"]), /no-transform/);
    assert.match(events.body.toString(), /data: ok/);
  });
});

test("public static headers revalidate index and manifest without starting long max-age", () => {
  const headers = new Map();
  const response = { setHeader(name, value) { headers.set(name, value); } };

  setPublicAssetCacheHeaders(response, "/public/index.html");
  assert.equal(headers.get("Cache-Control"), "no-cache");

  headers.clear();
  setPublicAssetCacheHeaders(response, "/public/manifest.webmanifest");
  assert.equal(headers.get("Cache-Control"), "no-cache");

  headers.clear();
  setPublicAssetCacheHeaders(response, "/public/app.js");
  assert.equal(headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
});
