import { fetchWithTimeout } from "./outbound.js";
import { getValidPlexServerToken } from "./plexTokenManager.js";

export function plexRequestHeaders(config = {}, accept = "application/json") {
  const headers = { Accept: accept, "X-Plex-Token": String(config.token || "") };
  if (config.clientIdentifier) headers["X-Plex-Client-Identifier"] = String(config.clientIdentifier);
  return headers;
}

function managedConnection(config = {}) {
  return Boolean(config.connectionId && ["plex_jwt", "plex_managed_jwt"].includes(config.authKind));
}

export async function fetchPlexWithRefresh(config, url, options = {}, timeoutMs = undefined, { fetchImpl = fetchWithTimeout, refreshToken = getValidPlexServerToken } = {}) {
  const request = (token) => fetchImpl(url, {
    ...options,
    headers: { ...plexRequestHeaders({ ...config, token }, options.headers?.Accept || options.headers?.accept || "application/json"), ...(options.headers || {}), "X-Plex-Token": token },
  }, timeoutMs);
  let response = await request(config.token);
  if (response.status !== 401 || !managedConnection(config)) return response;
  const token = await refreshToken({ force: true });
  config.token = token;
  response = await request(token);
  return response;
}
