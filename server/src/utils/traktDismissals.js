import { db, parseJson } from "../db.js";
import { activityGroupKeyFor, activityItemKeyFor } from "./syncActivityIdentity.js";

export const DISMISSED_TRAKT_NOT_FOUND_DETAIL = "Dismissed: Trakt does not have this show";

// Dismissal state lives in sync_history so it follows the existing backup and
// retention rules. The activity/item keys make the lookup independent of the
// particular server webhook or provider id that produced a later retry.
const selectTraktDismissalRowsStmt = db.prepare(`
  SELECT media_type, title, source, action, timestamp, target_states, raw_payload_debug,
         activity_group_key, activity_item_key
  FROM sync_history
  WHERE activity_item_key = ? OR activity_group_key = ?
  ORDER BY timestamp DESC, id DESC
`);

function text(value) {
  return String(value ?? "").trim();
}

function normalizedMedia(media = {}) {
  return {
    mediaType: media.type || media.mediaType,
    title: media.title,
    showTitle: media.showTitle || media.show_title,
    source: media.source,
    action: media.action || media.syncAction || media.sync_action,
    ids: media.ids || {},
    season: media.season,
    episode: media.episode,
    mediaKey: media.mediaKey || media.media_key,
    rawPayloadDebug: media.rawPayloadDebug || media.raw_payload_debug,
  };
}

function rowKeys(row, rawPayloadDebug) {
  const record = {
    mediaType: row.media_type,
    title: row.title,
    source: row.source,
    action: row.action,
    rawPayloadDebug,
  };
  return {
    group: text(row.activity_group_key) || activityGroupKeyFor(record),
    item: text(row.activity_item_key) || activityItemKeyFor(record),
  };
}

function isTraktNotFoundDismissal(value) {
  return value
    && text(value.target).toLowerCase() === "trakt"
    && /not[_ -]?found/i.test(text(value.reason));
}

function hasTraktSuccess(row) {
  const targetStates = parseJson(row.target_states, []);
  return Array.isArray(targetStates) && targetStates.some((target) =>
    text(target?.target).toLowerCase() === "trakt"
      && text(target?.status).toLowerCase() === "success",
  );
}

// Return whether a later retry should still treat a Trakt episode not_found
// as intentionally skipped. A successful Trakt result after the dismissal
// re-opens the match problem if it ever happens again, so a temporary Trakt
// catalog gap does not become permanently invisible after the show returns.
export function isTraktNotFoundDismissed(media = {}) {
  const record = normalizedMedia(media);
  if (text(record.mediaType).toLowerCase() !== "episode") return false;

  const groupKey = activityGroupKeyFor(record);
  const itemKey = activityItemKeyFor(record);
  if (!groupKey && !itemKey) return false;

  const rows = selectTraktDismissalRowsStmt.all(itemKey, groupKey);
  for (const row of rows) {
    const rawPayloadDebug = parseJson(row.raw_payload_debug, {});
    const dismissalHistory = Array.isArray(rawPayloadDebug?.dismissalHistory)
      ? rawPayloadDebug.dismissalHistory
      : [];
    if (!dismissalHistory.length) continue;

    const keys = rowKeys(row, rawPayloadDebug);
    for (const dismissal of dismissalHistory) {
      if (!isTraktNotFoundDismissal(dismissal)) continue;
      // Entries written before scope was introduced came from the show-level
      // bulk action, so preserve those existing user decisions as show-wide.
      const scope = text(dismissal.scope || dismissal.dismissalScope).toLowerCase() === "item"
        ? "item"
        : "show";
      const matches = scope === "item"
        ? keys.item === itemKey
        : keys.group === groupKey;
      if (!matches) continue;

      const dismissedAt = Number(dismissal.timestamp) || Number(row.timestamp) || 0;
      const supersededBySuccess = rows.some((candidate) => {
        const candidateDebug = parseJson(candidate.raw_payload_debug, {});
        const candidateKeys = rowKeys(candidate, candidateDebug);
        const sameScope = scope === "item"
          ? candidateKeys.item === itemKey
          : candidateKeys.group === groupKey;
        return sameScope
          && Number(candidate.timestamp || 0) > dismissedAt
          && hasTraktSuccess(candidate);
      });
      if (!supersededBySuccess) return true;
    }
  }
  return false;
}
