let getHeaders = () => ({ "Content-Type": "application/json" });
let bound = false;
let traktProvider = { appConfigured: false, configurationIncomplete: false, personalAppSupported: true };

const el = (id) => document.getElementById(id);
const setStatus = (text, tone = "muted") => {
  const status = el("traktConnectionStatus");
  if (status) { status.textContent = text; status.className = `status-pill status-${tone}`; }
};
const setMessage = (text, tone = "muted") => {
  const message = el("traktConnectMessage");
  if (!message) return;
  message.textContent = text || "";
  message.style.display = text ? "block" : "none";
  message.className = `message ${tone}`;
  message.dataset.tone = tone;
};
const setSyncProgress = (active, label = "Reading the complete Trakt watched snapshot…") => {
  const progress = el("traktSyncProgress");
  const progressLabel = el("traktSyncProgressLabel");
  progress?.classList.toggle("hidden", !active);
  if (progressLabel) progressLabel.textContent = label;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function traktSyncCompletionMessage(result = {}) {
  const watched = Number(result.watched || 0);
  const unwatched = Number(result.unwatched || 0);
  const deferred = Number(result.deferredWatched || 0) + Number(result.deferredUnwatched || 0);
  const remoteItems = Number(result.remoteItems || 0);
  const changes = watched + unwatched;
  const deferredCopy = deferred
    ? ` ${deferred} change${deferred === 1 ? "" : "s"} held for re-check.`
    : "";
  return `Trakt sync complete: ${remoteItems.toLocaleString()} item${remoteItems === 1 ? "" : "s"} checked; ${watched} watched and ${unwatched} unwatched change${changes === 1 ? "" : "s"} applied.${deferredCopy}`;
}

function renderConnection(connection) {
  const connected = connection?.status === "connected" || connection?.status === "reauth_required";
  const summary = el("traktConnectedSummary");
  const fields = el("traktConnectForm")?.querySelector(".sync-tuning-fields");
  const connectHint = el("traktConnectHint");
  el("traktConnectButton")?.classList.toggle("hidden", connected);
  el("traktSyncNowButton")?.classList.toggle("hidden", !connected);
  el("traktDisconnectButton")?.classList.toggle("hidden", !connected);
  fields?.classList.toggle("hidden", connected);
  connectHint?.classList.toggle("hidden", connected);
  el("traktPersonalAppFields")?.classList.toggle("hidden", connected);
  summary?.classList.toggle("hidden", !connected);
  if (!connected) {
    setStatus("Not connected", "warning");
    if (summary) summary.innerHTML = "";
    return;
  }
  setStatus(connection.status === "connected" ? "Connected" : "Reconnect required", connection.status === "connected" ? "ready" : "warning");
  if (summary) summary.innerHTML = `<b>${escapeText(connection.remoteUsername || "Trakt account")}</b><span>${connection.baselineComplete ? "Live bidirectional sync is active." : "The first complete Trakt snapshot is waiting to run."}</span>${connection.lastError ? `<small>${escapeText(connection.lastError)}</small>` : ""}`;
}

function renderProvider() {
  const status = el("traktAppStatus");
  const personal = el("traktPersonalAppFields");
  if (traktProvider.appConfigured) {
    if (status) status.textContent = "The Plembfin Trakt app is ready. Connect and approve the displayed device code.";
    personal?.removeAttribute("open");
    return;
  }
  if (status) status.textContent = traktProvider.configurationIncomplete
    ? "The server has an incomplete Trakt configuration. Set both TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET, then restart Plembfin."
    : "The Plembfin Trakt app is unavailable. A Trakt VIP developer may use a personal app below.";
  if (!traktProvider.configurationIncomplete) personal?.setAttribute("open", "");
}

function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = String(value || "");
  return span.innerHTML;
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...getHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}`);
  return body;
}

export async function refreshTrackerSettings() {
  try {
    const body = await api("/api/tracker-connections");
    traktProvider = body.providers?.trakt || traktProvider;
    renderProvider();
    renderConnection((body.connections || []).find((item) => item.provider === "trakt"));
  } catch (error) {
    if (!/401|403|administrator|same-origin/i.test(error.message)) setMessage(error.message, "error");
  }
}

async function startTraktFlow({ clientId = "", clientSecret = "" } = {}) {
  const isManual = Boolean(clientId || clientSecret);
  const connectBtn = el("traktConnectButton");
  const saveBtn = el("traktSaveManualButton");
  if (connectBtn) connectBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  setMessage(isManual ? "Starting Trakt device sign-in with manual credentials…" : "Starting Trakt device sign-in…");
  try {
    const start = await api("/api/tracker-auth/trakt/start", {
      method: "POST",
      body: JSON.stringify({
        clientId: isManual ? clientId : (traktProvider.appConfigured ? "" : el("traktClientId")?.value.trim() || ""),
        clientSecret: isManual ? clientSecret : (traktProvider.appConfigured ? "" : el("traktClientSecret")?.value.trim() || ""),
        initialSyncMode: el("traktInitialSyncMode")?.value || "baseline",
      }),
    });
    const code = el("traktDeviceCode");
    code.classList.remove("hidden");
    code.innerHTML = `<span>Enter this code in Trakt</span><b>${escapeText(start.userCode)}</b><small>The code expires automatically. Keep this page open while authorizing Plembfin.</small><div class="settings-actions"><button id="traktCopyDeviceCode" class="button-ghost sync-action-btn sync-tool-button" type="button">Copy code</button><a id="traktOpenActivation" class="button-primary sync-action-btn sync-tool-button" target="_blank" rel="noopener noreferrer">Open Trakt</a></div>`;
    el("traktOpenActivation").href = start.verificationUrl;
    el("traktCopyDeviceCode").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(start.userCode);
        el("traktCopyDeviceCode").textContent = "Copied";
      } catch {
        setMessage(`Copy this Trakt code: ${start.userCode}`, "warning");
      }
    });
    code.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setMessage("Copy the code, then open Trakt and approve Plembfin. This page will finish automatically.");
    let interval = Math.max(2, Number(start.intervalSeconds || 5));
    while (Date.now() < Number(start.expiresAt)) {
      await sleep(interval * 1000);
      const response = await fetch(`/api/tracker-auth/trakt/${encodeURIComponent(start.flowId)}/status`, { credentials: "same-origin", headers: getHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.status === 202 || body.status === "pending") { interval = Math.max(interval, Number(body.retryAfter || 0)); continue; }
      if (!response.ok) throw new Error(body.error || (body.status === "denied" ? "Trakt authorization was denied." : "Trakt sign-in expired."));
      if (body.status === "completed") {
        code.classList.add("hidden");
        if (el("traktClientSecret")) el("traktClientSecret").value = "";
        renderConnection(body.connection);
        setMessage("Trakt connected. Run Sync Now, or wait for the next one-minute poll.", "success");
        return;
      }
    }
    throw new Error("Trakt sign-in expired. Start again.");
  } catch (error) {
    setMessage(error.message || "Trakt connection failed.", "error");
  } finally {
    if (connectBtn) connectBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function connect(event) {
  event.preventDefault();
  await startTraktFlow();
}

async function saveManual(event) {
  event.preventDefault();
  const clientId = el("traktClientId")?.value.trim();
  const clientSecret = el("traktClientSecret")?.value.trim();
  if (!clientId || !clientSecret) {
    setMessage("Please enter both Trakt Client ID and Client Secret.", "warning");
    return;
  }
  await startTraktFlow({ clientId, clientSecret });
}

async function syncNow() {
  const button = el("traktSyncNowButton");
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = "Syncing…";
  button.setAttribute("aria-busy", "true");
  setMessage("");
  setSyncProgress(true);
  try {
    const body = await api("/api/tracker-connections/trakt", { method: "POST", body: "{}" });
    renderConnection(body.connection);
    setMessage(traktSyncCompletionMessage(body.result), "success");
  } catch (error) { setMessage(error.message, "error"); }
  finally {
    setSyncProgress(false);
    button.disabled = false;
    button.textContent = "Sync Now";
    button.removeAttribute("aria-busy");
  }
}

async function disconnect() {
  if (!window.confirm("Disconnect Trakt and delete its encrypted OAuth credentials from Plembfin?")) return;
  try {
    await api("/api/tracker-connections/trakt", { method: "DELETE" });
    renderConnection(null);
    setMessage("Trakt disconnected. Existing Plembfin history was kept.", "success");
  } catch (error) { setMessage(error.message, "error"); }
}

export function initTrackerSettings({ authHeaders } = {}) {
  if (authHeaders) getHeaders = authHeaders;
  if (bound) return;
  bound = true;
  el("traktConnectForm")?.addEventListener("submit", connect);
  el("traktManualForm")?.addEventListener("submit", saveManual);
  el("traktSyncNowButton")?.addEventListener("click", syncNow);
  el("traktDisconnectButton")?.addEventListener("click", disconnect);
}
