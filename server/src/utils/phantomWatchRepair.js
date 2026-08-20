// Repairs historical watch rows created by media-server state echoes. These
// rows arrive as an implausible burst of unrelated titles, unlike a real binge
// (which has meaningful gaps between episodes). Explicit manual watch actions
// are protected so a user can still bulk-mark a set of items intentionally.

const PLATFORM_SOURCES = new Set(["plex", "emby", "jellyfin"]);
const BURST_GAP_MS = 3 * 60 * 1000;
const MIN_BURST_ITEMS = 8;
// A chain of items is only bounded by the per-pair gap below, so without a
// total-span cap a real evening of mixed viewing (several shows, no single
// gap over BURST_GAP_MS) reads identically to a genuine echo-import flood.
// Real import bugs land every row within the same poll/webhook burst, well
// under this window; a real viewing session naturally exceeds it.
const CROSS_GROUP_MAX_SPAN_MS = 10 * 60 * 1000;
const SAME_GROUP_MIN_ITEMS = 6;
const SAME_GROUP_MAX_SPAN_MS = 60 * 1000;

function timestampMs(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function identity(row) {
  return row.media_key || [
    row.media_type,
    row.title,
    row.season ?? "",
    row.episode ?? "",
    row.imdb_id || "",
    row.tmdb_id || "",
    row.tvdb_id || "",
  ].join("|");
}

function groupIdentity(row) {
  if (row.media_type === "episode") return String(row.show_title || row.title || "").toLowerCase();
  return String(row.title || "").toLowerCase();
}

function isExplicitManualWatch(row) {
  const telemetry = String(row.sync_dispatch_telemetry || "");
  return /Origin:\s*manual/i.test(telemetry) && /Action:\s*Marked Watched/i.test(telemetry);
}

// A row every *other* configured platform has independently confirmed as
// synced is strong corroboration it's a real watch, not an import echo - each
// of those platforms verified the match and accepted the played state on its
// own. Bursts should never delete a row with that level of independent
// confirmation, even when its timing happens to match the burst pattern.
function isIndependentlyConfirmed(row, activeTargets = []) {
  const source = String(row.source || "").toLowerCase();
  const otherTargets = activeTargets
    .map((target) => String(target || "").toLowerCase())
    .filter((target) => target && target !== source && !source.startsWith(`${target}_`));
  if (!otherTargets.length) return false;

  const telemetry = String(row.sync_dispatch_telemetry || "").toLowerCase();
  if (!telemetry) return false;
  const lines = telemetry.split("\n");

  return otherTargets.every((target) => lines.some((line) => {
    if (!line.includes(`${target} status:`) && !line.includes(`${target} progress status:`)) return false;
    return line.includes("success");
  }));
}

function isCandidateRow(row, activeTargets) {
  if (!PLATFORM_SOURCES.has(String(row.source || "").toLowerCase())) return false;
  if (["unwatched", "unplayed"].includes(String(row.sync_action || "").toLowerCase())) return false;
  if (isExplicitManualWatch(row)) return false;
  if (isIndependentlyConfirmed(row, activeTargets)) return false;
  return timestampMs(row.watched_at) > 0;
}

export function findPhantomWatchBurstRows(database, {
  minItems = MIN_BURST_ITEMS,
  gapMs = BURST_GAP_MS,
  activeTargets = [],
} = {}) {
  const rows = database.prepare(`
    SELECT id, title, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id,
           season, episode, media_key, show_title, sync_action, sync_dispatch_telemetry
    FROM watch_history
    WHERE watched_at IS NOT NULL
      AND (sync_action IS NULL OR LOWER(sync_action) NOT IN ('unwatched', 'unplayed'))
    ORDER BY watched_at ASC
  `).all().filter((row) => isCandidateRow(row, activeTargets));

  const removeIds = new Set();
  const bursts = [];

  // A smaller but very clear form of the same import bug is two platform rows
  // for the same item at the exact same timestamp. Keep the first row and
  // remove only the extra copies; spaced-out rewatches are never included.
  const exactEvents = new Map();
  for (const row of rows) {
    const key = `${identity(row)}|${row.watched_at}`;
    const members = exactEvents.get(key) || [];
    members.push(row);
    exactEvents.set(key, members);
  }
  for (const members of exactEvents.values()) {
    if (members.length < 2) continue;
    const ids = members.slice(1).map((row) => row.id);
    ids.forEach((id) => removeIds.add(id));
    bursts.push({
      ids,
      itemCount: 1,
      groupCount: 1,
      reason: "exact-same-item-same-timestamp",
    });
  }

  let burst = [];

  const flush = () => {
    if (!burst.length) return;
    const identities = new Set(burst.map(identity));
    const groups = new Set(burst.map(groupIdentity));
    const firstAt = timestampMs(burst[0]?.watched_at);
    const lastAt = timestampMs(burst.at(-1)?.watched_at);
    const groupCounts = new Map();
    for (const row of burst) {
      const group = groupIdentity(row);
      groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
    }
    const sameGroupBatch = [...groupCounts.values()].some((count) => count >= SAME_GROUP_MIN_ITEMS)
      && lastAt - firstAt <= SAME_GROUP_MAX_SPAN_MS;
    const crossGroupBatch = identities.size >= minItems && groups.size >= 2
      && lastAt - firstAt <= CROSS_GROUP_MAX_SPAN_MS;
    if (crossGroupBatch || sameGroupBatch) {
      const ids = burst.map((row) => row.id);
      ids.forEach((id) => removeIds.add(id));
      bursts.push({
        ids,
        itemCount: identities.size,
        groupCount: groups.size,
        reason: sameGroupBatch && !crossGroupBatch ? "same-group-impossible-batch" : "cross-group-batch",
      });
    }
    burst = [];
  };

  let previousAt = 0;
  for (const row of rows) {
    const currentAt = timestampMs(row.watched_at);
    if (previousAt && currentAt - previousAt > gapMs) flush();
    burst.push(row);
    previousAt = currentAt;
  }
  flush();

  return { ids: [...removeIds], bursts };
}

export function repairPhantomWatchBursts(database, options = {}) {
  const detected = findPhantomWatchBurstRows(database, options);
  if (!detected.ids.length) return { deleted: 0, bursts: detected.bursts };

  const placeholders = detected.ids.map(() => "?").join(",");
  const deleteRows = database.prepare(`DELETE FROM watch_history WHERE id IN (${placeholders})`);
  const repair = () => {
    database.exec("DROP TABLE IF EXISTS watch_history_repair_keys");
    database.exec("CREATE TEMP TABLE watch_history_repair_keys (media_key TEXT PRIMARY KEY)");
    const deleteOrphanedPlaystates = database.prepare(`
      DELETE FROM playstate
      WHERE media_key IN (
        SELECT media_key FROM watch_history_repair_keys
      )
        AND NOT EXISTS (
          SELECT 1 FROM watch_history
          WHERE watch_history.media_key = playstate.media_key
            AND (watch_history.sync_action IS NULL OR LOWER(watch_history.sync_action) NOT IN ('unwatched', 'unplayed'))
        )
    `);
    const keys = database.prepare("SELECT media_key FROM watch_history WHERE id IN (" + placeholders + ") AND media_key IS NOT NULL").all(...detected.ids);
    const insertKey = database.prepare("INSERT OR IGNORE INTO watch_history_repair_keys (media_key) VALUES (?)");
    keys.forEach((row) => insertKey.run(row.media_key));
    const deleted = deleteRows.run(...detected.ids).changes;
    deleteOrphanedPlaystates.run();
    database.exec("DROP TABLE watch_history_repair_keys");
    return deleted;
  };

  const deleted = options.transaction === false ? repair() : database.transaction(repair)();
  return { deleted, bursts: detected.bursts };
}
