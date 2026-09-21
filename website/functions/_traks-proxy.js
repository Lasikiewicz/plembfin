const REQUEST_HEADERS = ["accept", "content-type", "origin", "referer", "user-agent"];
const RESPONSE_HEADERS = ["cache-control", "content-type", "etag", "expires", "last-modified", "vary"];

function resolveCollectorOrigin(env = {}) {
  const candidate = String(env.TRAKS_COLLECTOR_ORIGIN || env.PUBLIC_TRAKS_SCRIPT_URL || "").trim();
  if (!candidate) return "";

  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:") throw new Error("Traks collector URL must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Traks collector URL must not contain embedded credentials");
  return parsed.origin;
}

function upstreamPath(pathname) {
  if (pathname === "/t" || pathname === "/t/") return "/t.js";
  if (pathname === "/api/event") return "/api/event";
  return "";
}

function proxyHeaders(request) {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
    headers.set("X-Real-IP", clientIp);
  }
  return headers;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function proxyTraksRequest({ request, env }) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const isTracker = url.pathname === "/t" || url.pathname === "/t/";
  const allowedMethods = isTracker ? ["GET", "HEAD"] : ["POST"];

  if (method === "OPTIONS") return new Response(null, { status: 204 });
  if (!allowedMethods.includes(method)) {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        Allow: [...allowedMethods, "OPTIONS"].join(", "),
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }

  let collectorOrigin;
  try {
    collectorOrigin = resolveCollectorOrigin(env);
  } catch {
    return errorResponse(500, "Traks analytics is not configured");
  }
  if (!collectorOrigin) return errorResponse(404, "Traks analytics is not configured");

  const targetPath = upstreamPath(url.pathname);
  const target = new URL(targetPath, `${collectorOrigin}/`);
  target.search = url.search;

  try {
    const upstream = await fetch(target, {
      method,
      headers: proxyHeaders(request),
      ...(method === "GET" || method === "HEAD" ? {} : { body: request.body }),
    });
    const headers = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (isTracker) headers.set("Content-Type", upstream.headers.get("content-type") || "application/javascript; charset=utf-8");
    else headers.set("Cache-Control", "no-store");

    return new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return errorResponse(502, "Traks collector unavailable");
  }
}
