import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

test("expired Plex JWT refreshes from the durable device key with one concurrent exchange", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-plex-refresh-"));
  const script = `
    const repo = await import('./server/src/utils/mediaConnectionRepo.js');
    const manager = await import('./server/src/utils/plexTokenManager.js');
    const { db } = await import('./server/src/db.js');
    const device = repo.getOrCreatePlexAuthDevice({ deviceName: 'Plembfin test' });
    const jwt = (exp, label) => 'e30.' + Buffer.from(JSON.stringify({ exp, label })).toString('base64url') + '.signature';
    repo.saveMediaConnection({ provider: 'plex', baseUrl: 'http://192.168.1.10:32400', serverId: 'machine-1', authDeviceId: device.id, remoteUserId: 'user-1', remoteUsername: 'Alice', authKind: 'plex_jwt', credential: jwt(1, 'expired'), accessTokenExpiresAt: 1000 });
    let calls = 0;
    const fresh = jwt(Math.floor(Date.now() / 1000) + 7 * 86400, 'fresh');
    const fetchImpl = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 25)); return { ok: true, status: 200, json: async () => calls === 1 ? { nonce: 'nonce' } : { auth_token: fresh } }; };
    const [one, two] = await Promise.all([manager.getValidPlexToken({ fetchImpl }), manager.getValidPlexToken({ fetchImpl })]);
    if (one !== fresh || two !== fresh) throw new Error('refreshed token was not returned');
    if (calls !== 2) throw new Error('concurrent refresh performed more than one exchange: ' + calls);
    const row = db.prepare(\"SELECT * FROM media_connections WHERE provider='plex'\").get();
    if (row.refresh_failure_count !== 0 || row.refresh_lease_owner !== null || row.status !== 'connected') throw new Error('refresh health was not persisted');
    let resourceCalls = 0;
    const resourceFetch = async () => { resourceCalls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true, status: 200, json: async () => [{ product: 'Plex Media Server', clientIdentifier: 'machine-1', accessToken: 'server-access-token' }] }; };
    const [serverOne, serverTwo] = await Promise.all([manager.getValidPlexServerToken({ fetchImpl: resourceFetch }), manager.getValidPlexServerToken({ fetchImpl: resourceFetch })]);
    if (serverOne !== 'server-access-token' || serverTwo !== serverOne || resourceCalls !== 1) throw new Error('server-token discovery was not single-flight');
    const storedServer = db.prepare("SELECT server_credential_ciphertext FROM media_connections WHERE provider='plex'").get();
    if (!storedServer.server_credential_ciphertext || storedServer.server_credential_ciphertext.includes('server-access-token')) throw new Error('server token was not encrypted');
    db.close();
  `;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATA_DIR: dataDir, PLEMBFIN_CREDENTIAL_KEY: "22".repeat(32) }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `refresh child exited ${code}`)));
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
