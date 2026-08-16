import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { authenticateEmbyLike, initiateJellyfinQuickConnect, jellyfinQuickConnectEnabled, logoutEmbyLike, pollJellyfinQuickConnect } from "../server/src/utils/embyLikeAuth.js";

function mockDevice() {
  return { deviceIdentifier: "stable-device-id", deviceName: "Plembfin test" };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Emby direct login obtains and verifies a user-scoped access token", async () => {
  const requests = [];
  await withServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, authorization: req.headers["x-emby-authorization"], token: req.headers["x-emby-token"], body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/Users/AuthenticateByName") return res.end(JSON.stringify({ AccessToken: "user-token", User: { Id: "user-1", Name: "Alice" } }));
    if (req.url === "/Users/user-1") return res.end(JSON.stringify({ Id: "user-1", Name: "Alice" }));
    if (req.url === "/System/Info") return res.end(JSON.stringify({ Id: "server-1", ServerName: "Living Room" }));
    if (req.url === "/Sessions/Logout") return res.end("{}");
    res.statusCode = 404; res.end("{}");
  }, async (baseUrl) => {
    const result = await authenticateEmbyLike({ provider: "emby", baseUrl, username: "Alice", password: "secret", device: mockDevice() });
    assert.deepEqual(result, { baseUrl, token: "user-token", userId: "user-1", username: "Alice", serverId: "server-1", serverName: "Living Room" });
    assert.match(requests[0].authorization, /DeviceId="stable-device-id"/);
    assert.deepEqual(JSON.parse(requests[0].body), { Username: "Alice", Pw: "secret" });
    assert.equal(requests[1].token, "user-token");
    assert.equal(await logoutEmbyLike({ ...result, credential: result.token, remoteUserId: result.userId }, mockDevice()), true);
  });
});

test("Jellyfin Quick Connect checks availability, polls, and exchanges its secret", async () => {
  let polls = 0;
  await withServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/QuickConnect/Enabled") return res.end("true");
    if (req.url === "/QuickConnect/Initiate") return res.end(JSON.stringify({ Secret: "flow-secret", Code: "ABC123" }));
    if (req.url === "/QuickConnect/Connect?Secret=flow-secret") return res.end(JSON.stringify({ Authenticated: ++polls > 1 }));
    if (req.url === "/Users/AuthenticateWithQuickConnect") {
      assert.deepEqual(JSON.parse(body), { Secret: "flow-secret" });
      return res.end(JSON.stringify({ AccessToken: "jelly-token", User: { Id: "user-j", Name: "Jamie" } }));
    }
    if (req.url === "/Users/user-j") return res.end(JSON.stringify({ Id: "user-j", Name: "Jamie" }));
    if (req.url === "/System/Info") return res.end(JSON.stringify({ Id: "server-j", ServerName: "Jelly Home" }));
    res.statusCode = 404; res.end("{}");
  }, async (baseUrl) => {
    assert.equal(await jellyfinQuickConnectEnabled(baseUrl, mockDevice()), true);
    const start = await initiateJellyfinQuickConnect(baseUrl, mockDevice());
    assert.equal(start.code, "ABC123");
    assert.deepEqual(await pollJellyfinQuickConnect(baseUrl, mockDevice(), start.secret), { authorised: false });
    assert.deepEqual(await pollJellyfinQuickConnect(baseUrl, mockDevice(), start.secret), { authorised: true });
    const result = await authenticateEmbyLike({ provider: "jellyfin", baseUrl, quickConnectSecret: start.secret, device: mockDevice() });
    assert.equal(result.token, "jelly-token");
    assert.equal(result.userId, "user-j");
  });
});
