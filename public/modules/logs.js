export const DEBUG_LOGS_KEY = "plembfin_debug_logs";
export const MAX_DEBUG_LOGS = 500;

export function readStoredDebugLogs(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(DEBUG_LOGS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-MAX_DEBUG_LOGS) : [];
  } catch (error) {
    return [];
  }
}

export function appendDebugLog(logs, message, details, storage = localStorage) {
  const timestamp = new Date().toISOString();
  const suffix = details === undefined ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
  const nextLogs = [...logs, `[${timestamp}] ${message}${suffix}`].slice(-MAX_DEBUG_LOGS);
  storage.setItem(DEBUG_LOGS_KEY, JSON.stringify(nextLogs));
  return nextLogs;
}

export function clearDebugLogs(storage = localStorage) {
  storage.removeItem(DEBUG_LOGS_KEY);
  return [];
}

export function logsToText(logs) {
  return logs.join("\n");
}
