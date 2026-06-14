import { getTmdbPosterUrl } from "./tmdbGateway.js";

function showTitleFrom(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

export async function fetchPosterFromTmdb(row) {
  const mediaType = row.media_type === "movie" ? "movie" : "tv";
  const title = mediaType === "movie" ? row.title : row.show_title || showTitleFrom(row.title);
  return getTmdbPosterUrl({ mediaType, tmdbId: row.tmdb_id, title }).catch(() => null);
}
