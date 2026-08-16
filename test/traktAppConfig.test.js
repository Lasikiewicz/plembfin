import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getTraktAppConfig, hydrateTraktAppCredentials, resolveTraktAppCredentials } from "../server/src/utils/traktAppConfig.js";

test("Trakt server app configuration is reported without exposing values", () => {
  const config = getTraktAppConfig({ TRAKT_CLIENT_ID: "official-id", TRAKT_CLIENT_SECRET: "official-secret" });
  assert.equal(config.configured, true);
  assert.equal(config.incomplete, false);
  assert.equal(config.source, "environment");
});

test("Plembfin has a bundled Trakt device application", () => {
  const config = getTraktAppConfig({});
  assert.equal(config.configured, true);
  assert.equal(config.incomplete, false);
  assert.equal(config.source, "bundled");
  assert.ok(config.clientId);
  assert.ok(config.clientSecret);
});

test("Trakt server credentials are used when the browser supplies none", () => {
  const credentials = resolveTraktAppCredentials({}, { TRAKT_CLIENT_ID: "official-id", TRAKT_CLIENT_SECRET: "official-secret" });
  assert.deepEqual(credentials, { clientId: "official-id", clientSecret: "official-secret", source: "server" });
  assert.deepEqual(hydrateTraktAppCredentials({ status: "connected", clientId: "", clientSecret: "" }, { TRAKT_CLIENT_ID: "official-id", TRAKT_CLIENT_SECRET: "official-secret" }), {
    status: "connected", clientId: "official-id", clientSecret: "official-secret",
  });
});

test("Trakt personal app fallback requires both values", () => {
  assert.throws(() => resolveTraktAppCredentials({ clientId: "only-id" }, {}), /Both Trakt Client ID and Client Secret/);
  assert.deepEqual(resolveTraktAppCredentials({ clientId: "personal-id", clientSecret: "personal-secret" }, {}), {
    clientId: "personal-id", clientSecret: "personal-secret", source: "personal",
  });
});

test("official Trakt app credentials are not persisted in tracker records", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-trakt-app-"));
  const script = `
    const repo = await import('./server/src/utils/trackerConnectionRepo.js');
    const { db } = await import('./server/src/db.js');
    repo.saveTrackerConnection({ provider: 'trakt', clientId: '', clientSecret: '', accessToken: 'access-token', refreshToken: 'refresh-token', remoteUserId: 'user', remoteUsername: 'User' });
    const row = db.prepare('SELECT * FROM tracker_connections').get();
    if (row.client_id !== '') throw new Error('official client id persisted');
    const publicRecord = repo.getTrackerConnection('trakt');
    if ('clientId' in publicRecord || 'clientSecret' in publicRecord) throw new Error('app credential field exposed publicly');
    const privateRecord = repo.getTrackerConnection('trakt', { includeCredentials: true });
    if (privateRecord.clientId !== '' || privateRecord.clientSecret !== '') throw new Error('official app credentials persisted');
    db.close();
  `;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, DATA_DIR: dataDir, PLEMBFIN_CREDENTIAL_KEY: "22".repeat(32) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `repository child exited ${code}`)));
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  assert.ok(true);
});
