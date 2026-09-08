import packageJson from "../../../package.json" with { type: "json" };

function cleanHeaderValue(value = "") {
  return String(value ?? "").replaceAll('"', "").trim();
}

// Keep accepting every credential shape used by older Plembfin installs and
// connection modes. Manual API keys and account/Quick Connect access tokens
// are both valid values for Jellyfin's Token field.
export function jellyfinCredential(config = {}) {
  for (const value of [config.apiKey, config.api_key, config.token]) {
    const credential = String(value ?? "").trim();
    if (credential) return credential;
  }
  return "";
}

export function jellyfinAuthorization(config = {}) {
  const token = jellyfinCredential(config);
  const parts = [
    config.userId ? `UserId="${cleanHeaderValue(config.userId)}"` : "",
    'Client="Plembfin"',
    'Device="Plembfin"',
    'DeviceId="plembfin"',
    `Version="${cleanHeaderValue(packageJson.version)}"`,
    token ? `Token="${cleanHeaderValue(token)}"` : "",
  ].filter(Boolean);
  return `MediaBrowser ${parts.join(", ")}`;
}

// Jellyfin's modern Authorization header is the preferred and sufficient
// authentication mechanism for server-side Plembfin requests. Do not add the
// deprecated X-Emby/X-MediaBrowser token headers here: Jellyfin recommends
// avoiding multiple token mechanisms on one request.
export function jellyfinAuthHeaders(config = {}) {
  return {
    Accept: "application/json",
    Authorization: jellyfinAuthorization(config),
  };
}

// Browser/media URLs cannot generally attach an Authorization header, so use
// Jellyfin's supported query spelling only at those URL boundaries. Callers
// making fetch requests should use jellyfinAuthHeaders instead of both forms.
export function setJellyfinApiKey(url, config = {}) {
  const token = jellyfinCredential(config);
  if (token && url?.searchParams?.set) url.searchParams.set("ApiKey", token);
  return url;
}
