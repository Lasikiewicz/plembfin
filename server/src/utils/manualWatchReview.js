import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import {
  canonicalShowTitleKey,
  canonicalTitleKey,
  findWatchedByAnyMediaKeySync,
  getPlaystateForMediaSync,
  mediaKeyFor,
} from "./dataRepo.js";

const EXPLICIT_PLAYED_EVENT_KEYS = new Set([
  "itemmarkplayed",
  "itemmarkedplayed",
  "itemmarkedasplayed",
  "itemplayed",
]);

const selectPendingReviewsStmt = db.prepare(`
  SELECT * FROM manual_watch_reviews
  WHERE status = 'pending'
  ORDER BY created_at DESC, id DESC
`);
const selectManualUnwatchRowsStmt = db.prepare(`
  SELECT title, media_type, show_title, season, episode, imdb_id, tmdb_id, tvdb_id
  FROM watch_history
  WHERE source = 'manual'
    AND sync_action IN ('unwatched', 'unplayed')
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

function compactEventKey(value = "") {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isExplicitPlayedMedia(media = {}) {
  const provenance = media.watchProvenance || media.watch_provenance || {};
  return [media.event, provenance.event, provenance.source_event, provenance.sourceEvent]
    .some((event) => EXPLICIT_PLAYED_EVENT_KEYS.has(compactEventKey(event)));
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
    event: text(media.event) || undefined,
    playedFlagOnly: Boolean(media.playedFlagOnly),
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
  allowWhenUnwatched = false,
} = {}) {
  const normalizedMedia = serializableMedia(media);
  const mediaKey = mediaKeyFor(normalizedMedia);
  const source = text(normalizedMedia.source) || "unknown";
  const existing = selectReviewByMediaKeyStmt.get(mediaKey);

  // A generic provider flag arriving after an explicit local unwatch is almost
  // always the provider acknowledging the old watched state. Do not turn that
  // acknowledgement into a new manual decision. Explicit provider "Mark
  // played" events remain eligible because they carry a distinct user action.
  let currentPlaystate = null;
  try {
    currentPlaystate = getPlaystateForMediaSync(normalizedMedia);
  } catch {
    currentPlaystate = null;
  }
  const manuallyUnwatched = currentPlaystate?.state === "unwatched"
    || (!currentPlaystate && hasManualUnwatchForMedia(normalizedMedia));
  if (
    manuallyUnwatched
    && !allowWhenUnwatched
    && !isExplicitPlayedMedia(normalizedMedia)
  ) {
    return {
      queued: false,
      status: "unwatched",
      suppressed: true,
      review: existing ? rowToReview(existing) : null,
    };
  }

  const fingerprint = text(sourceFingerprint)
    || `${source}:${text(normalizedMedia.itemId)}:${text(observedWatchedAt)}:${text(releaseDate)}:${text(reason)}`;
  const now = Date.now();

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

function mediaProviderIds(media = {}) {
  const ids = media.ids || {};
  return [
    ids.imdb || media.imdb_id,
    ids.tmdb || media.tmdb_id,
    ids.tvdb || media.tvdb_id,
  ].map((value) => text(value)).filter(Boolean);
}

function mediaMatchesReview(left = {}, right = {}) {
  const leftType = text(left.type || left.media_type).toLowerCase();
  const rightType = text(right.type || right.media_type).toLowerCase();
  if (!leftType || leftType !== rightType) return false;

  if (mediaKeyFor(left) === mediaKeyFor(right)) return true;

  const rightIds = new Set(mediaProviderIds(right));
  if (mediaProviderIds(left).some((id) => rightIds.has(id))) return true;

  if (leftType === "episode") {
    const sameCoordinates = Number(left.season) === Number(right.season)
      && Number(left.episode) === Number(right.episode);
    if (!sameCoordinates) return false;
    const leftShow = canonicalShowTitleKey(showTitleFromMedia(left));
    const rightShow = canonicalShowTitleKey(showTitleFromMedia(right));
    return Boolean(leftShow && rightShow && leftShow === rightShow);
  }

  return leftType === "movie"
    && canonicalTitleKey(left.title) === canonicalTitleKey(right.title)
    && Boolean(canonicalTitleKey(left.title));
}

function watchRowMedia(row = {}) {
  return {
    title: row.title,
    showTitle: row.show_title,
    type: row.media_type,
    ids: {
      imdb: row.imdb_id,
      tmdb: row.tmdb_id,
      tvdb: row.tvdb_id,
    },
    season: row.season,
    episode: row.episode,
  };
}

function hasManualUnwatchForMedia(media = {}) {
  return selectManualUnwatchRowsStmt.all().some((row) => mediaMatchesReview(media, watchRowMedia(row)));
}

// Explicit manual unwatches should retire any review rows that refer to the
// same item. `before` keeps a provider callback that races after the click from
// being mistaken for an older pending decision; the queue guard above handles
// that callback separately.
export function dismissPendingManualWatchReviewsForMedia(media = {}, { before = Number.POSITIVE_INFINITY } = {}) {
  const normalizedMedia = serializableMedia(media);
  const now = Date.now();
  let dismissed = 0;
  for (const row of selectPendingReviewsStmt.all()) {
    const review = rowToReview(row);
    if (Number(review.updated_at || 0) > Number(before)) continue;
    if (!mediaMatchesReview(normalizedMedia, review.media)) continue;
    updateStatusStmt.run({
      id: review.id,
      status: "dismissed",
      decision_mode: "unwatched",
      updated_at: now,
      reviewed_at: now,
    });
    dismissed += 1;
  }
  return dismissed;
}

function reviewIsAlreadyWatched(review = {}) {
  try {
    const media = manualWatchReviewMedia(review);
    const playstate = getPlaystateForMediaSync(media);
    // An explicit current unwatch must win over an older watched history row;
    // only use the history fallback for legacy records with no playstate yet.
    if (playstate?.state === "watched") return true;
    // A generic/stale provider review is resolved by a local unwatch and must
    // not suddenly become visible merely because the canonical state changed
    // from watched to unwatched. Explicit provider Mark played events are the
    // exception: they represent a new user decision and may remain reviewable.
    if (playstate?.state === "unwatched") return !isExplicitPlayedMedia(media);
    if (!playstate && hasManualUnwatchForMedia(media) && !isExplicitPlayedMedia(media)) return true;
    return Boolean(findWatchedByAnyMediaKeySync(media));
  } catch {
    // A malformed legacy review should remain visible so it can be corrected
    // manually instead of disappearing because a read-only filter failed.
    return false;
  }
}
