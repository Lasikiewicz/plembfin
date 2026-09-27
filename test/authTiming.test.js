import test from "node:test";
import assert from "node:assert/strict";
import { verifyUsername, verifyPassword, verifyWebhookToken, AUTH, isDefaultPassword, updateAdminCredentials } from "../server/src/appConfig.js";

test("isDefaultPassword is memoized and follows credential changes", () => {
  updateAdminCredentials({ username: AUTH.username, password: "admin" });
  assert.equal(isDefaultPassword(), true);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) isDefaultPassword();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 20, `20 repeat calls took ${elapsedMs}ms; scrypt is not memoized`);
  updateAdminCredentials({ username: AUTH.username, password: "not-the-default-1" });
  assert.equal(isDefaultPassword(), false);
  updateAdminCredentials({ username: AUTH.username, password: "admin" });
  assert.equal(isDefaultPassword(), true);
});

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
