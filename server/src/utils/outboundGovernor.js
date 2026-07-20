// Shared, hostname-scoped outbound pacing for media servers and providers.
// The governor is deliberately small: callers await admission, then release
// in a finally block. Credentials and URL paths never enter its telemetry.

const PROFILES = {
  gentle: { sync: { concurrency: 2, intervalMs: 120 }, enrichment: { concurrency: 1, intervalMs: 300 }, interactive: { concurrency: 3, intervalMs: 60 } },
  standard: { sync: { concurrency: 4, intervalMs: 30 }, enrichment: { concurrency: 2, intervalMs: 120 }, interactive: { concurrency: 6, intervalMs: 15 } },
  fast: { sync: { concurrency: 8, intervalMs: 0 }, enrichment: { concurrency: 4, intervalMs: 30 }, interactive: { concurrency: 10, intervalMs: 0 } },
};
const LANES = ["interactive", "sync", "enrichment"];
const hosts = new Map();
let profile = "standard";

function laneConfig(lane) { return PROFILES[profile][LANES.includes(lane) ? lane : "sync"]; }
function hostState(host) {
  if (!hosts.has(host)) hosts.set(host, { active: 0, lastStartedAt: 0, cooldownUntil: 0, throttled: 0, retries: 0, cooldowns: 0, requests: 0, queued: 0 });
  return hosts.get(host);
}
function wait(ms) { return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }

export function configureOutboundGovernor(nextProfile = "standard") {
  profile = PROFILES[nextProfile] ? nextProfile : "standard";
  return profile;
}
export function resetOutboundGovernor() { hosts.clear(); profile = "standard"; }
export function outboundGovernorProfile() { return profile; }

export async function acquireOutboundSlot(hostname, { lane = "sync", signal } = {}) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return () => {};
  const state = hostState(host);
  const limits = laneConfig(lane);
  state.queued += 1;
  try {
    while (state.active >= limits.concurrency || state.cooldownUntil > Date.now() || Date.now() - state.lastStartedAt < limits.intervalMs) {
      if (signal?.aborted) throw signal.reason || new Error("Outbound request cancelled");
      const delay = Math.max(10, state.cooldownUntil - Date.now(), limits.intervalMs - (Date.now() - state.lastStartedAt));
      await wait(delay);
    }
    state.active += 1;
    state.lastStartedAt = Date.now();
    state.requests += 1;
    return () => { state.active = Math.max(0, state.active - 1); };
  } finally {
    state.queued = Math.max(0, state.queued - 1);
  }
}

export function noteOutboundResponse(hostname, status, retryAfter = "") {
  const host = String(hostname || "").toLowerCase();
  if (!host) return;
  const state = hostState(host);
  if (![429, 502, 503, 504].includes(Number(status))) return;
  state.throttled += Number(status) === 429 ? 1 : 0;
  const retrySeconds = Number.parseFloat(String(retryAfter).trim());
  const retryMs = Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds * 1000) : 1000;
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + retryMs);
  state.cooldowns += 1;
}
export function noteOutboundRetry(hostname) { const state = hostState(String(hostname || "").toLowerCase()); state.retries += 1; }
export function outboundGovernorTelemetry() {
  return { profile, destinations: [...hosts.entries()].map(([host, state]) => ({ host, requests: state.requests, throttled: state.throttled, retries: state.retries, cooldowns: state.cooldowns, active: state.active, queued: state.queued, cooldownUntil: state.cooldownUntil || 0, nextEligibleAt: Math.max(state.cooldownUntil || 0, state.lastStartedAt + laneConfig("sync").intervalMs) })) };
}
