import crypto from "node:crypto";
import { AUTH, updateAdminCredentials, verifyPassword, verifyUsername } from "../appConfig.js";
import { readJson } from "./requestBody.js";
import { sendJson } from "./http.js";

const COOKIE_NAME = "plembfin_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- Stateless signed session cookie --------------------------------------
function signSession(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token = "") {
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", AUTH.sessionSecret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.iat || Date.now() - data.iat > SESSION_TTL_MS) return null;
    return { username: data.u };
  } catch {
    return null;
  }
}

function apiKeyFromRequest(req) {
  const header = req.get("x-api-key") || req.get("X-Api-Key") || "";
  if (header) return header.trim();
  const auth = req.get("authorization") || req.get("Authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return String(req.query?.api_key || req.query?.token || req.query?.admin_token || "").trim();
}

function matchesApiKey(value) {
  if (!value || !AUTH.apiKey) return false;
  const a = Buffer.from(String(value));
  const b = Buffer.from(AUTH.apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Resolve the authenticated principal from either a valid session cookie or the
// API key, without sending a response. Returns the principal or null.
function resolvePrincipal(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const session = cookieToken ? verifySession(cookieToken) : null;
  if (session) return { username: session.username, via: "session" };
  if (matchesApiKey(apiKeyFromRequest(req))) return { username: AUTH.username, via: "apikey", apiKey: true };
  return null;
}

export async function requireAdmin(req, res) {
  const principal = resolvePrincipal(req);
  if (!principal) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return null;
  }
  return principal;
}

// Streaming variant: headers are already sent, so report failures in the body.
export async function requireAdminStreaming(req, res) {
  const principal = resolvePrincipal(req);
  if (!principal) {
    res.write("ERROR: Unauthorized\n");
    res.end();
    return null;
  }
  return principal;
}

// --- Auth routes -----------------------------------------------------------
export async function handleLogin(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || body.email || "").trim();
  const password = String(body.password || "");
  if (!verifyUsername(username) || !verifyPassword(password)) {
    return sendJson(res, { error: "Invalid username or password" }, 401);
  }
  res.cookie(COOKIE_NAME, signSession(username), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return sendJson(res, { ok: true, username, apiKey: AUTH.apiKey });
}

export async function handleLogout(req, res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  return sendJson(res, { ok: true });
}

export async function handleAuthStatus(req, res) {
  const principal = resolvePrincipal(req);
  if (!principal) return sendJson(res, { authenticated: false });
  return sendJson(res, { authenticated: true, username: principal.username, apiKey: AUTH.apiKey });
}

export async function handleAuthCredentials(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || "").trim();
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (!verifyPassword(currentPassword)) {
    return sendJson(res, { error: "Current password is incorrect" }, 401);
  }
  if (!username) return sendJson(res, { error: "Username is required" }, 400);
  if (username.length > 128) return sendJson(res, { error: "Username must be 128 characters or fewer" }, 400);
  if (newPassword && newPassword.length < 8) {
    return sendJson(res, { error: "New password must be at least 8 characters" }, 400);
  }
  if (newPassword.length > 256) {
    return sendJson(res, { error: "New password must be 256 characters or fewer" }, 400);
  }

  updateAdminCredentials({ username, password: newPassword });
  res.cookie(COOKIE_NAME, signSession(username), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return sendJson(res, { ok: true, username, apiKey: AUTH.apiKey });
}
