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

const MIN_SECRET_LENGTH = 32;

// Auto-generated secrets are always long enough (hex-encoded randomBytes), so
// this only ever fires for a value pinned via env or hand-edited into
// data/config.json — fail fast at startup rather than merely warn.
function assertMinSecretLength(name, value) {
  const length = String(value || "").length;
  if (length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${length}). ` +
      `Set a longer ${name} via environment variable, or remove it from data/config.json to auto-generate one.`,
    );
  }
}

// Set when resolveAuthConfig generates a random password for a brand-new
// install, so logSecuritySummary can print it once. Never persisted in
// plaintext — only the scrypt hash goes into data/config.json.
let generatedInitialPassword = null;

// Resolve the auth config from data/config.json, applying env overrides and
// generating an API key / session secret on first boot. Persists any changes.
function resolveAuthConfig() {
  const stored = readConfigFile();
  let changed = false;
  const authManagedInApp = stored.authManagedInApp === true;

  const username = String(authManagedInApp ? stored.username || "admin" : process.env.ADMIN_USERNAME || stored.username || "admin");
  if (stored.username !== username) { stored.username = username; changed = true; }

  // Password: an env override (re)hashes; otherwise keep the stored hash, or
  // generate a random one on a brand-new install (printed once at startup).
  if (!authManagedInApp && process.env.ADMIN_PASSWORD) {
    stored.passwordHash = hashPassword(process.env.ADMIN_PASSWORD);
    changed = true;
  } else if (!stored.passwordHash) {
    generatedInitialPassword = crypto.randomBytes(12).toString("base64url");
    stored.passwordHash = hashPassword(generatedInitialPassword);
    changed = true;
  }

  const apiKey = String(process.env.API_KEY || stored.apiKey || crypto.randomBytes(24).toString("hex"));
  assertMinSecretLength("API_KEY", apiKey);
  if (stored.apiKey !== apiKey) { stored.apiKey = apiKey; changed = true; }

  const webhookSecret = String(process.env.WEBHOOK_SECRET || stored.webhookSecret || crypto.randomBytes(24).toString("hex"));
  assertMinSecretLength("WEBHOOK_SECRET", webhookSecret);
  if (stored.webhookSecret !== webhookSecret) { stored.webhookSecret = webhookSecret; changed = true; }

  const sessionSecret = String(process.env.SESSION_SECRET || stored.sessionSecret || crypto.randomBytes(32).toString("hex"));
  assertMinSecretLength("SESSION_SECRET", sessionSecret);
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
  if (config.authManagedInApp && (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD)) {
    console.warn("[security] Admin credentials are managed in-app; ADMIN_USERNAME/ADMIN_PASSWORD environment variables are ignored (remove authManagedInApp from data/config.json to restore env control).");
  }
  if (generatedInitialPassword) {
    console.warn("⚠️  Generated initial admin credentials (shown once — this password is not stored anywhere in plaintext):");
    console.warn(`   • Username: ${config.username}`);
    console.warn(`   • Password: ${generatedInitialPassword}`);
    console.warn("   Change this immediately in Settings → General.");
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
