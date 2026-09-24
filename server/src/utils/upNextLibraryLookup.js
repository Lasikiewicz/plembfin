import {
  fetchPlexMetadataItem,
  fetchPlexSeriesEpisodes,
  findPlexItem,
} from "./plexClient.js";
import {
  fetchEmbyItemRuntimeMs,
  fetchEmbySeriesEpisodes,
  findEmbyItems,
} from "./embyClient.js";
import {
  fetchJellyfinItemRuntimeMs,
  fetchJellyfinSeriesEpisodes,
  findJellyfinItems,
} from "./jellyfinClient.js";
import { runWithConcurrency } from "./concurrency.js";
import { db } from "../db.js";

const PROVIDERS = ["plex", "emby", "jellyfin"];
// A resolved library item is stable: the same episode keeps its ratingKey/Id
// until the library is rebuilt. A miss is far more volatile - it is usually an
// episode that has not been downloaded yet - so it is retried far sooner.
const RESOLVED_TTL_MS = 6 * 60 * 60 * 1000;
const MISSING_TTL_MS = 15 * 60 * 1000;
// Cap direct episode-item lookups so a cold cache cannot turn a dashboard
// refresh into a burst of provider searches. Full-series inventory lookups
// are separately cached and run through the projection's bounded worker pool.
const MAX_LOOKUPS_PER_BUILD = 32;
const MAX_CACHE_ENTRIES = 2000;
const EPISODE_INVENTORY_TTL_MS = 5 * 60 * 1000;
// A failed lookup is not cached (it is not evidence the episode is absent), so
// without a backoff every projection rebuild during an outage re-ran every
// lookup against the unreachable server: about 2,800 failed Jellyfin requests,
// each logged with a stack trace, in a few minutes. Stand the provider down for
// about one scheduler tick after a failure; cached answers are still used.
const PROVIDER_OUTAGE_BACKOFF_MS = 60 * 1000;
// Resolved answers are also kept in SQLite, read only when the provider cannot
// answer. The in-memory cache is empty after a restart, so restarting during a
// Jellyfin outage dropped every local next-up card only Jellyfin could prove
// (The Assembly S01E01) and the Jellyfin ids of others until it came back
// (defect V). A remembered id is the last thing the library itself said; a
// live answer replaces it, and a live "missing" deletes it.
const REMEMBERED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REMEMBERED_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastRememberedPrune = 0;

const lookupCache = new Map();
const episodeInventoryCache = new Map();
const providerOutages = new Map();
let outageNow = () => Date.now();

function outageKey(provider, config) {
  return `${provider}:${text(config?.[provider]?.baseUrl).toLowerCase()}`;
}

function providerInOutage(provider, config) {
  const key = outageKey(provider, config);
  const until = providerOutages.get(key);
  if (!until) return false;
  if (outageNow() < until) return true;
  providerOutages.delete(key);
  return false;
}

function recordProviderOutage(provider, config) {
  providerOutages.set(outageKey(provider, config), outageNow() + PROVIDER_OUTAGE_BACKOFF_MS);
}

function clearProviderOutage(provider, config) {
  providerOutages.delete(outageKey(provider, config));
}

export function __setUpNextLibraryLookupNow(fn) {
  outageNow = typeof fn === "function" ? fn : () => Date.now();
}

function text(value = "") {
  return String(value ?? "").trim();
}

function providerIdValues(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((entry) => {
    if (entry && typeof entry === "object") return text(entry.id || entry.Id || entry.ratingKey || entry.provider_item_id);
    return text(entry);
  }).filter(Boolean);
}

function requestedProviderIds(item = {}, provider) {
  const source = item.provider_items || item.providerItems || {};
  const direct = providerIdValues(source[provider]);
  const sourceProvider = text(item.provider || item.source).toLowerCase();
  const sourceId = text(item.provider_item_id || item.providerItemId);
  if (sourceProvider === provider && sourceId) direct.push(sourceId);
  return [...new Set(direct)];
}

