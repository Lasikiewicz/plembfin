import packageJson from "../../../package.json" with { type: "json" };
import { assertSafeOutboundUrl, fetchWithTimeout, normalizeHttpUrl } from "./outbound.js";

function cleanBaseUrl(value, provider) {
  try {
    const baseUrl = normalizeHttpUrl(value, { label: `${provider} server URL` });
    if (!baseUrl) throw new Error(`${provider} server URL is required`);
    assertSafeOutboundUrl(baseUrl, { label: `${provider} server URL` });
    return baseUrl;
  } catch (error) {
    error.status = 400;
    error.expose = true;
    throw error;
  }
}

export function embyLikeAuthorization(device, { userId = "", token = "" } = {}) {
  const parts = [
    userId ? `UserId="${String(userId).replaceAll('"', "")}"` : "",
    'Client="Plembfin"',
    `Device="${String(device.deviceName || "Plembfin").replaceAll('"', "")}"`,
    `DeviceId="${String(device.deviceIdentifier).replaceAll('"', "")}"`,
    `Version="${packageJson.version}"`,
    token ? `Token="${String(token).replaceAll('"', "")}"` : "",
  ].filter(Boolean);
  return `MediaBrowser ${parts.join(", ")}`;
}

function headers(device, { userId = "", token = "" } = {}) {
  const authorization = embyLikeAuthorization(device, { userId, token });
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: authorization,
    "X-Emby-Authorization": authorization.replace(/^MediaBrowser /, "Emby "),
    ...(token ? { "X-Emby-Token": token, "X-MediaBrowser-Token": token } : {}),
  };
}

async function jsonResponse(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${label} failed with HTTP ${response.status}`);
    error.status = response.status === 401 || response.status === 403 ? 401 : 502;
    error.expose = true;
    throw error;
  }
  return body;
}

async function fetchServerIdentity(baseUrl, device, token, userId) {
  const response = await fetchWithTimeout(`${baseUrl}/System/Info`, { headers: headers(device, { token, userId }) });
  const body = await jsonResponse(response, "Media server identity check");
  const serverId = String(body.Id || body.ServerId || "").trim();
  if (!serverId) throw new Error("Media server identity response did not contain a server ID");
  return { serverId, serverName: String(body.ServerName || body.Name || "Media Server") };
}

async function verifyUser(baseUrl, device, token, user) {
  const userId = String(user?.Id || user?.id || "").trim();
  if (!userId) throw new Error("Authentication response did not contain a user ID");
  const response = await fetchWithTimeout(`${baseUrl}/Users/${encodeURIComponent(userId)}`, { headers: headers(device, { token, userId }) });
  const verified = await jsonResponse(response, "Media user verification");
  if (String(verified.Id || "") !== userId) throw new Error("Authenticated media user identity did not match");
  return { userId, username: String(verified.Name || user?.Name || "") };
}

export async function authenticateEmbyLike({ provider, baseUrl: inputUrl, username, password, device, quickConnectSecret = "" }) {
  const baseUrl = cleanBaseUrl(inputUrl, provider);
  const quickConnect = Boolean(quickConnectSecret);
  const endpoint = quickConnect ? "/Users/AuthenticateWithQuickConnect" : "/Users/AuthenticateByName";
  const payload = quickConnect
    ? { Secret: String(quickConnectSecret) }
    : { Username: String(username || "").trim(), Pw: String(password || "") };
  if (!quickConnect && !payload.Username) throw Object.assign(new Error("Username is required"), { status: 400, expose: true });
  const response = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: headers(device),
    body: JSON.stringify(payload),
  });
  const body = await jsonResponse(response, `${provider} sign-in`);
  const token = String(body.AccessToken || body.accessToken || "").trim();
  if (!token) throw new Error(`${provider} sign-in did not return an access token`);
  const identity = await verifyUser(baseUrl, device, token, body.User || {});
  const server = await fetchServerIdentity(baseUrl, device, token, identity.userId);
  return { baseUrl, token, ...identity, ...server };
}

export async function jellyfinQuickConnectEnabled(baseUrl, device) {
  const normalized = cleanBaseUrl(baseUrl, "Jellyfin");
  const response = await fetchWithTimeout(`${normalized}/QuickConnect/Enabled`, { headers: headers(device) });
  if (!response.ok) return false;
  return Boolean(await response.json().catch(() => false));
}

export async function initiateJellyfinQuickConnect(baseUrl, device) {
  const normalized = cleanBaseUrl(baseUrl, "Jellyfin");
  const response = await fetchWithTimeout(`${normalized}/QuickConnect/Initiate`, { method: "POST", headers: headers(device), body: "{}" });
  const body = await jsonResponse(response, "Jellyfin Quick Connect initiation");
  const secret = String(body.Secret || "");
  const code = String(body.Code || "");
  if (!secret || !code) throw new Error("Jellyfin Quick Connect did not return a code and secret");
  return { baseUrl: normalized, secret, code, expiresAt: Date.now() + 5 * 60_000 };
}

export async function pollJellyfinQuickConnect(baseUrl, device, secret) {
  const normalized = cleanBaseUrl(baseUrl, "Jellyfin");
  const url = new URL(`${normalized}/QuickConnect/Connect`);
  url.searchParams.set("Secret", String(secret));
  const response = await fetchWithTimeout(url, { headers: headers(device) });
  if (response.status === 404 || response.status === 401) return { authorised: false };
  const body = await jsonResponse(response, "Jellyfin Quick Connect status");
  return { authorised: Boolean(body.Authenticated) };
}

export async function logoutEmbyLike(connection, device) {
  if (!connection?.credential || !connection?.baseUrl) return false;
  try {
    const response = await fetchWithTimeout(`${connection.baseUrl}/Sessions/Logout`, {
      method: "POST",
      headers: headers(device, { token: connection.credential, userId: connection.remoteUserId }),
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}
