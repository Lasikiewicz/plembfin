import { db, parseJson, transaction } from "../db.js";

// Show and movie artwork is deliberately stored separately from watch_history.poster_url.
// The latter belongs to the recorded media item (and can be an episode still),
// while this table represents the poster chosen for the show or movie as a whole.
const selectArtworkByIdentityStmt = db.prepare(
  "SELECT poster_url FROM media_artwork WHERE identity_key = ? LIMIT 1",
);
const selectArtworkRecordByIdentityStmt = db.prepare(
  "SELECT poster_url, poster_source FROM media_artwork WHERE identity_key = ? LIMIT 1",
);
const selectTmdbMetadataStmt = db.prepare("SELECT details FROM tmdb_metadata_cache WHERE id = ?");
const selectPosterCacheStmt = db.prepare(
  "SELECT url FROM poster_cache WHERE media_key = ? AND variant = 'poster' AND status = 'cached' LIMIT 1",
);
const selectTvdbMetadataStmt = db.prepare("SELECT details FROM tvdb_metadata_cache WHERE id = ?");
const selectCachedTvMetadataStmt = db.prepare("SELECT details FROM tmdb_metadata_cache WHERE media_type = 'tv'");
const upsertArtworkStmt = db.prepare(`
  INSERT INTO media_artwork
    (identity_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, poster_source, updated_at)
  VALUES (@identity_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @poster_source, @updated_at)
  ON CONFLICT(identity_key) DO UPDATE SET
    media_type = excluded.media_type,
    title = excluded.title,
    tmdb_id = excluded.tmdb_id,
    tvdb_id = excluded.tvdb_id,
    imdb_id = excluded.imdb_id,
    poster_url = excluded.poster_url,
    poster_source = excluded.poster_source,
    updated_at = excluded.updated_at
`);

let cachedTvdbToTmdb = { expiresAt: 0, values: new Map() };

function clean(value) {
  return String(value ?? "").trim();
}

function mediaTypeFor(item = {}) {
  const raw = clean(item.media_type || item.mediaType || item.type).toLowerCase();
  if (raw === "movie") return "movie";
  if (raw === "episode") return "episode";
  return "tv";
}

function titleFor(item = {}, mediaType = mediaTypeFor(item)) {
  if (mediaType === "episode") return clean(item.show_title || item.showTitle || item.series_title || item.seriesTitle || "");
  return clean(item.title || item.name || "");
}

function titleKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function firstId(...values) {
  return values.map(clean).find(Boolean) || "";
}

// Episode rows usually carry episode-level provider ids. Only use explicit
// show_* ids for them by default. Personal-media rows can opt into their
// stored ids because that endpoint normalizes episode identity to the series.
export function showArtworkIdentity(item = {}, { allowEpisodeProviderIds = false } = {}) {
  const mediaType = mediaTypeFor(item);
  const isEpisode = mediaType === "episode";
  return {
    media_type: mediaType === "movie" ? "movie" : "tv",
    title: titleFor(item, mediaType),
    tmdb_id: firstId(
      item.show_tmdb_id,
      item.showTmdbId,
      (!isEpisode || allowEpisodeProviderIds) ? item.tmdb_id || item.tmdbId : "",
    ),
    tvdb_id: firstId(
      item.show_tvdb_id,
      item.showTvdbId,
      (!isEpisode || allowEpisodeProviderIds) ? item.tvdb_id || item.tvdbId : "",
    ),
    imdb_id: firstId(
      item.show_imdb_id,
      item.showImdbId,
      (!isEpisode || allowEpisodeProviderIds) ? item.imdb_id || item.imdbId : "",
    ),
  };
}

export function mediaArtworkIdentityKeys(item = {}, { allowEpisodeProviderIds = false, includeTitle = true } = {}) {
  const identity = showArtworkIdentity(item, { allowEpisodeProviderIds });
  const type = identity.media_type === "movie" ? "movie" : "tv";
  const keys = [];
  if (identity.tmdb_id) keys.push(`${type}:tmdb:${identity.tmdb_id}`);
  if (identity.tvdb_id) keys.push(`${type}:tvdb:${identity.tvdb_id}`);
  if (identity.imdb_id) keys.push(`${type}:imdb:${identity.imdb_id.toLowerCase()}`);
  if (includeTitle && identity.title) {
    const key = titleKey(identity.title);
    if (key) keys.push(`${type}:title:${key}`);
  }
  return [...new Set(keys)];
}

export function canonicalMediaArtworkCacheKey(item = {}) {
  const identity = showArtworkIdentity(item);
  const prefix = identity.media_type === "movie" ? "movie" : "tv";
  return mediaArtworkIdentityKeys(item, { includeTitle: true })[0] || `${prefix}:title:unknown`;
}

function posterUrlFromTmdbDetails(details, tmdbId = "", mediaType = "tv") {
  if (!details) return "";
  const cached = clean(details.cached_poster_url || details.cachedPosterUrl);
  if (cached) return cached;
  const path = clean(details.poster_path || details.posterPath);
  if (path) {
    return `/api/tmdb-poster?path=${encodeURIComponent(path)}&tmdbId=${encodeURIComponent(tmdbId)}&mediaType=${encodeURIComponent(mediaType)}`;
  }
  const tvdbPoster = clean(details.tvdb_poster_url || details.tvdbPosterUrl || details.image_url || details.imageUrl || details.image);
  if (tvdbPoster) return remoteArtworkUrl(tvdbPoster);
  return "";
}

