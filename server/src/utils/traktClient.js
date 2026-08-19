import { fetchWithTimeout } from "./outbound.js";

const API_BASE = "https://api.trakt.tv";
const API_VERSION = "2";
const USER_AGENT = "Plembfin (https://github.com/Lasikiewicz/plembfin)";

async function request(url, { method = "GET", body, clientId, accessToken, timeoutMs = 20_000, includePagination = false } = {}) {
  const response = await fetchWithTimeout(url, {
    method,
    lane: "sync",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "trakt-api-version": API_VERSION,
      ...(clientId ? { "trakt-api-key": clientId } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  }, timeoutMs);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error_description || data?.error || `Trakt request failed with ${response.status}`);
    error.status = response.status;
    error.retryAfter = Number(response.headers.get("retry-after") || 0);
    error.body = data;
    throw error;
  }
  if (includePagination) {
    return {
      data,
      page: Number(response.headers.get("x-pagination-page") || 0),
      pageCount: Number(response.headers.get("x-pagination-page-count") || 0),
      pageLimit: Number(response.headers.get("x-pagination-limit") || 0),
    };
  }
  return data;
}

export function startTraktDeviceAuth(clientId) {
  return request(`${API_BASE}/oauth/device/code`, { method: "POST", clientId, body: { client_id: clientId } });
}

export async function pollTraktDeviceAuth({ deviceCode, clientId, clientSecret }) {
  return request(`${API_BASE}/oauth/device/token`, {
    method: "POST", clientId, body: { code: deviceCode, client_id: clientId, client_secret: clientSecret },
  });
}