// Build the media descriptor the Plex/Emby lookup helpers expect from an Up
// Next item. Shared by the authoritative playlist push and the projection's
// local fallback so both resolve an episode the same way.
export function upNextLookupMedia(item = {}) {
  const type = text(item.media_type || item.mediaType).toLowerCase();
  const mediaType = type === "movie" ? "movie" : type === "episode" ? "episode" : "";
  const isEpisode = mediaType === "episode";
  const showIds = {
    imdb: text(item.show_imdb_id || item.showImdbId),
    tmdb: text(item.show_tmdb_id || item.showTmdbId),
    tvdb: text(item.show_tvdb_id || item.showTvdbId),
  };
  const episodeIds = {
    imdb: text(item.episode_imdb_id || item.episodeImdbId),
    tmdb: text(item.episode_tmdb_id || item.episodeTmdbId),
    tvdb: text(item.episode_tvdb_id || item.episodeTvdbId),
  };
  const fallbackIds = {
    imdb: text(item.imdb_id || item.imdbId || item.imdb),
    tmdb: text(item.tmdb_id || item.tmdbId || item.tmdb),
    tvdb: text(item.tvdb_id || item.tvdbId || item.tvdb),
  };
  return {
    type: mediaType,
    media_type: mediaType,
    title: text(item.title || item.episode_title || item.show_title),
    show_title: text(item.show_title || item.showTitle),
    season: item.season === "" || item.season == null ? undefined : Number(item.season),
    episode: item.episode === "" || item.episode == null ? undefined : Number(item.episode),
    // Episode lookup needs the series identity. The episode ids remain on the
    // object as well for clients that can use them, but must not be promoted
    // to a series id when the show ids are available.
    ids: isEpisode
      ? {
        imdb: showIds.imdb || fallbackIds.imdb,
        tmdb: showIds.tmdb || fallbackIds.tmdb,
        tvdb: showIds.tvdb || fallbackIds.tvdb,
      }
      : fallbackIds,
    show_imdb_id: showIds.imdb,
    show_tmdb_id: showIds.tmdb,
    show_tvdb_id: showIds.tvdb,
    episode_imdb_id: episodeIds.imdb || (isEpisode ? fallbackIds.imdb : ""),
    episode_tmdb_id: episodeIds.tmdb || (isEpisode ? fallbackIds.tmdb : ""),
    episode_tvdb_id: episodeIds.tvdb || (isEpisode ? fallbackIds.tvdb : ""),
    provider_items: item.provider_items || item.providerItems || {},
    provider_item_id: text(item.provider_item_id || item.providerItemId),
  };
}