function remoteArtworkUrl(url) {
  if (!/^https:\/\//i.test(url)) return url;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host !== "assets.fanart.tv" && host !== "artworks.thetvdb.com" && host !== "artworks.thetvdb.com.") return url;
    return `/api/remote-artwork?variant=poster&url=${encodeURIComponent(url)}`;
  } catch {
    return "";
  }
}

function cachedTmdbDetails(tmdbId) {
  const id = clean(tmdbId);
  if (!id) return null;
  const row = selectTmdbMetadataStmt.get(`tv_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

function cachedTmdbMovieDetails(tmdbId) {
  const id = clean(tmdbId);
  if (!id) return null;
  const row = selectTmdbMetadataStmt.get(`movie_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

function cachedTvdbDetails(tvdbId) {
  const id = clean(tvdbId);
  if (!id) return null;
  const row = selectTvdbMetadataStmt.get(`series_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

function tmdbDetailsForTvdbId(tvdbId) {
  const id = clean(tvdbId);
  if (!id) return null;
  const now = Date.now();
  if (now >= cachedTvdbToTmdb.expiresAt) {
    const values = new Map();
    for (const row of selectCachedTvMetadataStmt.all()) {
      const details = row?.details ? parseJson(row.details) : null;
      const externalTvdbId = clean(details?.external_ids?.tvdb_id || details?.external_ids?.tvdbId);
      if (externalTvdbId && details) values.set(externalTvdbId, details);
    }
    cachedTvdbToTmdb = { expiresAt: now + 10000, values };
  }
  return cachedTvdbToTmdb.values.get(id) || null;
}

function metadataPosterForIdentity(identity) {
  if (identity.media_type === "movie") {
    const tmdbDetails = cachedTmdbMovieDetails(identity.tmdb_id);
    const tmdbPoster = posterUrlFromTmdbDetails(tmdbDetails, identity.tmdb_id, "movie");
    if (tmdbPoster) return tmdbPoster;

    if (identity.tmdb_id) {
      const cached = selectPosterCacheStmt.get(`tmdb:movie:${identity.tmdb_id}`);
      if (cached?.url) return cached.url;
    }
    return "";
  }

  const tmdbDetails = cachedTmdbDetails(identity.tmdb_id);
  const tmdbPoster = posterUrlFromTmdbDetails(tmdbDetails, identity.tmdb_id, "tv");
  if (tmdbPoster) return tmdbPoster;

  const tvdbDetails = cachedTvdbDetails(identity.tvdb_id);
  const tvdbPoster = posterUrlFromTmdbDetails(tvdbDetails, identity.tmdb_id, "tv");
  if (tvdbPoster) return tvdbPoster;

  const mappedTmdbDetails = tmdbDetailsForTvdbId(identity.tvdb_id);
  return posterUrlFromTmdbDetails(mappedTmdbDetails, clean(mappedTmdbDetails?.id), "tv");
}

function storedPosterForKeys(keys = []) {
  for (const key of keys) {
    const row = selectArtworkByIdentityStmt.get(key);
    const poster = clean(row?.poster_url);
    if (poster) return poster;
  }
  return "";
}

// Resolve the show or movie poster used by shared cards and detail pages. Manual artwork
// wins over provider metadata. A title key is used only when the caller has no
// trusted show-level provider identity, which is necessary for legacy episode
// rows that only know their show title.
export function getCanonicalPosterUrl(item = {}, options = {}) {
  const identity = showArtworkIdentity(item, options);
  const stableKeys = mediaArtworkIdentityKeys(identity, { includeTitle: false });
  const lookupKeys = stableKeys.length
    ? stableKeys
    : mediaArtworkIdentityKeys(identity, { includeTitle: true });
  const manual = storedPosterForKeys(lookupKeys);
  if (manual) return manual;
  return metadataPosterForIdentity(identity);
}

// Save all known aliases to the same canonical value. This lets a show or movie found
// via TMDB, TVDB, IMDb, or a legacy title-only personal row converge on the
// same edited poster without copying it into any episode record.
export function saveCanonicalPoster(item = {}, posterUrl = "", { source = "manual", preserveExisting = false } = {}) {
  const identity = showArtworkIdentity(item);
  const url = clean(posterUrl);
  if (!url) return { ok: false, identity_keys: [] };
  const keys = mediaArtworkIdentityKeys(identity, { includeTitle: true });
  if (!keys.length) return { ok: false, identity_keys: [] };
  const timestamp = Date.now();
  let changed = 0;
  transaction(() => {
    for (const identityKey of keys) {
      const existing = preserveExisting ? selectArtworkRecordByIdentityStmt.get(identityKey) : null;
      if (preserveExisting && existing?.poster_url) continue;
      upsertArtworkStmt.run({
        identity_key: identityKey,
        media_type: identity.media_type,
        title: identity.title || null,
        tmdb_id: identity.tmdb_id || null,
        tvdb_id: identity.tvdb_id || null,
        imdb_id: identity.imdb_id || null,
        poster_url: url,
        poster_source: clean(source) || "manual",
        updated_at: timestamp,
      });
      changed += 1;
    }
  });
  return { ok: true, changed, poster_url: url, identity_keys: keys };
}
