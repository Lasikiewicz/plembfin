import { assertSafeOutboundUrl, fetchWithTimeout } from "./outbound.js";

const DEFAULT_PROXY_TIMEOUT_MS = 10_000;
const REQUEST_HEADERS = ["accept", "content-type", "origin", "referer", "user-agent"];
const RESPONSE_HEADERS = ["cache-control", "content-type", "etag", "expires", "last-modified", "vary"];

function requestPath(req) {
  return new URL(req.originalUrl || req.url || "/", "http://plembfin.invalid");
}

function routePath(pathname) {
  if (pathname === "/t" || pathname === "/t/") return "/t.js";
  if (pathname === "/api/event") return "/api/event";
  return "";
}

export function resolveTraksCollectorOrigin({ collectorOrigin = "", legacyScriptUrl = "" } = {}) {
  const candidate = String(collectorOrigin || legacyScriptUrl || "").trim();
  if (!candidate) return "";

  const parsed = assertSafeOutboundUrl(candidate, { label: "Traks collector URL" });
  if (parsed.protocol !== "https:") throw new Error("Traks collector URL must use HTTPS");
  return parsed.origin;
}

export function getTraksUpstreamUrl(pathname, collectorOrigin, search = "") {
  const upstreamPath = routePath(pathname);
  if (!upstreamPath) throw new Error("Unsupported Traks proxy route");

  const origin = resolveTraksCollectorOrigin({ collectorOrigin });
  if (!origin) return null;
  const target = new URL(upstreamPath, `${origin}/`);
  target.search = String(search || "");
  return target;
}

function copyRequestHeaders(req) {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.get(name);
    if (value) headers.set(name, value);
  }

  // Preserve the visitor address when the demo is behind a trusted reverse
  // proxy. Do not accept an arbitrary incoming X-Forwarded-For value.
  const clientIp = req.get("cf-connecting-ip") || req.ip || req.socket?.remoteAddress || "";
  if (clientIp) {
    headers.set("x-forwarded-for", clientIp);
    headers.set("x-real-ip", clientIp);
  }
  return headers;
}

function copyResponseHeaders(upstream, res) {
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

function sendProxyError(res, status, message) {
  if (res.headersSent) return;
  res.status(status).type("json").json({ error: message });
}

export function createTraksProxyHandler({ collectorOrigin = "", timeoutMs = DEFAULT_PROXY_TIMEOUT_MS } = {}) {
  return async function traksProxyHandler(req, res) {
    const method = String(req.method || "GET").toUpperCase();
    if (method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    const pathnameUrl = requestPath(req);
    const isTracker = pathnameUrl.pathname === "/t" || pathnameUrl.pathname === "/t/";
    const allowedMethods = isTracker ? ["GET", "HEAD"] : ["POST"];
    if (!allowedMethods.includes(method)) {
      res.set("Allow", [...allowedMethods, "OPTIONS"].join(", "));
      sendProxyError(res, 405, "Method not allowed");
      return;
    }

    let target;
    try {
      target = getTraksUpstreamUrl(pathnameUrl.pathname, collectorOrigin, pathnameUrl.search);
    } catch (error) {
      console.warn(`[analytics] Traks proxy disabled: ${error.message}`);
      sendProxyError(res, 404, "Traks analytics is not configured");
      return;
    }
    if (!target) {
      sendProxyError(res, 404, "Traks analytics is not configured");
      return;
    }

    try {
      const body = method === "GET" || method === "HEAD" ? undefined : req.body;
      const upstream = await fetchWithTimeout(target, {
        method,
        headers: copyRequestHeaders(req),
        ...(body === undefined ? {} : { body }),
        lane: "analytics",
        allowDemoAnalytics: true,
      }, timeoutMs);

      copyResponseHeaders(upstream, res);
      if (isTracker) res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/javascript; charset=utf-8");
      else res.setHeader("Cache-Control", "no-store");
      res.status(upstream.status);
      if (method === "HEAD") {
        res.end();
        return;
      }
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      console.warn(`[analytics] Traks proxy request failed: ${error.message}`);
      sendProxyError(res, 502, "Traks collector unavailable");
    }
  };
}