function runtimeMsOf(provider, result) {
  if (!result) return 0;
  if (provider === "plex") return Math.max(0, Math.round(Number(result.duration) || 0));
  const ticks = Number(result.RunTimeTicks ?? result.runTimeTicks ?? 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

export async function resolveUpNextProviderItemId(provider, config, item) {
  const direct = requestedProviderIds(item, provider);
  if (direct.length) return { providerItemId: direct[0], direct: true, runtimeMs: 0 };

  const media = upNextLookupMedia(item);
  if (!media.type || !media.title) return { providerItemId: "", reason: "The Up Next item has no usable media identity." };
  const result = provider === "plex"
    ? await findPlexItem(config, media)
    : provider === "jellyfin"
      ? (await findJellyfinItems(config, media))[0]
      : (await findEmbyItems(config, media))[0];
  const providerItemId = provider === "plex"
    ? text(result?.ratingKey)
    : text(result?.Id || result?.id);
  if (!providerItemId) return { providerItemId: "", reason: "The item was not found in the provider library." };
  return { providerItemId, direct: false, runtimeMs: runtimeMsOf(provider, result) };
}

// An item resolved straight from a stored provider id never passes through a
// search result, so it arrives with no runtime. Fetch it for playlist and
// native-rail diagnostics that need the provider's confirmed item metadata.
// Cached for the process lifetime: an episode's runtime does not change.
const runtimeCache = new Map();

async function providerRuntimeMs(provider, config, providerItemId) {
  const key = `${provider}:${text(config?.baseUrl).toLowerCase()}:${providerItemId}`;
  if (runtimeCache.has(key)) return runtimeCache.get(key);
  let runtimeMs = 0;
  try {
    if (provider === "plex") {
      const item = await fetchPlexMetadataItem(config, providerItemId, { lane: "interactive" });
      runtimeMs = Math.max(0, Math.round(Number(item?.duration) || 0));
    } else if (provider === "jellyfin") {
      runtimeMs = await fetchJellyfinItemRuntimeMs(config, providerItemId);
    } else {
      runtimeMs = await fetchEmbyItemRuntimeMs(config, providerItemId);
    }
  } catch {
    // Without a runtime the seed reports the item as skipped, which is the
    // correct outcome; it must not fail the whole push.
    runtimeMs = 0;
  }
  if (runtimeMs > 0) runtimeCache.set(key, runtimeMs);
  return runtimeMs;
}

// One resolution pass per provider per push, shared by the playlist
// reconciliation and native calculated-rail refresh.
//
// They used to resolve independently, and the two passes disagreed: a lookup
// that timed out during the playlist pass succeeded seconds later for the
// seed, so the Plex playlist kept a stale entry and missed two items that the
// seed had no trouble finding. Resolving once removes the disagreement, the
// shared cache makes the retry cheap, and carrying the resolved item through
// gives the seed the runtime it needs to size a position the provider will
// actually keep.
export async function resolveUpNextProviderTargets({
  provider,
  config,
  items = [],
  limit = 100,
  concurrency = 4,
} = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, limit);
  const outcomes = Array(list.length);
  await runWithConcurrency(list, async (item, index) => {
    const attempt = async () => resolveUpNextProviderItemId(provider, config, item);
    let target = null;
    let failure = "";
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        target = await attempt();
        if (target.providerItemId) break;
        failure = target.reason || "Provider item was not resolved.";
        // A clean "not in this library" answer is final; only retry the
        // transient case, which is what a timeout looks like here.
        if (!/timed out|timeout|failed|reset|refused/i.test(failure)) break;
      } catch (error) {
        failure = text(error?.message || error) || "Provider item lookup failed.";
        if (!/timed out|timeout|fetch failed|reset|refused/i.test(failure)) break;
      }
    }
    if (!target?.providerItemId) {
      outcomes[index] = { title: text(item?.title || item?.show_title || "Untitled"), reason: failure || "Provider item was not resolved." };
      return;
    }
    let runtimeMs = Math.max(
      Number(target.runtimeMs || 0),
      Math.max(0, Math.round(Number(item?.duration_ms ?? item?.durationMs) || 0)),
    );
    if (runtimeMs <= 0) runtimeMs = await providerRuntimeMs(provider, config, target.providerItemId);
    outcomes[index] = { item, providerItemId: target.providerItemId, runtimeMs };
  }, concurrency);

  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (!outcome.providerItemId) {
      unresolved.push(outcome);
      continue;
    }
    if (seen.has(outcome.providerItemId)) continue;
    seen.add(outcome.providerItemId);
    resolved.push(outcome);
  }
  return { provider, resolved, unresolved };
}

function configuredProvider(config, provider) {
  const section = config?.[provider] || {};
  if (section.disabled) return false;
  if (provider === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && (section.apiKey || section.api_key || section.token) && section.userId);
}

function cacheKey(provider, config, media) {
  const base = text(config?.[provider]?.baseUrl).toLowerCase();
  const ids = [media.show_imdb_id, media.show_tmdb_id, media.show_tvdb_id]
    .map((value) => text(value).toLowerCase())
    .join("|");
  const title = text(media.show_title || media.title).toLowerCase();
  const season = media.season == null ? "" : media.season;
  const episode = media.episode == null ? "" : media.episode;
  return `${provider}:${base}:${ids}:${title}:s${season}e${episode}`;
}

function readCache(key) {
  const entry = lookupCache.get(key);
  if (!entry) return null;
  const ttl = entry.providerItemId ? RESOLVED_TTL_MS : MISSING_TTL_MS;
  if (Date.now() - entry.at >= ttl) {
    lookupCache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key, providerItemId) {
  if (lookupCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest !== undefined) lookupCache.delete(oldest);
  }
  lookupCache.set(key, { at: Date.now(), providerItemId });
}

