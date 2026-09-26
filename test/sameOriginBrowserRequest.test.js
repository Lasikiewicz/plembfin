import test from "node:test";
import assert from "node:assert/strict";
import { isSameOriginBrowserRequest } from "../server/src/utils/auth.js";

function request(headers) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower[name.toLowerCase()] };
}

const host = "192.168.11.110:5055";

test("Sec-Fetch-Site decides when the browser sends it", () => {
  assert.equal(isSameOriginBrowserRequest(request({ host, "sec-fetch-site": "same-origin" })), true);
  assert.equal(isSameOriginBrowserRequest(request({ host, "sec-fetch-site": "cross-site", origin: `http://${host}` })), false);
  assert.equal(isSameOriginBrowserRequest(request({ host, "sec-fetch-site": "same-site", referer: `http://${host}/settings` })), false);
});

test("Origin decides when there is no Sec-Fetch-Site", () => {
  assert.equal(isSameOriginBrowserRequest(request({ host, origin: `http://${host}` })), true);
  assert.equal(isSameOriginBrowserRequest(request({ host, origin: "http://evil.example", referer: `http://${host}/settings` })), false);
  assert.equal(isSameOriginBrowserRequest(request({ host, origin: "null" })), false);
});

test("a plain-HTTP LAN status poll with only a same-origin Referer is accepted (issue 39)", () => {
  assert.equal(isSameOriginBrowserRequest(request({ host, referer: `http://${host}/settings/connections` })), true);
  assert.equal(isSameOriginBrowserRequest(request({ host, referer: "http://evil.example/page" })), false);
  assert.equal(isSameOriginBrowserRequest(request({ host, referer: "not a url" })), false);
});

test("a request with no Sec-Fetch-Site, Origin, or Referer is rejected", () => {
  assert.equal(isSameOriginBrowserRequest(request({ host })), false);
  assert.equal(isSameOriginBrowserRequest(request({ referer: `http://${host}/settings` })), false, "no Host header");
});
