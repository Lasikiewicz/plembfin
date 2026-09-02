// Identity helpers for the local personal watchlist.  This identity is
// deliberately separate from watched-state identity: a watchlist row is a
// movie or a series, while a watched event may describe an episode.

const MEDIA_TYPES = new Set(["movie", "tv"]);
const MAX_TITLE_LENGTH = 300;

function clean(value, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function titleKey(value) {
  return clean(value, MAX_TITLE_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function normalizePersonalWatchlistType(value) {
  const type = clean(value, 40).toLowerCase();
  if (["show", "series", "tv"].includes(type)) return "tv";
  return type === "movie" ? "movie" : "";
}

function providerIdsFrom(item = {}) {
  const read = (name) => item[name]
    ?? item[`${name}Id`]
    ?? item[`${name}_id`]
    ?? item.ids?.[name]
    ?? item.provider_ids?.[name]
    ?? item.providerIds?.[name];
  return {
    tmdb: clean(read("tmdb"), 100),
    tvdb: clean(read("tvdb"), 100),
    imdb: clean(read("imdb"), 100),
  };
}

export function personalWatchlistMediaKey(item = {}) {
  const type = normalizePersonalWatchlistType(item.media_type || item.mediaType || item.type) || "movie";
  const ids = providerIdsFrom(item);
  if (ids.tmdb) return `${type}:tmdb:${ids.tmdb}`;
  if (ids.tvdb) return `${type}:tvdb:${ids.tvdb}`;
  if (ids.imdb) return `${type}:imdb:${ids.imdb}`;
  return `${type}:title:${titleKey(item.title || item.name)}`;
}

export function normalizePersonalWatchlistMedia(item = {}, { mediaKey = "" } = {}) {
  const mediaType = normalizePersonalWatchlistType(item.media_type || item.mediaType || item.type);
  if (!MEDIA_TYPES.has(mediaType)) throw new Error("Watchlist media type must be movie or tv");
  const ids = providerIdsFrom(item);
  const title = clean(item.title || item.name || item.show_title || item.showTitle || "Untitled", MAX_TITLE_LENGTH);
  const releaseDate = clean(item.release_date || item.releaseDate || item.first_air_date || item.firstAirDate, 40);
  const normalized = {
    media_key: mediaKey || clean(item.media_key || item.mediaKey, 400) || personalWatchlistMediaKey({ ...item, media_type: mediaType, title, ...ids }),
    media_type: mediaType,
    type: mediaType,
    title,
    tmdb_id: ids.tmdb,
    tvdb_id: ids.tvdb,
    imdb_id: ids.imdb,
    poster_url: clean(item.poster_url || item.posterUrl || item.imageUrl, 2000),
    overview: clean(item.overview || item.description, 4000),
    release_date: releaseDate,
    year: numberOrNull(item.year || item.production_year || item.productionYear || releaseDate.slice(0, 4)),
    provider_item_ids: item.provider_item_ids && typeof item.provider_item_ids === "object"
      ? Object.fromEntries(Object.entries(item.provider_item_ids).map(([key, value]) => [key, clean(value, 200)]).filter(([, value]) => value))
      : item.providerItemIds && typeof item.providerItemIds === "object"
        ? Object.fromEntries(Object.entries(item.providerItemIds).map(([key, value]) => [key, clean(value, 200)]).filter(([, value]) => value))
        : {},
  };
  return normalized;
}

export function personalWatchlistMediaAliases(media = {}) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const aliases = [];
  for (const [provider, value] of Object.entries({
    tmdb: normalized.tmdb_id,
    tvdb: normalized.tvdb_id,
    imdb: normalized.imdb_id,
  })) {
    if (value) aliases.push(`${normalized.media_type}:${provider}:${value}`);
  }
  aliases.push(personalWatchlistMediaKey(normalized));
  const year = normalized.year || Number(String(normalized.release_date || "").slice(0, 4));
  if (normalized.title) aliases.push(`${normalized.media_type}:title:${titleKey(normalized.title)}${year ? `:${year}` : ""}`);
  if (normalized.title) aliases.push(`${normalized.media_type}:title:${titleKey(normalized.title)}`);
  return [...new Set(aliases)];
}

export function watchlistMediaForStorage(media = {}) {
  const normalized = normalizePersonalWatchlistMedia(media);
  return {
    media_key: normalized.media_key,
    media_type: normalized.media_type,
    title: normalized.title,
    tmdb_id: normalized.tmdb_id || null,
    tvdb_id: normalized.tvdb_id || null,
    imdb_id: normalized.imdb_id || null,
    poster_url: normalized.poster_url || null,
    overview: normalized.overview || null,
    release_date: normalized.release_date || null,
    provider_item_ids: normalized.provider_item_ids,
    year: normalized.year,
  };
}

export function isSameWatchlistMedia(left, right) {
  const leftAliases = new Set(personalWatchlistMediaAliases(left));
  return personalWatchlistMediaAliases(right).some((alias) => leftAliases.has(alias));
}