function rememberAnswer(key, provider, providerItemId) {
  const now = Date.now();
  try {
    if (providerItemId) {
      db.prepare(`
        INSERT INTO up_next_library_items (lookup_key, provider, provider_item_id, resolved_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(lookup_key) DO UPDATE SET
          provider_item_id = excluded.provider_item_id,
          resolved_at = excluded.resolved_at
      `).run(key, provider, providerItemId, now);
    } else {
      db.prepare("DELETE FROM up_next_library_items WHERE lookup_key = ?").run(key);
    }
    if (now - lastRememberedPrune >= REMEMBERED_PRUNE_INTERVAL_MS) {
      lastRememberedPrune = now;
      db.prepare("DELETE FROM up_next_library_items WHERE resolved_at < ?").run(now - REMEMBERED_TTL_MS);
    }
  } catch (error) {
    console.error(`[up-next] Could not remember a library lookup: ${error?.message || error}`);
  }
}

function rememberedAnswer(key) {
  try {
    const row = db.prepare(
      "SELECT provider_item_id FROM up_next_library_items WHERE lookup_key = ? AND resolved_at >= ?",
    ).get(key, Date.now() - REMEMBERED_TTL_MS);
    return text(row?.provider_item_id);
  } catch {
    return "";
  }
}

export function clearUpNextLibraryLookupCache() {
  lookupCache.clear();
  episodeInventoryCache.clear();
  runtimeCache.clear();
  providerOutages.clear();
}

function providerEpisodeId(provider, episode = {}) {
  return text(provider === "plex" ? (episode.ratingKey || episode.key) : episode.Id || episode.id);
}

function providerEpisodeCoordinate(provider, episode = {}) {
  const season = Number(provider === "plex" ? episode.parentIndex : episode.ParentIndexNumber);
  const number = Number(provider === "plex" ? episode.index : episode.IndexNumber);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(number) || number < 1) return null;
  return { season, episode: number };
}

function providerEpisodeTitle(provider, episode = {}) {
  return text(provider === "plex" ? episode.title : episode.Name || episode.name || episode.Title || episode.title);
}

function providerEpisodeAirDate(provider, episode = {}) {
  return text(provider === "plex"
    ? episode.originallyAvailableAt || episode.originallyAvailableAtUtc
    : episode.PremiereDate || episode.PremiereDateUtc || episode.premiereDate);
}

function providerSeriesEpisodes(provider, config, media) {
  if (provider === "plex") return fetchPlexSeriesEpisodes(config.plex, media);
  if (provider === "emby") return fetchEmbySeriesEpisodes(config.emby, media);
  return fetchJellyfinSeriesEpisodes(config.jellyfin, media);
}

function providerInventoryKey(provider, config, show = {}) {
  const ids = [show.imdb_id, show.tmdb_id, show.tvdb_id].map((value) => text(value).toLowerCase()).join("|");
  return `${provider}:${text(config?.[provider]?.baseUrl).toLowerCase()}:${ids}:${text(show.title).toLowerCase()}`;
}

// A new episode can exist in a configured media-server library before the
// cached TMDB/TVDB season list knows about it. In that window an episode-level
// lookup has no coordinate to search for. Keep a short-lived series inventory
// snapshot so the Up Next projection can discover the first available episode
// after the user's canonical watched history without turning every dashboard
// refresh into a full provider scan.
export function createUpNextLibraryEpisodeLookup(config = {}) {
  const providers = PROVIDERS.filter((provider) => configuredProvider(config, provider));
  if (!providers.length) return null;

  return async function resolveProviderEpisodes(show = {}) {
    const media = upNextLookupMedia({
      media_type: "episode",
      title: show.title,
      show_title: show.title,
      show_imdb_id: show.imdb_id,
      show_tmdb_id: show.tmdb_id,
      show_tvdb_id: show.tvdb_id,
    });
    if (!media.title || !media.show_title) return [];

    const results = await Promise.all(providers.map(async (provider) => {
      const key = providerInventoryKey(provider, config, show);
      const cached = episodeInventoryCache.get(key);
      if (cached && Date.now() - cached.at < EPISODE_INVENTORY_TTL_MS) return cached.episodes;
      if (providerInOutage(provider, config)) return [];
      try {
        const rawEpisodes = await providerSeriesEpisodes(provider, config, media);
        clearProviderOutage(provider, config);
        const episodes = (Array.isArray(rawEpisodes) ? rawEpisodes : [])
          .map((episode) => {
            const coordinate = providerEpisodeCoordinate(provider, episode);
            const providerItemId = providerEpisodeId(provider, episode);
            if (!coordinate || !providerItemId) return null;
            return {
              queue_kind: "next_up",
              media_type: "episode",
              title: `${show.title} - S${String(coordinate.season).padStart(2, "0")}E${String(coordinate.episode).padStart(2, "0")}`,
              show_title: show.title,
              episode_title: providerEpisodeTitle(provider, episode),
              season: coordinate.season,
              episode: coordinate.episode,
              show_ids: {
                imdb: text(show.imdb_id),
                tmdb: text(show.tmdb_id),
                tvdb: text(show.tvdb_id),
              },
              provider_items: { [provider]: [providerItemId] },
              provider: provider,
              source: provider,
              air_date: providerEpisodeAirDate(provider, episode),
            };
          })
          .filter(Boolean);
        if (episodeInventoryCache.size >= MAX_CACHE_ENTRIES) {
          const oldest = episodeInventoryCache.keys().next().value;
          if (oldest !== undefined) episodeInventoryCache.delete(oldest);
        }
        episodeInventoryCache.set(key, { at: Date.now(), episodes });
        return episodes;
      } catch {
        // A failed inventory is not evidence that the show is absent. Do not
        // cache failures, so the next projection can retry after an outage.
        recordProviderOutage(provider, config);
        return [];
      }
    }));
    return results.flat();
  };
}

