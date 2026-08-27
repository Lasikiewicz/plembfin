import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

test("media connection repository keeps credentials encrypted and device identities stable", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-media-connection-"));
  const script = `
    const repo = await import('./server/src/utils/mediaConnectionRepo.js');
    const { db } = await import('./server/src/db.js');
    const device1 = repo.getOrCreateAuthDevice('jellyfin', { deviceName: 'Plembfin test' });
    const device2 = repo.getOrCreateAuthDevice('jellyfin', { deviceName: 'ignored reconnect name' });
    if (device1.id !== device2.id) throw new Error('device identity changed');
    repo.saveMediaConnection({ provider: 'jellyfin', baseUrl: 'http://192.168.1.20:8096', serverId: 'server-1', serverName: 'Test', authDeviceId: device1.id, remoteUserId: 'user-1', remoteUsername: 'Alice', authKind: 'jellyfin_user', credential: 'plain-secret' });
    const row = db.prepare('SELECT * FROM media_connections').get();
    if (row.credential_ciphertext.includes('plain-secret')) throw new Error('plaintext persisted');
    const resolved = repo.resolveConnectedProviderConfig('jellyfin', {});
    if (resolved.apiKey !== 'plain-secret' || resolved.userId !== 'user-1') throw new Error('runtime adapter failed');
    const configStore = await import('./server/src/utils/configStore.js');
    const connectedErrors = configStore.validateConfig({ jellyfin: { baseUrl: '', apiKey: '', userId: '', disabled: false } });
    if (connectedErrors.length) throw new Error('connected credential did not satisfy validation: ' + connectedErrors.join('; '));
    const manualErrors = configStore.validateConfig({ jellyfin: { baseUrl: '', apiKey: '', userId: '', authMode: 'manual', disabled: false } });
    if (!manualErrors.some((error) => error.includes('jellyfin.apiKey'))) throw new Error('manual mode incorrectly used the account connection');
    const emptyDefaults = configStore.normalizeStoredConfig({});
    if (emptyDefaults.jellyfin.authMode !== 'account' || emptyDefaults.emby.authMode !== 'account') throw new Error('new setup did not default to account mode');
    const legacyDefaults = configStore.normalizeStoredConfig({ emby: { apiKey: 'legacy' }, jellyfin: { apiKey: 'legacy' } });
    if (legacyDefaults.jellyfin.authMode !== 'manual' || legacyDefaults.emby.authMode !== 'manual') throw new Error('existing manual setup was not preserved');
    await configStore.saveMediaConfig({ publicBaseUrl: 'https://plembfin.example.test' });
    const settings = db.prepare(\"SELECT data FROM settings WHERE id='mediaConfig'\").get()?.data || '';
    if (settings.includes('plain-secret')) throw new Error('runtime token leaked into general settings');
    const flow = repo.createAuthFlow({ provider: 'jellyfin', authDeviceId: device1.id, secret: 'flow-secret', adminSessionFingerprint: 'session-hash', expiresAt: Date.now() + 60000 });
    if (repo.consumeAuthFlow(flow.id, 'wrong-session') !== null) throw new Error('flow session binding failed');
    const consumed = repo.consumeAuthFlow(flow.id, 'session-hash');
    if (consumed.secret !== 'flow-secret') throw new Error('flow decryption failed');
    if (repo.consumeAuthFlow(flow.id, 'session-hash') !== null) throw new Error('flow replay succeeded');
    const resumable = repo.createAuthFlow({ provider: 'jellyfin', authDeviceId: device1.id, secret: 'pending-secret', adminSessionFingerprint: 'resume-session', expiresAt: Date.now() + 60000 });
    if (!repo.authoriseAuthFlow(resumable.id, 'resume-session', 'authorised-secret')) throw new Error('flow authorization failed');
    const resumed = repo.getReusableAuthorisedAuthFlow('jellyfin', 'resume-session');
    if (resumed?.id !== resumable.id || resumed.secret !== 'authorised-secret') throw new Error('authorised flow was not resumed');
    if (repo.getReusableAuthorisedAuthFlow('jellyfin', 'different-session') !== null) throw new Error('flow resumed across admin sessions');
    if (!repo.disableMediaConnection('jellyfin')) throw new Error('connection was not disabled');
    if (repo.getMediaConnection('jellyfin') !== null) throw new Error('disabled connection remained active');
    await configStore.saveMediaConfig({ jellyfin: { baseUrl: 'http://192.168.1.20:8096', apiKey: 'stored-legacy-secret' } });
    configStore.disableStoredLegacyCredential('jellyfin', 'retired-connection');
    const retired = await configStore.loadMediaConfig({ resolveConnections: false });
    if (retired.jellyfin.apiKey) throw new Error('retired legacy credential fell back from storage or environment');
    if (!retired.jellyfin.legacyFallbackDisabled) throw new Error('legacy fallback retirement marker was not persisted');
    db.close();
  `;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, DATA_DIR: dataDir, PLEMBFIN_CREDENTIAL_KEY: "11".repeat(32), JELLYFIN_API_KEY: "environment-legacy-secret" },
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
