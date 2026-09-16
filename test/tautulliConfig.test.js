import test from "node:test";
import assert from "node:assert/strict";
import { mergeEnvDefaults, normalizeStoredConfig, publicMediaConfig, validateConfig } from "../server/src/utils/configStore.js";

test("Tautulli configuration is normalized and public responses redact the API key", () => {
  const normalized = normalizeStoredConfig({ tautulli: { baseUrl: "http://127.0.0.1:8181/", apiKey: "secret", userId: 7 } });
  assert.equal(normalized.tautulli.baseUrl, "http://127.0.0.1:8181");
  assert.equal(normalized.tautulli.userId, "7");
  assert.equal(validateConfig({ tautulli: normalized.tautulli }).length, 0);
  const publicConfig = publicMediaConfig(normalized);
  assert.equal(publicConfig.tautulli.configured, true);
  assert.equal(publicConfig.tautulli.userId, "7");
  assert.equal(Object.hasOwn(publicConfig.tautulli, "apiKey"), false);
});

test("Tautulli cannot be enabled without a URL and API key", () => {
  const errors = validateConfig({ tautulli: { baseUrl: "", apiKey: "", userId: "7", disabled: false } });
  assert.ok(errors.some((error) => error.includes("tautulli.baseUrl")));
  assert.ok(errors.some((error) => error.includes("tautulli.apiKey")));
});

test("environment merging preserves saved Tautulli connection details", () => {
  const merged = mergeEnvDefaults({ tautulli: { baseUrl: "https://tautulli.example.test", apiKey: "secret", userId: "7" } });
  assert.deepEqual(merged.tautulli, {
    baseUrl: "https://tautulli.example.test",
    apiKey: "secret",
    userId: "7",
    disabled: false,
  });
});
