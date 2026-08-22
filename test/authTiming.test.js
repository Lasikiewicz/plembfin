import test from "node:test";
import assert from "node:assert/strict";
import { verifyUsername, verifyPassword, verifyWebhookToken, AUTH } from "../server/src/appConfig.js";

test("verifyUsername performs constant-time matching correctly", () => {
  assert.equal(verifyUsername(AUTH.username), true);
  assert.equal(verifyUsername(AUTH.username + "x"), false);
  assert.equal(verifyUsername("wrong-user"), false);
  assert.equal(verifyUsername(""), false);
  assert.equal(verifyUsername(null), false);
  assert.equal(verifyUsername(undefined), false);
});

test("verifyWebhookToken performs constant-time token verification", () => {
  assert.equal(verifyWebhookToken(AUTH.webhookSecret), true);
  assert.equal(verifyWebhookToken(AUTH.webhookSecret + "x"), false);
  assert.equal(verifyWebhookToken("invalid-token"), false);
  assert.equal(verifyWebhookToken(""), false);
  assert.equal(verifyWebhookToken(null), false);
});
