import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, bumpDataVersion } from "../db.js";
import { getTmdbDetails } from "./tmdbGateway.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE_PATH = path.resolve(here, "..", "..", "..", "data", "tv_progress_cache.json");

let progressCache = {};
const pendingShowUpdates = new Set();
// Bump whenever the total_episodes calculation changes shape, so previously
// cached shows are refetched instead of keeping a stale total indefinitely.
const PROGRESS_CACHE_SCHEMA_VERSION = 2; // bumped: total_episodes now excludes specials (season 0)

// Pure helper functions decoupled from dataRepo.js to avoid circular dependency issues
function decodeBasicHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
}

function canonicalTitleKey(value) {
  return decodeBasicHtmlEntities(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeKeyPart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function showTitleFrom(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const stripYear = (value) => String(value || "").replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return stripYear(seasonMatch[1]) || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return stripYear(alternateMatch[1]) || "Unknown Show";
  return stripYear(text.split(" - ")[0]) || "Unknown Show";
}

function isWatchedAction(row = {}) {
  return !["unwatched", "unplayed"].includes(String(row.sync_action || "watched").toLowerCase());
}

function isScheduledLibraryHistoryRow(row = {}) {
  const telemetry = String(row.sync_dispatch_telemetry || "");
  return /Watch event fetched from (Plex|Emby|Jellyfin) library history/i.test(telemetry);
}

function isPlembfinTrackedWatchRow(row = {}) {
  return isWatchedAction(row) && !isScheduledLibraryHistoryRow(row);
}

/**
 * Titles of shows present in watch history that have no progress cache entry
 * at all yet — e.g. shows watched before this cache existed, or added outside
 * the incremental queueShowProgressUpdate() call sites.
 */
function findUncachedShowTitles() {
  const rows = db.prepare(`
    SELECT show_title, title, sync_action, sync_dispatch_telemetry
    FROM watch_history
    WHERE media_type = 'episode'
  `).all();
  const titles = new Set();
  for (const row of rows.filter(isPlembfinTrackedWatchRow)) {
    const showTitle = showTitleFrom(row.show_title || row.title);
    const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
    if (!progressCache[showKey]) titles.add(showTitle);
  }
  return titles;
}

export async function initShowProgressCache() {
  if (fs.existsSync(CACHE_FILE_PATH)) {
    try {
      const data = fs.readFileSync(CACHE_FILE_PATH, "utf8");
      progressCache = JSON.parse(data);
      const total = Object.keys(progressCache).length;
      const missingTotals = Object.values(progressCache).filter((s) => !s.total_episodes).map((s) => s.title);
      const staleSchema = Object.values(progressCache).filter((s) => (s.schema_version || 1) < PROGRESS_CACHE_SCHEMA_VERSION).map((s) => s.title);
      const uncached = findUncachedShowTitles();
      const toQueue = new Set([...missingTotals, ...staleSchema, ...uncached]);
      console.log(`[ShowProgressCache] Loaded ${total} shows from cache file.`);
      if (toQueue.size) {
        console.log(`[ShowProgressCache] Scheduling background refresh for ${toQueue.size} shows (missing total episode count, stale calculation, or never cached).`);
        setImmediate(() => {
          for (const title of toQueue) queueShowProgressUpdate(title);
          flushShowProgressUpdates().catch((e) => console.error("[ShowProgressCache] Background refresh error:", e));
        });
      }
      return;
    } catch (e) {
      console.error("[ShowProgressCache] Failed to load cache file, rebuilding...", e);
    }
  }
  await rebuildShowProgressCache();
}

/**
 * Gets cached progress details for a show key.
 */
export function getCachedShowProgress(showKey) {
  return progressCache[showKey] || null;
}

/**
 * Queues a show title for progress update.
 */
export function queueShowProgressUpdate(showTitle) {
  const title = String(showTitle || "").trim();
  if (title) {
    pendingShowUpdates.add(title);
  }
}

/**
 * Calculates show progress for a single show and updates cache in-place.
 */
async function calculateAndSetShowProgress(showTitle) {
  const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
  
  // Get all episode rows for this show from SQLite
  const rows = db.prepare(`
    SELECT season, episode, tmdb_id, sync_action, sync_dispatch_telemetry
    FROM watch_history
    WHERE media_type = 'episode' AND show_title_lower = ?
  `).all(showTitle.toLowerCase());
  
  const trackedRows = rows.filter(isPlembfinTrackedWatchRow);
  
  if (trackedRows.length === 0) {
    // If no watched episodes remain, delete from cache
    delete progressCache[showKey];
    return;
  }
  
  // Deduplicate watched episodes by season and episode number
  const uniqueEpisodes = new Set();
  let tmdbId = "";
  
  for (const row of trackedRows) {
    if (row.season != null && row.episode != null) {
      uniqueEpisodes.add(`${row.season}_${row.episode}`);
    }
    if (!tmdbId && row.tmdb_id) {
      tmdbId = row.tmdb_id;
    }
  }
  
  const watchedCount = uniqueEpisodes.size;
  
  // Retrieve total episodes count from TMDB (utilizing cached details when possible)
  let totalEpisodes = 0;
  if (tmdbId || showTitle) {
    try {
      const tmdbShow = await getTmdbDetails({ mediaType: "tv", tmdbId, title: showTitle });
      totalEpisodes = tmdbShow?.number_of_episodes || 0;
    } catch (e) {
      console.error(`[ShowProgressCache] Failed fetching TMDB total episodes for ${showTitle}:`, e.message);
    }
  }
  
  progressCache[showKey] = {
    title: showTitle,
    tmdb_id: tmdbId || "",
    episode_count: watchedCount,
    total_episodes: totalEpisodes,
    schema_version: PROGRESS_CACHE_SCHEMA_VERSION
  };
}

/**
 * Flushes all pending queued updates to the cache and writes the cache file.
 */
export async function flushShowProgressUpdates() {
  if (pendingShowUpdates.size === 0) return;
  
  const titles = [...pendingShowUpdates];
  pendingShowUpdates.clear();
  
  console.log(`[ShowProgressCache] Updating progress for ${titles.length} shows: ${titles.join(", ")}`);
  for (const title of titles) {
    await calculateAndSetShowProgress(title);
  }
  
  try {
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(progressCache, null, 2), "utf8");
    console.log("[ShowProgressCache] Saved updated progress cache to file.");
  } catch (e) {
    console.error("[ShowProgressCache] Failed to save updated progress cache:", e);
  }
  // The show list is memoized by data version — bump it so refreshed totals
  // (e.g. from the startup background refresh) are visible without waiting
  // for an unrelated watch event to invalidate the cache.
  bumpDataVersion();
}

/**
 * Full rebuild of the cache file from database.
 */
export async function rebuildShowProgressCache() {
  console.log("[ShowProgressCache] Rebuilding TV show progress cache from scratch...");
  const tempCache = {};
  
  // Get all episode rows in watch history
  const rows = db.prepare(`
    SELECT show_title, title, season, episode, tmdb_id, sync_action, sync_dispatch_telemetry
    FROM watch_history
    WHERE media_type = 'episode'
  `).all();
  
  const trackedRows = rows.filter(isPlembfinTrackedWatchRow);
  
  // Group rows by show key
  const groups = new Map();
  for (const row of trackedRows) {
    const showTitle = showTitleFrom(row.show_title || row.title);
    const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
    
    if (!groups.has(showKey)) {
      groups.set(showKey, {
        title: showTitle,
        episodes: new Set(),
        tmdbId: ""
      });
    }
    
    const group = groups.get(showKey);
    if (row.season != null && row.episode != null) {
      group.episodes.add(`${row.season}_${row.episode}`);
    }
    if (!group.tmdbId && row.tmdb_id) {
      group.tmdbId = row.tmdb_id;
    }
  }
  
  // Process groups and query TMDB
  for (const [showKey, group] of groups.entries()) {
    let totalEpisodes = 0;
    if (group.tmdbId || group.title) {
      try {
        const tmdbShow = await getTmdbDetails({ mediaType: "tv", tmdbId: group.tmdbId, title: group.title });
        totalEpisodes = tmdbShow?.number_of_episodes || 0;
      } catch (e) {
        console.error(`[ShowProgressCache] Rebuild failed fetching TMDB total episodes for ${group.title}:`, e.message);
      }
    }
    
    tempCache[showKey] = {
      title: group.title,
      tmdb_id: group.tmdbId || "",
      episode_count: group.episodes.size,
      total_episodes: totalEpisodes,
      schema_version: PROGRESS_CACHE_SCHEMA_VERSION
    };
  }
  
  progressCache = tempCache;
  try {
    const dir = path.dirname(CACHE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(progressCache, null, 2), "utf8");
    console.log(`[ShowProgressCache] Rebuilt and saved ${Object.keys(progressCache).length} shows to cache file.`);
  } catch (e) {
    console.error("[ShowProgressCache] Failed to save rebuilt progress cache:", e);
  }
}
