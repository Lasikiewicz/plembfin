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
}

function hashPassword(plain, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
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

  const sessionSecret = String(process.env.SESSION_SECRET || stored.sessionSecret || crypto.randomBytes(32).toString("hex"));
  if (stored.sessionSecret !== sessionSecret) { stored.sessionSecret = sessionSecret; changed = true; }

  if (changed) writeConfigFile(stored);
  return stored;
}

const config = resolveAuthConfig();

export const AUTH = {
  username: config.username,
  apiKey: config.apiKey,
  sessionSecret: config.sessionSecret,
};

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
