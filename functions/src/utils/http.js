export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Admin-Token",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export function sendJson(res, body, status = 200, extraHeaders = {}) {
  res.status(status).set({ "Content-Type": "application/json", ...corsHeaders, ...extraHeaders }).send(JSON.stringify(body));
}

export function sendOptions(res) {
  res.status(204).set(corsHeaders).send("");
}

export function methodNotAllowed(res) {
  sendJson(res, { error: "Method not allowed" }, 405);
}

export function notFound(res) {
  sendJson(res, { error: "Not found" }, 404);
}
