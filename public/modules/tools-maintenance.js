import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, platformName, formatDate } from "./utils.js";
import { categorizeIssues } from "./sync.js";

let _setMessage = () => {};
let _showConfirmModal = () => {};
let _loadSyncJobs = async () => {};
let _loadSyncHistory = async () => {};
let _loadHistory = async () => {};
let _clearDerivedUiCaches = () => {};
let _loadSavedConfig = async () => {};

export function initMaintenanceTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadSyncJobs) _loadSyncJobs = callbacks.loadSyncJobs;
  if (callbacks.loadSyncHistory) _loadSyncHistory = callbacks.loadSyncHistory;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.loadSavedConfig) _loadSavedConfig = callbacks.loadSavedConfig;
  initSyncMatchReport();
}

function authHeaders() { return buildAuthHeaders(state.token); }
function setMessage(...args) { return _setMessage(...args); }
function showConfirmModal(...args) { return _showConfirmModal(...args); }
function loadSyncJobs(...args) { return _loadSyncJobs(...args); }
function loadSyncHistory(...args) { return _loadSyncHistory(...args); }
function loadHistory(...args) { return _loadHistory(...args); }
function clearDerivedUiCaches(...args) { return _clearDerivedUiCaches(...args); }
function setStatusPill(element, text, tone = "muted") {
  if (!element) return;
  element.textContent = text;
  element.className = `status-pill status-${tone}`;
}

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

  // Connection settings now live in edit modals, so diagnostics must use the
  // redacted saved config instead of reading inputs that may not exist. A blank
  // secret deliberately asks the backend to fall back to the stored credential.
  const plexUrl = String(state.savedConfig?.plex?.baseUrl || state.savedConfig?.plex?.url || "").trim();
  const embyUrl = String(state.savedConfig?.emby?.baseUrl || state.savedConfig?.emby?.url || "").trim();
  const jellyfinUrl = String(state.savedConfig?.jellyfin?.baseUrl || state.savedConfig?.jellyfin?.url || "").trim();

  const testConnection = async (type, url, token, name) => {
    // Secrets are never sent to the browser, so the token input is blank for an
    // already-configured server — the backend falls back to the stored credential.
    if (!url || (!token && !state.savedConfig?.[type]?.configured)) { results.push({ name, status: "skipped", detail: "Skipped - URL or token not provided." }); return; }
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

  await testConnection("plex", plexUrl, "", "Plex Media Server");

  if (plexUrl && state.savedConfig?.plex?.configured) {
    try {
      const startTime = Date.now();
      // A blank token is fine — the backend falls back to the saved Plex config.
      const response = await fetch("/api/test-plex-notifications", { method: "POST", headers: authHeaders(), body: JSON.stringify({ url: plexUrl, token: "" }) });
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

  await testConnection("emby", embyUrl, "", "Emby Media Server");
  await testConnection("jellyfin", jellyfinUrl, "", "Jellyfin Media Server");

  try {
    const report = await fetchSyncMatchReport();
    const lines = ["plex", "emby", "jellyfin"]
      .map((platform) => ({ platform, stats: report.platforms?.[platform] }))
      .filter((entry) => entry.stats && entry.stats.uniqueMediaCount > 0)
      .map((entry) => `${platformName(entry.platform)}: ${entry.stats.uniqueMediaCount} item${entry.stats.uniqueMediaCount !== 1 ? "s" : ""} unmatched (${entry.stats.movies} movies, ${entry.stats.episodes} episodes)`);
    if (!lines.length) {
      results.push({ name: "Cross-Platform Library Matching", status: "success", detail: `No "no matching item" sync failures across ${report.scannedRows} records with telemetry.` });
    } else {
      results.push({ name: "Cross-Platform Library Matching", status: "warning", detail: `Warnings - ${lines.join("; ")}.` });
    }
  } catch (error) {
    results.push({ name: "Cross-Platform Library Matching", status: "error", detail: `Match report failed: ${error.message}` });
  }

  container.innerHTML = results.map((res) => {
    let statusLabel = "Skipped";
    let pillStyle = "border-color: var(--line); background: var(--panel-3); color: var(--muted);";
    let fixInstruction = "";
    let settingsPath = "";

    if (res.status === "success") { statusLabel = "Online"; pillStyle = "border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.12); color: var(--green);"; }
    else if (res.status === "error") { statusLabel = "Failed"; pillStyle = "border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); color: var(--red);"; }
    else if (res.status === "skipped") { statusLabel = "Not Configured"; pillStyle = "border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.12); color: var(--yellow);"; }
    else if (res.status === "warning") { statusLabel = "Warnings Detected"; pillStyle = "border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12); color: var(--yellow);"; }

    if (res.status !== "success") {
      if (res.name === "Scheduled Cron Job") { fixInstruction = "Fix: The background sync worker runs in-process every minute. If it hasn't fired, confirm the server is running and check the server logs for errors. You can also trigger it manually via /api/cron-sync."; settingsPath = "/settings/sync"; }
      else if (res.name === "Watch History API") { fixInstruction = "Fix: The SQLite database may be locked or the data directory may not be writable. Check the server logs and confirm DATA_DIR is set correctly."; }
      else if (res.name === "Server Configuration") { fixInstruction = "Fix: Try saving your configuration again in Settings → Media Servers. If the error persists, check that data/config.json is writable."; }
      else if (res.name === "Webhook Listener Endpoint") { fixInstruction = "Fix: Confirm the server is running and accessible at the expected host and port. Check for firewall or reverse-proxy rules blocking /api/webhook."; }
      else if (res.name === "Outbound Playstate Sync") { fixInstruction = "Fix: Open the latest history row debug details, review sync_dispatch_telemetry, then correct the failed platform credentials or provider-ID match."; }
      else if (res.name === "Cross-Platform Library Matching") { fixInstruction = "Fix: Open the Cross-Platform Match Report under Settings → Sync → Sync Issues to see which media each platform could not find, then add the media to that library or correct its metadata/external IDs."; settingsPath = "/settings/sync"; }
      else if (res.name === "Plex Media Server") { fixInstruction = "Fix: Enter the Plex Server URL and Plex Token in Settings → Media Servers, then confirm the server is reachable from the machine running Plembfin."; settingsPath = "/settings/media-servers"; }
      else if (res.name === "Plex Realtime Notifications") { fixInstruction = "Fix: Ensure any reverse proxy / Cloudflare in front of Plex forwards WebSocket upgrades on /:/websockets/notifications, or set the Plex Server URL to the direct LAN address (e.g. http://192.168.x.x:32400). Unwatch sync still works via the fallback poll until this is fixed."; settingsPath = "/settings/media-servers"; }
      else if (res.name === "Emby Media Server") { fixInstruction = "Fix: Enter the Emby Server URL, API Key, and User ID in Settings → Media Servers, then confirm the server is reachable from the machine running Plembfin."; settingsPath = "/settings/media-servers"; }
      else if (res.name === "Jellyfin Media Server") { fixInstruction = "Fix: Enter the Jellyfin Server URL, API Key, and User ID in Settings → Media Servers, then confirm the server is reachable from the machine running Plembfin."; settingsPath = "/settings/media-servers"; }
    }

    return `
      <div class="ranking-row" style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-3); width: 100%;">
        <div style="display: grid; gap: 2px;">
          <b>${escapeHtml(res.name)}</b>
          <span style="font-size: 0.8rem; color: var(--muted);">${escapeHtml(res.detail)}</span>
          ${fixInstruction ? `<span style="font-size: 0.8rem; color: var(--text);">${escapeHtml(fixInstruction)}</span>` : ""}
          ${settingsPath ? `<button type="button" data-settings-path="${escapeAttribute(settingsPath)}" style="width: fit-content; border: 1px solid var(--line); background: var(--panel-3); color: var(--text); border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.78rem; font-weight: 800;">Open settings</button>` : ""}
        </div>
        <span class="target-pill" style="padding: 0.2rem 0.5rem; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; border: 1px solid; border-radius: 999px; ${pillStyle}">${statusLabel}</span>
      </div>
    `;
  }).join("");

  button.disabled = false;
  button.textContent = "Run System Diagnostic";
}

// ── Cross-platform match report ────────────────────────────────────────────

export async function fetchSyncMatchReport() {
  const response = await fetch("/api/sync-match-report", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Failed with HTTP ${response.status}`);
  return body.report || { scannedRows: 0, totalUnmatchedRows: 0, platforms: {} };
}

function matchReportSampleLabel(sample = {}) {
  if (sample.media_type === "episode") {
    const show = sample.show_title || sample.title || "Unknown show";
    const hasCode = sample.season != null && sample.episode != null;
    const code = hasCode ? ` S${String(sample.season).padStart(2, "0")}E${String(sample.episode).padStart(2, "0")}` : "";
    return `${show}${code}`;
  }
  return sample.title || "Unknown title";
}

export function renderSyncMatchReport(report = {}) {
  const platforms = ["plex", "emby", "jellyfin"]
    .map((platform) => ({ platform, stats: report.platforms?.[platform] }))
    .filter((entry) => entry.stats && entry.stats.uniqueMediaCount > 0);

  if (!platforms.length) {
    return `<div class="empty-log"><b>No match failures</b><span>No platform reported "no matching item found" for any synced media (${report.scannedRows || 0} records with telemetry scanned).</span></div>`;
  }

  return platforms.map(({ platform, stats }) => {
    const truncated = stats.uniqueMediaCount > stats.samples.length
      ? `<div style="font-size: 0.8rem; color: var(--muted); margin-top: var(--space-1);">Showing the first ${stats.samples.length} of ${stats.uniqueMediaCount} unmatched items.</div>`
      : "";
    return `
      <div>
        <div style="font-weight: 700; margin-bottom: var(--space-1);">
          ${escapeHtml(platformName(platform))}
          <span style="font-weight: 400; color: var(--muted); margin-left: var(--space-1);">${stats.uniqueMediaCount} item${stats.uniqueMediaCount !== 1 ? "s" : ""} not found (${stats.movies} movie${stats.movies !== 1 ? "s" : ""}, ${stats.episodes} episode${stats.episodes !== 1 ? "s" : ""}) across ${stats.rowCount} record${stats.rowCount !== 1 ? "s" : ""}</span>
        </div>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
            <thead>
              <tr style="text-align: left; color: var(--muted);">
                <th style="padding: 0.3rem 0.5rem;">Title</th>
                <th style="padding: 0.3rem 0.5rem;">Type</th>
                <th style="padding: 0.3rem 0.5rem;">Last watched</th>
                <th style="padding: 0.3rem 0.5rem;">Detail</th>
              </tr>
            </thead>
            <tbody>
              ${stats.samples.map((sample) => `
                <tr style="border-top: 1px solid var(--line);">
                  <td style="padding: 0.3rem 0.5rem; word-break: break-word;">${escapeHtml(matchReportSampleLabel(sample))}</td>
                  <td style="padding: 0.3rem 0.5rem;">${escapeHtml(sample.media_type === "episode" ? "TV" : "Movie")}</td>
                  <td style="padding: 0.3rem 0.5rem; white-space: nowrap;">${escapeHtml(formatDate(sample.watched_at))}</td>
                  <td style="padding: 0.3rem 0.5rem; color: var(--muted); word-break: break-word;">${escapeHtml(sample.detail || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        ${truncated}
      </div>
    `;
  }).join("");
}

function initSyncMatchReport() {
  const details = document.getElementById("syncMatchReport");
  const container = document.getElementById("syncMatchReportContainer");
  if (!details || !container || details.dataset.matchReportBound) return;
  details.dataset.matchReportBound = "1";
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    container.innerHTML = `<div class="idle-state"><b>Loading match report...</b></div>`;
    fetchSyncMatchReport()
      .then((report) => { container.innerHTML = renderSyncMatchReport(report); })
      .catch((error) => {
        container.innerHTML = `<div class="empty-log"><b>Match report unavailable</b><span>${escapeHtml(error.message)}</span></div>`;
      });
  });
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

// ── History repair / dedup / backfill / full-sync tools ────────────────────

export async function runRepairWorkflow() {
  const button = elements.runRepairButton;
  const status = elements.repairStatus;
  if (!button || !status) return;
  button.disabled = true;
  button.textContent = "Repairing History...";
  setStatusPill(status, "Starting history repair...", "warning");
  const maxIterations = 20;
  let totalConverted = 0;
  let totalBackfilled = 0;
  const appendLog = (text) => {
    const now = new Date().toISOString();
    if (elements.repairLog) {
      elements.repairLog.textContent = `${now} - ${text}\n` + elements.repairLog.textContent;
      elements.repairLog.scrollTop = 0;
    } else {
      status.textContent = text;
    }
  };
  for (let i = 1; i <= maxIterations; i++) {
    const passLabel = `Repair pass ${i}`;
    appendLog(`${passLabel} started`);
    try {
      const res = await fetch("/api/admin-fix-history", { method: "POST", headers: authHeaders() });
      let body;
      try { body = await res.json(); } catch (e) { body = { text: await res.text() }; }
      const converted = Number(body.converted || 0);
      const backfilled = Number(body.backfilled || 0);
      totalConverted += converted;
      totalBackfilled += backfilled;
      appendLog(`${passLabel} result: retyped=${Number(body.retyped || 0)}, converted=${converted}, backfilled=${backfilled}${body.note ? `, note=${body.note}` : ''}`);
      if (!converted && !backfilled) {
        appendLog(`${passLabel} made no changes; stopping.`);
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      appendLog(`ERROR: ${err?.message || String(err)}`);
      setStatusPill(status, `Repair failed: ${err?.message || String(err)}`, "error");
      button.disabled = false;
      throw err;
    }
  }
  setStatusPill(status, `Done: retyped history, converted ${totalConverted}, backfilled ${totalBackfilled}.`, "ready");
  button.disabled = false;
  button.textContent = "Repair History Now";
  clearDerivedUiCaches();
  await loadHistory().catch(() => { });
  return { converted: totalConverted, backfilled: totalBackfilled };
}

export async function runDedupHistory() {
  const button = elements.dedupHistoryButton;
  const status = elements.dedupHistoryStatus;
  const logEl = elements.dedupHistoryLog;
  if (!button) return;
  button.disabled = true;
  button.textContent = "Running...";
  setStatusPill(status, "Running deduplication...", "warning");
  if (logEl) logEl.textContent = "";
  try {
    const response = await fetch("/api/dedup-history", {
      method: "POST",
      headers: authHeaders(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResult = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("RESULT: ")) {
          try { finalResult = JSON.parse(trimmed.substring(8)); } catch (_) { }
        } else {
          if (logEl) logEl.textContent += trimmed + "\n";
        }
      }
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
    if (finalResult) {
      const msg = `Complete — deleted ${finalResult.deleted} duplicate(s) from ${finalResult.scanned} records.`;
      setStatusPill(status, msg, "ready");
      if (logEl) logEl.textContent += msg + "\n";
    } else {
      setStatusPill(status, "Complete.", "ready");
    }
  } catch (error) {
    const msg = `Error: ${error.message}`;
    setStatusPill(status, msg, "error");
    if (logEl) logEl.textContent += msg + "\n";
  } finally {
    button.disabled = false;
    button.textContent = "Clean Duplicates";
  }
}

export async function runTraktBackfill() {
  const button = elements.traktBackfillButton;
  const status = elements.traktBackfillStatus;
  const logEl = elements.traktBackfillLog;
  if (!button || !status) return;
  const limit = Math.max(1, Number(elements.traktBackfillLimit?.value || 500));
  const rate = Math.max(50, Number(elements.traktBackfillRate?.value || 300));
  button.disabled = true;
  button.textContent = "Backfilling Trakt Imports...";
  setStatusPill(status, `Starting Trakt import backfill (limit=${limit}, rate=${rate}ms)`, "warning");
  if (logEl) logEl.textContent = `Starting Trakt import backfill at ${new Date().toISOString()}\n`;
  try {
    const maxBatches = 2000;
    let batch = 0;
    let totalBackfilled = 0;
    let lastBackfilled = -1;
    for (; batch < maxBatches; batch++) {
      setStatusPill(status, `Running batch #${batch + 1}...`, "warning");
      const resp = await fetch(`/api/admin-backfill-trakt`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ limit, rateMs: rate }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = body.error || `Backfill failed (${resp.status})`;
        if (logEl) logEl.textContent = `${new Date().toISOString()} - ERROR: ${msg}\n` + logEl.textContent;
        setStatusPill(status, `Error: ${msg}`, "error");
        break;
      }
      const tried = Number(body.tried || 0);
      const backfilled = Number(body.backfilled || 0);
      totalBackfilled += backfilled;
      const now = new Date().toISOString();
      if (logEl) {
        logEl.textContent = `${now} - Batch ${batch + 1}: tried=${tried} backfilled=${backfilled}\n` + logEl.textContent;
      }
      let remaining = null;
      try {
        const st = await fetch(`/api/admin-backfill-status`, { headers: authHeaders() });
        const stBody = await st.json().catch(() => ({}));
        remaining = Number(stBody.remaining ?? stBody.missing ?? null);
      } catch (err) {
        // ignore
      }
      setStatusPill(status, remaining != null ? `Batch ${batch + 1}: backfilled ${backfilled}. Remaining: ${remaining}` : `Batch ${batch + 1}: backfilled ${backfilled}`, "warning");
      if ((backfilled === 0 && lastBackfilled === 0) || (remaining === 0)) {
        if (logEl) logEl.textContent = `${new Date().toISOString()} - No further progress; stopping.\n` + logEl.textContent;
        break;
      }
      lastBackfilled = backfilled;
      await new Promise((r) => setTimeout(r, 300));
    }
    setStatusPill(status, `Completed: total backfilled ${totalBackfilled} after ${batch + 1} batches`, "ready");
  } catch (err) {
    const msg = err?.message || String(err);
    if (logEl) logEl.textContent = `${new Date().toISOString()} - ERROR: ${msg}\n` + logEl.textContent;
    setStatusPill(status, `Error: ${msg}`, "error");
    throw err;
  } finally {
    button.disabled = false;
    button.textContent = "Backfill Trakt Imports";
  }
}

export async function runRematchTvShows() {
  const button = elements.rematchTvButton;
  const status = elements.rematchTvStatus;
  const logEl = elements.rematchTvLog;
  if (!button || !status) return;

  button.disabled = true;
  button.textContent = "Rematching...";
  status.textContent = "Running";
  status.className = "status-pill status-warning";
  if (logEl) logEl.textContent = `Starting TV show rematch at ${new Date().toISOString()}\n`;

  const limit = 8;
  let offset = 0;
  let page = 1;
  let hasMore = true;
  const totals = { matched: 0, updatedShows: 0, updatedRows: 0, failed: 0 };

  try {
    while (hasMore) {
      status.textContent = `Batch ${page}`;
      const response = await fetch("/api/rematch-tv-shows", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ offset, limit }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Rematch failed with ${response.status}`);

      totals.matched += Number(body.matched || 0);
      totals.updatedShows += Number(body.updatedShows || 0);
      totals.updatedRows += Number(body.updatedRows || 0);
      totals.failed += Number(body.failed || 0);

      if (logEl) {
        for (const line of body.log || []) logEl.textContent += line + "\n";
        logEl.scrollTop = logEl.scrollHeight;
      }

      offset = Number(body.nextOffset || offset + Number(body.processed || 0));
      hasMore = Boolean(body.hasMore) && Number(body.processed || 0) > 0;
      status.textContent = `Batch ${page}: ${Math.min(offset, Number(body.total || offset))}/${Number(body.total || offset)}`;
      page += 1;
    }

    clearDerivedUiCaches();
    await loadHistory({ force: true }).catch(() => null);
    status.textContent = `Complete: ${totals.updatedShows} shows, ${totals.updatedRows} rows`;
    status.className = "status-pill status-ready";
    setMessage(`TV rematch complete. Updated ${totals.updatedShows} shows and ${totals.updatedRows} episode rows.`, totals.failed ? "warning" : "success");
  } catch (error) {
    status.textContent = "Error";
    status.className = "status-pill status-error";
    if (logEl) logEl.textContent += `ERROR: ${error.message}\n`;
    setMessage(`TV rematch failed: ${error.message}`, "error");
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Rematch TV Shows";
  }
}

function appendFullSyncLog(message) {
  if (!elements.fullSyncLog) return;
  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  elements.fullSyncLog.textContent = `[${timestamp}] ${message}\n${elements.fullSyncLog.textContent || ""}`.trim();
  elements.fullSyncLog.scrollTop = 0;
}

function summarizeFullSyncPhase(summary = {}) {
  return Object.entries(summary)
    .map(([target, counts]) => {
      const success = Number(counts.success || 0);
      const notFound = Number(counts.notFound || 0);
      const skipped = Number(counts.skipped || 0);
      const error = Number(counts.error || 0);
      return `${platformName(target)} ${success} ok, ${notFound} not found, ${skipped} skipped, ${error} errors`;
    })
    .join(" | ");
}

export async function runFullSyncWatchstates() {
  if (state.fullSyncActive) return;
  const button = elements.fullSyncButton;
  const status = elements.fullSyncStatus;
  if (!button || !status) return;
  state.fullSyncActive = true;
  button.disabled = true;
  button.textContent = "Syncing...";
  status.textContent = "Running";
  status.className = "status-pill status-ready";
  if (elements.fullSyncLog) elements.fullSyncLog.textContent = "";
  const limit = 25;
  const phases = ["watched", "progress"];
  const totals = {
    watched: { processed: 0 },
    progress: { processed: 0 },
  };
  try {
    for (const phase of phases) {
      let offset = 0;
      let batch = 1;
      let hasMore = true;
      appendFullSyncLog(`Starting ${phase} restore.`);
      while (hasMore) {
        const response = await fetch("/api/full-sync-watchstates", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ phase, offset, limit }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Full sync failed with ${response.status}`);
        totals[phase].processed += Number(body.processed || 0);
        appendFullSyncLog(`${phase} batch ${batch}: processed ${Number(body.processed || 0)} of ${Number(body.total || 0)}. ${summarizeFullSyncPhase(body.summary || {})}`);
        if (Array.isArray(body.errors) && body.errors.length) {
          appendFullSyncLog(`${phase} batch ${batch}: ${body.errors.length} platform errors captured.`);
        }
        offset = Number(body.nextOffset || offset + Number(body.processed || 0));
        hasMore = Boolean(body.hasMore) && Number(body.processed || 0) > 0;
        batch += 1;
      }
    }
    clearDerivedUiCaches();
    status.textContent = "Complete";
    status.className = "status-pill status-ready";
    setMessage(`Full sync complete. Watched rows: ${totals.watched.processed}. Progress rows: ${totals.progress.processed}.`, "success");
  } catch (error) {
    status.textContent = "Error";
    status.className = "status-pill status-error";
    appendFullSyncLog(`ERROR: ${error.message}`);
    setMessage(`Full sync failed: ${error.message}`, "error");
    throw error;
  } finally {
    state.fullSyncActive = false;
    button.disabled = false;
    button.textContent = "Full Sync Watchstates";
  }
}

// ── Cache stats ──────────────────────────────────────────────────────────

function fmtCacheBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export async function loadCacheStats({ force = false } = {}) {
  if (!state.token || state.cacheStatsLoading || (state.cacheStats && !force)) return state.cacheStats;
  state.cacheStatsLoading = true;
  renderCachePanel();
  try {
    const response = await fetch("/api/cache-stats", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Cache stats failed with ${response.status}`);
    state.cacheStats = body;
    return body;
  } finally {
    state.cacheStatsLoading = false;
    renderCachePanel();
  }
}

async function clearCacheType(type) {
  try {
    const response = await fetch("/api/clear-cache", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Cache clear failed with ${response.status}`);
    const label = type === "all" ? "all images" : type;
    setMessage(`Cleared ${body.deleted} file${body.deleted !== 1 ? "s" : ""} (${fmtCacheBytes(body.freed)} freed) from ${label}.`, "success");
    state.cacheStats = null;
    loadCacheStats().catch((error) => setMessage(error.message, "error"));
  } catch (error) {
    setMessage(error.message, "error");
  }
}

export function renderCachePanel() {
  const panel = document.getElementById("cacheStatsPanel");
  if (!panel) return;
  if (state.cacheStatsLoading && !state.cacheStats) {
    panel.innerHTML = `<p class="muted-text" style="padding:var(--space-3) 0;">Loading...</p>`;
    return;
  }
  if (!state.cacheStats) {
    panel.innerHTML = `<p class="muted-text" style="padding:var(--space-3) 0;">No data loaded.</p>`;
    return;
  }
  const { disk } = state.cacheStats;
  const rows = [
    { key: "posters", label: "Posters" },
    { key: "backdrops", label: "Backdrops" },
    { key: "profiles", label: "Profiles" },
  ];
  const totalCount = rows.reduce((sum, r) => sum + (disk[r.key]?.count || 0), 0);
  const totalSize = rows.reduce((sum, r) => sum + (disk[r.key]?.size || 0), 0);

  const maxBytes = Math.max(...rows.map(({ key }) => disk[key]?.size || 0), 1);

  panel.innerHTML = `
    <div class="cache-gauge-grid">
      ${rows.map(({ key, label }) => {
        const count = disk[key]?.count || 0;
        const size = disk[key]?.size || 0;
        const percent = Math.max(5, Math.round((size / maxBytes) * 100));
        return `
          <div class="cache-gauge-card">
            <div class="cache-gauge-meta">
              <span class="cache-gauge-title">${label}</span>
              <span class="cache-gauge-count">${count.toLocaleString()} files</span>
            </div>
            <div class="cache-gauge-size">${fmtCacheBytes(size)}</div>
            <div class="cache-gauge-bar">
              <div class="cache-gauge-fill" style="width: ${percent}%;"></div>
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:0.25rem;">
              <button class="button-ghost" type="button" style="font-size:0.76rem; padding:0.25rem 0.65rem; min-height:1.85rem; height:1.85rem;" data-clear-cache="${key}">Clear</button>
            </div>
          </div>
        `;
      }).join("")}
    </div>
    <div style="display:flex; align-items:center; justify-content:space-between; margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--line); flex-wrap:wrap; gap:1rem;">
      <div style="display:flex; gap:1.5rem; font-size:0.85rem;">
        <div><span style="color:var(--muted)">Total Files:</span> <strong style="color:var(--text); margin-left:0.3rem;">${totalCount.toLocaleString()}</strong></div>
        <div><span style="color:var(--muted)">Total Size:</span> <strong style="color:var(--text); margin-left:0.3rem;">${fmtCacheBytes(totalSize)}</strong></div>
      </div>
      <button class="button-primary" type="button" style="font-size:0.8rem; padding:0.25rem 0.85rem; height:2.2rem; min-height:2.2rem;" data-clear-cache="all">Clear All</button>
    </div>
  `;
  for (const btn of panel.querySelectorAll("[data-clear-cache]")) {
    btn.addEventListener("click", () => clearCacheType(btn.dataset.clearCache));
  }
}
