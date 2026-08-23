// Validation for episode records coming from an automatic media-server
// library-history scan. A media server can report a played item with stale or
// incomplete metadata after a library refresh. Those items must not become
// canonical Plembfin history until their episode identity is trustworthy.

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function finiteInteger(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function providerIds(media = {}) {
  const ids = media.ids && typeof media.ids === "object" ? media.ids : {};
  return [
    media.imdb_id,
    media.imdb,
    ids.imdb,
    media.tmdb_id,
    media.tmdb,
    ids.tmdb,
    media.tvdb_id,
    media.tvdb,
    ids.tvdb,
  ].map(text).filter(Boolean);
}

function showTitleFromMedia(media = {}) {
  const explicit = text(media.show_title || media.showTitle);
  if (explicit) return explicit;

  const title = text(media.title);
  const match = title.match(/^(.*?)(?:\s+-\s+S\d{1,3}E(?:\d{1,3}|\?))/i);
  return text(match?.[1]);
}

function isPlaceholderMetadataTitle(value = "", kind = "metadata") {
  const normalized = lower(value);
  if (!normalized) return true;
  return new RegExp(`^(?:unknown(?:\\s+${kind})?|untitled|undefined|null|n\\/a)$`, "i").test(normalized);
}

/**
 * Returns true for server placeholder names such as `S10E0?` or `S04E01`.
 * A real episode can technically have a short title, so this is only used as
 * a rejection signal when the import has no provider identity to corroborate
 * it.
 */
export function isPlaceholderEpisodeTitle(value = "") {
  const title = text(value).replace(/\s+/g, " ");
  if (!title) return false;
  return /^(?:s\d{1,3}e(?:\d{1,3}|\?)(?:\?)?|episode\s*\??\d*)$/i.test(title);
}

function isLibraryHistoryImport(media = {}, context = "") {
  if (["library_history", "library_scan"].includes(lower(context))) return true;
  const provenance = media.watchProvenance || media.watch_provenance || {};
  return lower(provenance.event) === "library_history"
    || /library[_-]history/i.test(text(provenance.ingest_path || provenance.ingestPath));
}

/**
 * Return a structured rejection for an untrusted automatic episode import,
 * or null when it is safe to continue. The context flag is used by the
 * read-only library Force Sync planner; normal/manual history writes do not
 * need this media-server-specific policy.
 */
export function remoteEpisodeImportError(media = {}, { context = "" } = {}) {
  const type = lower(media.type || media.media_type || media.mediaType);
  if (type !== "episode" || !isLibraryHistoryImport(media, context)) return null;

  const season = finiteInteger(media.season);
  const episode = finiteInteger(media.episode);
  if (season == null || season < 0) {
    return {
      code: "invalid-season",
      message: "media-server episode has an invalid season number",
    };
  }
  if (episode == null || episode < 1) {
    return {
      code: "invalid-episode",
      message: "media-server episode has an invalid episode number",
    };
  }

  const showTitle = showTitleFromMedia(media);
  if (isPlaceholderMetadataTitle(showTitle, "show")) {
    return {
      code: "missing-show-title",
      message: "media-server episode has no trustworthy show title",
    };
  }

  const episodeTitle = text(media.episode_title || media.episodeTitle);
  const hasProviderId = providerIds(media).length > 0;
  // A question mark inside a coordinate-only title is the server explicitly
  // admitting that the episode identity is incomplete. A series-level provider
  // id does not make that episode trustworthy (the production Platonic rows
  // carried the show's TVDB id while still arriving as `S10E0?`).
  if (hasProviderId && episodeTitle.includes("?") && isPlaceholderEpisodeTitle(episodeTitle)) {
    return {
      code: "placeholder-episode-title",
      message: "media server returned an uncertain placeholder episode title",
    };
  }
  if (episodeTitle && isPlaceholderMetadataTitle(episodeTitle, "episode") && !hasProviderId) {
    return {
      code: "placeholder-episode-title",
      message: "media server returned a placeholder episode title without a provider ID",
    };
  }
  if (isPlaceholderEpisodeTitle(episodeTitle) && !hasProviderId) {
    return {
      code: "placeholder-episode-title",
      message: "media server returned a placeholder episode title without a provider ID",
    };
  }

  return null;
}

export function isRemoteEpisodeImportValid(media = {}, options = {}) {
  return !remoteEpisodeImportError(media, options);
}
