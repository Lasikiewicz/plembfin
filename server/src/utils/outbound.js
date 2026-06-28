const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export function normalizeHttpUrl(value = "", { label = "URL", allowRelativeMedia = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (allowRelativeMedia && raw.startsWith("/media/")) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  return url.toString().replace(/\/+$/, "");
}

// Cloud-metadata endpoints (AWS/GCP/Azure/etc.) are the one outbound target that is
// dangerous even in a self-hosted, admin-only context: a tricked request there can leak
// instance credentials. We intentionally do NOT block general private/LAN ranges because
// Plex/Emby/Jellyfin commonly run on localhost or the local network.
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "[fd00:ec2::254]",
  "fd00:ec2::254",
]);

export function assertSafeOutboundUrl(value, { label = "URL" } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`${label} targets a blocked metadata endpoint`);
  }
  return url;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", abortFromUpstream);
  }
}
