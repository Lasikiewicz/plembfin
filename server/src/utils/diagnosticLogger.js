import util from "node:util";

const MAX_LOGS = 1000;
const logs = [];
let isCapturing = false;

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function redactSecrets(value = "") {
  let text = String(value || "");
  text = text.replace(/([?&](?:token|api[_-]?key|secret|password|authorization|cookie)=)[^&\s'"]+/gi, "$1[redacted]");
  text = text.replace(/\b(authorization|cookie|x-api-key|x-plex-token|api[_-]?key|token|password|secret)(['"]?\s*[:=]\s*['"]?)[^,'"\s}]+/gi, "$1$2[redacted]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  return text;
}

function addLog(level, args) {
  if (!isCapturing) return;

  const timestamp = new Date().toISOString();
  const message = args.map((arg) => {
    if (arg instanceof Error) {
      return redactSecrets(arg.stack || arg.message || String(arg));
    }
    if (typeof arg === 'object') {
      return redactSecrets(util.inspect(arg, { depth: 6, breakLength: 120, compact: false }));
    }
    return redactSecrets(arg);
  }).join(' ');

  logs.push({ timestamp, level, message });
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }
}

export function startCapturing() {
  if (isCapturing) return;
  isCapturing = true;

  console.log = function(...args) {
    originalLog.apply(console, args);
    addLog('info', args);
  };

  console.error = function(...args) {
    originalError.apply(console, args);
    addLog('error', args);
  };

  console.warn = function(...args) {
    originalWarn.apply(console, args);
    addLog('warn', args);
  };
}

export function stopCapturing() {
  if (!isCapturing) return;
  isCapturing = false;

  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
}

export function getLogs(filter = {}) {
  const { level, limit = 500, offset = 0 } = filter;

  let filtered = logs;
  if (level) {
    filtered = logs.filter((log) => log.level === level);
  }

  return {
    total: filtered.length,
    logs: filtered.slice(-limit).map((log) => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`),
  };
}

export function clearLogs() {
  logs.length = 0;
}

// Auto-start capturing
startCapturing();
