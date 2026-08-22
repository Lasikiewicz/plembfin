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

// A stored id on the episode itself (from the media server or an import)
// identifies this exact row and must win over a title-based guess - a short
// or common show title ("G'wed") can resolve TMDB's search to the wrong
// series, and overwriting an already-correct id with that wrong one sends
// every future Trakt dispatch for the show to a series Trakt has never heard
// of, which then can't be matched to clear or add anything (see the
// not_found handling in dispatchTrakt below). Existing ids are only filled
// in where the episode doesn't already have one, never replaced.
export function trackerMediaWithSeriesIds(media = {}, details = {}) {
  if ((media.type || media.mediaType) !== "episode") return media;
  const tmdb = String(details.id || details.external_ids?.tmdb_id || "").trim();
  const tvdb = String(details.external_ids?.tvdb_id || "").trim();
  const imdb = String(details.external_ids?.imdb_id || "").trim();
  if (!tmdb && !tvdb && !imdb) return media;
  const existingIds = media.ids || {};
  return {
    ...media,
    showTitle: trackerShowTitle(media),
    ids: {
      ...(tmdb ? { tmdb } : {}),
      ...(tvdb ? { tvdb } : {}),
      ...(imdb ? { imdb } : {}),
      ...existingIds,
    },
  };
}

// Same backfill-only reasoning as trackerMediaWithSeriesIds above, for a
// movie instead of an episode: fills in ids the movie arrived without (e.g. a
// media server webhook for a very new release whose own metadata agent has not
// matched yet, like ids: {} straight from Plex), never
// replaces an id that's already there.
export function trackerMediaWithMovieIds(media = {}, details = {}) {
  if ((media.type || media.mediaType) !== "movie") return media;
  const tmdb = String(details.id || details.external_ids?.tmdb_id || "").trim();
  const tvdb = String(details.external_ids?.tvdb_id || "").trim();
  const imdb = String(details.external_ids?.imdb_id || "").trim();
  if (!tmdb && !tvdb && !imdb) return media;
  const existingIds = media.ids || {};
  return {
    ...media,
    ids: {
      ...(tmdb ? { tmdb } : {}),
      ...(tvdb ? { tvdb } : {}),
      ...(imdb ? { imdb } : {}),
      ...existingIds,
    },
  };
}

