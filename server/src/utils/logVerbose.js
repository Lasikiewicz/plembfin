// Opt-in tracing for the chatty per-request paths (Plex GUID lookups, search
// fallbacks, per-item sync skips). These are useful when diagnosing a specific
// match failure but produce hundreds of lines per minute in normal operation,
// so they stay off unless LOG_VERBOSE is set.
//
// Deliberately dependency-free: plexClient/scheduled/tmdb modules all import
// this, and pulling in db.js or diagnosticLogger.js here would risk a cycle.

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

let verbose = truthy(process.env.LOG_VERBOSE);

export function isVerboseLogging() {
  return verbose;
}

// Exposed for tests and for a future runtime toggle in Settings.
export function setVerboseLogging(enabled) {
  verbose = Boolean(enabled);
}

// Drop-in replacement for console.log at trace call sites.
export function traceLog(...args) {
  if (!verbose) return;
  console.log(...args);
}
