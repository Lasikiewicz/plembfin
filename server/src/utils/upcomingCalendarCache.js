import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../paths.js";
import { getCachedShows } from "./dataRepo.js";
import { getTmdbDetails } from "./tmdbGateway.js";
import { getTvdbSeasonEpisodes } from "./tvdbGateway.js";
import { cachedNextAiringFor, readNextAiringCache } from "./nextAiringCache.js";

const CACHE_VERSION = 1;
const CACHE_FILE = path.join(DATA_DIR, "upcoming-calendar-cache.json");
const TEMP_FILE = `${CACHE_FILE}.tmp`;
const FUTURE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_MONTHS = 60;
const BACKGROUND_HISTORY_MONTHS = 24;
const BACKGROUND_FUTURE_MONTHS = 12;
const UPCOMING_CONCURRENCY = 4;

let memoryCache = null;
let writeChain = Promise.resolve();
const buildsInFlight = new Map();
const checkedAtByMonth = new Map();
let preferHistoricalBuild = true;

function emptyCache() {
  return { version: CACHE_VERSION, updatedAt: 0, months: {} };
}

async function readCache() {
  if (memoryCache) return memoryCache;
  try {
    const parsed = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
    memoryCache = {
      version: CACHE_VERSION,
      updatedAt: Number(parsed?.updatedAt || 0),
      months: parsed?.months && typeof parsed.months === "object" ? parsed.months : {},
    };
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Failed to read upcoming calendar cache", error);
    memoryCache = emptyCache();
  }
  return memoryCache;
}

function trimMonths(months) {
  const entries = Object.entries(months);
  if (entries.length <= CACHE_MAX_MONTHS) return months;
  entries.sort((a, b) => Number(b[1]?.builtAt || 0) - Number(a[1]?.builtAt || 0));
  return Object.fromEntries(entries.slice(0, CACHE_MAX_MONTHS));
}

async function storeMonth(month, payload, showKeys) {
  let changed = false;
  writeChain = writeChain.catch(() => {}).then(async () => {
    const cache = await readCache();
    const existing = cache.months[month];
    const normalizedKeys = [...new Set(showKeys)].sort();
    if (JSON.stringify(existing?.payload) === JSON.stringify(payload)
      && JSON.stringify(existing?.showKeys || []) === JSON.stringify(normalizedKeys)) return;
    const now = Date.now();
    const next = {
      version: CACHE_VERSION,
      updatedAt: now,
      months: trimMonths({ ...cache.months, [month]: { builtAt: now, showKeys: normalizedKeys, payload } }),
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TEMP_FILE, JSON.stringify(next), "utf8");
    await fs.rename(TEMP_FILE, CACHE_FILE);
    memoryCache = next;
    changed = true;
  });
  await writeChain;
  return changed;
}

