// Pure helpers shared by the database migration, sync-history writes, and the
// grouped Sync Activity API. Keep this module free of database imports so it
// can be used while the database schema is being upgraded.

const PROVIDERS = ["imdb", "tmdb", "tvdb", "trakt"];

function text(value) {
  return String(value ?? "").trim();
}

function keyPart(value) {
  return text(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mediaTypeOf(record = {}) {
  const value = text(record.mediaType || record.media_type || record.type).toLowerCase();
  if (["episode", "tv", "show", "series", "season"].includes(value)) return "episode";
  if (value === "movie" || value === "film") return "movie";
  if (value === "progress" || value === "resume") return "progress";
  return value || "unknown";
}

function objectValue(record = {}, key) {
  const value = record[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function providerIdsOf(record = {}) {
  const debug = objectValue(record, "rawPayloadDebug");
  const rawDebug = Object.keys(debug).length ? debug : objectValue(record, "raw_payload_debug");
  const ids = objectValue(record, "ids");
  const debugIds = objectValue(rawDebug, "ids");
  const merged = { ...debugIds, ...ids };
  for (const provider of PROVIDERS) {
    const value = text(record[`${provider}_id`] || record[provider] || merged[provider]);
    if (value) return { provider, value: keyPart(value) };
  }
  return null;
}

function coordinatesOf(record = {}) {
  const debug = objectValue(record, "rawPayloadDebug");
  const rawDebug = Object.keys(debug).length ? debug : objectValue(record, "raw_payload_debug");
  const season = record.season ?? rawDebug.season;
  const episode = record.episode ?? rawDebug.episode;
  return {
    season: season == null || season === "" ? "?" : keyPart(season),
    episode: episode == null || episode === "" ? "?" : keyPart(episode),
  };
}

function showTitleOf(record = {}) {
  const debug = objectValue(record, "rawPayloadDebug");
  const rawDebug = Object.keys(debug).length ? debug : objectValue(record, "raw_payload_debug");
  return text(record.showTitle || record.show_title || rawDebug.showTitle || rawDebug.show_title);
}

function mediaKeyOf(record = {}) {
  const debug = objectValue(record, "rawPayloadDebug");
  const rawDebug = Object.keys(debug).length ? debug : objectValue(record, "raw_payload_debug");
  return text(record.mediaKey || record.media_key || rawDebug.mediaKey || rawDebug.media_key);
}

function episodeShowTitleOf(record = {}) {
  const explicit = showTitleOf(record);
  if (explicit) return explicit;
  const title = text(record.title);
  return title.match(/^(.*?)\s+-\s+S\d{1,3}E\d{1,3}(?:\s+-\s+.*)?$/i)?.[1] || "";
}

/**
 * Return a stable display-group identity for one sync_history event.
 * Provider IDs win over titles for movies. Episode events are grouped at the
 * show level; their season/episode coordinates remain on each child event.
 */
export function activityGroupKeyFor(record = {}) {
  const supplied = text(record.activityGroupKey || record.activity_group_key);
  if (supplied) return supplied;

  const mediaType = mediaTypeOf(record);
  const provider = providerIdsOf(record);
  const mediaKey = mediaKeyOf(record);

  if (mediaType === "episode") {
    // Sync Activity is a show-level view. Episode coordinates stay on the
    // child event, but must not create a separate top-level row for every
    // episode in a bulk Trakt or server reconciliation.
    const showTitle = keyPart(episodeShowTitleOf(record));
    if (showTitle) return `show|title:${showTitle}`;
    if (provider) return `show|${provider.provider}:${provider.value}`;
    if (mediaKey) return `show|media:${keyPart(mediaKey).replace(/^episode:[^:]+:[^:]+:/, "")}`;
    return `show|title:${keyPart(record.title)}`;
  }

  if (mediaType === "movie") {
    if (provider) return `movie|${provider.provider}:${provider.value}`;
    if (mediaKey) return `movie|media:${keyPart(mediaKey)}`;
    return `movie|title:${keyPart(record.title)}`;
  }

  if (provider) return `${mediaType}|${provider.provider}:${provider.value}`;
  if (mediaKey) return `${mediaType}|media:${keyPart(mediaKey)}`;
  return `${mediaType}|title:${keyPart(record.title)}`;
}

export function activityGroupTitleFromRecord(record = {}) {
  const mediaType = mediaTypeOf(record);
  if (mediaType !== "episode") return text(record.title) || "Unknown media";
  return showTitleOf(record) || text(record.title).replace(/\s+-\s+S\d{1,3}E\d{1,3}(?:\s+-\s+.*)?$/i, "") || "Unknown show";
}

export function activityGroupMediaType(record = {}) {
  return mediaTypeOf(record) === "movie" ? "movie" : mediaTypeOf(record) === "episode" ? "show" : mediaTypeOf(record);
}

export function activityGroupCoordinates(record = {}) {
  const coordinates = coordinatesOf(record);
  return coordinates.season !== "?" || coordinates.episode !== "?" ? coordinates : null;
}
