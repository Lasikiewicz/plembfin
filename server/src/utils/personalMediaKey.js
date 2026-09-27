// Stable keys for personal ratings, watchlist, and playlist items. Shared by
// the personal route and the playlist pull pass, which imports app-added items.

const MAX_TEXT_LENGTH = 4000;
const MAX_TITLE_LENGTH = 300;

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function titleKey(value) {
  return cleanText(value, MAX_TITLE_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizePersonalMediaType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["tv", "show", "series"].includes(type)) return "tv";
  if (type === "episode") return "episode";
  if (type === "movie") return "movie";
  return "";
}

export function personalMediaKey(item = {}) {
  const type = normalizePersonalMediaType(item.media_type || item.mediaType || item.type) || "movie";
  const tmdbId = cleanText(item.tmdb_id || item.tmdbId, 100);
  const tvdbId = cleanText(item.tvdb_id || item.tvdbId, 100);
  const imdbId = cleanText(item.imdb_id || item.imdbId, 100);
  if (type === "episode") {
    const showTitle = cleanText(item.show_title || item.showTitle || item.series_title || item.seriesTitle || item.title || item.name);
    const season = numberOrNull(item.season ?? item.seasonNumber);
    const episode = numberOrNull(item.episode ?? item.episodeNumber);
    const coordinate = `s${Number.isInteger(season) ? season : "?"}e${Number.isInteger(episode) ? episode : "?"}`;
    // Episode provider ids identify the episode itself. Only explicit parent
    // show ids may participate in an episode rating key.
    const showTmdbId = cleanText(item.show_tmdb_id || item.showTmdbId, 100);
    const showTvdbId = cleanText(item.show_tvdb_id || item.showTvdbId, 100);
    const showImdbId = cleanText(item.show_imdb_id || item.showImdbId, 100);
    if (showTmdbId) return `episode:tmdb:${showTmdbId}:${coordinate}`;
    if (showTvdbId) return `episode:tvdb:${showTvdbId}:${coordinate}`;
    if (showImdbId) return `episode:imdb:${showImdbId}:${coordinate}`;
    return `episode:title:${titleKey(showTitle)}:${coordinate}`;
  }
  if (tmdbId) return `${type}:tmdb:${tmdbId}`;
  if (tvdbId) return `${type}:tvdb:${tvdbId}`;
  if (imdbId) return `${type}:imdb:${imdbId}`;
  return `${type}:title:${titleKey(item.title || item.name)}`;
}
