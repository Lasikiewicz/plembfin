export const PLEX_WATCHED_ROLLBACK_GRACE_MS = 5 * 60 * 1000;

// Plex can briefly publish viewCount=0 immediately after scrobbling a live
// session while retaining the session's positive viewOffset. That combination
// is not a trustworthy manual unwatch when Plembfin either saw the matching
// session cross its configured threshold or only just accepted Plex's watched
// transition. The short transition grace covers threshold rounding at the
// credits boundary; a later deliberate unwatch remains authoritative.
export function shouldRepairRecentPlexUnwatch({
  playstate,
  viewOffset = 0,
  hasPlaybackEvidence = false,
  now = Date.now(),
} = {}) {
  const transitionAt = Number(playstate?.updated_at || 0);
  const transitionAge = Number(now) - transitionAt;
  const justMarkedWatched = transitionAt > 0
    && transitionAge >= 0
    && transitionAge <= PLEX_WATCHED_ROLLBACK_GRACE_MS;
  return playstate?.state === "watched"
    && Number(viewOffset || 0) > 0
    && (hasPlaybackEvidence === true || justMarkedWatched);
}
