import crypto from "node:crypto";
import { db } from "../db.js";
import { decryptCredential, encryptCredential } from "./credentialVault.js";

const PROVIDERS = new Set(["trakt"]);
const SERVER_CREDENTIAL_SENTINEL = "plembfin:server-configured";
const providerName = (value) => {
  const provider = String(value || "").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error("Unsupported tracker provider");
  return provider;
};

const encrypted = (value) => encryptCredential(String(value || ""));
const decrypted = (row, prefix) => decryptCredential({
  ciphertext: row[`${prefix}_ciphertext`], iv: row[`${prefix}_iv`], tag: row[`${prefix}_tag`], version: row.token_version || row.key_version,
});

function publicConnection(row) {
  if (!row) return null;
  return {
    id: row.id, provider: row.provider, status: row.status,
    remoteUserId: row.remote_user_id || "", remoteUsername: row.remote_username || "",
    accessTokenExpiresAt: row.access_token_expires_at,
    initialSyncMode: row.initial_sync_mode, baselineComplete: Boolean(row.baseline_complete),
    lastPolledAt: row.last_polled_at, lastValidatedAt: row.last_validated_at,
    lastError: row.last_error || "", createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getTrackerConnection(provider, { includeCredentials = false } = {}) {
  const row = db.prepare("SELECT * FROM tracker_connections WHERE provider=? LIMIT 1").get(providerName(provider));
  const result = publicConnection(row);
  if (result && includeCredentials) {
    result.clientId = row.client_id;
    const clientSecret = decrypted(row, "client_secret");
    result.clientSecret = clientSecret === SERVER_CREDENTIAL_SENTINEL ? "" : clientSecret;
    result.accessToken = decrypted(row, "access_token");
    result.refreshToken = decrypted(row, "refresh_token");
  }
  return result;
}

export function listTrackerConnections() {
  return db.prepare("SELECT * FROM tracker_connections ORDER BY provider").all().map(publicConnection);
}

export function saveTrackerConnection(input) {
  const provider = providerName(input.provider);
  const clientSecret = encrypted(input.clientSecret || SERVER_CREDENTIAL_SENTINEL);
  const accessToken = encrypted(input.accessToken);
  const refreshToken = encrypted(input.refreshToken);
  const timestamp = Date.now();
  const existing = db.prepare("SELECT id, created_at FROM tracker_connections WHERE provider=?").get(provider);
  const row = {
    id: existing?.id || crypto.randomUUID(), provider, status: input.status || "connected",
    remote_user_id: String(input.remoteUserId || ""), remote_username: String(input.remoteUsername || ""), client_id: String(input.clientId || ""),
    client_secret_ciphertext: clientSecret.ciphertext, client_secret_iv: clientSecret.iv, client_secret_tag: clientSecret.tag,
    access_token_ciphertext: accessToken.ciphertext, access_token_iv: accessToken.iv, access_token_tag: accessToken.tag,
    refresh_token_ciphertext: refreshToken.ciphertext, refresh_token_iv: refreshToken.iv, refresh_token_tag: refreshToken.tag,
    token_version: accessToken.version, access_token_expires_at: Number(input.accessTokenExpiresAt || 0) || null,
    initial_sync_mode: input.initialSyncMode === "import" ? "import" : "baseline", baseline_complete: input.baselineComplete ? 1 : 0,
    last_polled_at: input.lastPolledAt || null, last_validated_at: input.lastValidatedAt || timestamp,
    last_error: input.lastError || null, created_at: existing?.created_at || timestamp, updated_at: timestamp,
  };
  db.prepare(`INSERT INTO tracker_connections (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(",")})
    ON CONFLICT(provider) DO UPDATE SET status=excluded.status,remote_user_id=excluded.remote_user_id,remote_username=excluded.remote_username,
    client_id=excluded.client_id,client_secret_ciphertext=excluded.client_secret_ciphertext,client_secret_iv=excluded.client_secret_iv,client_secret_tag=excluded.client_secret_tag,
    access_token_ciphertext=excluded.access_token_ciphertext,access_token_iv=excluded.access_token_iv,access_token_tag=excluded.access_token_tag,
    refresh_token_ciphertext=excluded.refresh_token_ciphertext,refresh_token_iv=excluded.refresh_token_iv,refresh_token_tag=excluded.refresh_token_tag,
    token_version=excluded.token_version,access_token_expires_at=excluded.access_token_expires_at,initial_sync_mode=excluded.initial_sync_mode,
    baseline_complete=excluded.baseline_complete,last_validated_at=excluded.last_validated_at,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(row);
  return getTrackerConnection(provider);
}

export function updateTrackerTokens(provider, tokens) {
  const access = encrypted(tokens.accessToken);
  const refresh = encrypted(tokens.refreshToken);
  db.prepare(`UPDATE tracker_connections SET access_token_ciphertext=?,access_token_iv=?,access_token_tag=?,refresh_token_ciphertext=?,refresh_token_iv=?,refresh_token_tag=?,token_version=?,access_token_expires_at=?,status='connected',last_error=NULL,updated_at=? WHERE provider=?`)
    .run(access.ciphertext, access.iv, access.tag, refresh.ciphertext, refresh.iv, refresh.tag, access.version, tokens.accessTokenExpiresAt || null, Date.now(), providerName(provider));
}

export function updateTrackerConnectionStatus(provider, patch = {}) {
  const allowed = { status: "status", baselineComplete: "baseline_complete", lastPolledAt: "last_polled_at", lastValidatedAt: "last_validated_at", lastError: "last_error" };
  const entries = Object.entries(patch).filter(([key]) => allowed[key]);
  if (!entries.length) return;
  const values = entries.map(([, value]) => value instanceof Boolean ? Number(value) : value);
  db.prepare(`UPDATE tracker_connections SET ${entries.map(([key]) => `${allowed[key]}=?`).join(",")},updated_at=? WHERE provider=?`)
    .run(...values.map((value) => typeof value === "boolean" ? Number(value) : value), Date.now(), providerName(provider));
}

export function deleteTrackerConnection(provider) {
  const name = providerName(provider);
  return db.transaction(() => {
    db.prepare("DELETE FROM tracker_item_state WHERE provider=?").run(name);
    return db.prepare("DELETE FROM tracker_connections WHERE provider=?").run(name).changes > 0;
  })();
}

export function createTrackerAuthFlow(input) {
  const provider = providerName(input.provider);
  const secret = encrypted(input.clientSecret || SERVER_CREDENTIAL_SENTINEL);
  const device = encrypted(input.deviceCode);
  const timestamp = Date.now();
  const row = {
    id: crypto.randomUUID(), provider, client_id: String(input.clientId),
    client_secret_ciphertext: secret.ciphertext, client_secret_iv: secret.iv, client_secret_tag: secret.tag,
    device_code_ciphertext: device.ciphertext, device_code_iv: device.iv, device_code_tag: device.tag,
    key_version: secret.version, user_code: String(input.userCode), verification_url: String(input.verificationUrl),
    interval_seconds: Math.max(1, Number(input.intervalSeconds || 5)), initial_sync_mode: input.initialSyncMode === "import" ? "import" : "baseline",
    status: "pending", expires_at: Number(input.expiresAt), last_polled_at: null, created_at: timestamp, updated_at: timestamp,
  };
  db.prepare(`INSERT INTO tracker_auth_flows (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(",")})`).run(row);
  return { id: row.id, provider, userCode: row.user_code, verificationUrl: row.verification_url, intervalSeconds: row.interval_seconds, expiresAt: row.expires_at, status: row.status };
}

export function getTrackerAuthFlow(id, { includeCredentials = false } = {}) {
  const row = db.prepare("SELECT * FROM tracker_auth_flows WHERE id=?").get(String(id || ""));
  if (!row) return null;
  const result = { id: row.id, provider: row.provider, clientId: row.client_id, userCode: row.user_code, verificationUrl: row.verification_url, intervalSeconds: row.interval_seconds, initialSyncMode: row.initial_sync_mode, status: row.status, expiresAt: row.expires_at, lastPolledAt: row.last_polled_at };
  if (includeCredentials) {
    const clientSecret = decrypted(row, "client_secret");
    result.clientSecret = clientSecret === SERVER_CREDENTIAL_SENTINEL ? "" : clientSecret;
    result.deviceCode = decrypted(row, "device_code");
  }
  return result;
}

export function markTrackerAuthFlow(id, status) {
  db.prepare("UPDATE tracker_auth_flows SET status=?,last_polled_at=?,updated_at=? WHERE id=?").run(status, Date.now(), Date.now(), id);
}

export function listTrackerItemStates(provider) {
  return db.prepare("SELECT * FROM tracker_item_state WHERE provider=?").all(providerName(provider)).map((row) => ({
    provider: row.provider, mediaKey: row.media_key, media: JSON.parse(row.media_json), remoteWatchedAt: row.remote_watched_at,
    lastSeenAt: row.last_seen_at, lastOutboundState: row.last_outbound_state, lastOutboundAt: row.last_outbound_at,
  }));
}

export function replaceTrackerSnapshot(provider, items) {
  const name = providerName(provider);
  const timestamp = Date.now();
  db.transaction(() => {
    const previous = new Map(db.prepare("SELECT * FROM tracker_item_state WHERE provider=?").all(name).map((row) => [row.media_key, row]));
    db.prepare("DELETE FROM tracker_item_state WHERE provider=?").run(name);
    const insert = db.prepare("INSERT INTO tracker_item_state (provider,media_key,media_json,remote_watched_at,last_seen_at,last_outbound_state,last_outbound_at) VALUES (?,?,?,?,?,?,?)");
    for (const item of items) {
      const old = previous.get(item.mediaKey);
      insert.run(name, item.mediaKey, JSON.stringify(item.media), item.watchedAt || null, timestamp, old?.last_outbound_state || null, old?.last_outbound_at || null);
    }
  })();
}

export function recordTrackerOutbound(provider, mediaKey, media, state) {
  const name = providerName(provider);
  const timestamp = Date.now();
  db.prepare(`INSERT INTO tracker_item_state (provider,media_key,media_json,remote_watched_at,last_seen_at,last_outbound_state,last_outbound_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,media_key) DO UPDATE SET media_json=excluded.media_json,last_outbound_state=excluded.last_outbound_state,last_outbound_at=excluded.last_outbound_at`)
    .run(name, mediaKey, JSON.stringify(media), state === "watched" ? timestamp : null, timestamp, state, timestamp);
}
