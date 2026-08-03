const MAX_TEXT_LENGTH = 240;

const LEGACY_NOTE = "Record predates detailed provenance capture; only the originating platform was retained.";

function text(value, maxLength = MAX_TEXT_LENGTH) {
  const valueText = String(value ?? "").trim();
  return valueText ? valueText.slice(0, maxLength) : "";
}

function timestamp(value) {
  const valueText = text(value, 80);
  if (!valueText) return "";
  const parsed = new Date(valueText);
  return Number.isNaN(parsed.getTime()) ? valueText : parsed.toISOString();
}

function objectFrom(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function inferredPath(source = "") {
  const normalized = text(source).toLowerCase();
  if (normalized === "manual") return "manual";
  if (normalized === "progress_resolve") return "manual_progress_resolve";
  if (normalized === "force_sync") return "force_sync";
  if (normalized.includes("import")) return "historical_import";
  if (normalized.endsWith("_initial_sync")) return normalized;
  return "unknown";
}

/**
 * Normalize the persisted, deliberately small provenance object. Raw webhook
 * payloads and credentials never belong in this object; those remain in the
 * existing short-lived diagnostic history when an invalid request needs them.
 */
export function normalizeWatchProvenance(value, defaults = {}) {
  const input = objectFrom(value);
  const hasDefaults = Object.keys(defaults || {}).length > 0;
  if (!Object.keys(input).length && !hasDefaults) return null;

  const source = text(input.source || defaults.source);
  const ingestPath = text(input.ingest_path || input.ingestPath || defaults.ingestPath) || inferredPath(source);
  const confidence = text(input.confidence || defaults.confidence) || (ingestPath === "unknown" ? "source_only" : "exact");
  const sourceEvent = text(input.event || input.source_event || input.sourceEvent || defaults.event);
  const sourceTimestamp = timestamp(input.source_timestamp || input.sourceTimestamp || defaults.sourceTimestamp);
  const capturedAt = timestamp(input.captured_at || input.capturedAt || defaults.capturedAt) || new Date().toISOString();

  return {
    version: 1,
    source,
    ingest_path: ingestPath,
    event: sourceEvent,
    phase: text(input.phase || defaults.phase),
    item_id: text(input.item_id || input.itemId || defaults.itemId),
    session_id: text(input.session_id || input.sessionId || defaults.sessionId),
    user: text(input.user || defaults.user),
    source_timestamp: sourceTimestamp,
    captured_at: capturedAt,
    confidence,
    note: text(input.note || defaults.note || (confidence === "source_only" ? LEGACY_NOTE : ""), 400),
  };
}

export function buildWatchProvenance(media = {}, {
  ingestPath = "",
  sourceTimestamp = "",
  capturedAt = "",
  confidence = "",
  note = "",
} = {}) {
  const source = text(media.source || media.platform);
  const path = text(ingestPath || media.ingest_path || media.ingestPath) || inferredPath(source);
  return normalizeWatchProvenance({
    source,
    ingest_path: path,
    event: media.event,
    phase: media.phase,
    item_id: media.item_id || media.itemId,
    session_id: media.session_id || media.sessionId,
    user: media.user,
    source_timestamp: sourceTimestamp || media.source_timestamp || media.sourceTimestamp || media.playedAt,
    captured_at: capturedAt,
    confidence: confidence || (path === "unknown" ? "source_only" : "exact"),
    note: note || (path === "unknown" ? LEGACY_NOTE : ""),
  });
}

export function provenanceTelemetryLines(value, defaults = {}) {
  const provenance = normalizeWatchProvenance(value, defaults);
  if (!provenance) {
    return [
      "Ingest path: unavailable",
      "Source event: unavailable",
      "Source item ID: unavailable",
      "Provenance confidence: source_only",
      `Provenance note: ${LEGACY_NOTE}`,
    ];
  }

  const lines = [
    `Ingest path: ${provenance.ingest_path || "unknown"}`,
    `Source event: ${provenance.event || "unavailable"}`,
    `Source item ID: ${provenance.item_id || "unavailable"}`,
  ];
  if (provenance.session_id) lines.push(`Source session ID: ${provenance.session_id}`);
  if (provenance.user) lines.push(`Source user: ${provenance.user}`);
  if (provenance.source_timestamp) lines.push(`Source timestamp: ${provenance.source_timestamp}`);
  if (provenance.captured_at) lines.push(`Provenance captured: ${provenance.captured_at}`);
  lines.push(`Provenance confidence: ${provenance.confidence || "unknown"}`);
  if (provenance.note) lines.push(`Provenance note: ${provenance.note}`);
  return lines;
}

export const legacyProvenanceNote = LEGACY_NOTE;
