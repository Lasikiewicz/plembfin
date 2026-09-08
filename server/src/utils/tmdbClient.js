import { getTmdbPosterUrl } from "./tmdbGateway.js";

function showTitleFrom(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const stripYear = (value) => String(value || "").replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return stripYear(seasonMatch[1]) || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return stripYear(alternateMatch[1]) || "Unknown Show";
  return stripYear(text.split(" - ")[0]) || "Unknown Show";
}

export async function fetchPosterFromTmdb(row) {
  const mediaType = row.media_type === "movie" ? "movie" : "tv";
  const title = mediaType === "movie" ? row.title : row.show_title || showTitleFrom(row.title);
  // Episode rows often carry the episode-level TVDB id. Passing it through
  // lets the TVDB-backed resolver find the parent series after Fix Match has
  // cleared the old TMDB id, instead of falling back to an ambiguous title
  // search and leaving dashboard posters blank while the metadata warm-up is
  // still running.
  return getTmdbPosterUrl({
    mediaType,
    tmdbId: row.tmdb_id,
    title,
    ids: mediaType === "tv" ? { tvdbId: row.tvdb_id } : {},
  }).catch(() => null);
}
