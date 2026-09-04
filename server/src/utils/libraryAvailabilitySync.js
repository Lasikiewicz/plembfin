import { runWithConcurrency } from "./concurrency.js";
import { getCanonicalWatchState } from "./dataRepo.js";
import { normalizeProviderIds, parsePlexMediaIds } from "./parsers.js";
import { fetchPlexLibraryItems } from "./plexClient.js";
import { fetchEmbyLibraryItems } from "./embyClient.js";
import { fetchJellyfinLibraryItems } from "./jellyfinClient.js";
import { syncCanonicalPlaystate } from "./syncOrchestrator.js";
import { buildWatchProvenance } from "./watchProvenance.js";

const PROVIDERS = ["plex", "emby", "jellyfin"];
const RECONCILIATION_CONCURRENCY = 4;

const defaultClients = {
  plex: { fetch: fetchPlexLibraryItems },
  emby: { fetch: fetchEmbyLibraryItems },
  jellyfin: { fetch: fetchJellyfinLibraryItems },
};

function text(value) {
  return String(value ?? "").trim();
}

function providerItemId(provider, item = {}) {
  return text(provider === "plex" ? (item.ratingKey || item.key) : item.Id || item.id);
}

function providerItemType(provider, item = {}) {
  const raw = text(provider === "plex" ? item.type : item.Type || item.type).toLowerCase();
  if (raw === "movie") return "movie";
  if (raw === "episode") return "episode";
  return "";
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function isProviderItemUnplayed(provider, item = {}) {
  if (provider === "plex") {
    // The dedicated inventory requests Plex's `unwatched=1` filter. Some Plex
    // servers omit viewCount from that filtered response, so the client tags
    // those items as positive unplayed evidence. Arbitrary incomplete Plex
    // responses remain unknown and must never become permission to write.
    if (!Object.prototype.hasOwnProperty.call(item, "viewCount")) {
      return item.__plembfinUnwatchedFeed === true;
    }
    return Number(item.viewCount || 0) <= 0;
  }

  const userData = item.UserData;
  if (!userData || typeof userData !== "object") return false;
  return userData.Played !== true && Number(userData.PlayCount || 0) <= 0;
}

function providerEpisodeIds(item = {}) {
  return {
    ...(item.ProviderIds || {}),
    ...(item.SeriesProviderIds || {}),
  };
}

function providerEpisodeTitle(provider, item = {}) {
  return text(provider === "plex" ? item.title : item.Name || item.name || item.Title || item.title);
}

function providerSeriesTitle(provider, item = {}) {
  return text(provider === "plex"
    ? item.grandparentTitle
    : item.SeriesName || item.seriesName || item.ShowTitle || item.showTitle || item.GrandparentTitle || item.grandparentTitle);
}

function providerMediaIds(provider, item, type) {
  if (provider === "plex") return parsePlexMediaIds(item, type);
  const normalized = normalizeProviderIds(type === "episode" ? providerEpisodeIds(item) : item.ProviderIds || {});
  return {
    imdb: normalized.imdb || undefined,
    tmdb: normalized.tmdb || undefined,
    tvdb: normalized.tvdb || undefined,
  };
}

/**
 * Convert one item from a provider's full library inventory into the same
 * coordinate/identity shape used by watched-history imports. The native item
 * id is kept separately so a duplicate 4K episode is marked on that exact
 * item instead of being resolved back to an older 1080p sibling.
 */
export function mediaFromLibraryItem(provider, item = {}) {
  const type = providerItemType(provider, item);
  const itemId = providerItemId(provider, item);
  if (!type || !itemId) return null;

  const ids = providerMediaIds(provider, item, type);
  const media = {
    type,
    source: provider,
    ids,
    itemId,
    provider_item_id: itemId,
    provider_items: { [provider]: [itemId] },
    providerItems: { [provider]: [itemId] },
    isValid: true,
    watchProvenance: buildWatchProvenance(
      { source: provider, event: "library.availability", phase: "added", itemId },
      { ingestPath: `${provider}_scheduled_library_availability` },
    ),
  };

  if (type === "movie") {
    media.title = provider === "plex" ? text(item.title) : text(item.Name || item.name || item.Title || item.title);
    return media.title ? media : null;
  }

  const showTitle = providerSeriesTitle(provider, item);
  const season = numberOrNull(provider === "plex" ? item.parentIndex : item.ParentIndexNumber);
  const episode = numberOrNull(provider === "plex" ? item.index : item.IndexNumber);
  if (!showTitle || season == null || season < 0 || episode == null || episode < 1) return null;

  media.show_title = showTitle;
  media.showTitle = showTitle;
  media.season = season;
  media.episode = episode;
  media.episodeTitle = providerEpisodeTitle(provider, item) || null;
  media.title = `${showTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return media;
}

function providerIsConfigured(config, provider) {
  if (config?.[provider]?.disabled) return false;
  if (provider === "plex") return Boolean(config?.plex?.baseUrl && config?.plex?.token);
  return Boolean(config?.[provider]?.baseUrl && config?.[provider]?.apiKey && config?.[provider]?.userId);
}

function isSuccessfulMark(result = {}) {
  return result?.status === "success" || result?.status === "fulfilled" || result?.applied === true;
}

/**
 * Find provider items that are present but still unplayed even though the
 * canonical Plembfin state is watched. This is deliberately a one-way repair:
 * absent items and provider-unplayed items with no canonical watch are both
 * left alone, so a missing library or a partial API response cannot mark
 * anything unwatched.
 */
export async function reconcileAvailableWatchedItems(config = {}, {
  clients = defaultClients,
  loopStore = null,
  logger = () => {},
  markWatched = null,
  onMarked = null,
  shouldStop = async () => false,
  concurrency = RECONCILIATION_CONCURRENCY,
} = {}) {
  const result = {
    scanned: 0,
    candidates: 0,
    canonicalWatched: 0,
    marked: 0,
    skipped: 0,
    errors: [],
    providers: {},
  };

  const mark = markWatched || ((media, provider) => syncCanonicalPlaystate(
    { ...media, syncTargets: [provider] },
    config,
    loopStore,
    "watched",
    { trackDispatch: false, includeTrackers: false },
  ));

  for (const provider of PROVIDERS) {
    if (!providerIsConfigured(config, provider)) continue;
    if (await shouldStop()) break;

    const providerResult = {
      scanned: 0,
      candidates: 0,
      canonicalWatched: 0,
      marked: 0,
      skipped: 0,
      error: "",
    };
    result.providers[provider] = providerResult;

    let items;
    try {
      items = await clients[provider].fetch(config[provider], { limit: 0 });
    } catch (error) {
      providerResult.error = error?.message || String(error);
      result.errors.push(`${provider}: ${providerResult.error}`);
      logger(`Scheduled Sync: ${provider} library availability scan failed: ${providerResult.error}`);
      // A failed/partial inventory is never treated as an empty library. In
      // particular, this path has no unwatch operation at all.
      continue;
    }

    const seenIds = new Set();
    const candidates = [];
    for (const item of Array.isArray(items) ? items : []) {
      const itemId = providerItemId(provider, item);
      if (!itemId || seenIds.has(itemId)) continue;
      seenIds.add(itemId);
      providerResult.scanned += 1;
      if (!isProviderItemUnplayed(provider, item)) continue;
      const media = mediaFromLibraryItem(provider, item);
      if (!media) {
        providerResult.skipped += 1;
        continue;
      }
      candidates.push(media);
    }
    providerResult.candidates = candidates.length;
    result.scanned += providerResult.scanned;
    result.candidates += providerResult.candidates;
    result.skipped += providerResult.skipped;

    await runWithConcurrency(candidates, async (media) => {
      if (await shouldStop()) return;
      const canonicalState = await getCanonicalWatchState(media).catch(() => null);
      if (canonicalState !== "watched") {
        providerResult.skipped += 1;
        return;
      }

      providerResult.canonicalWatched += 1;
      result.canonicalWatched += 1;
      try {
        const markResult = await mark(media, provider);
        if (isSuccessfulMark(markResult)) {
          providerResult.marked += 1;
          result.marked += 1;
          await onMarked?.(media, markResult, provider);
        } else {
          providerResult.skipped += 1;
        }
      } catch (error) {
        providerResult.error = providerResult.error || (error?.message || String(error));
        result.errors.push(`${provider} ${media.title}: ${error?.message || String(error)}`);
      }
    }, concurrency);

    logger(`Scheduled Sync: ${provider} availability checked ${providerResult.scanned} item(s), found ${providerResult.marked} watched-state repair(s).`);
  }

  return result;
}
