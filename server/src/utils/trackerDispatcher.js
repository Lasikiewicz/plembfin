import { getTrackerConnection, recordTrackerOutbound, recordTrackerOutboundBatch, updateTrackerConnectionStatus, updateTrackerTokens } from "./trackerConnectionRepo.js";
import { refreshTraktToken, setTraktWatchState, trackerMediaIdentityKeys, trackerMediaKey } from "./traktClient.js";
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

function primaryHydrationCacheKey(media = {}) {
  const type = media.type || media.mediaType;
  const title = type === "episode" ? trackerShowTitle(media) : String(media.title || "").trim();
  return `${type}:${title.toLowerCase().replace(/\s+/g, " ").trim()}:${String(media.year || "")}`;
}

// Trakt accepts any one provider id, so a sparse item already has a reliable
// primary payload and does not need a series metadata lookup merely to enrich
// it. This is especially important for legacy shows with hundreds of episode
// rows. Title-only items still need hydration; callers can share their
// series-level details promise across the whole Force batch.
async function hydrateTrackerMedia(media, {
  primaryHydrationCache = null,
  detailsResolver = getTmdbDetails,
} = {}) {
  const type = media.type || media.mediaType;
  if (type !== "episode" && type !== "movie") return media;
  if (trackerMediaIdentityKeys(media).length) return media;
  const resolveDetails = (args) => {
    const resolve = () => Promise.resolve().then(() => detailsResolver(args));
    if (!primaryHydrationCache) return resolve();
    const key = primaryHydrationCacheKey(media);
    if (!primaryHydrationCache.has(key)) primaryHydrationCache.set(key, resolve());
    return primaryHydrationCache.get(key);
  };
  if (type === "episode") {
    const title = trackerShowTitle(media);
    if (!title) return media;
    try {
      const details = await resolveDetails({
        mediaType: "tv",
        tmdbId: "",
        title,
        ids: {},
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
    const details = await resolveDetails({
      mediaType: "movie",
      tmdbId: "",
      title,
      ids: {},
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

// A stored provider id remains the primary payload. Movies may receive one
// title-derived retry when Trakt rejects that id, because a movie title maps
// directly to the payload Trakt expects. Episodes are different: Trakt expects
// a series id plus season/episode coordinates, and a title search can select
// the wrong series. An existing episode identity is therefore never retried
// with a guessed series id. Title-only episodes can still be hydrated once
// before their first dispatch because they have no identity to protect.
function titleRetryCacheKey(media = {}) {
  const type = media.type || media.mediaType;
  if (type !== "movie") return "";
  const title = String(media.title || "").trim();
  return `${type}:${title.toLowerCase().replace(/\s+/g, " ").trim()}:${String(media.year || "")}`;
}

async function titleIdsForRetry(media, cache = null, detailsResolver = getTmdbDetails) {
  const type = media.type || media.mediaType;
  if (type !== "movie") return null;
  const title = String(media.title || "").trim();
  if (!title) return null;
  const resolve = async () => {
    const details = await Promise.resolve()
      .then(() => detailsResolver({ mediaType: "movie", title, light: true }))
      .catch(() => null);
    const ids = {
      imdb: String(details?.external_ids?.imdb_id || "").trim(),
      tmdb: String(details?.id || details?.external_ids?.tmdb_id || "").trim(),
      tvdb: String(details?.external_ids?.tvdb_id || "").trim(),
    };
    return ids.imdb || ids.tmdb || ids.tvdb ? ids : null;
  };
  if (!cache) return resolve();
  const key = titleRetryCacheKey(media);
  if (!key) return null;
  if (!cache.has(key)) cache.set(key, resolve());
  return cache.get(key);
}

// Resolve the identities the real Trakt dispatch can use before it mutates
// anything remotely. `hydrateTrackerMedia` fills title-only Force items while
// raw sparse IDs remain authoritative primaries. Only movies receive a
// title-derived not_found retry; an existing episode identity is never replaced
// with a guessed series id. Force Sync asks for the same safe candidates up
// front, so its preflight marker covers the item during the earlier LAN phase.
export async function trackerDispatchMediaCandidates(media = {}, {
  includeTitleFallback = false,
  primaryHydrationCache = null,
  titleFallbackCache = null,
  detailsResolver = getTmdbDetails,
} = {}) {
  const hadPrimaryIdentity = trackerMediaIdentityKeys(media).length > 0;
  const primary = await hydrateTrackerMedia(media, { primaryHydrationCache, detailsResolver });
  const candidates = trackerMediaIdentityKeys(primary).length ? [primary] : [];
  // A title-only item's hydrated primary already *is* its title-derived
  // candidate. Only raw-ID primaries need the separate not_found retry.
  const type = primary.type || primary.mediaType;
  if (includeTitleFallback && hadPrimaryIdentity && type !== "episode") {
    const titleIds = await titleIdsForRetry(primary, titleFallbackCache, detailsResolver).catch(() => null);
    if (titleIds) {
      const fallback = { ...primary, ids: titleIds };
      const primaryIds = JSON.stringify(Object.entries(primary.ids || {}).filter(([, value]) => value != null && String(value) !== "").sort());
      const fallbackIds = JSON.stringify(Object.entries(titleIds).filter(([, value]) => value != null && String(value) !== "").sort());
      if (fallbackIds !== primaryIds && trackerMediaIdentityKeys(fallback).length) candidates.push(fallback);
    }
  }
  return candidates;
}

async function dispatchTrakt(media, state, lane = "sync") {
  let connection = await withFreshTraktConnection();
  if (!connection) return { target: "trakt", status: "skipped", detail: "Trakt is not connected" };
  // Anything sourced from Trakt itself - the live poller ("trakt") or a bulk
  // history import ("trakt_import", used by both the CSV/JSON importer and
  // the play-history backfill) - already exists on Trakt. Echoing it back
  // via /sync/history would create a duplicate play there every time.
  if (String(media.source || "").toLowerCase().includes("trakt")) return { target: "trakt", status: "skipped", detail: "Source tracker echo suppressed" };
  let [trackerMedia] = await trackerDispatchMediaCandidates(media);
  if (!trackerMedia) {
    [trackerMedia] = await trackerDispatchMediaCandidates(media, { includeTitleFallback: true });
  }
  if (!trackerMedia) {
    throw Object.assign(new Error("Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for this item"), { code: "not_found" });
  }
  const isCanonicalReplay = state === "watched" && String(media.source || "").toLowerCase() === "manual";
  const mediaKey = trackerMediaKey(trackerMedia);
  // Prime the persistent echo ledger before touching Trakt. A canonical
  // replay is a non-atomic remove -> add pair; without this intent marker a
  // concurrent watched-state poll can observe the temporary gap and fan a
  // false unwatch back out to Plex/Emby/Jellyfin before the add completes.
  recordTrackerOutbound("trakt", mediaKey, trackerMedia, state);
  let dispatch;
  try {
    dispatch = await performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane);
  } catch (error) {
    if (error.status !== 401) throw error;
    connection = await withFreshTraktConnection(true);
    dispatch = await performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane);
  }
  // Refresh the marker on confirmed completion so the normal Trakt
  // read-after-write consistency window is protected as well.
  recordTrackerOutbound("trakt", mediaKey, trackerMedia, state);

  let addNotFound = traktNotFoundCount(dispatch.result);
  let usedTitleIdFallback = false;
  if (addNotFound > 0) {
    const candidates = await trackerDispatchMediaCandidates(trackerMedia, { includeTitleFallback: true });
    const retryMedia = candidates[1] || null;
    if (retryMedia) {
      recordTrackerOutbound("trakt", trackerMediaKey(retryMedia), retryMedia, state);
      const retryDispatch = await performTraktDispatch(connection, retryMedia, state, isCanonicalReplay, lane).catch(() => null);
      if (retryDispatch && traktNotFoundCount(retryDispatch.result) === 0) {
        dispatch = retryDispatch;
        addNotFound = 0;
        usedTitleIdFallback = true;
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

  let detail = usedTitleIdFallback
    ? trackerMedia.type === "episode"
      ? `Marked ${state} on Trakt (this episode's own stored id didn't match; used the show's series id instead)`
      : `Marked ${state} on Trakt (the stored movie id didn't match; used the title-derived movie id instead)`
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

// A multi-phase canonical replay may update Plembfin and the LAN media
// servers before its deliberately slower Trakt phase begins. Publish that
// final Trakt intent before the first local mutation so a poll that already
// fetched a stale snapshot can see it in its last-responsible-moment guard,
// rather than committing the opposite state in the gap between phases.
//
// The real dispatch records the same intent again immediately before and
// after its Trakt request. This early marker is therefore only a phase-order
// barrier; it does not replace the normal request-level echo protection.
export async function primeTrackerWatchStateIntents(entries = [], {
  detailsResolver = getTmdbDetails,
} = {}) {
  const connection = getTrackerConnection("trakt");
  if (!connection || connection.status !== "connected") return 0;
  const eligible = entries.filter(({ media }) => !String(media?.source || "").toLowerCase().includes("trakt"));
  // Resolve every item first, then publish the entire title under one SQLite
  // transaction. A poll in another process must never observe only the first
  // few hydrated markers while the remaining Force Sync items are still being
  // prepared.
  const primaryHydrationCache = new Map();
  const titleFallbackCache = new Map();
  const resolved = await Promise.all(eligible.map(async ({ media, state }) => ({
    state,
    candidates: await trackerDispatchMediaCandidates(media, {
      includeTitleFallback: true,
      primaryHydrationCache,
      titleFallbackCache,
      detailsResolver,
    }),
  })));
  const outboundByKey = new Map();
  for (const { state, candidates } of resolved) {
    for (const candidate of candidates) {
      const mediaKey = trackerMediaKey(candidate);
      // If primary and fallback prefer the same storage key, retain the
      // title-derived fallback (it is last) while still publishing both when
      // their IDs are wholly non-overlapping.
      outboundByKey.set(mediaKey, { mediaKey, media: candidate, state });
    }
  }
  const outbound = [...outboundByKey.values()];
  return recordTrackerOutboundBatch("trakt", outbound);
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
