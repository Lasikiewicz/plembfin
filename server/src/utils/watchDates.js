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

// A played flag without a played timestamp is historical state, not evidence of
// a watch occurring during the current poll. Never manufacture a current-time
// watch date here: doing so turns an existing Emby library into a burst of new
// watch-history rows after a restore, rebuild, or first connection.
export function watchedAtForEmbyLikeItem(item = {}) {
  const playedAt = embyLikePlayedDate(item);
  if (playedAt) return { watchedAt: playedAt, reason: "played" };

  if (isEmbyLikePlayed(item)) {
    return { watchedAt: "", reason: "missing played date" };
  }

  return { watchedAt: "", reason: "" };
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
