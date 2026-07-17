const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_OUTBOUND_REDIRECTS = 5;

export function createUpstreamTimeoutError(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const error = new Error(`Upstream request timed out after ${timeoutMs}ms`);
  error.status = 504;
  error.code = "UPSTREAM_TIMEOUT";
  return error;
}

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
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`${label} targets a blocked metadata endpoint`);
  }
  return url;
}

function redirectRequestOptions(options, status, fromUrl, toUrl) {
  const redirected = { ...options };
  const method = String(redirected.method || "GET").toUpperCase();
  if ((status === 303 && method !== "GET" && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
    redirected.method = "GET";
    delete redirected.body;
  }

  if (fromUrl.origin !== toUrl.origin && redirected.headers) {
    const headers = new Headers(redirected.headers);
    for (const name of [...headers.keys()]) {
      if (/authorization|cookie|token|api[-_]?key|secret/i.test(name)) headers.delete(name);
    }
    redirected.headers = headers;
  }
  return redirected;
}

async function fetchFollowingSafeRedirects(url, options) {
  let currentUrl = assertSafeOutboundUrl(url, { label: "Outbound URL" });
  let currentOptions = { ...options, redirect: "manual" };

  for (let redirects = 0; redirects <= MAX_OUTBOUND_REDIRECTS; redirects += 1) {
    // The URL and every redirect target are validated immediately above/below. This
    // application deliberately permits configured LAN media servers, while blocking
    // cloud-metadata endpoints and unsafe URL forms at this shared request boundary.
    // CodeQL's js/request-forgery query is excluded repo-wide in
    // .github/codeql/codeql-config.yml for this exact reason — see that file for why.
    const response = await fetch(currentUrl, currentOptions);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_OUTBOUND_REDIRECTS) throw new Error("Upstream request exceeded the redirect limit");

    const nextUrl = assertSafeOutboundUrl(new URL(location, currentUrl), { label: "Outbound redirect URL" });
    await response.body?.cancel();
    currentOptions = { ...redirectRequestOptions(currentOptions, response.status, currentUrl, nextUrl), redirect: "manual" };
    currentUrl = nextUrl;
  }

  throw new Error("Upstream request exceeded the redirect limit");
}

// Set PLEMBFIN_DEBUG_OUTBOUND=1 to log a per-host outbound request count once
// a minute (visible in Settings → Logs via the diagnostic logger). Useful for
// measuring how much traffic each upstream (TMDB, TVDB, fanart.tv, media
// servers) actually receives before/after a caching change.
const DEBUG_OUTBOUND = ["1", "true"].includes(String(process.env.PLEMBFIN_DEBUG_OUTBOUND || "").toLowerCase());
const outboundCounts = new Map();
let outboundWindowStartedAt = 0;

function trackOutbound(url) {
  if (!DEBUG_OUTBOUND) return;
  let host = "";
  try {
    host = new URL(String(url)).host;
  } catch {
    host = "unparsed";
  }
  const now = Date.now();
  if (!outboundWindowStartedAt) outboundWindowStartedAt = now;
  outboundCounts.set(host, (outboundCounts.get(host) || 0) + 1);
  if (now - outboundWindowStartedAt >= 60_000) {
    const summary = [...outboundCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
    console.log(`[outbound] last ${Math.round((now - outboundWindowStartedAt) / 1000)}s: ${summary}`);
    outboundCounts.clear();
    outboundWindowStartedAt = now;
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const safeUrl = assertSafeOutboundUrl(url, { label: "Outbound URL" });
  trackOutbound(safeUrl);
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const timeoutError = createUpstreamTimeoutError(timeoutMs);
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }

  try {
    return await fetchFollowingSafeRedirects(safeUrl, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", abortFromUpstream);
  }
}
