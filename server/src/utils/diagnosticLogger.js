const MAX_LOGS = 1000;
const logs = [];
let isCapturing = false;

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function addLog(level, args) {
  if (!isCapturing) return;

  const timestamp = new Date().toISOString();
  const message = args.map((arg) => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
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
