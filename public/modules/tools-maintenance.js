import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute } from "./utils.js";
import { categorizeIssues } from "./sync.js";

let _setMessage = () => {};
let _showConfirmModal = () => {};
let _loadSyncJobs = async () => {};
let _loadSyncHistory = async () => {};

export function initMaintenanceTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadSyncJobs) _loadSyncJobs = callbacks.loadSyncJobs;
  if (callbacks.loadSyncHistory) _loadSyncHistory = callbacks.loadSyncHistory;
}

function authHeaders() { return buildAuthHeaders(state.token); }
function setMessage(...args) { return _setMessage(...args); }
function showConfirmModal(...args) { return _showConfirmModal(...args); }
function loadSyncJobs(...args) { return _loadSyncJobs(...args); }
function loadSyncHistory(...args) { return _loadSyncHistory(...args); }

export async function runSystemIntegrityCheck() {
  const button = elements.runCompleteCheckButton;
  const container = elements.completeCheckResults;
  if (!button || !container) return;

  button.disabled = true;
  button.textContent = "Running diagnostics...";
  container.classList.remove("hidden");
  container.innerHTML = `<div class="idle-state"><b>Running integrity checks...</b></div>`;

  const results = [];

  try {
    const startTime = Date.now();
    const response = await fetch("/api/history?limit=1", { headers: authHeaders() });
    const elapsed = Date.now() - startTime;
    if (response.ok) {
      results.push({ name: "Watch History API", status: "success", detail: `Connected successfully. Response time: ${elapsed}ms.` });
    } else {
      results.push({ name: "Watch History API", status: "error", detail: `Server responded with HTTP ${response.status}.` });
    }
  } catch (error) {
    results.push({ name: "Watch History API", status: "error", detail: `Connection failed: ${error.message}` });
  }

  try {
    await _loadSavedConfig();
    results.push({ name: "Server Configuration", status: "success", detail: "Read server-side media configuration successfully." });
  } catch (error) {
    results.push({ name: "Server Configuration", status: "error", detail: `Failed to read config: ${error.message}` });
  }

  let webhookEndpointStatus = "error";
  let webhookEndpointDetail = "Unavailable";
  try {
    const startTime = Date.now();
    const response = await fetch("/api/webhook", { method: "OPTIONS" });
    if (response.ok) {
      webhookEndpointStatus = "success";
      const elapsed = Date.now() - startTime;
      if (state.lastWebhook && state.lastWebhook.timestamp) {
        webhookEndpointDetail = `Active. Last event: ${platformName(state.lastWebhook.source)} watched "${state.lastWebhook.title}" at ${formatDate(state.lastWebhook.timestamp)}.`;
      } else {
        webhookEndpointDetail = `Active & online. No events received yet (${elapsed}ms).`;
      }
    } else {
      webhookEndpointDetail = `Responded with HTTP ${response.status}`;
    }
  } catch (error) {
    webhookEndpointDetail = `Ping failed: ${error.message}`;
  }
  results.push({ name: "Webhook Listener Endpoint", status: webhookEndpointStatus, detail: webhookEndpointDetail });

  if (state.lastCron) {
    const diff = Date.now() - Number(state.lastCron);
    const fiveMinutesMs = 5 * 60 * 1000;
    if (diff <= fiveMinutesMs) {
      results.push({ name: "Scheduled Cron Job", status: "success", detail: `Active. Last run: ${formatDate(state.lastCron)} (${Math.round(diff / 1000)}s ago).` });
    } else {
      results.push({ name: "Scheduled Cron Job", status: "warning", detail: `Warnings - Delayed execution. Last run: ${formatDate(state.lastCron)} (${Math.round(diff / 60000)}m ago).` });
    }
  } else {
    results.push({ name: "Scheduled Cron Job", status: "skipped", detail: "Not Configured - No execution logged." });
  }

  let historyToCheck = state.history || [];
  if (!historyToCheck.length) {
    try {
      const response = await fetch("/api/history?limit=5", { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(body.history)) historyToCheck = body.history;
    } catch (e) { /* ignore */ }
  }

  if (!historyToCheck.length) {
    results.push({ name: "Outbound Playstate Sync", status: "skipped", detail: "Not Configured - No watch history logged to scan." });
  } else {
    const recentRows = historyToCheck.slice(0, 5);
    let errorCount = 0;
    let totalChecked = 0;
    for (const row of recentRows) {
      if (row.sync_dispatch_telemetry) {
        totalChecked++;
        const tel = String(row.sync_dispatch_telemetry).toLowerCase();
        if (tel.includes("status: error") || tel.includes("failed") || tel.includes("propagation failed")) errorCount++;
      }
    }
    if (totalChecked === 0) {
      results.push({ name: "Outbound Playstate Sync", status: "success", detail: "Active. No recent outbound dispatches to check." });
    } else if (errorCount > 0) {
      results.push({ name: "Outbound Playstate Sync", status: "warning", detail: `Warnings - ${errorCount} of ${totalChecked} recent syncs failed. Check logs.` });
    } else {
      results.push({ name: "Outbound Playstate Sync", status: "success", detail: `All ${totalChecked} recent outbound syncs completed successfully.` });
    }
  }

  const plexUrl = elements.plexServerUrl?.value?.trim() || "";
  const plexToken = elements.plexToken?.value?.trim() || "";
  const embyUrl = elements.embyServerUrl?.value?.trim() || "";
  const embyApiKey = elements.embyApiKey?.value?.trim() || "";
  const jellyfinUrl = elements.jellyfinServerUrl?.value?.trim() || "";
  const jellyfinApiKey = elements.jellyfinApiKey?.value?.trim() || "";

  const testConnection = async (type, url, token, name) => {
    if (!url || !token) { results.push({ name, status: "skipped", detail: "Skipped - URL or token not provided." }); return; }
    try {
      const startTime = Date.now();
      const response = await fetch("/api/test-connection", { method: "POST", headers: authHeaders(), body: JSON.stringify({ type, url, token }) });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name, status: "success", detail: `${body.detail || "Server identity verified"} in ${body.elapsedMs || elapsed}ms.` });
      } else {
        results.push({ name, status: "error", detail: body.error || `Connection failed (HTTP ${response.status}).` });
      }
    } catch (error) {
      results.push({ name, status: "error", detail: `Check failed: ${error.message}` });
    }
  };

  await testConnection("plex", plexUrl, plexToken, "Plex Media Server");

  if (plexUrl && plexToken) {
    try {
      const startTime = Date.now();
      const response = await fetch("/api/test-plex-notifications", { method: "POST", headers: authHeaders(), body: JSON.stringify({ url: plexUrl, token: plexToken }) });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name: "Plex Realtime Notifications", status: "success", detail: `Notification WebSocket connected in ${body.elapsedMs || elapsed}ms. Event-driven unwatch detection is active.` });
      } else {
        results.push({ name: "Plex Realtime Notifications", status: "warning", detail: `${body.error || `Unavailable (HTTP ${response.status})`}. Unwatch sync falls back to the periodic poll.` });
      }
    } catch (error) {
      results.push({ name: "Plex Realtime Notifications", status: "warning", detail: `Check failed: ${error.message}. Unwatch sync falls back to the periodic poll.` });
    }
  } else {
    results.push({ name: "Plex Realtime Notifications", status: "skipped", detail: "Skipped - Plex URL or token not provided." });
  }

  await testConnection("emby", embyUrl, embyApiKey, "Emby Media Server");
  await testConnection("jellyfin", jellyfinUrl, jellyfinApiKey, "Jellyfin Media Server");

  container.innerHTML = results.map((res) => {
    let statusLabel = "Skipped";
    let pillStyle = "border-color: var(--line); background: var(--panel-3); color: var(--muted);";
    let fixInstruction = "";
    let settingsLink = "";

    if (res.status === "success") { statusLabel = "Online"; pillStyle = "border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.12); color: var(--green);"; }
    else if (res.status === "error") { statusLabel = "Failed"; pillStyle = "border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); color: var(--red);"; }
    else if (res.status === "skipped") { statusLabel = "Not Configured"; pillStyle = "border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.12); color: var(--yellow);"; }
    else if (res.status === "warning") { statusLabel = "Warnings Detected"; pillStyle = "border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12); color: var(--yellow);"; }

    if (res.status !== "success") {
      if (res.name === "Scheduled Cron Job") { fixInstruction = "Fix: The background sync worker runs in-process every minute. If it hasn't fired, confirm the server is running and check the server logs for errors. You can also trigger it manually via /api/cron-sync."; settingsLink = "sync"; }
      else if (res.name === "Watch History API") { fixInstruction = "Fix: The SQLite database may be locked or the data directory may not be writable. Check the server logs and confirm DATA_DIR is set correctly."; }
      else if (res.name === "Server Configuration") { fixInstruction = "Fix: Try saving your configuration again in Settings → Apps. If the error persists, check that data/config.json is writable."; }
      else if (res.name === "Webhook Listener Endpoint") { fixInstruction = "Fix: Confirm the server is running and accessible at the expected host and port. Check for firewall or reverse-proxy rules blocking /api/webhook."; }
      else if (res.name === "Outbound Playstate Sync") { fixInstruction = "Fix: Open the latest history row debug details, review sync_dispatch_telemetry, then correct the failed platform credentials or provider-ID match."; }
      else if (res.name === "Plex Media Server") { fixInstruction = "Fix: Enter the Plex Server URL and Plex Token in Settings → Apps, then confirm the server is reachable from the machine running Plembfin."; }
      else if (res.name === "Plex Realtime Notifications") { fixInstruction = "Fix: Ensure any reverse proxy / Cloudflare in front of Plex forwards WebSocket upgrades on /:/websockets/notifications, or set the Plex Server URL to the direct LAN address (e.g. http://192.168.x.x:32400). Unwatch sync still works via the fallback poll until this is fixed."; settingsLink = "apps"; }
      else if (res.name === "Emby Media Server") { fixInstruction = "Fix: Enter the Emby Server URL, API Key, and User ID in Settings → Apps, then confirm the server is reachable from the machine running Plembfin."; }
      else if (res.name === "Jellyfin Media Server") { fixInstruction = "Fix: Enter the Jellyfin Server URL, API Key, and User ID in Settings → Apps, then confirm the server is reachable from the machine running Plembfin."; }
    }

    return `
      <div class="ranking-row" style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-3); width: 100%;">
        <div style="display: grid; gap: 2px;">
          <b>${escapeHtml(res.name)}</b>
          <span style="font-size: 0.8rem; color: var(--muted);">${escapeHtml(res.detail)}</span>
          ${fixInstruction ? `<span style="font-size: 0.8rem; color: var(--text);">${escapeHtml(fixInstruction)}</span>` : ""}
          ${settingsLink ? `<button type="button" data-settings-link="${escapeAttribute(settingsLink)}" style="width: fit-content; border: 1px solid var(--line); background: var(--panel-3); color: var(--text); border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.78rem; font-weight: 800;">Open setup guide</button>` : ""}
        </div>
        <span class="target-pill" style="padding: 0.2rem 0.5rem; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; border: 1px solid; border-radius: 999px; ${pillStyle}">${statusLabel}</span>
      </div>
    `;
  }).join("");

  button.disabled = false;
  button.textContent = "Run System Diagnostic";
}

