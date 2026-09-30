// A show being rewatched from an older season can hold two Up Next cards
// (loose-ends step 20, user decision 30 September 2026): the rewatch, which is
// the episode after the most recent play, and the newly arrived episode after
// the furthest one watched. Each card carries `up_next_lane` ("rewatch" or
// "new") so the one-card-per-show collapse, the native rail refresh, and the
// Remove choice can tell them apart.

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function compareCoordinates(left = {}, right = {}) {
  return number(left.season) - number(right.season) || number(left.episode) - number(right.episode);
}

// Where the viewer is (the most recent play) against how far they have got
// (the furthest episode watched). Returns both only when the most recent play
// is behind the furthest one: a normal viewer's latest play is the furthest,
// and gets no rewatch lane. Plays sharing a timestamp (a season marked watched
// in one go) count as their furthest episode, so they never open a lane.
export function rewatchPosition(watchedRows = []) {
  let latest = null;
  let latestAt = -Infinity;
  let frontier = null;
  for (const row of Array.isArray(watchedRows) ? watchedRows : []) {
    const coordinate = { season: number(row?.season), episode: number(row?.episode) };
    if (coordinate.season <= 0 || coordinate.episode <= 0) continue;
    if (!frontier || compareCoordinates(coordinate, frontier) > 0) frontier = coordinate;
    const watchedAt = Date.parse(row?.watched_at || "");
    if (!Number.isFinite(watchedAt)) continue;
    if (watchedAt > latestAt || (watchedAt === latestAt && compareCoordinates(coordinate, latest) > 0)) {
      latest = coordinate;
      latestAt = watchedAt;
    }
  }
  if (!latest || !frontier || compareCoordinates(latest, frontier) >= 0) return null;
  return { latest, frontier };
}

// The episode immediately after `latest` in metadata order: the next number in
// its season, else the first episode of the next listed season.
export function episodeAfter(latest, seasonNumbers = [], episodesForSeason = () => []) {
  const numbersIn = (season) => (episodesForSeason(season) || [])
    .map((episode) => number(episode?.episode_number))
    .filter((episode) => episode > 0)
    .sort((left, right) => left - right);
  const sameSeason = numbersIn(latest.season).find((episode) => episode > latest.episode);
  if (sameSeason) return { season: latest.season, episode: sameSeason };
  const nextSeason = [...seasonNumbers].sort((left, right) => left - right).find((season) => season > latest.season);
  const first = nextSeason ? numbersIn(nextSeason)[0] : 0;
  return first ? { season: nextSeason, episode: first } : null;
}

// The lane is decided by the local resolver, but the card that reaches the
// rail can be a merged provider row. Copy the lane onto whichever merged item
// shares the lane candidate's episode.
export function withUpNextLanes(items = [], laneCandidates = [], sameEpisode = () => false) {
  const lanes = laneCandidates.filter((candidate) => candidate?.up_next_lane);
  if (!lanes.length) return items;
  return items.map((item) => {
    const lane = lanes.find((candidate) => sameEpisode(item, candidate))?.up_next_lane;
    return lane ? { ...item, up_next_lane: lane } : item;
  });
}
