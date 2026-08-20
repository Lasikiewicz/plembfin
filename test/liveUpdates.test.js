import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "./domStubs.js";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-live-updates-");

const { db, getDataVersion, bumpDataVersion } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { setRuntimeState } = await import("../server/src/utils/configStore.js");
const { handleLiveUpdates } = await import("../server/src/routes/liveUpdates.js");
const { startLiveUpdates, stopLiveUpdates } = await import("../public/modules/live-updates.js");

function createMockReqRes({ method = "GET", headers = {}, cookies = {} } = {}) {
  const req = new http.IncomingMessage(null);
  req.method = method;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  req.cookies = cookies;
  req.get = (name) => req.headers[name.toLowerCase()] || "";

  let statusCode = 200;
  const responseHeaders = {};
  const chunks = [];
  let isEnded = false;

  const res = {
    statusCode: 200,
    status(code) {
      statusCode = code;
      this.statusCode = code;
      return this;
    },
    set(hdrs, val) {
      if (typeof hdrs === "string") {
        responseHeaders[hdrs] = val;
      } else if (hdrs && typeof hdrs === "object") {
        Object.assign(responseHeaders, hdrs);
      }
      return this;
    },
    setHeader(name, value) {
      responseHeaders[name] = value;
      return this;
    },
    getHeader(name) {
      return responseHeaders[name];
    },
    flushHeaders() {},
    send(body) {
      if (body) chunks.push(typeof body === "string" ? body : JSON.stringify(body));
      isEnded = true;
      res.writableEnded = true;
      return this;
    },
    json(body) {
      return this.send(body);
    },
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(chunk);
      isEnded = true;
      res.writableEnded = true;
      return this;
    },
    writableEnded: false,
    destroyed: false,
    _listeners: {},
    once(event, listener) {
      this._listeners[event] = listener;
    },
    on(event, listener) {
      this._listeners[event] = listener;
    },
    close() {
      this.writableEnded = true;
      this.destroyed = true;
      if (this._listeners["close"]) this._listeners["close"]();
      if (req._listeners?.["close"]) req._listeners["close"]();
    },
  };

  req._listeners = {};
  req.once = (event, listener) => { req._listeners[event] = listener; };
  req.on = (event, listener) => { req._listeners[event] = listener; };

  return { req, res, getOutput: () => chunks.join(""), getStatusCode: () => statusCode, getHeaders: () => responseHeaders };
}

test("liveUpdates rejects unauthorized requests", async () => {
  const { req, res, getStatusCode } = createMockReqRes({
    headers: {},
  });

  await handleLiveUpdates(req, res);
  assert.equal(getStatusCode(), 401);
});

test("liveUpdates rejects non-GET methods", async () => {
  const { req, res, getStatusCode } = createMockReqRes({
    method: "POST",
    headers: { "x-api-key": AUTH.apiKey },
  });

  await handleLiveUpdates(req, res);
  assert.equal(getStatusCode(), 405);
});

test("liveUpdates establishes SSE stream and sends ready event", async () => {
  const initialVersion = getDataVersion();
  const { req, res, getOutput, getHeaders, getStatusCode } = createMockReqRes({
    method: "GET",
    headers: { "x-api-key": AUTH.apiKey },
  });

  await handleLiveUpdates(req, res);

  assert.equal(getStatusCode(), 200);
  assert.equal(getHeaders()["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(getHeaders()["Cache-Control"], "no-cache, no-transform");
  assert.equal(getHeaders()["Connection"], "keep-alive");

  const output = getOutput();
  assert.ok(output.includes(`"type":"ready"`));
  assert.ok(output.includes(`"version":${initialVersion}`));

  res.close();
});

test("liveUpdates broadcasts history version changes", async () => {
  const { req, res, getOutput } = createMockReqRes({
    method: "GET",
    headers: { "x-api-key": AUTH.apiKey },
  });

  await handleLiveUpdates(req, res);

  // Bump data version
  const newVersion = bumpDataVersion();

  // Allow the interval check (250ms) to trigger
  await new Promise((resolve) => setTimeout(resolve, 600));

  const output = getOutput();
  assert.ok(output.includes(`"type":"history-version"`));
  assert.ok(output.includes(`"version":${newVersion}`));

  res.close();
});

test("liveUpdates broadcasts background sync progress", async () => {
  const { req, res, getOutput } = createMockReqRes({
    method: "GET",
    headers: { "x-api-key": AUTH.apiKey },
  });

  await handleLiveUpdates(req, res);

  // Update runtime state with sync progress
  await setRuntimeState({ backgroundSyncProgress: { total: 50, completed: 25 } });

  // Allow the sync progress interval check (1000ms) to trigger
  await new Promise((resolve) => setTimeout(resolve, 1300));

  const output = getOutput();
  assert.ok(output.includes(`"type":"sync-progress"`));
  assert.ok(output.includes(`"total":50`));
  assert.ok(output.includes(`"completed":25`));

  res.close();
});

test("client live-updates parses SSE stream and invokes callbacks", async () => {
  let receivedVersion = null;
  let receivedProgress = null;

  const mockStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"ready","version":1}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"history-version","version":2}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"sync-progress","total":10,"completed":4}\n\n'));
      controller.close();
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: mockStream,
  });

  try {
    startLiveUpdates({
      authHeaders: () => ({ Authorization: "Bearer test" }),
      onHistoryVersion: (ver) => { receivedVersion = ver; },
      onSyncProgress: (prog) => { receivedProgress = prog; },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(receivedVersion, 2);
    assert.deepEqual(receivedProgress, { total: 10, completed: 4 });
  } finally {
    stopLiveUpdates();
    globalThis.fetch = originalFetch;
  }
});
