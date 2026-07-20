import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";

export function initHealthTools() {
  const button = document.querySelector("#refreshSyncHealthButton");
  const panel = document.querySelector("#syncHealthPanel");
  if (!button || !panel) return;
  button.addEventListener("click", () => loadSyncHealth(panel, button));
}
export async function loadSyncHealth(panel = document.querySelector("#syncHealthPanel"), button = document.querySelector("#refreshSyncHealthButton")) {
  if (!panel) return;
  if (button) button.disabled = true;
  panel.innerHTML = "<p>Loading sync health…</p>";
  try {
    const response = await fetch("/api/health/sync", { headers: buildAuthHeaders(state.token), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Health check failed");
    const health = body.health || {};
    const counts = health.counts || {};
    const destinations = health.outbound?.destinations || [];
    panel.innerHTML = `<div class="sync-health-grid">${Object.entries(counts).map(([key, item]) => { const value = typeof item === "object" ? item.value : item; const status = typeof item === "object" ? item.status : "normal"; return `<div class="sync-health-metric"><span>${key.replaceAll(/([A-Z])/g, " $1")}</span><strong>${Number(value || 0).toLocaleString()}</strong><small>${status}</small></div>`; }).join("")}</div><h4>Outbound pressure</h4>${destinations.length ? `<div class="sync-health-destinations">${destinations.map((item) => `<div><b>${item.host}</b><span>${item.requests} requests · ${item.throttled} throttled · ${item.cooldowns} cooldowns</span></div>`).join("")}</div>` : "<p>No paced destinations recorded yet.</p>"}${(health.recommendations || []).map((item) => `<p class="sync-preview-warning">${item}</p>`).join("")}`;
  } catch (error) { panel.innerHTML = `<p class="sync-preview-state error">${error.message}</p>`; }
  finally { if (button) button.disabled = false; }
}
