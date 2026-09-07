import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { findWatchedByAnyMediaKeySync, getPlaystateForMediaSync, mediaKeyFor } from "./dataRepo.js";

const selectPendingReviewsStmt = db.prepare(`
  SELECT * FROM manual_watch_reviews
  WHERE status = 'pending'
  ORDER BY created_at DESC, id DESC
`);
const selectReviewByIdStmt = db.prepare("SELECT * FROM manual_watch_reviews WHERE id = ?");
const selectReviewByMediaKeyStmt = db.prepare("SELECT * FROM manual_watch_reviews WHERE media_key = ?");
const insertReviewStmt = db.prepare(`
  INSERT INTO manual_watch_reviews (
    id, media_key, source, source_item_id, title, media_type, show_title,
    episode_title, season, episode, release_date, observed_watched_at,
    source_fingerprint, media_json, status, decision_mode, created_at,
    updated_at, reviewed_at
  ) VALUES (
    @id, @media_key, @source, @source_item_id, @title, @media_type, @show_title,
    @episode_title, @season, @episode, @release_date, @observed_watched_at,
    @source_fingerprint, @media_json, 'pending', NULL, @created_at,
    @updated_at, NULL
  )
`);
const updateReviewStmt = db.prepare(`
  UPDATE manual_watch_reviews
  SET source = @source,
      source_item_id = @source_item_id,
      title = @title,
      media_type = @media_type,
      show_title = @show_title,
      episode_title = @episode_title,
      season = @season,
      episode = @episode,
      release_date = @release_date,
      observed_watched_at = @observed_watched_at,
      source_fingerprint = @source_fingerprint,
      media_json = @media_json,
      status = 'pending',
      decision_mode = NULL,
      updated_at = @updated_at,
      reviewed_at = NULL
  WHERE id = @id
`);
const updateStatusStmt = db.prepare(`
  UPDATE manual_watch_reviews
  SET status = @status, decision_mode = @decision_mode,
      updated_at = @updated_at, reviewed_at = @reviewed_at
  WHERE id = @id
`);

function text(value = "") {
  return String(value ?? "").trim();
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function showTitleFromMedia(media = {}) {
  const explicit = text(media.showTitle || media.show_title);
  if (explicit) return explicit;
  const title = text(media.title);
  return title.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i)?.[1]?.trim() || "";
}

function serializableMedia(media = {}) {
  const showIds = media.showIds || media.show_ids || {};
  const normalized = {
    title: text(media.title),
    showTitle: showTitleFromMedia(media),
    type: text(media.type || media.media_type).toLowerCase(),
    source: text(media.source),
    ids: {
      imdb: text(media.ids?.imdb || media.imdb_id) || undefined,
      tmdb: text(media.ids?.tmdb || media.tmdb_id) || undefined,
      tvdb: text(media.ids?.tvdb || media.tvdb_id) || undefined,
    },
    showIds: {
      imdb: text(showIds.imdb || media.showImdbId || media.show_imdb_id) || undefined,
      tmdb: text(showIds.tmdb || media.showTmdbId || media.show_tmdb_id) || undefined,
      tvdb: text(showIds.tvdb || media.showTvdbId || media.show_tvdb_id) || undefined,
    },
    season: integerOrNull(media.season),
    episode: integerOrNull(media.episode),
    episodeTitle: text(media.episodeTitle || media.episode_title) || undefined,
    itemId: text(media.itemId || media.item_id) || undefined,
    posterUrl: text(media.posterUrl || media.poster_url) || undefined,
    showPosterUrl: text(media.showPosterUrl || media.show_poster_url) || undefined,
    providerItemId: text(media.providerItemId || media.provider_item_id) || undefined,
    providerItems: media.providerItems || media.provider_items || undefined,
    releaseDate: text(media.releaseDate || media.release_date) || undefined,
    runtimeMinutes: Number.isFinite(Number(media.runtimeMinutes ?? media.runtime_minutes))
      ? Number(media.runtimeMinutes ?? media.runtime_minutes)
      : undefined,
    watched_at: text(media.watched_at),
    watchProvenance: media.watchProvenance || media.watch_provenance || null,
    isValid: true,
  };
  return normalized;
}