export function refreshTraktToken({ refreshToken, clientId, clientSecret }) {
  return request(`${API_BASE}/oauth/token`, {
    method: "POST", clientId,
    body: { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", redirect_uri: "urn:ietf:wg:oauth:2.0:oob" },
  });
}

export function getTraktUser({ clientId, accessToken }) {
  return request(`${API_BASE}/users/settings`, { clientId, accessToken });
}

async function fetchAllWatchedPages(type, connection, { extended = "full" } = {}) {
  const limit = 250;
  const items = [];
  for (let page = 1; page <= 10_000; page += 1) {
    const result = await request(`${API_BASE}/sync/watched/${type}?extended=${encodeURIComponent(extended)}&page=${page}&limit=${limit}`, {
      ...connection,
      includePagination: true,
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    items.push(...rows);
    if (result.pageCount > 0 ? page >= result.pageCount : rows.length < (result.pageLimit || limit)) return items;
  }
  throw new Error(`Trakt ${type} watched history exceeded the pagination safety limit`);
}

function cleanIds(ids = {}) {
  return Object.fromEntries(Object.entries(ids).filter(([key, value]) => ["trakt", "imdb", "tmdb", "tvdb"].includes(key) && value != null && String(value) !== ""));
}

function normalizedMediaKey(type, ids, season, episode) {
  const identity = ids.imdb ? `imdb:${ids.imdb}` : ids.tmdb ? `tmdb:${ids.tmdb}` : ids.tvdb ? `tvdb:${ids.tvdb}` : ids.trakt ? `trakt:${ids.trakt}` : "";
  return type === "episode" ? `episode:${identity}:s${Number(season)}e${Number(episode)}` : `movie:${identity}`;
}

function normalizeMovie(entry) {
  const movie = entry.movie || entry;
  const ids = cleanIds(movie.ids);
  const media = { isValid: true, source: "trakt", type: "movie", mediaType: "movie", title: movie.title || "Unknown movie", year: movie.year || null, ids };
  return { mediaKey: normalizedMediaKey("movie", ids), media, watchedAt: Date.parse(entry.last_watched_at || entry.watched_at || "") || Date.now() };
}

function normalizeEpisode(showEntry, episodeEntry) {
  const show = showEntry.show || {};
  const episode = episodeEntry.episode || episodeEntry;
  const ids = cleanIds(show.ids || {});
  const episodeIds = cleanIds(episode.ids || {});
  const season = Number(episode.season);
  const number = Number(episode.number);
  const displayTitle = `${show.title || "Unknown show"} - S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}${episode.title ? ` - ${episode.title}` : ""}`;
  const media = { isValid: true, source: "trakt", type: "episode", mediaType: "episode", title: displayTitle, showTitle: show.title || "", episodeTitle: episode.title || "", season, episode: number, year: show.year || null, ids, trackerEpisodeIds: episodeIds };
  return { mediaKey: normalizedMediaKey("episode", ids, season, number), media, watchedAt: Date.parse(episodeEntry.last_watched_at || episodeEntry.watched_at || "") || Date.now() };
}

export async function fetchTraktWatchedSnapshot({ clientId, accessToken }) {
  const [movies, shows] = await Promise.all([
    fetchAllWatchedPages("movies", { clientId, accessToken }),
    // Since July 2026 Trakt's default/full watched-show response deliberately
    // omits season progress. Request it explicitly or every episode silently
    // disappears from the snapshot and can be mistaken for an unwatch.
    fetchAllWatchedPages("shows", { clientId, accessToken }, { extended: "progress" }),
  ]);
  const malformedShow = shows.find((show) => !Array.isArray(show?.seasons));
  if (malformedShow) {
    throw new Error("Trakt watched-show response did not include season progress");
  }
  const result = [];
  for (const movie of movies || []) result.push(normalizeMovie(movie));
  for (const show of shows || []) for (const season of show.seasons || []) for (const episode of season.episodes || []) {
    result.push(normalizeEpisode(show, { ...episode, season: episode.season ?? season.number }));
  }
  return result.filter((item) => !item.mediaKey.endsWith(":"));
}

async function fetchAllHistoryPages(type, connection, { startAt } = {}) {
  const limit = 250;
  const items = [];
  const startParam = startAt ? `&start_at=${encodeURIComponent(startAt)}` : "";
  for (let page = 1; page <= 10_000; page += 1) {
    const result = await request(`${API_BASE}/sync/history/${type}?page=${page}&limit=${limit}${startParam}`, {
      ...connection,
      includePagination: true,
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    items.push(...rows);
    if (result.pageCount > 0 ? page >= result.pageCount : rows.length < (result.pageLimit || limit)) return items;
  }
  throw new Error(`Trakt ${type} history exceeded the pagination safety limit`);
}

function normalizeHistoryMovie(entry) {
  const { mediaKey, media, watchedAt } = normalizeMovie(entry);
  return { historyId: String(entry.id), mediaKey, media, watchedAt };
}

function normalizeHistoryEpisode(entry) {
  // The episode entry's own timestamp fields are missing on /sync/history
  // responses - watched_at lives on the outer history entry instead.
  const episodeEntry = { ...(entry.episode || {}), watched_at: entry.watched_at };
  const { mediaKey, media, watchedAt } = normalizeEpisode({ show: entry.show }, episodeEntry);
  return { historyId: String(entry.id), mediaKey, media, watchedAt };
}

// Unlike fetchTraktWatchedSnapshot (which returns Trakt's collapsed
// last-watched-per-item view), this reads Trakt's actual play-by-play
// history, so a rewatch shows up as its own entry with its own timestamp
// and history id instead of being folded into a single "last watched" row.
export async function fetchTraktPlayHistory({ clientId, accessToken }, { startAt } = {}) {
  const [movies, episodes] = await Promise.all([
    fetchAllHistoryPages("movies", { clientId, accessToken }, { startAt }),
    fetchAllHistoryPages("episodes", { clientId, accessToken }, { startAt }),
  ]);
  const result = [];
  for (const entry of movies || []) result.push(normalizeHistoryMovie(entry));
  for (const entry of episodes || []) result.push(normalizeHistoryEpisode(entry));
  return result.filter((item) => !item.mediaKey.endsWith(":"));
}

function syncPayload(media, state) {
  const ids = cleanIds(media.ids);
  if (!Object.keys(ids).length) throw Object.assign(new Error("Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for this item"), { code: "not_found" });
  const watchedAt = state === "watched" ? new Date(media.watched_at || media.watchedAt || Date.now()).toISOString() : undefined;
  if (media.type === "episode" || media.mediaType === "episode") {
    const episode = { number: Number(media.episode) };
    if (watchedAt) episode.watched_at = watchedAt;
    return { shows: [{ ids, seasons: [{ number: Number(media.season), episodes: [episode] }] }] };
  }
  const item = { ids };
  if (watchedAt) item.watched_at = watchedAt;
  return { movies: [item] };
}

export function setTraktWatchState({ clientId, accessToken }, media, state) {
  const path = state === "unwatched" ? "/sync/history/remove" : "/sync/history";
  return request(`${API_BASE}${path}`, { method: "POST", clientId, accessToken, body: syncPayload(media, state) });
}

export function trackerMediaKey(media) {
  return normalizedMediaKey(media.type || media.mediaType, cleanIds(media.ids), media.season, media.episode);
}
