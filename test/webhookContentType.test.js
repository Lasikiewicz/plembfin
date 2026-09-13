import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-webhook-content-type-");

const { handleWebhook, normalizeWebhook } = await import("../server/src/routes/sync.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { deleteActiveSession, listActiveSessions } = await import("../server/src/utils/activeSessions.js");
const { UP_NEXT_SEED_DEVICE_ID } = await import("../server/src/utils/embyClient.js");

function request({ contentType = "", userAgent = "test-agent", body = "" } = {}) {
  const headers = { "content-type": contentType, "user-agent": userAgent };
  return {
    get: (name) => headers[String(name).toLowerCase()] || "",
    rawBody: Buffer.from(body, "utf8"),
  };
}

function responseCapture() {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    send(body) {
      this.body = JSON.parse(body);
      return this;
    },
  };
  return response;
}

function webhookRequest(body) {
  const headers = {
    "content-type": "application/json",
    "x-plembfin-webhook-secret": AUTH.webhookSecret,
  };
  return {
    method: "POST",
    query: {},
    body,
    headers,
    get: (name) => headers[String(name).toLowerCase()] || "",
  };
}

// Jellyfin's webhook plugin posts valid JSON under a text/plain content type.
// Trusting the header drops every event it sends, including the mark-played and
// mark-unplayed events unwatch propagation depends on.
const jellyfinBody = JSON.stringify({
  ServerId: "d00d1f450389495c9bd54d6eeb9cda53",
  ServerName: "jellyfin",
  NotificationType: "ItemMarkPlayed",
  Item: {
    Type: "Movie",
    Name: "Arrival",
    ProviderIds: { Tmdb: "329865" },
    UserData: { Played: true, LastPlayedDate: "2026-07-25T20:15:47.000Z" },
  },
});

test("valid JSON sent as text/plain is parsed, not rejected", async () => {
  const media = await normalizeWebhook(
    request({ contentType: "text/plain; charset=utf-8", userAgent: "Jellyfin-Server/10.11.9", body: jellyfinBody }),
  );

  assert.equal(media.isValid, true, "a text/plain body holding JSON must still be handled");
  assert.equal(media.source, "jellyfin");
  assert.equal(media.phase, "completed");
  assert.equal(media.playedFlagOnly, true);
});

test("a declared JSON content type still parses the same payload", async () => {
  const media = await normalizeWebhook(
    request({ contentType: "application/json", body: jellyfinBody }),
  );
  assert.equal(media.isValid, true);
  assert.equal(media.source, "jellyfin");
});

test("a body that is not JSON at all is rejected with the sender recorded", async () => {
  const media = await normalizeWebhook(
    request({ contentType: "text/plain", userAgent: "Some-Server/1.0", body: "not json at all" }),
  );

  assert.equal(media.isValid, false);
  assert.equal(media.title, "Unsupported webhook content type");
  assert.equal(media.rawPayloadDebug.userAgent, "Some-Server/1.0");
  assert.equal(media.rawPayloadDebug.contentType, "text/plain");
  assert.match(media.rawPayloadDebug.bodyPreview, /not json at all/);
});

test("a malformed body claiming to be JSON is a client error", async () => {
  await assert.rejects(
    () => normalizeWebhook(request({ contentType: "application/json", body: "{ broken" })),
    (error) => error.status === 400,
    "declaring JSON and sending something else stays a 400 rather than being silently ignored",
  );
});

test("an empty body is rejected rather than treated as an event", async () => {
  const media = await normalizeWebhook(request({ contentType: "text/plain", body: "" }));
  assert.equal(media.isValid, false);
  assert.equal(media.title, "Unsupported webhook content type");
});

test("Emby Up Next seed callbacks never become active sessions", async () => {
  const seedPayload = {
    Event: "playback.start",
    UserId: "emby-user",
    DeviceId: UP_NEXT_SEED_DEVICE_ID,
    DeviceName: "Plembfin Up Next",
    Client: "Emby",
    ApplicationVersion: "1.0.0",
    SessionId: "plembfin-up-next-seed-episode",
    Item: {
      Type: "Movie",
      Name: "Arrival",
      ProviderIds: { Tmdb: "329865" },
      RunTimeTicks: 36_000_000_000,
    },
  };
  const seedResponse = responseCapture();

  await handleWebhook(webhookRequest(seedPayload), seedResponse);

  assert.equal(seedResponse.statusCode, 200);
  assert.equal(seedResponse.body.skipped, true);
  assert.equal(seedResponse.body.active, false);
  assert.equal((await listActiveSessions()).length, 0);

  const realPayload = {
    ...seedPayload,
    DeviceId: "a-real-device",
    DeviceName: "Real Emby Player",
    SessionId: "real-emby-session",
    Item: { ...seedPayload.Item, Name: "The Martian" },
  };
  const realResponse = responseCapture();
  await handleWebhook(webhookRequest(realPayload), realResponse);

  assert.equal(realResponse.body.active, true);
  assert.equal((await listActiveSessions()).length, 1);
  assert.equal((await listActiveSessions())[0].client.deviceId, "a-real-device");
  await deleteActiveSession({
    source: "emby",
    type: "movie",
    title: "The Martian",
    ids: { tmdb: "329865" },
  });
});