// Local history plus TMDB metadata is enough to know which episode comes next,
// but not enough to prove that episode exists in a configured library, and a
// card for an episode nobody can play is worse than no card. Watch history
// only carries a native item id once something has been played, so an
// unwatched next episode never has one - which is why Reacher S04E07 could be
// in Plex, Emby, and Plembfin's own show detail and still be missing from Up
// Next. Ask the library directly instead, with the same lookup the
// authoritative push already uses, and cache both answers.
//
// Returns null when no supported provider is configured, so the caller keeps
// its offline behavior instead of silently dropping every fallback candidate.
//
// With `{ detailed: true }` it returns `{ providerItems, unanswered }`, where
// `unanswered` lists the providers that were not asked (budget, outage) or
// failed. A missing id from a provider not in that list is a real "not in this
// library" answer.
export function createUpNextLibraryLookup(config = {}) {
  const providers = PROVIDERS.filter((provider) => configuredProvider(config, provider));
  if (!providers.length) return null;
  let budget = MAX_LOOKUPS_PER_BUILD;

  return async function resolveProviderItems(candidate, { detailed = false, only = null } = {}) {
    // `only` limits the lookup to named providers, so a caller filling a gap
    // does not spend the build budget re-asking providers it already has.
    const asked = Array.isArray(only) ? providers.filter((provider) => only.includes(provider)) : providers;
    const media = upNextLookupMedia(candidate);
    if (!media.type || !media.title) return detailed ? { providerItems: {}, unanswered: [...asked] } : {};
    const providerItems = {};
    const unanswered = [];
    for (const provider of asked) {
      const key = cacheKey(provider, config, media);
      const cached = readCache(key);
      if (cached) {
        if (cached.providerItemId) providerItems[provider] = [cached.providerItemId];
        continue;
      }
      // An unreachable provider still counts as unanswered, but its last
      // resolved id (from before a restart) keeps the card it proved.
      const useRemembered = () => {
        const remembered = rememberedAnswer(key);
        if (remembered) providerItems[provider] = [remembered];
        unanswered.push(provider);
      };
      if (providerInOutage(provider, config)) {
        useRemembered();
        continue;
      }
      if (budget <= 0) {
        unanswered.push(provider);
        continue;
      }
      budget -= 1;
      try {
        const { providerItemId } = await resolveUpNextProviderItemId(provider, config[provider], candidate);
        clearProviderOutage(provider, config);
        writeCache(key, providerItemId);
        // A direct stored id is returned unverified; only a library answer
        // is worth remembering.
        if (!media.provider_item_id && !Object.keys(media.provider_items || {}).length) {
          rememberAnswer(key, provider, providerItemId);
        }
        if (providerItemId) providerItems[provider] = [providerItemId];
      } catch {
        // A provider that cannot answer right now is not evidence that the
        // episode is absent. Leave it uncached so the next build retries
        // rather than hiding a real episode for the whole miss window.
        recordProviderOutage(provider, config);
        useRemembered();
      }
    }
    return detailed ? { providerItems, unanswered } : providerItems;
  };
}
