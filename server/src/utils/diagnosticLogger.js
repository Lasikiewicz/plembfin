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

export function categorizeLog(message = "") {
  const msg = String(message || "");
  if (/plex notification|websocket|parseplexnotification|activitynotification|timelineentry|probePlexNotificationSocket/i.test(msg)) {
    return "plex-notifications";
  }
  if (/sync playstate|sync unplayed|sync progress|outbound sync|applymanualunwatch|marked played|marked unplayed|loop-check|dispatch status|sync history|manual watch|manual unwatch/i.test(msg)) {
    return "sync";
  }
  if (/scheduled|syncRecently|cron|sections check|history fetch|background refresh|syncRecentlyWatched|syncRecentlyResumable/i.test(msg)) {
    return "scheduled-poll";
  }
  return "system";
}

function addLog(level, args) {
  if (!isCapturing) return;
  const message = args.map((arg) => {
    if (arg instanceof Error) return redactSecrets(arg.stack || arg.message || String(arg));
    if (typeof arg === "object") return redactSecrets(util.inspect(arg, { depth: 6, breakLength: 120, compact: false }));
    return redactSecrets(arg);
  }).join(" ");
  const category = categorizeLog(message);
  const entry = { timestamp: new Date().toISOString(), ts: Date.now(), level, category, role, instance, message };
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

export function isSpamLog(message = "") {
  const msg = String(message || "");
  if (/no activity for \d+s, recycling the connection/i.test(msg)) return true;
  if (/Failed fetching TMDB total episodes for .* Could not resolve TVDB ID/i.test(msg)) return true;
  if (/Scheduled Sync complete! Synced Plex: 0, Emby: 0, Jellyfin: 0, Resume Plex: 0, Resume Emby: 0, Resume Jellyfin: 0, Manual: 0/i.test(msg)) return true;
  return false;
}

function formatLocalTimestamp(ts, isoString) {
  try {
    const d = ts ? new Date(Number(ts)) : new Date(isoString || Date.now());
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      const seconds = String(d.getSeconds()).padStart(2, "0");
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
  } catch (e) {
    /* fallback */
  }
  return String(isoString || "").replace("T", " ").replace(/\.\d+Z$/, "");
}

export function getLogs({ level, category = "all", limit = 500 } = {}) {
  const clearedAt = clearTimestamp();
  const categoryMap = {
    "plex-notifications": "PLEX",
    "sync": "SYNC",
    "scheduled-poll": "POLL",
    "system": "SYSTEM"
  };

  const filtered = readSharedLogs()
    .filter((entry) => {
      if (Number(entry.ts) <= clearedAt) return false;
      if (level && entry.level !== level) return false;
      if (isSpamLog(entry.message)) return false;
      const cat = entry.category || categorizeLog(entry.message);
      if (category && category !== "all" && cat !== category) return false;
      return true;
    })
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const bounded = filtered.slice(-Math.min(Math.max(Number(limit) || 500, 1), MAX_LOGS));
  return {
    total: filtered.length,
    logs: bounded.map((entry) => {
      const rawCat = entry.category || categorizeLog(entry.message);
      const catTag = categoryMap[rawCat] || rawCat.toUpperCase();
      const isoTs = entry.timestamp || (entry.ts ? new Date(Number(entry.ts)).toISOString() : new Date().toISOString());
      return `[${isoTs}] [${catTag}] [${entry.instance}] ${entry.message}`;
    }),
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
