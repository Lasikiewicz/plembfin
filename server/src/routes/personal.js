import crypto from "node:crypto";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { bumpDataVersion, db, transaction, writeAuditLog } from "../db.js";
import { getCanonicalPosterUrl } from "../utils/mediaArtwork.js";

const PERSONAL_MEDIA_TYPES = new Set(["movie", "tv", "episode"]);
const MAX_TITLE_LENGTH = 300;
const MAX_TEXT_LENGTH = 4000;
const MAX_URL_LENGTH = 2000;

function normalizeMediaType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["tv", "show", "series"].includes(type)) return "tv";
  if (type === "episode") return "episode";
  if (type === "movie") return "movie";
  return "";
}

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function titleKey(value) {
  return cleanText(value, MAX_TITLE_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

const knownTvTmdbIdStmt = db.prepare("SELECT 1 FROM tmdb_metadata_cache WHERE media_type = 'tv' AND tmdb_id = ? LIMIT 1");
const knownSeriesTvdbIdStmt = db.prepare("SELECT 1 FROM tvdb_metadata_cache WHERE id LIKE 'series_%' AND tvdb_id = ? LIMIT 1");

function isKnownTvTmdbId(value) {
  const id = cleanText(value, 100);
  return Boolean(id && knownTvTmdbIdStmt.get(id));
}

function isKnownSeriesTvdbId(value) {
  const id = cleanText(value, 100);
  return Boolean(id && knownSeriesTvdbIdStmt.get(id));
}

export function personalMediaKey(item = {}) {
  const type = normalizeMediaType(item.media_type || item.mediaType || item.type) || "movie";
  const tmdbId = cleanText(item.tmdb_id || item.tmdbId, 100);
  const tvdbId = cleanText(item.tvdb_id || item.tvdbId, 100);
  const imdbId = cleanText(item.imdb_id || item.imdbId, 100);
  if (type === "episode") {
    const showTitle = cleanText(item.show_title || item.showTitle || item.series_title || item.seriesTitle || item.title || item.name);
    const season = numberOrNull(item.season ?? item.seasonNumber);
    const episode = numberOrNull(item.episode ?? item.episodeNumber);
    const coordinate = `s${Number.isInteger(season) ? season : "?"}e${Number.isInteger(episode) ? episode : "?"}`;
    // Episode provider ids identify the episode itself. Only explicit parent
    // show ids may participate in an episode rating key.
    const showTmdbId = cleanText(item.show_tmdb_id || item.showTmdbId, 100);
    const showTvdbId = cleanText(item.show_tvdb_id || item.showTvdbId, 100);
    const showImdbId = cleanText(item.show_imdb_id || item.showImdbId, 100);
    if (showTmdbId) return `episode:tmdb:${showTmdbId}:${coordinate}`;
    if (showTvdbId) return `episode:tvdb:${showTvdbId}:${coordinate}`;
    if (showImdbId) return `episode:imdb:${showImdbId}:${coordinate}`;
    return `episode:title:${titleKey(showTitle)}:${coordinate}`;
  }
  if (tmdbId) return `${type}:tmdb:${tmdbId}`;
  if (tvdbId) return `${type}:tvdb:${tvdbId}`;
  if (imdbId) return `${type}:imdb:${imdbId}`;
  return `${type}:title:${titleKey(item.title || item.name)}`;
}

function mediaFromBody(body = {}, { allowEpisode = false } = {}) {
  const mediaType = normalizeMediaType(body.media_type || body.mediaType || body.type);
  const title = cleanText(body.title || body.episode_title || body.episodeTitle || body.name, MAX_TITLE_LENGTH);
  if (!PERSONAL_MEDIA_TYPES.has(mediaType) || (mediaType === "episode" && !allowEpisode)) {
    const error = new Error(allowEpisode ? "media_type must be movie, tv, or episode" : "media_type must be movie or tv");
    error.status = 400;
    throw error;
  }
  if (!title) {
    const error = new Error("A title is required");
    error.status = 400;
    throw error;
  }
  const isEpisode = mediaType === "episode";
  const showTitle = isEpisode
    ? cleanText(body.show_title || body.showTitle || body.series_title || body.seriesTitle, MAX_TITLE_LENGTH)
    : "";
  const season = isEpisode ? numberOrNull(body.season ?? body.seasonNumber) : null;
  const episode = isEpisode ? numberOrNull(body.episode ?? body.episodeNumber) : null;
  if (isEpisode && !showTitle) {
    const error = new Error("A show title is required for episode ratings");
    error.status = 400;
    throw error;
  }
  if (isEpisode && (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1)) {
    const error = new Error("A valid season and episode number are required for episode ratings");
    error.status = 400;
    throw error;
  }
  const rawTmdbId = cleanText(body.tmdb_id || body.tmdbId, 100);
  const rawTvdbId = cleanText(body.tvdb_id || body.tvdbId, 100);
  const explicitShowTmdbId = cleanText(body.show_tmdb_id || body.showTmdbId, 100);
  const explicitShowTvdbId = cleanText(body.show_tvdb_id || body.showTvdbId, 100);
  const explicitShowImdbId = cleanText(body.show_imdb_id || body.showImdbId, 100);
  const tmdbId = isEpisode
    ? (explicitShowTmdbId || (isKnownTvTmdbId(rawTmdbId) ? rawTmdbId : ""))
    : rawTmdbId;
  const tvdbId = isEpisode
    ? (explicitShowTvdbId || (isKnownSeriesTvdbId(rawTvdbId) ? rawTvdbId : ""))
    : rawTvdbId;
  const imdbId = isEpisode ? explicitShowImdbId : cleanText(body.imdb_id || body.imdbId, 100);
  const media = {
    media_key: personalMediaKey({
      ...body,
      media_type: mediaType,
      title,
      show_title: showTitle,
      tmdb_id: tmdbId,
      tvdb_id: tvdbId,
      imdb_id: imdbId,
      show_tmdb_id: tmdbId,
      show_tvdb_id: tvdbId,
      show_imdb_id: imdbId,
      season,
      episode,
    }),
    media_type: mediaType,
    title,
    tmdb_id: tmdbId,
    tvdb_id: tvdbId,
    imdb_id: imdbId,
    poster_url: cleanText(body.poster_url || body.posterUrl, MAX_URL_LENGTH),
    overview: cleanText(body.overview || body.description, MAX_TEXT_LENGTH),
    release_date: cleanText(body.release_date || body.releaseDate || body.first_air_date, 40),
    show_title: showTitle,
    show_tmdb_id: isEpisode ? tmdbId : "",
    show_tvdb_id: isEpisode ? tvdbId : "",
    show_imdb_id: isEpisode ? imdbId : "",
    season,
    episode,
  };
  if (!isEpisode) return media;

  const submittedShowIdentity = Boolean(
    explicitShowTmdbId
    || explicitShowTvdbId
    || explicitShowImdbId
    || isKnownTvTmdbId(rawTmdbId)
    || isKnownSeriesTvdbId(rawTvdbId)
  );
  if (submittedShowIdentity) return media;

  // Older history records may only contain an episode-level provider id. If
  // the canonical media-page rating already exists, reuse its identity and
  // metadata instead of creating a second key for the same episode.
  const existing = db.prepare(`
    SELECT *
    FROM personal_ratings
    WHERE media_type = 'episode'
      AND lower(trim(show_title)) = lower(trim(?))
      AND season = ?
      AND episode = ?
    ORDER BY updated_at DESC, media_key ASC
  `).all(showTitle, season, episode);
  const canonical = existing
    .map((row) => ({ row, score: (isKnownTvTmdbId(row.tmdb_id) ? 100 : 0) + (isKnownSeriesTvdbId(row.tvdb_id) ? 100 : 0) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.row.updated_at || 0) - Number(left.row.updated_at || 0))[0]?.row;
  if (!canonical) return media;
  return {
    ...media,
    media_key: canonical.media_key,
    title: canonical.title || media.title,
    tmdb_id: canonical.tmdb_id || media.tmdb_id,
    tvdb_id: canonical.tvdb_id || media.tvdb_id,
    imdb_id: canonical.imdb_id || media.imdb_id,
    poster_url: canonical.poster_url || media.poster_url,
    overview: canonical.overview || media.overview,
    release_date: canonical.release_date || media.release_date,
    show_title: canonical.show_title || media.show_title,
    show_tmdb_id: canonical.tmdb_id || media.show_tmdb_id,
    show_tvdb_id: canonical.tvdb_id || media.show_tvdb_id,
    show_imdb_id: canonical.imdb_id || media.show_imdb_id,
  };
}

function mediaRow(row = {}, extra = {}) {
  const mediaType = normalizeMediaType(row.media_type) || "movie";
  const showTmdbId = mediaType === "episode" && isKnownTvTmdbId(row.tmdb_id) ? row.tmdb_id : "";
  const showTvdbId = mediaType === "episode" && isKnownSeriesTvdbId(row.tvdb_id) ? row.tvdb_id : "";
  const showPosterUrl = mediaType === "episode"
    ? getCanonicalPosterUrl({
      ...row,
      media_type: "episode",
      show_title: row.show_title || row.title || "",
    }, { allowEpisodeProviderIds: true })
    : mediaType === "tv"
      ? getCanonicalPosterUrl({ ...row, media_type: "tv" })
      : "";
  return {
    media_key: row.media_key,
    id: row.media_key,
    media_type: mediaType,
    title: row.title,
    tmdb_id: row.tmdb_id || "",
    tvdb_id: row.tvdb_id || "",
    imdb_id: row.imdb_id || "",
    show_tmdb_id: showTmdbId || "",
    show_tvdb_id: showTvdbId || "",
    show_imdb_id: mediaType === "episode" ? row.imdb_id || "" : "",
    poster_url: row.poster_url || "",
    show_poster_url: showPosterUrl || "",
    overview: row.overview || "",
    release_date: row.release_date || "",
    show_title: row.show_title || "",
    season: row.season ?? null,
    episode: row.episode ?? null,
    created_at: row.created_at || 0,
    updated_at: row.updated_at || 0,
    ...extra,
  };
}

const selectRatingsStmt = db.prepare("SELECT * FROM personal_ratings ORDER BY updated_at DESC, media_key ASC");
const selectWatchlistStmt = db.prepare("SELECT * FROM personal_watchlist ORDER BY updated_at DESC, media_key ASC");
const selectListsStmt = db.prepare("SELECT * FROM personal_lists ORDER BY name COLLATE NOCASE ASC, id ASC");
const selectListItemsStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? ORDER BY updated_at DESC, media_key ASC");

function personalPayload() {
  const lists = selectListsStmt.all().map((list) => ({
    id: list.id,
    name: list.name,
    created_at: list.created_at,
    updated_at: list.updated_at,
    items: selectListItemsStmt.all(list.id).map((item) => mediaRow(item)),
  }));
  return {
    ratings: selectRatingsStmt.all().map((row) => mediaRow(row, { rating: row.rating })),
    watchlist: selectWatchlistStmt.all().map((row) => mediaRow(row)),
    lists,
  };
}

function requireListId(body = {}) {
  const listId = cleanText(body.list_id || body.listId, 100);
  if (!listId) {
    const error = new Error("A list id is required");
    error.status = 400;
    throw error;
  }
  if (!db.prepare("SELECT id FROM personal_lists WHERE id = ?").get(listId)) {
    const error = new Error("Custom list not found");
    error.status = 404;
    throw error;
  }
  return listId;
}

function touchList(listId, timestamp) {
  db.prepare("UPDATE personal_lists SET updated_at = ? WHERE id = ?").run(timestamp, listId);
}

function upsertMedia(tableName, media, timestamp, { rating = null } = {}) {
  if (tableName === "personal_ratings") {
    db.prepare(`
      INSERT INTO personal_ratings
        (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, show_title, season, episode, rating, created_at, updated_at)
      VALUES (@media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date, @show_title, @season, @episode, @rating, @created_at, @updated_at)
      ON CONFLICT(media_key) DO UPDATE SET
        media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id,
        tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, poster_url=excluded.poster_url,
        overview=excluded.overview, release_date=excluded.release_date, show_title=excluded.show_title,
        season=excluded.season, episode=excluded.episode, rating=excluded.rating,
        updated_at=excluded.updated_at
    `).run({ ...media, rating, created_at: timestamp, updated_at: timestamp });
    return;
  }
  db.prepare(`
    INSERT INTO personal_watchlist
      (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, created_at, updated_at)
    VALUES (@media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date, @created_at, @updated_at)
    ON CONFLICT(media_key) DO UPDATE SET
      media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id,
      tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, poster_url=excluded.poster_url,
      overview=excluded.overview, release_date=excluded.release_date, updated_at=excluded.updated_at
  `).run({ ...media, created_at: timestamp, updated_at: timestamp });
}

function upsertListItem(listId, media, timestamp) {
  db.prepare(`
    INSERT INTO personal_list_items
      (list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, created_at, updated_at)
    VALUES (@list_id, @media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date, @created_at, @updated_at)
    ON CONFLICT(list_id, media_key) DO UPDATE SET
      media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id,
      tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, poster_url=excluded.poster_url,
      overview=excluded.overview, release_date=excluded.release_date, updated_at=excluded.updated_at
  `).run({ list_id: listId, ...media, created_at: timestamp, updated_at: timestamp });
}

function deleteEpisodeRatingAliases(media, { keepMediaKey = "" } = {}) {
  if (media.media_type !== "episode") return;
  const conditions = [
    "media_type = 'episode'",
    "lower(trim(show_title)) = lower(trim(?))",
    "season = ?",
    "episode = ?",
  ];
  const params = [media.show_title, media.season, media.episode];
  if (keepMediaKey) {
    conditions.push("media_key <> ?");
    params.push(keepMediaKey);
  }
  db.prepare(`DELETE FROM personal_ratings WHERE ${conditions.join(" AND ")}`).run(...params);
}

export async function handlePersonalMedia(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method === "GET") {
    return sendJson(res, personalPayload(), 200, {
      "Cache-Control": "private, max-age=20, stale-while-revalidate=60",
      Vary: "Authorization",
    });
  }
  if (req.method !== "POST") return methodNotAllowed(res);

  const body = await readJson(req);
  const action = cleanText(body.action, 60).toLowerCase();
  try {
    if (action === "watchlist-add" || action === "watchlist-remove" || action === "rate" || action === "remove-rating" || action === "list-add" || action === "list-remove") {
      const media = mediaFromBody(body, { allowEpisode: action === "rate" || action === "remove-rating" });
      const timestamp = Date.now();
      transaction(() => {
        if (action === "watchlist-add") upsertMedia("personal_watchlist", media, timestamp);
        if (action === "watchlist-remove") db.prepare("DELETE FROM personal_watchlist WHERE media_key = ?").run(media.media_key);
        if (action === "rate") {
          const rating = Number(body.rating);
          if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
            const error = new Error("Rating must be a whole number from 1 to 10");
            error.status = 400;
            throw error;
          }
          deleteEpisodeRatingAliases(media, { keepMediaKey: media.media_key });
          upsertMedia("personal_ratings", media, timestamp, { rating });
        }
        if (action === "remove-rating") {
          if (media.media_type === "episode") deleteEpisodeRatingAliases(media);
          else db.prepare("DELETE FROM personal_ratings WHERE media_key = ?").run(media.media_key);
        }
        if (action === "list-add") {
          const listId = requireListId(body);
          upsertListItem(listId, media, timestamp);
          touchList(listId, timestamp);
        }
        if (action === "list-remove") {
          const listId = requireListId(body);
          db.prepare("DELETE FROM personal_list_items WHERE list_id = ? AND media_key = ?").run(listId, media.media_key);
          touchList(listId, timestamp);
        }
      });
      bumpDataVersion();
      writeAuditLog(`personal.${action}`, { detail: { mediaKey: media.media_key } });
      return sendJson(res, { ok: true, media_key: media.media_key }, 200);
    }

    if (action === "list-create") {
      const name = cleanText(body.name, 100);
      if (!name) return sendJson(res, { error: "A list name is required" }, 400);
      if (db.prepare("SELECT id FROM personal_lists WHERE lower(name) = lower(?)").get(name)) {
        return sendJson(res, { error: "A custom list with that name already exists" }, 409);
      }
      const id = crypto.randomUUID();
      const timestamp = Date.now();
      try {
        db.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, timestamp, timestamp);
      } catch (error) {
        if (String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) return sendJson(res, { error: "A custom list with that name already exists" }, 409);
        throw error;
      }
      bumpDataVersion();
      writeAuditLog("personal.list-create", { detail: { listId: id } });
      return sendJson(res, { ok: true, list: { id, name, created_at: timestamp, updated_at: timestamp, items: [] } }, 201);
    }

    if (action === "list-delete") {
      const listId = requireListId(body);
      db.prepare("DELETE FROM personal_lists WHERE id = ?").run(listId);
      bumpDataVersion();
      writeAuditLog("personal.list-delete", { detail: { listId } });
      return sendJson(res, { ok: true }, 200);
    }

    return sendJson(res, { error: "Unknown personal media action" }, 400);
  } catch (error) {
    return sendJson(res, { error: error.message || "Personal media update failed" }, error.status || 500);
  }
}
