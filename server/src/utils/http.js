// The API is same-origin only: no Access-Control-Allow-Origin is ever sent, so
// cross-origin reads are blocked by the browser. Same-origin requests (the SPA)
// and server-to-server callers (webhooks, cron) never preflight, so no other
// CORS headers are needed either.
function sanitizeResponseBody(body, status) {
  if (!body || typeof body !== "object") return body;
  if (status >= 500 && body.error) {
    const raw = typeof body.error === "string" ? body.error : (body.error?.message || "Internal server error");
    const sanitized = String(raw).split(/\r?\n/)[0].replace(/(\/|[A-Za-z]:\\)[^\s:]+/g, "[path]").trim();
    return { ...body, error: sanitized || "Internal server error" };
  }
  return body;
}

export function sendJson(res, body, status = 200, extraHeaders = {}) {
  const safeBody = sanitizeResponseBody(body, status);
  res.status(status).set({ "Content-Type": "application/json", ...extraHeaders }).send(JSON.stringify(safeBody));
}

export function sendOptions(res) {
  res.status(204).send("");
}

export function methodNotAllowed(res) {
  sendJson(res, { error: "Method not allowed" }, 405);
}

export function notFound(res) {
  sendJson(res, { error: "Not found" }, 404);
}
