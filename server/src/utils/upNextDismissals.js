import crypto from "node:crypto";
import { db, bumpUpNextVersion, parseJson, toJson } from "../db.js";
import { normalizeUpNextCandidate, upNextIdentityAliases } from "./upNextIdentity.js";

// Dismissals were browser-local until this module existed, which meant the
// server's queue and the user's queue were different lists. Anything pushing
// from outside that one browser session - the API, a second device, a
// scheduled job - sent the dismissed items straight back to every media
// server. See docs/decisions.md entry 23.
const MAX_DISMISSALS = 500;

function queueAutomaticUpNextSync(reason) {
  void import("./upNextAutoSync.js")
    .then(({ requestUpNextAutoSync }) => requestUpNextAutoSync(reason))
    .catch((error) => console.error(`[up-next] Automatic sync request failed: ${error?.message || error}`));
}

const upsertStmt = db.prepare(`
  INSERT INTO up_next_dismissals
    (id, aliases_json, media_key, media_type, title, show_title, episode_title, season, episode, snapshot_json, dismissed_at)
  VALUES
    (@id, @aliases_json, @media_key, @media_type, @title, @show_title, @episode_title, @season, @episode, @snapshot_json, @dismissed_at)
  ON CONFLICT(id) DO UPDATE SET
    aliases_json = excluded.aliases_json,
    media_key = excluded.media_key,
    media_type = excluded.media_type,
    title = excluded.title,
    show_title = excluded.show_title,
    episode_title = excluded.episode_title,
    season = excluded.season,
    episode = excluded.episode,
    snapshot_json = excluded.snapshot_json,
    dismissed_at = excluded.dismissed_at
`);
const selectAllStmt = db.prepare("SELECT * FROM up_next_dismissals ORDER BY dismissed_at DESC");
const deleteStmt = db.prepare("DELETE FROM up_next_dismissals WHERE id = ?");
const deleteAllStmt = db.prepare("DELETE FROM up_next_dismissals");
const trimStmt = db.prepare(`
  DELETE FROM up_next_dismissals
   WHERE id IN (SELECT id FROM up_next_dismissals ORDER BY dismissed_at DESC LIMIT -1 OFFSET ?)
`);

function text(value = "") {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// An episode keeps its identity across re-matches and provider id changes, so
// the coordinate is stored alongside the provider aliases. Without it a
// dismissal would be lost the moment the item's native id changed.
function coordinateAlias(item = {}) {
  const showTitle = text(item.show_title || item.showTitle)
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const season = number(item.season);
  const episode = number(item.episode);
  if (!showTitle || season === null || episode === null) return "";
  return `coordinate:${showTitle}:s${season}:e${episode}`;
}

export function dismissalAliases(item = {}) {
  const candidate = normalizeUpNextCandidate(item);
  const aliases = new Set(upNextIdentityAliases(candidate));
  for (const key of [item.id, item.media_key, item.mediaKey]) {
    const value = text(key);
    if (value) aliases.add(`key:${value.toLowerCase()}`);
  }
  const providerItems = item.provider_items || item.providerItems || {};
  for (const [provider, values] of Object.entries(providerItems)) {
    for (const value of (Array.isArray(values) ? values : [values])) {
      const id = text(value);
      if (id) aliases.add(`provider:${String(provider).toLowerCase()}:${id.toLowerCase()}`);
    }
  }
  const coordinate = coordinateAlias(item);
  if (coordinate) aliases.add(coordinate);
  return [...aliases].filter(Boolean);
}

export function recordUpNextDismissal(item = {}, { now = Date.now() } = {}) {
  const aliases = dismissalAliases(item);
  if (!aliases.length) return null;
  const id = text(item.dismissal_id) || crypto.randomUUID();
  const row = {
    id,
    aliases_json: toJson(aliases),
    media_key: text(item.media_key || item.mediaKey) || null,
    media_type: text(item.media_type || item.mediaType) || null,
    title: text(item.title) || null,
    show_title: text(item.show_title || item.showTitle) || null,
    episode_title: text(item.episode_title || item.episodeTitle) || null,
    season: number(item.season),
    episode: number(item.episode),
    snapshot_json: toJson(item),
    dismissed_at: Number(now) || Date.now(),
  };
  // One dismissal per identity: re-dismissing an item that already has a row
  // under an overlapping alias replaces it rather than accumulating rows that
  // all resolve to the same card.
  const existing = findDismissalByAliases(aliases);
  db.transaction(() => {
    if (existing && existing.id !== id) deleteStmt.run(existing.id);
    upsertStmt.run(row);
    trimStmt.run(MAX_DISMISSALS);
  }).immediate();
  bumpUpNextVersion();
  queueAutomaticUpNextSync("Up Next dismissal changed");
  return id;
}

function rowToDismissal(row) {
  return {
    id: row.id,
    aliases: parseJson(row.aliases_json, []) || [],
    media_key: row.media_key || "",
    media_type: row.media_type || "",
    title: row.title || "",
    show_title: row.show_title || "",
    episode_title: row.episode_title || "",
    season: row.season,
    episode: row.episode,
    snapshot: parseJson(row.snapshot_json, {}) || {},
    dismissed_at: Number(row.dismissed_at || 0),
  };
}

export function listUpNextDismissals() {
  return selectAllStmt.all().map(rowToDismissal);
}

function findDismissalByAliases(aliases = []) {
  const wanted = new Set(aliases);
  if (!wanted.size) return null;
  for (const row of selectAllStmt.all()) {
    const stored = parseJson(row.aliases_json, []) || [];
    if (stored.some((alias) => wanted.has(alias))) return rowToDismissal(row);
  }
  return null;
}

export function restoreUpNextDismissal(id) {
  const key = text(id);
  if (!key) return false;
  const removed = deleteStmt.run(key).changes > 0;
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("Up Next dismissal restored");
  }
  return removed;
}

export function restoreAllUpNextDismissals() {
  const removed = deleteAllStmt.run().changes;
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("All Up Next dismissals restored");
  }
  return removed;
}

// Returns a predicate rather than testing one item at a time: the projection
// checks every candidate, and re-reading and re-parsing the table for each one
// turns a cheap filter into a per-item table scan.
export function createUpNextDismissalFilter() {
  const dismissals = listUpNextDismissals();
  if (!dismissals.length) {
    return { isDismissed: () => false, dismissedAt: () => 0, count: 0 };
  }
  const byAlias = new Map();
  for (const dismissal of dismissals) {
    for (const alias of dismissal.aliases) {
      const existing = byAlias.get(alias);
      if (!existing || dismissal.dismissed_at > existing.dismissed_at) byAlias.set(alias, dismissal);
    }
  }
  const lookup = (candidate) => {
    for (const alias of dismissalAliases(candidate)) {
      const hit = byAlias.get(alias);
      if (hit) return hit;
    }
    return null;
  };
  return {
    count: dismissals.length,
    dismissedAt: (candidate) => lookup(candidate)?.dismissed_at || 0,
    isDismissed: (candidate) => Boolean(lookup(candidate)),
    match: lookup,
  };
}
