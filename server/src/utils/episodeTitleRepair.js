import { db, parseJson } from "../db.js";

// Watch history records an episode's title verbatim from whatever the source
// reported at ingest time. When a media server only supplies a coordinate
// ("8", "Episode 08") instead of the real name, the record lands with a
// placeholder value and every surface that reads `episode_title` (the
// dashboard's TV "recently watched" row, /history cards, detail watch info)
// shows the coordinate instead of the episode name shown on the media page.
//
// These helpers give one shared, server-side answer to "what is this
// episode called?" so the ingest path stops persisting placeholders and the
// Database Repairs tool can rewrite rows that were already recorded with
// one. Resolution is stored-data first (no network, stable once a name is
// cached); the callers that opt into a live provider lookup for names that are
// not stored anywhere yet do that fetch themselves (see
// dataRepo.backfillEpisodeTitleGaps) and read the shaped season here.

// The TVDB-shaped episode objects the metadata gateways return carry
// `episode_number` + `name`. Only accept a real title - never a coordinate the
// upstream still reports as a name.
function acceptEpisodeName(value = "") {
  const name = String(value ?? "").trim();
  if (!name || isPlaceholderEpisodeTitleValue(name)) return false;
  return true;
}

function selectEpisodeNameFromSeason(details, episodeNumber) {
  const episodes = Array.isArray(details?.episodes) ? details.episodes : [];
  const match = episodes.find((ep) => String(ep?.episode_number) === String(episodeNumber));
  const name = String(match?.name || "").trim();
  return acceptEpisodeName(name) ? name : null;
}

/**
 * Export the shaped-season → name projection so callers that already hold a
 * getTmdbSeason result (the live-fetch backfill pass) can read the name without
 * redoing the episode-number matching.
 */
export function episodeNameFromSeason(details, episodeNumber) {
  return selectEpisodeNameFromSeason(details, episodeNumber);
}

function clean(value = "") {
  return String(value ?? "").trim();
}

/**
 * True when `value` should be treated as "this record has no episode name":
 * null/empty, a bare integer coordinate ("8"), or a literal `Episode N` /
 * `Episode 08` label the app synthesised. Kept conservative so a genuinely
 * short real title is never treated as missing. `isPlaceholderEpisodeTitle`
 * in episodeImportGuard.js covers the library-scan coordinate forms and is
 * reused at that boundary; this is the general detector used everywhere else.
 */
export function isPlaceholderEpisodeTitleValue(value) {
  if (value == null) return true;
  const title = clean(value);
  if (!title) return true;
  // Handle the storage form the dashboard synthesised ("Episode 08").
  if (/^episode(?:\s+(\d{1,3}))?$/i.test(title)) return true;
  // A bare number was persisted instead of a name (Plex metadata.title).
  if (/^\d{1,3}$/.test(title)) return true;
  return false;
}

// ---- sibling watch rows that already hold a real name -----------------------

const siblingTitleStmt = db.prepare(`
  SELECT episode_title
  FROM watch_history
  WHERE media_type = 'episode'
    AND season = @season
    AND episode = @episode
    AND episode_title IS NOT NULL
    AND TRIM(episode_title) <> ''
    AND (
      (@tmdb IS NOT NULL AND tmdb_id = @tmdb)
      OR (@tvdb IS NOT NULL AND tvdb_id = @tvdb)
      OR (@imdb IS NOT NULL AND imdb_id = @imdb)
      OR (@show_lower IS NOT NULL AND show_title_lower = @show_lower)
    )
  ORDER BY watched_at DESC
  LIMIT 1
`);

function findNameFromSiblingRows({ tmdb_id = "", tvdb_id = "", imdb_id = "", show_title = "", season, episode }) {
  if (season == null || episode == null) return null;
  try {
    const row = siblingTitleStmt.get({
      season: Number(season),
      episode: Number(episode),
      tmdb: clean(tmdb_id) || null,
      tvdb: clean(tvdb_id) || null,
      imdb: clean(imdb_id) || null,
      show_lower: show_title ? clean(show_title).toLowerCase() : null,
    });
    const name = clean(row?.episode_title);
    return acceptEpisodeName(name) ? name : null;
  } catch {
    // Database may be inaccessible in isolated/test contexts.
    return null;
  }
}

// ---- season metadata already cached by the gateway tables (no network) ------

const cachedSeasonNameStmt = db.prepare(`
  SELECT details FROM tmdb_season_cache WHERE tmdb_id = @byId AND season_number = @season
  UNION ALL
  SELECT details FROM tvdb_season_cache WHERE (tvdb_id = @byId OR id = @byKey) AND season_number = @season
  LIMIT 1
`);

function findNameFromSeasonCaches({ tmdb_id = "", tvdb_id = "", season, episode }) {
  if (season == null || episode == null) return null;
  const ids = [tmdb_id, tvdb_id].map(clean).filter(Boolean);
  for (const byId of ids) {
    try {
      const row = cachedSeasonNameStmt.get({ byId, byKey: `${byId}_${Number(season)}`, season: Number(season) });
      if (!row?.details) continue;
      const found = selectEpisodeNameFromSeason(parseJson(row.details), episode);
      if (found) return found;
    } catch {
      // ignore malformed/absent cache rows
    }
  }
  return null;
}

/**
 * Resolve a real episode name from data that requires no network: an already
 * recorded sibling watch row (same show + season + episode) first, then season
 * metadata the metadata gateways have already cached. Returns the name string,
 * or null when nothing usable is stored yet. `row` uses the same show-id shape
 * as a watch-history record in this repo (imdb_id/tmdb_id/tvdb_id are the
 * show's ids on an episode row; show_title is the series title; season/episode
 * are the coordinates).
 */
export function resolveStoredEpisodeName(row = {}) {
  const sibling = findNameFromSiblingRows(row);
  if (sibling) return sibling;
  return findNameFromSeasonCaches(row);
}

/**
 * Small projection for the ingest chokepoint and the Database Repairs backfill:
 * given the raw fields a watch record will carry, return the episode title that
 * should actually be stored - the caller's value when it is already a real name,
 * otherwise a stored-data resolution, otherwise null. `episode_title` coming in
 * equals what the source reported; providers (e.g. Plex metadata.title) sometimes
 * send only the coordinate.
 */
export function resolvedEpisodeTitleForRecord(record = {}) {
  const incoming = clean(record.episode_title || record.episodeTitle || record.episode?.title);
  if (incoming && !isPlaceholderEpisodeTitleValue(incoming)) return incoming;

  const season = record.season ?? record.season_number;
  const episode = record.episode ?? record.episode_number;
  if (season == null || episode == null) return incoming || null;

  const resolved = resolveStoredEpisodeName({
    tmdb_id: record.tmdb_id || record.show_tmdb_id,
    tvdb_id: record.tvdb_id || record.show_tvdb_id,
    imdb_id: record.imdb_id || record.show_imdb_id,
    show_title: record.show_title,
    season,
    episode,
  });
  // Never persist a placeholder as if it were a real name: a bare coordinate or
  // synthesised "Episode N" is dropped to null when no real name can be resolved,
  // letting the UI fall back to a sensible label from the season/episode numbers
  // (and allowing a later Database Repairs backfill to fill the real name in).
  return resolved || null;
}
