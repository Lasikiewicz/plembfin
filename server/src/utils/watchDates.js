// Shared watched-date/release-date helpers used by the scheduled sync engine
// (scheduled.js) and the force-sync planner (forceSyncPlanner.js).

export function dateOnlyIso(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
}

export function isoDateTime(value = "") {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function embyLikePlayedDate(item = {}) {
  return isoDateTime(
    item.UserData?.LastPlayedDate ||
      item.UserData?.PlayedDate ||
      item.UserData?.DatePlayed ||
      item.LastPlayedDate ||
      item.PlayedDate ||
      item.DatePlayed ||
      item.LastWatchedDate,
  );
}

export function isEmbyLikePlayed(item = {}) {
  const value = item.UserData?.Played ?? item.UserData?.IsPlayed ?? item.Played ?? item.IsPlayed;
  return value === true || value === "true" || value === 1 || value === "1";
}

// True when an item is flagged played but was never actually played through:
// marking an item watched over the API (which is what our own playstate sync
// does) leaves PlayCount at 0 and writes no played date. Emby reports these
// back to us on the next poll, so recognising them keeps our own writes from
// looking like watches with broken metadata.
export function isEmbyLikeApiMarked(item = {}) {
  if (embyLikePlayedDate(item)) return false;
  if (!isEmbyLikePlayed(item)) return false;
  // Require an explicit zero. A missing PlayCount means the server did not tell
  // us, which is not the same as telling us the item was never played - that
  // case stays a reportable "missing played date".
  const raw = item.UserData?.PlayCount ?? item.PlayCount;
  if (raw === undefined || raw === null || raw === "") return false;
  const count = Number(raw);
  return Number.isFinite(count) && count === 0;
}

// A played flag without a played timestamp is historical state, not evidence of
// a watch occurring during the current poll. Never manufacture a current-time
// watch date here: doing so turns an existing Emby library into a burst of new
// watch-history rows after a restore, rebuild, or first connection.
export function watchedAtForEmbyLikeItem(item = {}) {
  const playedAt = embyLikePlayedDate(item);
  if (playedAt) return { watchedAt: playedAt, reason: "played" };

  if (isEmbyLikePlayed(item)) {
    // Distinguish "we marked this" from "played but the server lost the date",
    // so only the latter is worth surfacing as a data gap.
    return { watchedAt: "", reason: isEmbyLikeApiMarked(item) ? "marked without playback" : "missing played date" };
  }

  return { watchedAt: "", reason: "" };
}

// Plex's viewed flag is historical state unless Plex supplies the actual view
// timestamp. A library refresh must never become a new watch at poll time.
export function watchedAtForPlexItem(item = {}) {
  const raw = item.lastViewedAt ?? item.viewedAt;
  if (raw === undefined || raw === null || raw === "") {
    return { watchedAt: "", reason: "missing viewed date" };
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return { watchedAt: new Date(seconds * 1000).toISOString(), reason: "viewed" };
  }

  const viewedAt = isoDateTime(raw);
  return viewedAt
    ? { watchedAt: viewedAt, reason: "viewed" }
    : { watchedAt: "", reason: "invalid viewed date" };
}

export function releaseDateForItem(item = {}) {
  return dateOnlyIso(
    item.PremiereDate ||
      item.OriginalReleaseDate ||
      item.originallyAvailableAt ||
      (item.ProductionYear ? `${item.ProductionYear}-01-01T00:00:00.000Z` : ""),
  );
}

export function releaseDateForPlexItem(item = {}) {
  return dateOnlyIso(
    item.originallyAvailableAt ||
      item.OriginallyAvailableAt ||
      (item.year ? `${item.year}-01-01T00:00:00.000Z` : ""),
  );
}

// A played flag raised by a library action is not playback evidence. When the
// source does not provide a trustworthy play timestamp, use the item's release
// day as the stable historical date rather than the time Plembfin happened to
// receive the flag (or the time somebody clicked "Mark watched").
export function releaseDateForSourceItem(item = {}, source = "") {
  return String(source || "").toLowerCase() === "plex"
    ? releaseDateForPlexItem(item)
    : releaseDateForItem(item);
}

// Plex's library-state notification reports that the watched flag is set, but
// it cannot distinguish a threshold-reaching playback from a manual "Mark
// watched" action. Only use Plex's viewed timestamp when the caller has
// independently confirmed playback; otherwise anchor the manual state to the
// item's release day instead of the click/notification time.
export function resolvePlexWatchDate(item = {}, { hasPlaybackEvidence = false } = {}) {
  const viewedAt = watchedAtForPlexItem(item).watchedAt;
  const releaseDate = releaseDateForPlexItem(item);
  if (hasPlaybackEvidence && viewedAt) {
    return { watchedAt: viewedAt, manualMark: false, sourceTimestamp: viewedAt, note: "" };
  }
  if (releaseDate) {
    return {
      watchedAt: releaseDate,
      manualMark: true,
      sourceTimestamp: "",
      note: "Plex reported a watched library flag without a recent threshold-reaching playback session; the release date was used instead of the manual mark time.",
    };
  }
  return {
    watchedAt: "",
    manualMark: true,
    sourceTimestamp: "",
    note: "Plex reported a watched library flag without a reliable playback timestamp or release date.",
  };
}
