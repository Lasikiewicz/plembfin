import { getTrackerConnection, recordTrackerOutbound, updateTrackerConnectionStatus, updateTrackerTokens } from "./trackerConnectionRepo.js";
import { refreshTraktToken, setTraktWatchState, trackerMediaKey } from "./traktClient.js";
import { hydrateTraktAppCredentials } from "./traktAppConfig.js";
import { getTmdbDetails } from "./tmdbGateway.js";

let traktRefreshInFlight = null;

function trackerShowTitle(media = {}) {
  const explicit = String(media.showTitle || media.show_title || "").trim();
  if (explicit) return explicit;
  return String(media.title || "").replace(/\s+-\s+S\d{1,2}E\d{1,2}.*$/i, "").trim();
}

export function trackerMediaWithSeriesIds(media = {}, details = {}) {
  if ((media.type || media.mediaType) !== "episode") return media;
  const tmdb = String(details.id || details.external_ids?.tmdb_id || "").trim();
  const tvdb = String(details.external_ids?.tvdb_id || "").trim();
  const imdb = String(details.external_ids?.imdb_id || "").trim();
  if (!tmdb && !tvdb && !imdb) return media;
  return {
    ...media,
    showTitle: trackerShowTitle(media),
    ids: {
      ...(tmdb ? { tmdb } : {}),
      ...(tvdb ? { tvdb } : {}),
      ...(imdb ? { imdb } : {}),
    },
  };
}

async function hydrateTrackerMedia(media) {
  if ((media.type || media.mediaType) !== "episode") return media;
  const title = trackerShowTitle(media);
  if (!title) return media;
  try {
    const details = await getTmdbDetails({ mediaType: "tv", title, light: true });
    return trackerMediaWithSeriesIds(media, details);
  } catch {
    return media;
  }
}

function tokenExpiry(tokens) {
  const created = Number(tokens.created_at || Math.floor(Date.now() / 1000));
  return (created + Number(tokens.expires_in || 604800)) * 1000;
}

export async function withFreshTraktConnection(force = false) {
  let connection = getTrackerConnection("trakt", { includeCredentials: true });
  if (!connection || connection.status !== "connected") return null;
  connection = hydrateTraktAppCredentials(connection);
  if (!force && Number(connection.accessTokenExpiresAt || 0) > Date.now() + 5 * 60_000) return connection;
  if (!traktRefreshInFlight) {
    traktRefreshInFlight = refreshTraktToken(connection)
      .then((tokens) => {
        updateTrackerTokens("trakt", { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessTokenExpiresAt: tokenExpiry(tokens) });
      })
      .catch((error) => {
        updateTrackerConnectionStatus("trakt", { status: error.status === 400 || error.status === 401 ? "reauth_required" : "connected", lastError: error.message });
        throw error;
      })
      .finally(() => { traktRefreshInFlight = null; });
  }
  await traktRefreshInFlight;
  connection = getTrackerConnection("trakt", { includeCredentials: true });
  return hydrateTraktAppCredentials(connection);
}

async function dispatchTrakt(media, state) {
  let connection = await withFreshTraktConnection();
  if (!connection) return { target: "trakt", status: "skipped", detail: "Trakt is not connected" };
  if (String(media.source || "").toLowerCase() === "trakt") return { target: "trakt", status: "skipped", detail: "Source tracker echo suppressed" };
  const trackerMedia = await hydrateTrackerMedia(media);
  try {
    await setTraktWatchState(connection, trackerMedia, state);
  } catch (error) {
    if (error.status !== 401) throw error;
    connection = await withFreshTraktConnection(true);
    await setTraktWatchState(connection, trackerMedia, state);
  }
  const mediaKey = trackerMediaKey(trackerMedia);
  recordTrackerOutbound("trakt", mediaKey, trackerMedia, state);
  return { target: "trakt", status: "success", detail: `Marked ${state} on Trakt` };
}

export async function dispatchTrackerWatchState(media, state) {
  const connection = getTrackerConnection("trakt");
  if (!connection || connection.status === "disabled") return [];
  try {
    return [await dispatchTrakt(media, state)];
  } catch (error) {
    updateTrackerConnectionStatus("trakt", { lastError: error.message });
    const status = error.code === "not_found" ? "not_found" : "failed";
    return [{ target: "trakt", status, detail: error.message || String(error) }];
  }
}

export function traktTokenExpiry(tokens) {
  return tokenExpiry(tokens);
}
