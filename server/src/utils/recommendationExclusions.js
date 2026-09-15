import { db } from "../db.js";

const MAX_EXCLUSIONS = 1000;

const upsertStmt = db.prepare(`
  INSERT INTO recommendation_exclusions (media_type, tmdb_id, title, excluded_at)
  VALUES (@media_type, @tmdb_id, @title, @excluded_at)
  ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
    title = excluded.title,
    excluded_at = excluded.excluded_at
`);
const selectAllStmt = db.prepare("SELECT media_type, tmdb_id, title, excluded_at FROM recommendation_exclusions ORDER BY excluded_at DESC");
const trimStmt = db.prepare(`
  DELETE FROM recommendation_exclusions
   WHERE rowid IN (
     SELECT rowid FROM recommendation_exclusions
      ORDER BY excluded_at DESC
      LIMIT -1 OFFSET ?
   )
`);

function text(value = "") {
  return String(value ?? "").trim();
}

function normalizeMediaType(value) {
  const type = text(value).toLowerCase();
  return type === "tv" || type === "show" || type === "series" ? "tv" : type === "movie" ? "movie" : "";
}

function normalizeTmdbId(value) {
  const id = text(value);
  return /^\d+$/.test(id) ? id : "";
}

export function normalizeRecommendationExclusion(input = {}) {
  const media_type = normalizeMediaType(input.media_type || input.mediaType || input.type);
  const tmdb_id = normalizeTmdbId(input.tmdb_id || input.tmdbId || input.id);
  if (!media_type || !tmdb_id) return null;
  return {
    media_type,
    tmdb_id,
    title: text(input.title || input.name),
  };
}

export function recommendationExclusionKey(input = {}) {
  const normalized = normalizeRecommendationExclusion(input);
  return normalized ? `${normalized.media_type}:${normalized.tmdb_id}` : "";
}

export function listRecommendationExclusions() {
  return selectAllStmt.all().map((row) => ({
    media_type: row.media_type,
    tmdb_id: row.tmdb_id,
    title: row.title || "",
    excluded_at: Number(row.excluded_at || 0),
  }));
}

export function createRecommendationExclusion(input = {}, { now = Date.now() } = {}) {
  const normalized = normalizeRecommendationExclusion(input);
  if (!normalized) return null;
  const excluded_at = Number(now) || Date.now();
  db.transaction(() => {
    upsertStmt.run({ ...normalized, excluded_at });
    trimStmt.run(MAX_EXCLUSIONS);
  }).immediate();
  return { ...normalized, excluded_at };
}

export function filterExcludedRecommendations(payload = {}, exclusions = listRecommendationExclusions()) {
  const excludedKeys = new Set((Array.isArray(exclusions) ? exclusions : [])
    .map(recommendationExclusionKey)
    .filter(Boolean));
  if (!excludedKeys.size) return payload;
  return {
    ...payload,
    results: (payload.results || []).filter((item) => !excludedKeys.has(recommendationExclusionKey({
      media_type: item.media_type,
      tmdb_id: item.id || item.tmdb_id,
    }))),
  };
}
