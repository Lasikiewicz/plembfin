// Configurable sync heuristics. This module imports nothing else in the repo
// (env-only reads) so configStore.js — which already imports outbound.js —
// can import this module too without creating an import cycle.
//
// Each value has an env var, a default equal to the previous hardcoded
// literal, and a clamp range. `applyTuningConfig` lets configStore.js layer
// stored settings over the env/default without this module reading the
// settings table itself.

const DEFAULTS = {
  watchedThresholdPercent: 90,
  minResumePositionSec: 60,
  activeSessionTtlMin: 5,
  outboundTimeoutSec: 10,
};

const CLAMPS = {
  watchedThresholdPercent: [50, 100],
  minResumePositionSec: [0, 3600],
  activeSessionTtlMin: [1, 120],
  outboundTimeoutSec: [2, 120],
};

const ENV_VARS = {
  watchedThresholdPercent: "WATCHED_THRESHOLD_PERCENT",
  minResumePositionSec: "MIN_RESUME_POSITION_SEC",
  activeSessionTtlMin: "ACTIVE_SESSION_TTL_MIN",
  outboundTimeoutSec: "OUTBOUND_TIMEOUT_SEC",
};

function clamp(key, value) {
  const [min, max] = CLAMPS[key];
  return Math.min(max, Math.max(min, value));
}

function readEnvValue(key) {
  const raw = process.env[ENV_VARS[key]];
  if (raw === undefined || String(raw).trim() === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return clamp(key, num);
}

function envOrDefault(key) {
  const envValue = readEnvValue(key);
  return envValue === null ? DEFAULTS[key] : envValue;
}

// Effective values, refreshed by applyTuningConfig() on boot and on every
// settings save. Start out env/default so a getter call before the config
// store has loaded still returns a safe value.
let effective = {
  watchedThresholdPercent: envOrDefault("watchedThresholdPercent"),
  minResumePositionSec: envOrDefault("minResumePositionSec"),
  activeSessionTtlMin: envOrDefault("activeSessionTtlMin"),
  outboundTimeoutSec: envOrDefault("outboundTimeoutSec"),
};

// Normalizes a raw stored/incoming tuning section (numbers-or-null/blank) into
// { key: number|null } — null means "not overridden, fall back to env/default".
// Deliberately does NOT clamp: out-of-range values are rejected by
// validateConfig() in configStore.js rather than silently corrected here, so
// bad input via the settings API produces a validation error instead of a
// value that quietly differs from what the admin typed.
export function normalizeTuningSection(raw = {}) {
  const normalized = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw?.[key];
    if (value === null || value === undefined || String(value).trim() === "") {
      normalized[key] = null;
      continue;
    }
    const num = Number(value);
    normalized[key] = Number.isFinite(num) ? num : null;
  }
  return normalized;
}

// Applies a normalized (or raw) tuning section as the current effective
// values: an explicit non-null field overrides env/default; null/missing
// falls back to env/default. Call on boot and after every settings save.
// Clamps as a safety net for out-of-range values that reach storage some
// other way (hand-edited config.json, older data) — normal saves are already
// range-checked by validateConfig() before they ever get here.
export function applyTuningConfig(section = {}) {
  const normalized = normalizeTuningSection(section);
  const next = {};
  for (const key of Object.keys(DEFAULTS)) {
    next[key] = normalized[key] === null ? envOrDefault(key) : clamp(key, normalized[key]);
  }
  effective = next;
  return effective;
}

// Test-only: restores the module to its env/default state, undoing any
// applyTuningConfig() call. Re-reads env vars so tests that set/unset env
// vars between calls see the change.
export function resetTuningForTests() {
  effective = {
    watchedThresholdPercent: envOrDefault("watchedThresholdPercent"),
    minResumePositionSec: envOrDefault("minResumePositionSec"),
    activeSessionTtlMin: envOrDefault("activeSessionTtlMin"),
    outboundTimeoutSec: envOrDefault("outboundTimeoutSec"),
  };
}

export function watchedThresholdPercent() {
  return effective.watchedThresholdPercent;
}

export function minResumePositionMs() {
  return effective.minResumePositionSec * 1000;
}

export function activeSessionTtlMs() {
  return effective.activeSessionTtlMin * 60 * 1000;
}

export function outboundTimeoutMs() {
  return effective.outboundTimeoutSec * 1000;
}

export function tuningDefaults() {
  return { ...DEFAULTS };
}

export function tuningClamps() {
  return { ...CLAMPS };
}

// Env-or-hardcoded-default per key, ignoring any stored config override.
// Used by configStore.js to show the effective placeholder when a field is
// unset, and as the base for envMediaConfig().
export function tuningEnvDefaults() {
  const result = {};
  for (const key of Object.keys(DEFAULTS)) result[key] = envOrDefault(key);
  return result;
}