// ── Clear missing telemetry ────────────────────────────────────────────────

export async function triggerClearMissingTelemetry(button) {
  const btn = button || elements.clearMissingTelemetryButton || document.querySelector('[data-action="clearMissingTelemetry"]');
  if (!btn) return;

  _showConfirmModal(
    "Clear missing dispatch telemetry records?\n\nThis will mark records with missing telemetry as resolved, removing them from the outstanding jobs list. This is safe — it only affects logging, not actual sync functionality.",
    async () => {
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Clearing...";

      const titleEl = document.getElementById("terminalModalTitle");
      if (titleEl) titleEl.textContent = "Clear Telemetry Terminal";

      elements.terminalModal?.classList.remove("hidden");
      if (elements.retryTerminalOutput) elements.retryTerminalOutput.innerHTML = "";

      function termLog(text, tone = "info") {
        if (!elements.retryTerminalOutput) return;
        const span = document.createElement("span");
        if (tone === "error") { span.style.color = "#fb7185"; span.style.fontWeight = "bold"; }
        else if (tone === "success") { span.style.color = "#34d399"; span.style.fontWeight = "bold"; }
        else if (tone === "warn") { span.style.color = "#f59e0b"; }
        else if (tone === "header") { span.style.color = "#38bdf8"; span.style.fontWeight = "bold"; }
        else { span.style.color = "#e8edf2"; }
        span.textContent = text + "\n";
        elements.retryTerminalOutput.appendChild(span);
        elements.retryTerminalOutput.scrollTop = elements.retryTerminalOutput.scrollHeight;
      }

      termLog("plembfin@server:~$ ./clear-missing-telemetry", "header");
      termLog("Initiating request to clear missing dispatch telemetry...", "info");
      termLog("POST /api/clear-missing-telemetry HTTP/1.1", "info");

      try {
        const response = await fetch("/api/clear-missing-telemetry", { method: "POST", headers: authHeaders() });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          termLog("[ERROR] Clear request failed with status: " + response.status, "error");
          if (body.error) termLog("Reason: " + body.error, "error");
          throw new Error(body.error || `Failed with HTTP ${response.status}`);
        }
        termLog("Response received: HTTP 200 OK", "success");
        termLog(`Successfully cleared ${body.cleared || 0} watch history record(s) with missing telemetry.`, "success");
        termLog("\n✨ Done!", "success");
        _setMessage(`Cleared ${body.cleared || 0} records`, "success");
        await _loadSyncJobs({ force: true });
      } catch (error) {
        termLog(`\n[FATAL ERROR] Clear process aborted: ${error.message}`, "error");
        _setMessage(`Error: ${error.message}`, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  );
}

// ── Retry all in category ──────────────────────────────────────────────────

export async function triggerRetryAllCategory(categoryName, button) {
  if (!categoryName || !state.syncJobs) return;

  const categories = categorizeIssues(state.syncJobs);
  const jobsInCategory = categories[categoryName] || [];

  if (!jobsInCategory.length) { _setMessage("No issues to retry in this category", "info"); return; }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = `Retrying ${jobsInCategory.length}...`;

  const categoryLabels = {
    plexMismatch: "Plex Match",
    targetMismatch: "Emby/Jellyfin Match",
    otherIssues: "Unresolved",
    missingTelemetry: "Missing Telemetry",
  };
  const categoryLabel = categoryLabels[categoryName] || categoryName;

  _showConfirmModal(
    `Retry all ${jobsInCategory.length} ${categoryLabel} issues?\n\nThis will sequentially retry each item. The process may take a minute or two.`,
    async () => {
      try {
        _setMessage(`Retrying ${jobsInCategory.length} items...`, "info");
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < jobsInCategory.length; i++) {
          const job = jobsInCategory[i];
          try {
            const response = await fetch("/api/retry-sync", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ id: job.id }),
            });
            if (response.ok) {
              const data = await response.json();
              if (data.status === "success" || String(data.status || "").includes("success")) successCount++;
              else failCount++;
            } else { failCount++; }
          } catch (err) {
            console.error(`Failed to retry ${job.id}:`, err);
            failCount++;
          }
          if (i % 5 === 0 || i === jobsInCategory.length - 1) {
            _setMessage(`Retrying... ${i + 1}/${jobsInCategory.length} (${successCount} passed)`, "info");
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        await _loadSyncJobs({ force: true });
        await _loadSyncHistory({ force: true });
        const resultMsg = `Completed ${jobsInCategory.length} retries. ${successCount} passed, ${failCount} had issues.`;
        _setMessage(resultMsg, successCount > failCount ? "success" : "warning");
      } catch (error) {
        _setMessage(`Error during retry: ${error.message}`, "error");
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  );
}
