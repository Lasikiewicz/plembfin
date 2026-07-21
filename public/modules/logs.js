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

export async function fetchDiagnosticLogs(headers = {}, category = "all") {
  try {
    const url = new URL("/api/diagnostic-logs", window.location.origin);
    url.searchParams.set("limit", "500");
    if (category && category !== "all") {
      url.searchParams.set("category", category);
    }
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { ...headers, "Cache-Control": "no-store" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return [`Diagnostic logs request failed (${res.status}): ${data.error || res.statusText || "unknown error"}`];
    }
    return data.logs || [];
  } catch (error) {
    console.error("Failed to fetch diagnostic logs", error);
    return [`Diagnostic logs request failed: ${error.message || String(error)}`];
  }
}

export async function clearDiagnosticLogs(headers = {}) {
  const url = new URL("/api/diagnostic-logs", window.location.origin);
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { ...headers, "Cache-Control": "no-store" },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Clear logs failed with ${res.status}`);
  }
  return true;
}

export function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatLogLineToHtml(rawLine = "") {
  const line = String(rawLine || "").trim();
  if (!line) return "";
  if (line.startsWith("===")) {
    return `<div class="log-section-header">${escapeHtml(line)}</div>`;
  }

  const match = line.match(/^\[(.*?)\]\s*\[(.*?)\](?:\s*\[(.*?)\])?\s*(.*)$/);
  if (!match) {
    return `<div class="log-row"><span class="log-msg">${escapeHtml(line)}</span></div>`;
  }

  const [, timestamp, category, instance, message] = match;
  const catKey = category.toLowerCase();
  
  let badgeClass = "badge-system";
  if (catKey.includes("plex")) badgeClass = "badge-plex";
  else if (catKey.includes("sync")) badgeClass = "badge-sync";
  else if (catKey.includes("poll") || catKey.includes("cron")) badgeClass = "badge-poll";
  
  const isError = catKey.includes("error") || message.toLowerCase().includes("error") || message.toLowerCase().includes("failed");
  if (isError) badgeClass = "badge-error";

  return `
    <div class="log-row ${isError ? "log-row-error" : ""}">
      <span class="log-time">${escapeHtml(timestamp)}</span>
      <span class="log-badge ${badgeClass}">${escapeHtml(category)}</span>
      ${instance ? `<span class="log-instance">[${escapeHtml(instance)}]</span>` : ""}
      <span class="log-msg">${escapeHtml(message)}</span>
    </div>
  `.trim();
}
