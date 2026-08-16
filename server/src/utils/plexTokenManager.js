import crypto from "node:crypto";
import { db } from "../db.js";
import { decryptCredential, encryptCredential } from "./credentialVault.js";
import { getPlexPrivateKey } from "./mediaConnectionRepo.js";
import { plexClientHeaders, refreshPlexJwt } from "./plexAuth.js";
import { fetchWithTimeout } from "./outbound.js";

const REFRESH_AHEAD_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 30 * 1000;
const WAIT_LIMIT_MS = 5 * 1000;
let serverTokenRefreshPromise = null;

function activePlexRow() {
  return db.prepare("SELECT * FROM media_connections WHERE provider='plex' AND status IN ('connected','reauth_required') ORDER BY updated_at DESC LIMIT 1").get();
}

function plexDevice(row) {
  const device = db.prepare("SELECT * FROM media_auth_devices WHERE id=? AND provider='plex' AND retired_at IS NULL").get(row.auth_device_id);
  if (!device) throw new Error("Active Plex device identity is unavailable");
  return { id: device.id, deviceIdentifier: device.device_identifier, deviceName: device.device_name, publicJwk: JSON.parse(device.public_jwk) };
}

function decryptedToken(row, vaultOptions) {
  return decryptCredential({ ciphertext: row.credential_ciphertext, iv: row.credential_iv, tag: row.credential_tag, version: row.token_version }, vaultOptions);
}

function looksLikeJwt(token) {
  return String(token || "").split(".").length === 3;
}

function encryptedLegacyPmsFallback(activeRow, vaultOptions) {
  const row = db.prepare(`SELECT * FROM media_connections WHERE provider='plex' AND id<>? AND status='disabled'
    AND auth_kind IN ('legacy','plex_legacy') AND credential_ciphertext<>'' ORDER BY updated_at DESC LIMIT 1`).get(activeRow.id);
  return row ? decryptedToken(row, vaultOptions) : "";
}

function storeServerToken(connectionId, token, vaultOptions) {
  const encrypted = encryptCredential(token, vaultOptions);
  db.prepare(`UPDATE media_connections SET server_credential_ciphertext=?,server_credential_iv=?,server_credential_tag=?,server_token_version=?,updated_at=? WHERE id=?`)
    .run(encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.version, Date.now(), connectionId);
}

function tokenIsFresh(row, now) {
  return Number(row?.access_token_expires_at || 0) > now + REFRESH_AHEAD_MS;
}

function claimRefreshLease(connectionId, owner, now) {
  return db.prepare(`UPDATE media_connections SET refresh_lease_owner=?,refresh_lease_expires_at=?,updated_at=?
    WHERE id=? AND (refresh_lease_expires_at IS NULL OR refresh_lease_expires_at<=? OR refresh_lease_owner=?)`).run(owner, now + LEASE_MS, now, connectionId, now, owner).changes === 1;
}

