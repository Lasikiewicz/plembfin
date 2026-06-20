import crypto from "node:crypto";
import { AUTH, updateAdminCredentials, rotateWebhookSecret, verifyPassword, verifyUsername } from "../appConfig.js";
import { writeAuditLog } from "../db.js";
import { readJson } from "./requestBody.js";
import { sendJson } from "./http.js";

const COOKIE_NAME = "plembfin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

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
  return "";
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

// --- Auth routes -----------------------------------------------------------
export async function handleLogin(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || body.email || "").trim();
  const password = String(body.password || "");
  const ip = req.ip || req.socket?.remoteAddress;
  if (!verifyUsername(username) || !verifyPassword(password)) {
    writeAuditLog("login.failure", { ip, detail: { username } });
    return sendJson(res, { error: "Invalid username or password" }, 401);
  }
  writeAuditLog("login.success", { ip, detail: { username } });
  res.cookie(COOKIE_NAME, signSession(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return sendJson(res, { ok: true, username });
}

export async function handleLogout(req, res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  return sendJson(res, { ok: true });
}

export async function handleAuthStatus(req, res) {
  const principal = resolvePrincipal(req);
  if (!principal) return sendJson(res, { authenticated: false });
  return sendJson(res, { authenticated: true, username: principal.username });
}

export async function handleAuthApiKey(req, res) {
  if (req.method !== "GET") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!(await requireAdmin(req, res))) return;
  return sendJson(res, { apiKey: AUTH.apiKey });
}

export async function handleAuthWebhookSecret(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!(await requireAdmin(req, res))) return;
  if (req.method === "POST") {
    const newSecret = rotateWebhookSecret();
    writeAuditLog("webhook-secret.rotated", { ip: req.ip || req.socket?.remoteAddress });
    return sendJson(res, { webhookToken: newSecret });
  }
  return sendJson(res, { webhookToken: AUTH.webhookSecret });
}

export async function handleRevokeAllSessions(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  const principal = await requireAdmin(req, res);
  if (!principal) return;
  const callerUsername = principal.username;
  // updateAdminCredentials regenerates sessionSecret, persists it, and updates AUTH —
  // this atomically invalidates all existing signed cookies.
  updateAdminCredentials({ username: AUTH.username, password: "" });
  writeAuditLog("sessions.revoked", { ip: req.ip || req.socket?.remoteAddress, detail: { username: callerUsername } });
  // Issue a fresh cookie for the current caller so they stay logged in.
  res.cookie(COOKIE_NAME, signSession(callerUsername), {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return sendJson(res, { ok: true, message: "All other sessions have been revoked." });
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
  writeAuditLog("credentials.updated", { ip: req.ip || req.socket?.remoteAddress, detail: { username } });
  res.cookie(COOKIE_NAME, signSession(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return sendJson(res, { ok: true, username });
}
