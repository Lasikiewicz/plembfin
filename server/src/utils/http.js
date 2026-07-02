// The API is same-origin only: no Access-Control-Allow-Origin is ever sent, so
// cross-origin reads are blocked by the browser. Same-origin requests (the SPA)
// and server-to-server callers (webhooks, cron) never preflight, so no other
// CORS headers are needed either.
export function sendJson(res, body, status = 200, extraHeaders = {}) {
  res.status(status).set({ "Content-Type": "application/json", ...extraHeaders }).send(JSON.stringify(body));
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