function releaseFailedLease(row, owner, error, now) {
  const rejected = [401, 403, 422].includes(Number(error?.status));
  db.prepare(`UPDATE media_connections SET refresh_lease_owner=NULL,refresh_lease_expires_at=NULL,
    refresh_failure_count=refresh_failure_count+1,status=CASE WHEN ? THEN 'reauth_required' ELSE status END,updated_at=?
    WHERE id=? AND refresh_lease_owner=?`).run(rejected ? 1 : 0, now, row.id, owner);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getValidPlexToken({ force = false, fetchImpl, now = () => Date.now(), vaultOptions = {} } = {}) {
  let row = activePlexRow();
  if (!row) throw new Error("No connected Plex JWT account is configured");
  if (!String(row.auth_kind).includes("plex_jwt") && row.auth_kind !== "plex_managed_jwt") return decryptedToken(row, vaultOptions);
  const checkedAt = now();
  if (!force && tokenIsFresh(row, checkedAt)) return decryptedToken(row, vaultOptions);

  const owner = `${process.env.PLEMBFIN_INSTANCE_ID || process.pid}:${crypto.randomUUID()}`;
  if (!claimRefreshLease(row.id, owner, checkedAt)) {
    const deadline = checkedAt + WAIT_LIMIT_MS;
    while (now() < deadline) {
      await delay(50);
      row = activePlexRow();
      if (!row) throw new Error("Plex connection was removed during token refresh");
      if (tokenIsFresh(row, now())) return decryptedToken(row, vaultOptions);
      if (!row.refresh_lease_expires_at || row.refresh_lease_expires_at <= now()) break;
    }
    if (!claimRefreshLease(row.id, owner, now())) {
      if (!force && Number(row.access_token_expires_at || 0) > now()) return decryptedToken(row, vaultOptions);
      throw new Error("Plex token refresh is already in progress");
    }
  }

  try {
    // Re-read after acquiring the lease: another process may have refreshed
    // between our first read and compare-and-set.
    row = activePlexRow();
    if (!force && tokenIsFresh(row, now())) {
      db.prepare("UPDATE media_connections SET refresh_lease_owner=NULL,refresh_lease_expires_at=NULL WHERE id=? AND refresh_lease_owner=?").run(row.id, owner);
      return decryptedToken(row, vaultOptions);
    }
    const refreshed = await refreshPlexJwt({ device: plexDevice(row), privateKey: getPlexPrivateKey({ vaultOptions }), fetchImpl, now: now() });
    const encrypted = encryptCredential(refreshed.token, vaultOptions);
    const updatedAt = now();
    const updated = db.prepare(`UPDATE media_connections SET credential_ciphertext=?,credential_iv=?,credential_tag=?,token_version=?,
      access_token_expires_at=?,last_refreshed_at=?,refresh_failure_count=0,status='connected',refresh_lease_owner=NULL,refresh_lease_expires_at=NULL,updated_at=?
      WHERE id=? AND refresh_lease_owner=?`).run(encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.version, refreshed.expiresAt, updatedAt, updatedAt, row.id, owner);
    if (updated.changes !== 1) throw new Error("Plex token refresh lease was lost before the credential could be saved");
    return refreshed.token;
  } catch (error) {
    releaseFailedLease(row, owner, error, now());
    const latest = activePlexRow();
    if (!force && latest && Number(latest.access_token_expires_at || 0) > now() && ![401, 403, 422].includes(Number(error?.status))) {
      return decryptedToken(latest, vaultOptions);
    }
    throw error;
  }
}

export async function getValidPlexServerToken({ force = false, fetchImpl = fetchWithTimeout, vaultOptions = {} } = {}) {
  const current = activePlexRow();
  if (!current) throw new Error("No connected Plex JWT account is configured");
  if (!force && current.server_credential_ciphertext) {
    const stored = decryptCredential({ ciphertext: current.server_credential_ciphertext, iv: current.server_credential_iv, tag: current.server_credential_tag, version: current.server_token_version }, vaultOptions);
    if (!looksLikeJwt(stored)) return stored;
  }
  const legacyFallback = encryptedLegacyPmsFallback(current, vaultOptions);
  if (legacyFallback) {
    storeServerToken(current.id, legacyFallback, vaultOptions);
    return legacyFallback;
  }
  if (serverTokenRefreshPromise) return serverTokenRefreshPromise;
  serverTokenRefreshPromise = (async () => {
    let accountToken = await getValidPlexToken({ vaultOptions });
    const device = plexDevice(current);
    const request = () => fetchImpl("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", { headers: plexClientHeaders(device, { token: accountToken }) });
    let response = await request();
    if (response.status === 401) {
      accountToken = await getValidPlexToken({ force: true, vaultOptions });
      response = await request();
    }
    if (!response.ok) throw Object.assign(new Error(`Plex server-token discovery failed with HTTP ${response.status}`), { status: response.status });
    const body = await response.json();
    const resources = Array.isArray(body) ? body : body?.MediaContainer?.Device || [];
    const server = resources.find((item) => String(item.clientIdentifier || item.machineIdentifier || "") === String(current.server_id));
    const token = String(server?.accessToken || server?.access_token || "");
    if (!token) throw new Error("Selected Plex server did not provide an access token");
    if (looksLikeJwt(token)) throw Object.assign(new Error("Plex returned an account JWT instead of a PMS-compatible token; reconnect the Plex account to obtain a compatibility token"), { status: 409 });
    storeServerToken(current.id, token, vaultOptions);
    return token;
  })();
  try {
    return await serverTokenRefreshPromise;
  } finally {
    serverTokenRefreshPromise = null;
  }
}
