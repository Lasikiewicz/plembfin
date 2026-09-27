import { fetchWithTimeout } from "./outbound.js";
import { fetchPlexWithRefresh } from "./plexFetch.js";
import { jellyfinAuthHeaders } from "./jellyfinAuth.js";
import { normalizeProviderIds, parsePlexGuids } from "./parsers.js";
import { PLAYLIST_PROVIDERS } from "./providerPlaylists.js";
import { configuredProvider } from "./upNextLibraryLookup.js";

// Library catalogue read for automatic playlists (plan/archive/custom-playlist-sync
// step 8a): every movie and show each app holds, with the genres, year, added
// date, and rating that app reports. Kept out of the grandfathered provider
// clients. A read is all or nothing: any failed page or section throws, so a
// partial library can never read as titles that stopped matching (decision 41,
// "a failed library read never removes"). Reads are cached per app for the
// hourly rule run; a failed read is not cached, so the next run retries.

export const CATALOGUE_CACHE_TTL_MS = 50 * 60 * 1000;
const EMBY_PAGE_SIZE = 500;

function text(value = "") {
  return String(value ?? "").trim();
}

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// TMDB's genre lists (ids are stable; names as TMDB shows them). The picker
// names a merged genre after TMDB where TMDB has it (decision 43), and the
// catalogue source needs the ids for Discover.
export const TMDB_GENRES = Object.freeze({
  movie: Object.freeze([
    [28, "Action"], [12, "Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"],
    [99, "Documentary"], [18, "Drama"], [10751, "Family"], [14, "Fantasy"], [36, "History"],
    [27, "Horror"], [10402, "Music"], [9648, "Mystery"], [10749, "Romance"],
    [878, "Science Fiction"], [10770, "TV Movie"], [53, "Thriller"], [10752, "War"], [37, "Western"],
  ].map(([id, name]) => Object.freeze({ id, name }))),
  tv: Object.freeze([
    [10759, "Action & Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"],
    [99, "Documentary"], [18, "Drama"], [10751, "Family"], [10762, "Kids"], [9648, "Mystery"],
    [10763, "News"], [10764, "Reality"], [10765, "Sci-Fi & Fantasy"], [10766, "Soap"],
    [10767, "Talk"], [10768, "War & Politics"], [37, "Western"],
  ].map(([id, name]) => Object.freeze({ id, name }))),
});

// Spellings that name the same genre (decision 43). Keys and values are in
// the compact form genreKey() produces.
const GENRE_ALIASES = new Map([
  ["scifi", "sciencefiction"],
  ["children", "kids"],
  ["childrens", "kids"],
  ["sport", "sports"],
  ["documentaries", "documentary"],
  ["realitytv", "reality"],
  ["talkshow", "talk"],
  ["tvmovies", "tvmovie"],
  ["actionadventure", "actionandadventure"],
  ["scififantasy", "scifiandfantasy"],
  ["sciencefictionandfantasy", "scifiandfantasy"],
  ["sciencefictionfantasy", "scifiandfantasy"],
  ["warpolitics", "warandpolitics"],
]);

// The merge key for a genre name: case, spacing, and punctuation are ignored
// and known alternate spellings map to one key.
export function genreKey(name) {
  const compact = text(name).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
  return GENRE_ALIASES.get(compact) || compact;
}

function uniqueGenres(names) {
  const seen = new Set();
  const genres = [];
  for (const name of names) {
    const value = text(name);
    const key = genreKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    genres.push(value);
  }
  return genres;
}

function catalogueItem(provider, fields) {
  const genres = uniqueGenres(fields.genres || []);
  return {
    provider,
    item_id: text(fields.item_id),
    media_type: fields.media_type,
    title: text(fields.title),
    year: finiteOrNull(fields.year),
    // YYYY-MM-DD, for newest/oldest order within a year (decision 49).
    release_date: /^\d{4}-\d{2}-\d{2}/.test(text(fields.release_date)) ? text(fields.release_date).slice(0, 10) : "",
    genres,
    genre_keys: genres.map(genreKey),
    added_at: finiteOrNull(fields.added_at),
    rating: finiteOrNull(fields.rating),
    ids: { tmdb: text(fields.ids?.tmdb), tvdb: text(fields.ids?.tvdb), imdb: text(fields.ids?.imdb) },
  };
}

// --- Plex ---------------------------------------------------------------

const PLEX_SECTION_TYPES = { movie: { type: "1", media_type: "movie" }, show: { type: "2", media_type: "tv" } };

function plexTags(value) {
  return (Array.isArray(value) ? value : [value]).map((entry) => text(typeof entry === "string" ? entry : entry?.tag)).filter(Boolean);
}

