import { auth } from "../firebase.js";
import { sendJson } from "./http.js";

const LOCAL_ADMIN_TOKEN = "plembfin-local-admin";

function parseList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function bearerToken(req) {
  const header = req.get("authorization") || req.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token) return token;
  return String(req.query?.token || req.query?.admin_token || "").trim();
}

export function isLocalAdminToken(token = "") {
  const localRuntime = process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  return localRuntime && String(token || "") === LOCAL_ADMIN_TOKEN;
}

export async function requireAdmin(req, res) {
  const token = bearerToken(req);
  if (!token) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return null;
  }

  if (isLocalAdminToken(token)) {
    return { uid: "local-admin", email: "admin", local: true };
  }

  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch (error) {
    sendJson(res, { error: "Unauthorized", details: "Invalid Firebase ID token" }, 401);
    return null;
  }

  const allowedEmails = parseList(process.env.ADMIN_EMAILS);
  const allowedUids = parseList(process.env.ADMIN_UIDS);
  const email = String(decoded.email || "").toLowerCase();
  const uid = String(decoded.uid || "").toLowerCase();

  if (!allowedEmails.length && !allowedUids.length) {
    sendJson(res, { error: "Admin allowlist is not configured", details: "Set ADMIN_EMAILS or ADMIN_UIDS for the Functions runtime." }, 403);
    return null;
  }

  if ((allowedEmails.length && allowedEmails.includes(email)) || (allowedUids.length && allowedUids.includes(uid))) {
    return decoded;
  }

  sendJson(res, { error: "Forbidden" }, 403);
  return null;
}
