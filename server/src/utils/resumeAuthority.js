export function resumePositionUnchanged(existingProgress = {}, media = {}) {
  const existingPosition = Number(existingProgress.position_ms || 0);
  const incomingPosition = Number(media.positionMs ?? media.offsetMs ?? 0);
  const existingDuration = Number(existingProgress.duration_ms || 0);
  const incomingDuration = Number(media.durationMs || 0);
  const existingPercent = Number(existingProgress.progress || 0);
  const incomingPercent = Number(media.progress || 0);

  return (
    Math.abs(existingPosition - incomingPosition) <= 2000
    && (!existingDuration || !incomingDuration || Math.abs(existingDuration - incomingDuration) <= 2000)
    && Math.abs(existingPercent - incomingPercent) <= 0.25
  );
}

export function resumeProgressAuthorityTimestamp(existingProgress = null, media = {}) {
  const incomingUpdatedAt = Number(media.updatedAt || 0);
  if (!existingProgress || !resumePositionUnchanged(existingProgress, media)) {
    return incomingUpdatedAt > 0 ? incomingUpdatedAt : 0;
  }

  // Emby/Jellyfin can return the exact position Plembfin just pushed with an
  // older LastPlayedDate (or no useful source date at all). The acknowledgement
  // must not make that fresh, already-stored progress look older than a stale
  // unwatched pointer. A genuinely different position cannot borrow this time.
  return Math.max(incomingUpdatedAt, Number(existingProgress.updated_at || 0));
}

export function resumeProgressBlockedByPlaystate(playstate = null, resumeUpdatedAt = 0) {
  const state = String(playstate?.state || "").toLowerCase();
  const progressUpdatedAt = Number(resumeUpdatedAt || 0);
  const playstateUpdatedAt = Number(playstate?.updated_at || 0);

  if (state === "watched") return "item is watched";
  if (state === "unwatched" && (progressUpdatedAt <= 0 || playstateUpdatedAt >= progressUpdatedAt)) {
    return "item is unwatched";
  }
  if (state && progressUpdatedAt > 0 && playstateUpdatedAt >= progressUpdatedAt) {
    return "newer playstate";
  }
  return "";
}

export function playstateBlocksStoredResumeProgress(playstate = null, existingProgress = null) {
  if (!existingProgress) return false;
  return Boolean(resumeProgressBlockedByPlaystate(playstate, existingProgress.updated_at));
}

function timestampFromDate(value = "") {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

export function resumeProgressEventTimestamp(media = {}, receiptUpdatedAt = 0) {
  const explicitUpdatedAt = Number(media.updatedAt || 0);
  if (explicitUpdatedAt > 0) return explicitUpdatedAt;

  const sourcePlayedAt = timestampFromDate(media.playedAt);
  if (sourcePlayedAt > 0) return sourcePlayedAt;

  // Playback-stop events are direct lifecycle evidence, so arrival time is a
  // safe fallback when the source omitted its own date. Generic UserDataSaved
  // callbacks are also emitted by outbound progress writes and must not gain
  // new authority merely because a delayed acknowledgement arrived now.
  const eventKey = String(media.event || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["mediastop", "playbackstop"].includes(eventKey)) {
    const receipt = Number(receiptUpdatedAt || 0);
    return receipt > 0 ? receipt : 0;
  }
  return 0;
}

export function resumeWebhookPhaseForPlaystate(media = {}, playstate = null) {
  const source = String(media.source || "").toLowerCase();
  const state = String(playstate?.state || "").toLowerCase();
  if (
    ["emby", "jellyfin"].includes(source)
    && media.phase === "ended"
    && media.playedFlagOnly === true
    && state === "watched"
  ) {
    // Jellyfin's webhook plugin can report a genuine Mark Unplayed action only
    // as UserDataSaved. Positive ticks can be stale, so a watched -> Played=false
    // transition is authoritative even though the parser initially treats the
    // ambiguous payload as ordinary partial progress.
    return "unplayed";
  }
  return media.phase;
}
