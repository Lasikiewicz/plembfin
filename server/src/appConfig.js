import fs from "node:fs";
import crypto from "node:crypto";
import { CONFIG_PATH, ensureDataDirs } from "./paths.js";

ensureDataDirs();

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeConfigFile(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* non-POSIX FS (Windows, some Docker volumes) */ }
}

function hashPassword(plain, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

// Returns true when the stored hash matches the default "admin" password.
function isDefaultPasswordHash(hash = "") {
  const [scheme, salt, storedHash] = String(hash).split("$");
  if (scheme !== "scrypt" || !salt || !storedHash) return false;
  try {
    const candidate = crypto.scryptSync("admin", salt, 64).toString("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(storedHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Resolve the auth config from data/config.json, applying env overrides and
// generating an API key / session secret on first boot. Persists any changes.
function resolveAuthConfig() {
  const stored = readConfigFile();
  let changed = false;
  const authManagedInApp = stored.authManagedInApp === true;

  const username = String(authManagedInApp ? stored.username || "admin" : process.env.ADMIN_USERNAME || stored.username || "admin");
  if (stored.username !== username) { stored.username = username; changed = true; }

  // Password: an env override (re)hashes; otherwise keep the stored hash, or
  // fall back to a default "admin" password on a brand-new install.
  if (!authManagedInApp && process.env.ADMIN_PASSWORD) {
    stored.passwordHash = hashPassword(process.env.ADMIN_PASSWORD);
    changed = true;
  } else if (!stored.passwordHash) {
    stored.passwordHash = hashPassword("admin");
    changed = true;
  }

  const apiKey = String(process.env.API_KEY || stored.apiKey || crypto.randomBytes(24).toString("hex"));
  if (stored.apiKey !== apiKey) { stored.apiKey = apiKey; changed = true; }

  const webhookSecret = String(process.env.WEBHOOK_SECRET || stored.webhookSecret || crypto.randomBytes(24).toString("hex"));
  if (stored.webhookSecret !== webhookSecret) { stored.webhookSecret = webhookSecret; changed = true; }

  const sessionSecret = String(process.env.SESSION_SECRET || stored.sessionSecret || crypto.randomBytes(32).toString("hex"));
  if (stored.sessionSecret !== sessionSecret) { stored.sessionSecret = sessionSecret; changed = true; }

  if (changed) writeConfigFile(stored);
  return stored;
}

const config = resolveAuthConfig();

// Runs once at startup to warn about insecure configuration.
function logSecuritySummary() {
  const warnings = [];

  if (isDefaultPasswordHash(config.passwordHash)) {
    warnings.push("ADMIN PASSWORD IS DEFAULT ('admin') — change it immediately in Settings → General");
  } else if (!config.authManagedInApp && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 8) {
    warnings.push("ADMIN_PASSWORD is shorter than 8 characters — use a stronger password");
  }

  if (config.sessionSecret && config.sessionSecret.length < 32) {
    warnings.push("SESSION_SECRET is shorter than 32 characters — regenerate it");
  }
  if (config.apiKey && config.apiKey.length < 32) {
    warnings.push("API_KEY is shorter than 32 characters — use a longer key");
  }
  if (config.webhookSecret && config.webhookSecret.length < 32) {
    warnings.push("WEBHOOK_SECRET is shorter than 32 characters — use a longer secret");
  }

  const pinned = [];
  const generated = [];
  if (process.env.API_KEY) pinned.push("API_KEY"); else generated.push("API_KEY");
  if (process.env.WEBHOOK_SECRET) pinned.push("WEBHOOK_SECRET"); else generated.push("WEBHOOK_SECRET");
  if (process.env.SESSION_SECRET) pinned.push("SESSION_SECRET"); else generated.push("SESSION_SECRET");

  if (warnings.length > 0) {
    console.warn("⚠️  Security warnings:");
    for (const w of warnings) console.warn(`   • ${w}`);
  }
  if (generated.length > 0) {
    console.log(`[security] Auto-generated secrets: ${generated.join(", ")} (persisted in data/config.json)`);
  }
  if (pinned.length > 0) {
    console.log(`[security] Pinned secrets from env: ${pinned.join(", ")}`);
  }
}

logSecuritySummary();

export const AUTH = {
  username: config.username,
  apiKey: config.apiKey,
  webhookSecret: config.webhookSecret,
  sessionSecret: config.sessionSecret,
};

export function isDefaultPassword() {
  return isDefaultPasswordHash(config.passwordHash);
}

export function verifyWebhookToken(token) {
  if (!token || !AUTH.webhookSecret) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(AUTH.webhookSecret);
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; }
}

export function rotateWebhookSecret() {
  const newSecret = crypto.randomBytes(24).toString("hex");
  const nextConfig = { ...config, webhookSecret: newSecret };
  writeConfigFile(nextConfig);
  Object.assign(config, nextConfig);
  AUTH.webhookSecret = newSecret;
  return newSecret;
}

export function verifyPassword(plain) {
  const stored = String(config.passwordHash || "");
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyUsername(name) {
  return String(name || "") === config.username;
}

export function updateAdminCredentials({ username, password = "" }) {
  const nextUsername = String(username || "").trim();
  if (!nextUsername) throw new Error("Username is required");

  const nextConfig = {
    ...config,
    username: nextUsername,
    authManagedInApp: true,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
  };
  if (password) nextConfig.passwordHash = hashPassword(password);
  writeConfigFile(nextConfig);
  Object.assign(config, nextConfig);

  AUTH.username = config.username;
  AUTH.sessionSecret = config.sessionSecret;
  return { username: config.username };
}