async function plexJson(config, url, fetchPlex, label) {
  const response = await fetchPlex(config, url, { lane: "sync" });
  if (!response.ok) throw statusError(`Plex ${label} failed with status ${response.status}`, response.status);
  const body = await response.json();
  if (!body || typeof body !== "object" || !body.MediaContainer) throw statusError(`Plex ${label} returned no MediaContainer`, 0);
  return body.MediaContainer;
}

// The genre filter URL for one entry of /library/sections/{key}/genre. Older
// servers give the whole filtered path as the key, newer ones the tag id.
function plexGenreUrl(baseUrl, sectionKey, directory, type) {
  const key = text(directory?.fastKey || directory?.key);
  const url = key.startsWith("/")
    ? new URL(`${baseUrl}${key}`)
    : new URL(`${baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all`);
  if (!key.startsWith("/")) url.searchParams.set("genre", key);
  url.searchParams.set("type", type);
  return url;
}

// Plex list responses carry only the first few genre tags of each title, so
// genre membership is read per genre with the section's genre filter.
export async function readPlexLibraryCatalogue(config = {}, { fetchPlex = fetchPlexWithRefresh } = {}) {
  if (!config.baseUrl || !config.token) throw new Error("Missing Plex baseUrl or token");
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const sections = await plexJson(config, new URL(`${baseUrl}/library/sections`), fetchPlex, "library sections read");
  const items = [];
  for (const section of Array.isArray(sections.Directory) ? sections.Directory : []) {
    const sectionType = PLEX_SECTION_TYPES[text(section?.type).toLowerCase()];
    const sectionKey = text(section?.key);
    if (!sectionType || !sectionKey) continue;
    const allUrl = new URL(`${baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all`);
    allUrl.searchParams.set("type", sectionType.type);
    allUrl.searchParams.set("includeGuids", "1");
    const all = await plexJson(config, allUrl, fetchPlex, `section ${sectionKey} read`);
    const byKey = new Map();
    for (const entry of Array.isArray(all.Metadata) ? all.Metadata : []) {
      const ratingKey = text(entry?.ratingKey);
      if (!ratingKey) continue;
      byKey.set(ratingKey, { entry, genres: plexTags(entry.Genre) });
    }
    const genreList = await plexJson(config, new URL(`${baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/genre`), fetchPlex, `section ${sectionKey} genre list`);
    for (const directory of Array.isArray(genreList.Directory) ? genreList.Directory : []) {
      const name = text(directory?.title);
      if (!name) continue;
      const members = await plexJson(config, plexGenreUrl(baseUrl, sectionKey, directory, sectionType.type), fetchPlex, `section ${sectionKey} genre "${name}" read`);
      for (const member of Array.isArray(members.Metadata) ? members.Metadata : []) {
        byKey.get(text(member?.ratingKey))?.genres.push(name);
      }
    }
    for (const [ratingKey, { entry, genres }] of byKey) {
      items.push(catalogueItem("plex", {
        item_id: ratingKey,
        media_type: sectionType.media_type,
        title: entry.title,
        year: entry.year,
        release_date: entry.originallyAvailableAt,
        genres,
        added_at: finiteOrNull(entry.addedAt) === null ? null : Number(entry.addedAt) * 1000,
        rating: entry.audienceRating ?? entry.rating,
        ids: parsePlexGuids(entry),
      }));
    }
  }
  return items;
}

// --- Emby and Jellyfin --------------------------------------------------

const EMBY_LIKE = {
  emby: {
    label: "Emby",
    headers: (config) => ({ Accept: "application/json", "X-Emby-Token": text(config.apiKey || config.api_key || config.token) }),
    sign: (url, config) => url.searchParams.set("api_key", text(config.apiKey || config.api_key || config.token)),
    params: { recursive: "Recursive", types: "IncludeItemTypes", fields: "Fields", start: "StartIndex", limit: "Limit", images: "EnableImages", userData: "EnableUserData" },
    // Emby leaves CommunityRating out unless asked (every title came back
    // unrated in the 8b count); Jellyfin sends it anyway.
    fields: "Genres,DateCreated,ProviderIds,ProductionYear,PremiereDate,CommunityRating",
  },
  jellyfin: {
    label: "Jellyfin",
    headers: (config) => jellyfinAuthHeaders(config),
    sign: () => {},
    params: { recursive: "recursive", types: "includeItemTypes", fields: "fields", start: "startIndex", limit: "limit", images: "enableImages", userData: "enableUserData" },
  },
};

const EMBY_LIKE_TYPES = { movie: "movie", series: "tv" };

