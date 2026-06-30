import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, parseJson, toJson } from "../db.js";
import { FULL_BACKUPS_DIR } from "../paths.js";
import { getFullBackup } from "./backup.js";

const CONFIG_ID = "plembfinBackups";
const RUNTIME_ID = "plembfinBackups";
const FILE_PATTERN = /^plembfin-backup-(\d{8}T\d{6}Z)\.encrypted\.json$/;

const selectSetting = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertSetting = db.prepare(`
  INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const selectRuntime = db.prepare("SELECT data FROM runtime_state WHERE id = ?");
const upsertRuntime = db.prepare(`
  INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

function safeConfig(value = {}) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.time || "")) ? String(value.time) : "03:00";
  return {
    enabled: Boolean(value.enabled),
    time,
    retention: Math.max(1, Math.min(Number(value.retention) || 7, 365)),
    passphrase: String(value.passphrase || "").trim(),
  };
}

export function loadPlembfinBackupConfig() {
  return safeConfig(parseJson(selectSetting.get(CONFIG_ID)?.data, {}) || {});
}

export function savePlembfinBackupConfig(value = {}) {
  const config = safeConfig(value);
  upsertSetting.run(CONFIG_ID, toJson(config), Date.now());
  return config;
}

export function loadPlembfinBackupRuntime() {
  return parseJson(selectRuntime.get(RUNTIME_ID)?.data, {}) || {};
}

function saveRuntime(values = {}) {
  const current = loadPlembfinBackupRuntime();
  const next = { ...current, ...values, updatedAt: Date.now() };
  upsertRuntime.run(RUNTIME_ID, toJson(next), Date.now());
  return next;
}

function timestampName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `plembfin-backup-${yyyy}${mm}${dd}T${hh}${min}${ss}Z.encrypted.json`;
}

function backupPath(filename) {
  const clean = path.basename(filename);
  if (!FILE_PATTERN.test(clean)) throw new Error("Invalid backup filename");
  return path.join(FULL_BACKUPS_DIR, clean);
}

export function listPlembfinBackups() {
  if (!fs.existsSync(FULL_BACKUPS_DIR)) return [];
  return fs.readdirSync(FULL_BACKUPS_DIR)
    .filter((name) => FILE_PATTERN.test(name))
    .map((name) => {
      const absolute = path.join(FULL_BACKUPS_DIR, name);
      const stat = fs.statSync(absolute);
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function applyRetention(retention) {
  const files = listPlembfinBackups();
  for (const file of files.slice(Math.max(1, retention))) {
    try {
      fs.unlinkSync(backupPath(file.name));
    } catch (e) {
      console.error(`Failed to delete backup ${file.name}:`, e);
    }
  }
}

function encryptPlembfinBackup(backup, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(backup), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([encrypted, tag]);

  return {
    format: "plembfin-encrypted-backup",
    version: 1,
    encryptedAt: new Date().toISOString(),
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: 100000,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
    },
    payload: payload.toString("base64"),
  };
}

export async function createPlembfinBackup({ reason = "manual", passphrase } = {}) {
  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  const actualPassphrase = passphrase || loadPlembfinBackupConfig().passphrase;
  if (!actualPassphrase || actualPassphrase.length < 12) {
    throw new Error("Enter an encryption passphrase of at least 12 characters.");
  }

  const document = getFullBackup();
  const encryptedObj = encryptPlembfinBackup(document, actualPassphrase);
  const jsonContent = JSON.stringify(encryptedObj, null, 2);

  let createdAt = new Date();
  let filename = timestampName(createdAt);
  while (fs.existsSync(path.join(FULL_BACKUPS_DIR, filename))) {
    createdAt = new Date(createdAt.getTime() + 1000);
    filename = timestampName(createdAt);
  }

  const destination = backupPath(filename);
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, jsonContent, "utf8");
  fs.renameSync(temporary, destination);

  const config = loadPlembfinBackupConfig();
  applyRetention(config.retention);

  const result = {
    name: filename,
    sizeBytes: Buffer.byteLength(jsonContent, "utf8"),
    createdAt: encryptedObj.encryptedAt,
    reason,
  };
  saveRuntime({ lastSuccessAt: Date.now(), lastError: "", lastBackup: result, lastRunDate: localDateKey() });
  return result;
}

export function readPlembfinBackupFile(filename) {
  const absolute = backupPath(filename);
  const content = fs.readFileSync(absolute, "utf8");
  return { absolute, content };
}

export function deletePlembfinBackup(filename) {
  const absolute = backupPath(filename);
  if (fs.existsSync(absolute)) {
    fs.unlinkSync(absolute);
  }
  return { deleted: filename };
}

export function plembfinBackupStatus() {
  return {
    config: loadPlembfinBackupConfig(),
    runtime: loadPlembfinBackupRuntime(),
    files: listPlembfinBackups(),
  };
}

function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function runScheduledPlembfinBackup() {
  const config = loadPlembfinBackupConfig();
  if (!config.enabled || !config.passphrase || config.passphrase.length < 12) return null;
  
  const now = new Date();
  const today = localDateKey(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const runtime = loadPlembfinBackupRuntime();
  
  if (runtime.lastRunDate === today || currentTime < config.time) return null;
  
  try {
    return await createPlembfinBackup({ reason: "scheduled", passphrase: config.passphrase });
  } catch (error) {
    saveRuntime({ lastError: error.message || String(error), lastFailureAt: Date.now(), lastRunDate: today });
    throw error;
  }
}
