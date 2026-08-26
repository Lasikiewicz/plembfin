import crypto from "node:crypto";
import { AUTH, updateAdminCredentials, rotateWebhookSecret, verifyPassword, verifyUsername, isDefaultPassword, isClaimRequired } from "../appConfig.js";
import { claimAccount } from "./onboardingStore.js";
import { writeAuditLog } from "../db.js";
import { readJson } from "./requestBody.js";
import { sendJson } from "./http.js";
import { checkRateLimit } from "./rateLimit.js";

const COOKIE_NAME = "plembfin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const AUTH_RATE_LIMIT = { max: 10, windowMs: 15 * 60_000 };

function callerIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// Rejects cross-site POSTs that carry an Origin header pointing elsewhere.
// Requests with no Origin header (same-origin form posts in older browsers,
// server-to-server API/webhook callers) are allowed through - this guards
// browser-driven CSRF, not general API access.
function isSameOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.get("host");
    return Boolean(requestHost) && originHost === requestHost;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
export function resolveAdminPrincipal(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const session = cookieToken ? verifySession(cookieToken) : null;
  if (session) return { username: session.username, via: "session" };
  if (matchesApiKey(apiKeyFromRequest(req))) return { username: AUTH.username, via: "apikey", apiKey: true };
  return null;
}

export async function requireAdmin(req, res) {
  const principal = resolveAdminPrincipal(req);
  if (!principal) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return null;
  }
  return principal;
}

// --- Auth routes -----------------------------------------------------------
export async function handleLogin(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-site request rejected", code: "ORIGIN_REJECTED", retryable: false }, 403);
  const ip = callerIp(req);
  if (!checkRateLimit(`login:${ip}`, AUTH_RATE_LIMIT)) {
    return sendJson(res, { error: "Too many attempts. Try again later.", code: "RATE_LIMITED", retryable: true }, 429);
  }
  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || body.email || "").trim();
  const password = String(body.password || "");
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
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  return sendJson(res, { ok: true });
}

export async function handleAuthStatus(req, res) {
  const principal = resolveAdminPrincipal(req);
  if (!principal) return sendJson(res, { authenticated: false, claimRequired: isClaimRequired() });
  return sendJson(res, {
    authenticated: true,
    username: principal.username,
    mustChangePassword: isDefaultPassword(),
    claimRequired: false,
  });
}

// One-time administrator account claim for a pristine install. Only usable
// while isClaimRequired() is true (no ADMIN_PASSWORD, no prior in-app
// credentials); requireAdmin()/resolveAdminPrincipal() gate every other route
// separately with a CLAIM_REQUIRED 403 while unclaimed, so this handler
// itself is intentionally public (see scripts/build-check.js publicHandlers).
export async function handleAuthClaim(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-site request rejected", code: "ORIGIN_REJECTED", retryable: false }, 403);
  const ip = callerIp(req);
  if (!checkRateLimit(`claim:${ip}`, AUTH_RATE_LIMIT)) {
    return sendJson(res, { error: "Too many attempts. Try again later.", code: "RATE_LIMITED", retryable: true }, 429);
  }
  // Artificial delay so a flood of claim attempts against slightly different
  // request timings can't be used to time the atomic-claim race window.
  await sleep(150 + Math.floor(Math.random() * 150));

  if (!isClaimRequired()) {
    return sendJson(res, { error: "This instance has already been claimed", code: "CLAIM_CONFLICT", retryable: false }, 409);
  }

  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const confirmPassword = String(body.confirmPassword || "");

  if (!username) return sendJson(res, { error: "Username is required", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (username.length > 128) return sendJson(res, { error: "Username must be 128 characters or fewer", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (password.length < 8) return sendJson(res, { error: "Password must be at least 8 characters", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (password.length > 256) return sendJson(res, { error: "Password must be 256 characters or fewer", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (password !== confirmPassword) return sendJson(res, { error: "Passwords do not match", code: "VALIDATION_FAILED", retryable: false }, 400);

  const won = claimAccount();
  if (!won) {
    // Someone else's claim committed first inside the same SQLite immediate
    // transaction window - fall back to sign-in, no credentials revealed.
    writeAuditLog("account.claim_conflict", { ip, detail: { username } });
    return sendJson(res, { error: "This instance has already been claimed", code: "CLAIM_CONFLICT", retryable: false }, 409);
  }

  updateAdminCredentials({ username, password });
  writeAuditLog("account.claimed", { ip, detail: { username } });
  res.cookie(COOKIE_NAME, signSession(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return sendJson(res, { ok: true, username });
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
  // updateAdminCredentials regenerates sessionSecret, persists it, and updates AUTH -
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