function rowToReview(row) {
  if (!row) return null;
  const media = parseJson(row.media_json, {}) || {};
  return {
    id: row.id,
    media_key: row.media_key,
    source: row.source,
    source_item_id: row.source_item_id || null,
    title: row.title,
    media_type: row.media_type,
    show_title: row.show_title || null,
    episode_title: row.episode_title || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    release_date: row.release_date || null,
    observed_watched_at: row.observed_watched_at || null,
    source_fingerprint: row.source_fingerprint,
    status: row.status,
    decision_mode: row.decision_mode || null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    reviewed_at: Number(row.reviewed_at || 0) || null,
    media,
  };
}

export function listPendingManualWatchReviews() {
  return selectPendingReviewsStmt.all()
    .map(rowToReview)
    .filter((review) => !reviewIsAlreadyWatched(review));
}

export function countPendingManualWatchReviews() {
  return listPendingManualWatchReviews().length;
}

export function getManualWatchReview(id) {
  return rowToReview(selectReviewByIdStmt.get(text(id)));
}

export function enqueueManualWatchReview(media = {}, {
  releaseDate = "",
  observedWatchedAt = "",
  sourceFingerprint = "",
  reason = "",
} = {}) {
  const normalizedMedia = serializableMedia(media);
  const mediaKey = mediaKeyFor(normalizedMedia);
  const source = text(normalizedMedia.source) || "unknown";
  const fingerprint = text(sourceFingerprint)
    || `${source}:${text(normalizedMedia.itemId)}:${text(observedWatchedAt)}:${text(releaseDate)}:${text(reason)}`;
  const now = Date.now();
  const existing = selectReviewByMediaKeyStmt.get(mediaKey);

  // A dismissed flag should not come back every minute while the provider's
  // snapshot is unchanged. A changed provider fingerprint is a new decision.
  if (existing?.status === "approved") return { queued: false, status: "approved", review: rowToReview(existing) };
  if (existing?.status === "dismissed" && existing.source_fingerprint === fingerprint) {
    return { queued: false, status: "dismissed", review: rowToReview(existing) };
  }

  const values = {
    id: existing?.id || crypto.randomUUID(),
    media_key: mediaKey,
    source,
    source_item_id: text(normalizedMedia.itemId || normalizedMedia.providerItemId) || null,
    title: normalizedMedia.title || "Unknown media",
    media_type: normalizedMedia.type,
    show_title: normalizedMedia.showTitle || null,
    episode_title: normalizedMedia.episodeTitle || null,
    season: normalizedMedia.season,
    episode: normalizedMedia.episode,
    release_date: text(releaseDate || normalizedMedia.releaseDate) || null,
    observed_watched_at: text(observedWatchedAt) || null,
    source_fingerprint: fingerprint,
    media_json: toJson(normalizedMedia),
    updated_at: now,
  };
  if (existing) updateReviewStmt.run(values);
  else insertReviewStmt.run({ ...values, created_at: now });
  return { queued: true, status: "pending", review: getManualWatchReview(values.id) };
}

export function setManualWatchReviewStatus(id, status, decisionMode = null) {
  const normalizedStatus = ["pending", "approved", "dismissed"].includes(String(status || ""))
    ? String(status)
    : "pending";
  const now = Date.now();
  updateStatusStmt.run({
    id: text(id),
    status: normalizedStatus,
    decision_mode: text(decisionMode) || null,
    updated_at: now,
    reviewed_at: normalizedStatus === "pending" ? null : now,
  });
  return getManualWatchReview(id);
}

export function manualWatchReviewMedia(review = {}) {
  return serializableMedia(review.media || review);
}

function reviewIsAlreadyWatched(review = {}) {
  try {
    const media = manualWatchReviewMedia(review);
    const playstate = getPlaystateForMediaSync(media);
    // An explicit current unwatch must win over an older watched history row;
    // only use the history fallback for legacy records with no playstate yet.
    if (playstate?.state === "watched") return true;
    if (playstate?.state === "unwatched") return false;
    return Boolean(findWatchedByAnyMediaKeySync(media));
  } catch {
    // A malformed legacy review should remain visible so it can be corrected
    // manually instead of disappearing because a read-only filter failed.
    return false;
  }
}
