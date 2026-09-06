// Pure watch-history projections persisted at write time. This module stays
// database-free so startup migrations and every writer share the same rules.
export function decodeStoredWatchTitle(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
}

export function repairedStoredEpisodeTitle(title = "") {
  return decodeStoredWatchTitle(title).trim().replace(
    /\bS0\?E(\d{1,3})\b/gi,
    (_, episode) => `S00E${String(Number(episode)).padStart(2, "0")}`,
  );
}

export function episodeCoordinatesFromStoredTitle(title = "") {
  const text = decodeStoredWatchTitle(title).trim();
  const exact = text.match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  if (exact) return { season: Number(exact[1]), episode: Number(exact[2]) };
  const legacy = text.match(/\bS0\?E(\d{1,3})\b/i);
  if (!legacy) return {};
  return { season: 0, episode: Number(legacy[1]) };
}

export function persistedWatchDerivedFields(row = {}) {
  const isEpisode = String(row.media_type || "").toLowerCase() === "episode";
  const title = isEpisode
    ? repairedStoredEpisodeTitle(row.title)
    : decodeStoredWatchTitle(row.title);
  const coordinates = isEpisode ? episodeCoordinatesFromStoredTitle(row.title) : {};
  return {
    title,
    title_lower: title.toLowerCase(),
    season: row.season ?? coordinates.season ?? null,
    episode: row.episode ?? coordinates.episode ?? null,
  };
}
