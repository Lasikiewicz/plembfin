// Pure aggregation over watch-history rows answering: which media did each
// platform report "No matching item found" for during outbound playstate sync?
// Works on the rows returned by getCachedHistory() (current per-record state),
// so a record that later synced or was resolved by Force Sync is not counted.
//
// The target-line regex matches both telemetry formats the app writes
// ("Target plex status: ..." from the scheduler and "Plex status: ..." from the
// webhook path) and mirrors telemetryTargetStates() in public/modules/sync.js —
// keep the two in step.

const TARGET_LINE_RE = /^(?:Target\s+)?(Plex|Emby|Jellyfin)\s+(?:progress\s+)?status:\s*([^-]+?)(?:\s+-\s*(.*))?$/i;

const SAMPLE_LIMIT = 20;

function telemetryLineValue(value = "", label = "") {
  const prefix = `${label}:`.toLowerCase();
  const line = String(value || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

export function parseTelemetryTargetStates(telemetry = "") {
  const states = [];
  for (const line of String(telemetry || "").split(/\r?\n/)) {
    const match = line.trim().match(TARGET_LINE_RE);
    if (!match) continue;
    states.push({
      target: match[1].toLowerCase(),
      status: match[2].trim().toLowerCase(),
      detail: (match[3] || "").trim(),
    });
  }
  return states;
}

function isForceSyncResolved(telemetry = "") {
  return String(telemetry || "").includes("Force Sync resolved status to");
}

// Rows created by an initial history import that never had an outbound sync job
// (same definition as isLegacyInitialSyncPlaceholder in dataRepo.js).
function isLegacyInitialSyncPlaceholder(telemetry = "", states = []) {
  const origin = telemetryLineValue(telemetry, "Origin").toLowerCase();
  const details = telemetryLineValue(telemetry, "Details").toLowerCase();
  return origin.endsWith("_initial_sync") && !states.length && details.includes("awaiting outbound sync telemetry");
}

function targetStateNotFound(state = {}) {
  return `${state.status || ""} ${state.detail || ""}`.toLowerCase().includes("no matching item found");
}

function createPlatformAggregate() {
  return { rowCount: 0, media: new Map() };
}

function finalizePlatformAggregate(aggregate) {
  const media = [...aggregate.media.values()];
  return {
    rowCount: aggregate.rowCount,
    uniqueMediaCount: media.length,
    movies: media.filter((item) => item.media_type === "movie").length,
    episodes: media.filter((item) => item.media_type === "episode").length,
    samples: media.slice(0, SAMPLE_LIMIT),
  };
}

export function buildSyncMatchReport(rows = []) {
  const platforms = {
    plex: createPlatformAggregate(),
    emby: createPlatformAggregate(),
    jellyfin: createPlatformAggregate(),
  };
  let scannedRows = 0;

  for (const row of rows) {
    const telemetry = String(row?.sync_dispatch_telemetry || "");
    if (!telemetry.trim()) continue;
    scannedRows += 1;
    if (isForceSyncResolved(telemetry)) continue;
    const states = parseTelemetryTargetStates(telemetry);
    if (isLegacyInitialSyncPlaceholder(telemetry, states)) continue;

    for (const state of states) {
      const aggregate = platforms[state.target];
      if (!aggregate || !targetStateNotFound(state)) continue;
      aggregate.rowCount += 1;
      const mediaKey = row.media_key || row.id || `${row.title || ""}|${row.media_type || ""}`;
      const existing = aggregate.media.get(mediaKey);
      if (existing) {
        existing.rowCount += 1;
      } else {
        aggregate.media.set(mediaKey, {
          media_key: row.media_key || null,
          id: row.id || null,
          title: row.title || "",
          show_title: row.show_title || null,
          media_type: row.media_type || "",
          season: row.season ?? null,
          episode: row.episode ?? null,
          watched_at: row.watched_at || "",
          detail: state.detail || "No matching item found",
          rowCount: 1,
        });
      }
    }
  }

  const report = {
    scannedRows,
    totalUnmatchedRows: 0,
    platforms: {},
  };
  for (const [platform, aggregate] of Object.entries(platforms)) {
    const finalized = finalizePlatformAggregate(aggregate);
    report.platforms[platform] = finalized;
    report.totalUnmatchedRows += finalized.rowCount;
  }
  return report;
}
