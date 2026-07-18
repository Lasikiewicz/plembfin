import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { DATA_DIR } from "../paths.js";
import { db, parseJson, toJson } from "../db.js";

const MAX_LOGS = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LOGS_DIR = path.join(DATA_DIR, "logs");
const role = String(process.env.ROLE || "all");
const instance = `${role}:${process.pid}`;
const startedAt = Date.now();
const logFile = path.join(LOGS_DIR, `diagnostic-${role}-${process.pid}-${startedAt}.jsonl`);
const memoryLogs = [];
let isCapturing = false;

fs.mkdirSync(LOGS_DIR, { recursive: true });

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function redactSecrets(value = "") {
  let text = String(value || "");
  text = text.replace(/([?&](?:token|api[_-]?key|secret|password|authorization|cookie)=)[^&\s'"]+/gi, "$1[redacted]");
  text = text.replace(/\b(authorization|cookie|x-api-key|x-plex-token|api[_-]?key|token|password|secret)(['"]?\s*[:=]\s*['"]?)[^,'"\s}]+/gi, "$1$2[redacted]");
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(logFile).size < MAX_FILE_BYTES) return;
    const rotated = `${logFile}.1`;
    try { fs.rmSync(rotated, { force: true }); } catch { /* ignore */ }
    fs.renameSync(logFile, rotated);
  } catch { /* missing/new file */ }
}

function addLog(level, args) {
  if (!isCapturing) return;
  const message = args.map((arg) => {
    if (arg instanceof Error) return redactSecrets(arg.stack || arg.message || String(arg));
    if (typeof arg === "object") return redactSecrets(util.inspect(arg, { depth: 6, breakLength: 120, compact: false }));
    return redactSecrets(arg);
  }).join(" ");
  const entry = { timestamp: new Date().toISOString(), ts: Date.now(), level, role, instance, message };
  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_LOGS) memoryLogs.shift();
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch { /* diagnostics must never break primary work */ }
}

function clearTimestamp() {
  try {
    const row = db.prepare("SELECT data FROM runtime_state WHERE id='main'").get();
    return Number(parseJson(row?.data, {})?.diagnosticClearedAt || 0);
  } catch { return 0; }
}

function readSharedLogs() {
  const entries = [];
  let files = [];
  try { files = fs.readdirSync(LOGS_DIR).filter((name) => /^diagnostic-.*\.jsonl(?:\.1)?$/.test(name)); } catch { return memoryLogs; }
  for (const name of files) {
    try {
      for (const line of fs.readFileSync(path.join(LOGS_DIR, name), "utf8").split("\n")) {
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry && Number(entry.ts)) entries.push(entry);
      }
    } catch { /* skip a concurrently rotating or partial file */ }
  }
  return entries;
}

export function startCapturing() {
  if (isCapturing) return;
  isCapturing = true;
  console.log = function(...args) { originalLog.apply(console, args); addLog("info", args); };
  console.error = function(...args) { originalError.apply(console, args); addLog("error", args); };
  console.warn = function(...args) { originalWarn.apply(console, args); addLog("warn", args); };
}

export function stopCapturing() {
  if (!isCapturing) return;
  isCapturing = false;
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
}

export function getLogs({ level, limit = 500 } = {}) {
  const clearedAt = clearTimestamp();
  const filtered = readSharedLogs()
    .filter((entry) => Number(entry.ts) > clearedAt && (!level || entry.level === level))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const bounded = filtered.slice(-Math.min(Math.max(Number(limit) || 500, 1), MAX_LOGS));
  return {
    total: filtered.length,
    logs: bounded.map((entry) => `[${entry.timestamp}] [${String(entry.level).toUpperCase()}] [${entry.instance}] ${entry.message}`),
  };
}

export function clearLogs() {
  const select = db.prepare("SELECT data FROM runtime_state WHERE id='main'");
  const upsert = db.prepare(`INSERT INTO runtime_state (id,data,updated_at) VALUES ('main',?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
  db.transaction(() => {
    const current = parseJson(select.get()?.data, {}) || {};
    const now = Date.now();
    upsert.run(toJson({ ...current, diagnosticClearedAt: now, updatedAt: now }), now);
  }).immediate();
}

startCapturing();