// Hydrates any missing provider ids even when the item already carries one:
// TMDB's details response carries the other external ids, and existing ids
// remain authoritative; this only fills gaps.
async function hydrateTrackerMedia(media) {
  const type = media.type || media.mediaType;
  if (type !== "episode" && type !== "movie") return media;
  const existingIds = media.ids || {};
  const hasAllIds = Boolean(existingIds.imdb && existingIds.tmdb && existingIds.tvdb);
  if (hasAllIds) return media;
  if (type === "episode") {
    const title = trackerShowTitle(media);
    if (!title) return media;
    try {
      const details = await getTmdbDetails({
        mediaType: "tv",
        tmdbId: existingIds.tmdb || "",
        title,
        ids: { imdbId: existingIds.imdb, tvdbId: existingIds.tvdb },
        light: true,
      });
      return trackerMediaWithSeriesIds(media, details);
    } catch {
      return media;
    }
  }
  const title = String(media.title || "").trim();
  if (!title) return media;
  try {
    const details = await getTmdbDetails({
      mediaType: "movie",
      tmdbId: existingIds.tmdb || "",
      title,
      ids: { imdbId: existingIds.imdb, tvdbId: existingIds.tvdb },
      light: true,
    });
    return trackerMediaWithMovieIds(media, details);
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

// Trakt's /sync/history and /sync/history/remove both return 200 with a
// summary body - {added|deleted: {movies, episodes}, not_found: {movies,
// shows, seasons, episodes}} - even when nothing actually matched. A
// non-empty not_found means Trakt could not resolve the ids/season/episode
// we sent to a real item, which is a real failure that an HTTP 200 alone
// hides; without reading the body, a canonical replay's "clear existing
// plays first" step can silently do nothing while still being reported as a
// success.
function traktNotFoundCount(result) {
  const notFound = result?.not_found || {};
  return Object.values(notFound).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

// Trakt's history is a play log, not a "watched" flag - POST /sync/history
// always adds a new play, it never corrects an existing one. A canonical
// replay (Force Sync, a watched-date correction - anything sourced as
// "manual") isn't a fresh watch event, so clear any existing plays for this
// item first; otherwise every replay silently piles up duplicate history
// entries at whatever time it happened to run. A genuine watch reported by a
// media server still just adds, since that really is a new play. Removing an
// item with no existing history is a no-op on Trakt's side, not an error.
async function performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane = "sync") {
  let removeResult = null;
  if (isCanonicalReplay) {
    removeResult = await setTraktWatchState(connection, trackerMedia, "unwatched", { lane });
  }
  const result = await setTraktWatchState(connection, trackerMedia, state, { lane });
  return { removeResult, result };
}

// hydrateTrackerMedia deliberately never overrides an episode's own stored
// id, since that id normally must win over a title-based guess (see its own
// comment). But Trakt rejecting the add outright is a much stronger signal
// than "no id was ever recorded" - it means the specific id we sent doesn't
// correspond to anything Trakt recognizes, which is exactly what happens
// when a media server's own metadata match is wrong for one episode (its
// webhook still reports *an* id, just the wrong one). One retry against the
// show's own known series ids, only once Trakt has explicitly said the
// episode's own id doesn't work, recovers this without ever silently
// replacing a genuinely-working id the way the title-search bug used to.
async function seriesIdsForRetry(media) {
  const title = trackerShowTitle(media);
  if (!title) return null;
  const details = await getTmdbDetails({ mediaType: "tv", title, light: true }).catch(() => null);
  const ids = {
    imdb: String(details?.external_ids?.imdb_id || "").trim(),
    tmdb: String(details?.id || details?.external_ids?.tmdb_id || "").trim(),
    tvdb: String(details?.external_ids?.tvdb_id || "").trim(),
  };
  return ids.imdb || ids.tmdb || ids.tvdb ? ids : null;
}

async function dispatchTrakt(media, state, lane = "sync") {
  let connection = await withFreshTraktConnection();
  if (!connection) return { target: "trakt", status: "skipped", detail: "Trakt is not connected" };
  // Anything sourced from Trakt itself - the live poller ("trakt") or a bulk
  // history import ("trakt_import", used by both the CSV/JSON importer and
  // the play-history backfill) - already exists on Trakt. Echoing it back
  // via /sync/history would create a duplicate play there every time.
  if (String(media.source || "").toLowerCase().includes("trakt")) return { target: "trakt", status: "skipped", detail: "Source tracker echo suppressed" };
  const trackerMedia = await hydrateTrackerMedia(media);
  const isCanonicalReplay = state === "watched" && String(media.source || "").toLowerCase() === "manual";
  let dispatch;
  try {
    dispatch = await performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane);
  } catch (error) {
    if (error.status !== 401) throw error;
    connection = await withFreshTraktConnection(true);
    dispatch = await performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane);
  }
  const mediaKey = trackerMediaKey(trackerMedia);
  recordTrackerOutbound("trakt", mediaKey, trackerMedia, state);

  let addNotFound = traktNotFoundCount(dispatch.result);
  let usedSeriesIdFallback = false;
  if (addNotFound > 0 && trackerMedia.type === "episode") {
    const seriesIds = await seriesIdsForRetry(trackerMedia).catch(() => null);
    const changed = seriesIds && JSON.stringify(seriesIds) !== JSON.stringify(trackerMedia.ids || {});
    if (changed) {
      const retryMedia = { ...trackerMedia, ids: seriesIds };
      const retryDispatch = await performTraktDispatch(connection, retryMedia, state, isCanonicalReplay, lane).catch(() => null);
      if (retryDispatch && traktNotFoundCount(retryDispatch.result) === 0) {
        dispatch = retryDispatch;
        addNotFound = 0;
        usedSeriesIdFallback = true;
        recordTrackerOutbound("trakt", trackerMediaKey(retryMedia), retryMedia, state);
      }
    }
  }
  if (addNotFound > 0) {
    return {
      target: "trakt",
      status: "error",
      detail: `Trakt could not match this item to mark it ${state} (not_found: ${JSON.stringify(dispatch.result.not_found)})`,
    };
  }

  let detail = usedSeriesIdFallback
    ? `Marked ${state} on Trakt (this episode's own stored id didn't match; used the show's series id instead)`
    : `Marked ${state} on Trakt`;
  if (isCanonicalReplay && dispatch.removeResult) {
    const deleted = dispatch.removeResult.deleted || {};
    const deletedCount = Number(deleted.movies || 0) + Number(deleted.episodes || 0);
    const removeNotFound = traktNotFoundCount(dispatch.removeResult);
    detail += ` (cleared ${deletedCount} existing play${deletedCount === 1 ? "" : "s"} first`;
    detail += removeNotFound ? `, ${removeNotFound} not recognized: ${JSON.stringify(dispatch.removeResult.not_found)})` : ")";
  }
  return { target: "trakt", status: "success", detail };
}

export async function dispatchTrackerWatchState(media, state, { lane = "sync" } = {}) {
  const connection = getTrackerConnection("trakt");
  if (!connection || connection.status === "disabled") return [];
  try {
    return [await dispatchTrakt(media, state, lane)];
  } catch (error) {
    updateTrackerConnectionStatus("trakt", { lastError: error.message });
    const status = error.code === "not_found" ? "not_found" : "failed";
    return [{ target: "trakt", status, detail: error.message || String(error) }];
  }
}

export function traktTokenExpiry(tokens) {
  return tokenExpiry(tokens);
}