function monthBounds(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function showKey(show) {
  return String(show?.tmdb_id || "").trim();
}

function uniqueTrackedShows(shows) {
  const seen = new Set();
  return shows.filter((show) => {
    const key = showKey(show);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortAndDedupeEpisodes(episodes) {
  const seen = new Set();
  return episodes.filter((episode) => {
    const key = [episode.airDate, episode.tmdbId, episode.showId, episode.season, episode.episode].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.airDate.localeCompare(b.airDate)
    || a.showTitle.localeCompare(b.showTitle)
    || a.season - b.season
    || a.episode - b.episode);
}

async function collectMonth(month, { shows: suppliedShows = null, prefilterFuture = true } = {}) {
  const { start, end } = monthBounds(month);
  const thisMonth = currentMonth();
  const isHistoricalMonth = month < thisMonth;
  const includesHistory = month <= thisMonth;
  const [allShows, airingCache] = await Promise.all([suppliedShows || getCachedShows(), readNextAiringCache()]);
  const trackedShows = uniqueTrackedShows(allShows);
  const queue = trackedShows.filter((show) => {
    if (!includesHistory && prefilterFuture) {
      const entry = cachedNextAiringFor(airingCache.entries, show.tmdb_id, show.title);
      if (!entry?.nextAiringDate || entry.nextAiringDate > end) return false;
    }
    return true;
  });

  const episodes = [];
  async function worker() {
    for (let show = queue.shift(); show; show = queue.shift()) {
      const details = await getTmdbDetails({ mediaType: "tv", tmdbId: show.tmdb_id, title: show.title, ids: { tvdbId: show.tvdb_id } }).catch(() => null);
      const tvdbId = String(details?.external_ids?.tvdb_id || show.tvdb_id || "");
      if (!tvdbId) continue;
      const maxSeason = Math.max(0, ...(details?.seasons || []).map((season) => Number(season.season_number) || 0));
      const seasonNumbers = isHistoricalMonth
        ? [...new Set((details?.seasons || []).map((season) => Number(season.season_number) || 0))].filter((value) => value > 0)
        : [...new Set([maxSeason, maxSeason + 1])].filter((value) => value > 0);
      for (const seasonNumber of seasonNumbers) {
        const season = await getTvdbSeasonEpisodes({ tvdbId, seasonNumber }).catch(() => null);
        for (const episode of season?.episodes || []) {
          const airDate = String(episode.air_date || "");
          if (!airDate || airDate < start || airDate > end) continue;
          episodes.push({
            airDate,
            showTitle: show.title,
            showId: show.id,
            tmdbId: String(show.tmdb_id),
            tvdbId,
            posterUrl: show.poster_url || "",
            posterRecordId: show.representative_episode?.id || "",
            season: seasonNumber,
            episode: Number(episode.episode_number) || 0,
            episodeTitle: episode.name || "",
            status: details?.status || show.status || "",
          });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(UPCOMING_CONCURRENCY, queue.length)) }, worker));

  return {
    payload: { month, start, end, episodes: sortAndDedupeEpisodes(episodes) },
    showKeys: trackedShows.map(showKey),
  };
}

async function buildAndStoreMonth(month) {
  if (buildsInFlight.has(month)) return buildsInFlight.get(month);
  const promise = collectMonth(month)
    .then(async ({ payload, showKeys }) => {
      const changed = await storeMonth(month, payload, showKeys);
      return { payload, changed };
    })
    .finally(() => buildsInFlight.delete(month));
  buildsInFlight.set(month, promise);
  return promise;
}

export async function getUpcomingCalendarMonth(month) {
  const cache = await readCache();
  const entry = cache.months[month];
  if (!entry?.payload) return (await buildAndStoreMonth(month)).payload;

  // Library-derived shows can change at any time. Add only newly tracked shows
  // to an existing month so the calendar updates immediately without rebuilding
  // every show and season already represented in the local cache.
  const trackedShows = uniqueTrackedShows(await getCachedShows());
  const covered = new Set(entry.showKeys || []);
  const missingShows = trackedShows.filter((show) => !covered.has(showKey(show)));
  if (!missingShows.length) return entry.payload;
  const addition = await collectMonth(month, { shows: missingShows, prefilterFuture: false });
  const payload = {
    ...entry.payload,
    episodes: sortAndDedupeEpisodes([...(entry.payload.episodes || []), ...addition.payload.episodes]),
  };
  await storeMonth(month, payload, [...covered, ...trackedShows.map(showKey)]);
  return payload;
}

export async function refreshUpcomingCalendarCache() {
  const cache = await readCache();
  const anchor = currentMonth();
  const historicalMonths = Array.from({ length: BACKGROUND_HISTORY_MONTHS }, (_, index) => addMonths(anchor, -(index + 1)));
  const futureMonths = Array.from({ length: BACKGROUND_FUTURE_MONTHS + 1 }, (_, index) => addMonths(anchor, index));
  const missingHistorical = historicalMonths.find((month) => !cache.months[month]);
  const missingFuture = futureMonths.find((month) => !cache.months[month]);
  let month;
  if (!cache.months[anchor]) month = anchor;
  else if (missingHistorical && missingFuture) {
    month = preferHistoricalBuild ? missingHistorical : missingFuture;
    preferHistoricalBuild = !preferHistoricalBuild;
  } else {
    month = missingHistorical || missingFuture;
  }
  if (!month) {
    month = futureMonths
      .filter((candidate) => Date.now() - Number(checkedAtByMonth.get(candidate) || cache.months[candidate]?.builtAt || 0) >= FUTURE_CHECK_INTERVAL_MS)
      .sort((a, b) => Number(checkedAtByMonth.get(a) || cache.months[a]?.builtAt || 0)
        - Number(checkedAtByMonth.get(b) || cache.months[b]?.builtAt || 0))[0];
  }
  if (!month) return { refreshed: 0 };
  console.log(`Upcoming calendar cache refresh: checking ${month}...`);
  const result = await buildAndStoreMonth(month);
  checkedAtByMonth.set(month, Date.now());
  console.log(`Upcoming calendar cache refresh complete: ${month}, ${result.payload.episodes.length} episode${result.payload.episodes.length === 1 ? "" : "s"}${result.changed ? ", cache updated" : ", unchanged"}.`);
  return { refreshed: 1, changed: result.changed, month, episodes: result.payload.episodes.length };
}
