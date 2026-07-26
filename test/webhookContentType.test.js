import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-webhook-content-type-");

const { normalizeWebhook } = await import("../server/src/routes/sync.js");

function request({ contentType = "", userAgent = "test-agent", body = "" } = {}) {
  const headers = { "content-type": contentType, "user-agent": userAgent };
  return {
    get: (name) => headers[String(name).toLowerCase()] || "",
    rawBody: Buffer.from(body, "utf8"),
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