export async function readEmbyLikeLibraryCatalogue(provider, config = {}, { fetchImpl = fetchWithTimeout, pageSize = EMBY_PAGE_SIZE } = {}) {
  const flavor = EMBY_LIKE[provider];
  if (!flavor) throw new Error(`Unknown provider ${provider}`);
  if (!configuredProvider({ [provider]: config }, provider)) throw new Error(`Missing ${flavor.label} baseUrl, apiKey, or userId`);
  const { params } = flavor;
  const items = [];
  for (let start = 0; ;) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(text(config.userId))}/Items`);
    flavor.sign(url, config);
    url.searchParams.set(params.recursive, "true");
    url.searchParams.set(params.types, "Movie,Series");
    url.searchParams.set(params.fields, flavor.fields || "Genres,DateCreated,ProviderIds,ProductionYear,PremiereDate");
    url.searchParams.set(params.start, String(start));
    url.searchParams.set(params.limit, String(pageSize));
    url.searchParams.set(params.images, "false");
    url.searchParams.set(params.userData, "false");
    const response = await fetchImpl(url, { headers: flavor.headers(config), lane: "sync" });
    if (!response.ok) throw statusError(`${flavor.label} library read failed with status ${response.status}`, response.status);
    const body = await response.json();
    if (!body || !Array.isArray(body.Items)) throw statusError(`${flavor.label} library read returned no Items`, 0);
    for (const entry of body.Items) {
      const mediaType = EMBY_LIKE_TYPES[text(entry?.Type).toLowerCase()];
      const id = text(entry?.Id);
      if (!mediaType || !id) continue;
      const added = Date.parse(text(entry.DateCreated));
      items.push(catalogueItem(provider, {
        item_id: id,
        media_type: mediaType,
        title: entry.Name,
        year: entry.ProductionYear,
        release_date: entry.PremiereDate,
        genres: Array.isArray(entry.Genres) ? entry.Genres : [],
        added_at: Number.isFinite(added) ? added : null,
        rating: entry.CommunityRating,
        ids: normalizeProviderIds(entry.ProviderIds),
      }));
    }
    start += body.Items.length;
    const total = finiteOrNull(body.TotalRecordCount);
    if (!body.Items.length || body.Items.length < pageSize || (total !== null && start >= total)) {
      if (total !== null && start < total) throw statusError(`${flavor.label} library read stopped at ${start} of ${total} titles`, 0);
      break;
    }
  }
  return items;
}

// --- Episodes of one library show ----------------------------------------

function episodeEntry(season, episode, title, overview, airDate) {
  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0 || !Number.isInteger(episodeNumber) || episodeNumber < 1) return null;
  return { season: seasonNumber, episode: episodeNumber, title: text(title), overview: text(overview).slice(0, 4000), air_date: text(airDate).slice(0, 10) };
}

// The episodes an app holds for a show, read by the series id its catalogue
// listed (automatic TV playlists, step 8b). A search by ids or title missed
// real shows (Jellyfin "Bad Thoughts", 2026-09-26), so the id is used
// directly. A definite answer may be empty (a show folder with no episodes);
// a failed read throws.
export async function readLibrarySeriesEpisodes(provider, config = {}, seriesId, { fetchPlex = fetchPlexWithRefresh, fetchImpl = fetchWithTimeout, pageSize = EMBY_PAGE_SIZE } = {}) {
  const id = text(seriesId);
  if (!id) throw new Error("A series id is required");
  if (provider === "plex") {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/library/metadata/${encodeURIComponent(id)}/allLeaves`);
    const container = await plexJson(config, url, fetchPlex, `series ${id} episodes read`);
    return (Array.isArray(container.Metadata) ? container.Metadata : [])
      .map((entry) => episodeEntry(entry?.parentIndex, entry?.index, entry?.title, entry?.summary, entry?.originallyAvailableAt))
      .filter(Boolean);
  }
  const flavor = EMBY_LIKE[provider];
  if (!flavor) throw new Error(`Unknown provider ${provider}`);
  const { params } = flavor;
  const episodes = [];
  for (let start = 0; ;) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(text(config.userId))}/Items`);
    flavor.sign(url, config);
    url.searchParams.set(provider === "emby" ? "ParentId" : "parentId", id);
    url.searchParams.set(params.recursive, "true");
    url.searchParams.set(params.types, "Episode");
    url.searchParams.set(params.fields, "Overview,PremiereDate");
    url.searchParams.set(params.start, String(start));
    url.searchParams.set(params.limit, String(pageSize));
    url.searchParams.set(params.images, "false");
    url.searchParams.set(params.userData, "false");
    const response = await fetchImpl(url, { headers: flavor.headers(config), lane: "sync" });
    if (!response.ok) throw statusError(`${flavor.label} episodes read failed with status ${response.status}`, response.status);
    const body = await response.json();
    if (!body || !Array.isArray(body.Items)) throw statusError(`${flavor.label} episodes read returned no Items`, 0);
    for (const entry of body.Items) {
      const episode = episodeEntry(entry?.ParentIndexNumber, entry?.IndexNumber, entry?.Name, entry?.Overview, entry?.PremiereDate);
      if (episode) episodes.push(episode);
    }
    start += body.Items.length;
    const total = finiteOrNull(body.TotalRecordCount);
    if (!body.Items.length || body.Items.length < pageSize || (total !== null && start >= total)) {
      if (total !== null && start < total) throw statusError(`${flavor.label} episodes read stopped at ${start} of ${total}`, 0);
      break;
    }
  }
  return episodes;
}

// --- Cache and genre list -----------------------------------------------

const DEFAULT_READERS = {
  plex: (config) => readPlexLibraryCatalogue(config),
  emby: (config) => readEmbyLikeLibraryCatalogue("emby", config),
  jellyfin: (config) => readEmbyLikeLibraryCatalogue("jellyfin", config),
};

const catalogueCache = new Map();
const catalogueReads = new Map();

export function clearLibraryCatalogueCache() {
  catalogueCache.clear();
  catalogueReads.clear();
}

function cacheKey(provider, config = {}) {
  return [provider, trimTrailingSlash(config.baseUrl).toLowerCase(), text(config.userId)].join("|");
}

// One app's catalogue: { status: "ok", items, fetched_at }, or
// { status: "error", error } when the read failed (that app is unreadable for
// this run), or { status: "not_configured" }.
export async function readLibraryCatalogue(provider, config = {}, { force = false, now = Date.now(), readers = DEFAULT_READERS } = {}) {
  const providerConfig = config?.[provider] || {};
  if (!PLAYLIST_PROVIDERS.includes(provider) || !configuredProvider(config, provider)) return { status: "not_configured" };
  const key = cacheKey(provider, providerConfig);
  const cached = catalogueCache.get(key);
  if (!force && cached && now - cached.fetched_at < CATALOGUE_CACHE_TTL_MS) return { status: "ok", items: cached.items, fetched_at: cached.fetched_at };
  let read = catalogueReads.get(key);
  if (!read) {
    read = Promise.resolve().then(() => readers[provider](providerConfig)).finally(() => catalogueReads.delete(key));
    catalogueReads.set(key, read);
  }
  try {
    const items = await read;
    const fetchedAt = Date.now();
    catalogueCache.set(key, { items, fetched_at: fetchedAt });
    return { status: "ok", items, fetched_at: fetchedAt };
  } catch (error) {
    return { status: "error", error: text(error?.message || error) || "Unknown error" };
  }
}

export async function readLibraryCatalogues(providers = PLAYLIST_PROVIDERS, config = {}, options = {}) {
  const entries = await Promise.all(providers.map(async (provider) => [provider, await readLibraryCatalogue(provider, config, options)]));
  return Object.fromEntries(entries);
}

// The genre picker's list for a Movies or TV automatic playlist: TMDB's
// genres plus every genre the readable apps report for that kind, merged by
// genreKey (decision 43). A merged genre is named as TMDB names it (this
// kind's list first), otherwise by its most used app spelling.
export function playlistRuleGenres(kind, catalogues = {}) {
  const mediaType = kind === "tv" ? "tv" : "movie";
  const otherType = mediaType === "tv" ? "movie" : "tv";
  const tmdbNames = new Map();
  for (const type of [otherType, mediaType]) {
    for (const genre of TMDB_GENRES[type]) tmdbNames.set(genreKey(genre.name), genre.name);
  }
  const genres = new Map();
  const entryFor = (key) => {
    if (!genres.has(key)) genres.set(key, { key, spellings: new Map(), tmdb_id: null, providers: new Set(), app_titles: 0 });
    return genres.get(key);
  };
  for (const genre of TMDB_GENRES[mediaType]) entryFor(genreKey(genre.name)).tmdb_id = genre.id;
  for (const [provider, catalogue] of Object.entries(catalogues)) {
    if (catalogue?.status !== "ok") continue;
    for (const item of catalogue.items || []) {
      if (item.media_type !== mediaType) continue;
      item.genres.forEach((name, index) => {
        const entry = entryFor(item.genre_keys[index]);
        entry.providers.add(provider);
        entry.app_titles += 1;
        entry.spellings.set(name, (entry.spellings.get(name) || 0) + 1);
      });
    }
  }
  return [...genres.values()].map((entry) => {
    const spelled = [...entry.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    return {
      key: entry.key,
      name: tmdbNames.get(entry.key) || spelled || entry.key,
      tmdb_id: entry.tmdb_id,
      providers: PLAYLIST_PROVIDERS.filter((provider) => entry.providers.has(provider)),
      // Titles carrying it, summed over the apps (one title in two apps counts twice).
      app_titles: entry.app_titles,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
