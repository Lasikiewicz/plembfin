import {
  fetchPlexContinueWatchingItems,
  hidePlexFromContinueWatching,
} from "./plexClient.js";
import {
  fetchEmbyNextUpItems,
  fetchEmbyResumableItems,
  hideEmbyFromResume,
} from "./embyClient.js";
import {
  fetchJellyfinNextUpItems,
  fetchJellyfinResumableItems,
  hideJellyfinFromResume,
} from "./jellyfinClient.js";
import { recordUpNextProviderFeed } from "./upNextRepository.js";
import { normalizeUpNextCandidate, upNextIdentityAliases } from "./upNextIdentity.js";
import { createLoopStore } from "./loopStore.js";
import { syncMediaProgress } from "./syncOrchestrator.js";
import { syncUpNextProviderPlaylists } from "./upNextProviderPlaylists.js";
import { seedUpNextProviderRails } from "./upNextRailSeed.js";
import { resolveUpNextProviderTargets } from "./upNextLibraryLookup.js";

// All three media servers participate in Up Next. Jellyfin was briefly
// excluded; see docs/decisions.md entry 20 for why that was reversed.
const PROVIDERS = ["plex", "emby", "jellyfin"];
const PUSH_PROVIDERS = PROVIDERS;
const MAX_REQUEST_ITEMS = 100;

function text(value = "") {
  return String(value ?? "").trim();
}
function providerIdValues(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((entry) => {
    if (entry && typeof entry === "object") {
      return text(entry.id || entry.Id || entry.ratingKey || entry.provider_item_id);
    }
    return text(entry);
  }).filter(Boolean);
}

function normalizedProviderItems(item = {}) {
  const result = {};
  const source = item.provider_items || item.providerItems || {};
  for (const provider of PROVIDERS) {
    const values = providerIdValues(source[provider]);
    if (values.length) result[provider] = [...new Set(values)];
  }

  const provider = text(item.source || item.provider).toLowerCase();
  const providerItemId = text(item.provider_item_id || item.providerItemId);
  if (PROVIDERS.includes(provider) && providerItemId) {
    result[provider] = [...new Set([...(result[provider] || []), providerItemId])];
  }
  return result;
}

function configuredProvider(config, provider) {
  const section = config?.[provider] || {};
  if (section.disabled) return false;
  if (provider === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && (section.apiKey || section.api_key || section.token) && section.userId);
}

function feedDefinitions(config = {}) {
  return [
    {
      provider: "plex",
      feedKind: "resume",
      supportsDismissal: true,
      configured: configuredProvider(config, "plex"),
      fetch: () => fetchPlexContinueWatchingItems(config.plex, { limit: 0 }),
      hide: (providerItemId) => hidePlexFromContinueWatching(config.plex, providerItemId, { lane: "interactive" }),
    },
    {
      provider: "emby",
      feedKind: "resume",
      supportsDismissal: true,
      configured: configuredProvider(config, "emby"),
      fetch: () => fetchEmbyResumableItems(config.emby, { limit: 0 }),
      hide: (providerItemId) => hideEmbyFromResume(config.emby, providerItemId, { lane: "interactive" }),
    },
    {
      provider: "emby",
      feedKind: "next_up",
      supportsDismissal: false,
      configured: configuredProvider(config, "emby"),
      fetch: () => fetchEmbyNextUpItems(config.emby, { limit: 0 }),
    },
    {
      provider: "jellyfin",
      feedKind: "resume",
      supportsDismissal: true,
      configured: configuredProvider(config, "jellyfin"),
      fetch: () => fetchJellyfinResumableItems(config.jellyfin, { limit: 0 }),
      hide: (providerItemId) => hideJellyfinFromResume(config.jellyfin, providerItemId, { lane: "interactive" }),
    },
    {
      // Jellyfin's Next Up is a calculated GET feed with no per-item write, so
      // it is read as an observation and reported as unsupported for removal.
      // The rail seed still steers it: /Shows/NextUp is requested with
      // EnableResumable, so a seeded episode becomes its series' entry.
      provider: "jellyfin",
      feedKind: "next_up",
      supportsDismissal: false,
      configured: configuredProvider(config, "jellyfin"),
      fetch: () => fetchJellyfinNextUpItems(config.jellyfin, { limit: 0 }),
    },
  ];
}

function feedCandidates(provider, feedKind, items = []) {
  const seen = new Set();
  const candidates = [];
  for (const item of Array.isArray(items) ? items : []) {
    const candidate = normalizeUpNextCandidate({
      provider,
      feed_kind: feedKind,
      item,
    });
    const providerItemId = text(candidate.provider_item_id);
    if (!providerItemId || seen.has(providerItemId)) continue;
    seen.add(providerItemId);
    candidates.push(candidate);
  }
  return candidates;
}

function desiredProviderIds(items = []) {
  const ids = Object.fromEntries(PROVIDERS.map((provider) => [provider, new Set()]));
  for (const item of (Array.isArray(items) ? items : []).slice(0, MAX_REQUEST_ITEMS)) {
    const providerItems = normalizedProviderItems(item);
    for (const provider of PROVIDERS) {
      for (const providerItemId of providerIdValues(providerItems[provider])) {
        ids[provider].add(providerItemId);
      }
    }
  }
  return ids;
}

function normalizedDesiredCandidates(items = []) {
  return (Array.isArray(items) ? items : [])
    .slice(0, MAX_REQUEST_ITEMS)
    .filter((item) => item && typeof item === "object")
    .map((item) => normalizeUpNextCandidate(item));
}

function candidateAliases(candidate) {
  return new Set(upNextIdentityAliases(candidate));
}

function matchesDesiredCandidate(candidate, desiredAliases) {
  const aliases = candidateAliases(candidate);
  return desiredAliases.some((desired) => [...aliases].some((alias) => desired.has(alias)));
}

// Build a dry-run reconciliation plan without talking to a media server. This
// is useful for diagnostics and for the authoritative push route. Only a
// successful native feed is eligible for reconciliation; failed feeds must
// never be interpreted as an empty queue.
export function planUpNextProviderSync({ desiredItems = [], feeds = [] } = {}) {
  const desiredIds = desiredProviderIds(desiredItems);
  const desiredAliases = normalizedDesiredCandidates(desiredItems).map(candidateAliases);
  const dismissals = [];
  const unsupported = [];

  for (const feed of Array.isArray(feeds) ? feeds : []) {
    if (feed?.status !== "succeeded") continue;
    const provider = text(feed.provider).toLowerCase();
    if (!PROVIDERS.includes(provider)) continue;
    const feedKind = text(feed.feed_kind || feed.feedKind).toLowerCase();
    const candidates = Array.isArray(feed.items) ? feed.items : [];
    const seen = new Set();
    for (const candidate of candidates) {
      const providerItemId = text(candidate?.provider_item_id || candidate?.providerItemId);
      if (!providerItemId || seen.has(providerItemId)) continue;
      seen.add(providerItemId);
      const isDesired = desiredIds[provider].has(providerItemId)
        || matchesDesiredCandidate({
          ...candidate,
          provider,
          feed_kind: feedKind,
        }, desiredAliases);
      if (isDesired) {
        desiredIds[provider].add(providerItemId);
        continue;
      }
      const action = {
        provider,
        feed_kind: feedKind,
        provider_item_id: providerItemId,
        title: text(candidate?.title || candidate?.name) || "Untitled",
      };
      if (feed.supportsDismissal === true && PUSH_PROVIDERS.includes(provider)) dismissals.push(action);
      else unsupported.push(action);
    }
  }

  return {
    desiredProviderIds: Object.fromEntries(PROVIDERS.map((provider) => [provider, [...desiredIds[provider]]])),
    dismissals,
    unsupported,
  };
}

function mediaFromRequestedItem(item = {}) {
  const type = text(item.media_type || item.mediaType).toLowerCase();
  const mediaType = type === "movie" ? "movie" : type === "episode" ? "episode" : "";
  const title = text(item.title || item.episode_title || item.show_title);
  const positionMs = Math.max(0, Math.round(Number(item.position_ms ?? item.positionMs ?? item.offset_ms ?? item.offsetMs ?? 0) || 0));
  const durationMs = Math.max(0, Math.round(Number(item.duration_ms ?? item.durationMs ?? 0) || 0));
  const progress = Math.max(0, Math.min(100, Number(item.progress || 0) || 0));
  const fallbackIds = {
    imdb: text(item.imdb_id || item.imdbId || item.imdb) || undefined,
    tmdb: text(item.tmdb_id || item.tmdbId || item.tmdb) || undefined,
    tvdb: text(item.tvdb_id || item.tvdbId || item.tvdb) || undefined,
  };
  const showIds = {
    imdb: text(item.show_imdb_id || item.showImdbId) || undefined,
    tmdb: text(item.show_tmdb_id || item.showTmdbId) || undefined,
    tvdb: text(item.show_tvdb_id || item.showTvdbId) || undefined,
  };
  const episodeIds = {
    imdb: text(item.episode_imdb_id || item.episodeImdbId) || undefined,
    tmdb: text(item.episode_tmdb_id || item.episodeTmdbId) || undefined,
    tvdb: text(item.episode_tvdb_id || item.episodeTvdbId) || undefined,
  };
  const providerItems = normalizedProviderItems(item);
  return {
    title,
    showTitle: text(item.show_title || item.showTitle) || undefined,
    type: mediaType,
    source: "manual",
    ids: mediaType === "episode"
      ? {
        imdb: showIds.imdb || fallbackIds.imdb,
        tmdb: showIds.tmdb || fallbackIds.tmdb,
        tvdb: showIds.tvdb || fallbackIds.tvdb,
      }
      : fallbackIds,
    show_imdb_id: showIds.imdb,
    show_tmdb_id: showIds.tmdb,
    show_tvdb_id: showIds.tvdb,
    episode_imdb_id: episodeIds.imdb || (mediaType === "episode" ? fallbackIds.imdb : undefined),
    episode_tmdb_id: episodeIds.tmdb || (mediaType === "episode" ? fallbackIds.tmdb : undefined),
    episode_tvdb_id: episodeIds.tvdb || (mediaType === "episode" ? fallbackIds.tvdb : undefined),
    season: item.season == null || item.season === "" ? undefined : Number(item.season),
    episode: item.episode == null || item.episode === "" ? undefined : Number(item.episode),
    media_key: text(item.media_key || item.mediaKey || item.id) || undefined,
    providerItems,
    providerItemId: text(item.provider_item_id || item.providerItemId) || undefined,
    positionMs,
    offsetMs: positionMs,
    durationMs,
    progress,
    isValid: Boolean(title && mediaType),
    syncTargets: PUSH_PROVIDERS,
  };
}

function actionableProgressItem(item = {}) {
  const media = mediaFromRequestedItem(item);
  return media.isValid && media.positionMs >= 1000 && media.progress < 95 ? media : null;
}

async function fetchAndRecordFeed(definition) {
  try {
    const rawItems = await definition.fetch();
    const items = feedCandidates(definition.provider, definition.feedKind, rawItems);
    recordUpNextProviderFeed(definition.provider, definition.feedKind, rawItems);
    return {
      provider: definition.provider,
      feed_kind: definition.feedKind,
      status: "succeeded",
      item_count: items.length,
      items,
      supportsDismissal: definition.supportsDismissal,
    };
  } catch (error) {
    return {
      provider: definition.provider,
      feed_kind: definition.feedKind,
      status: "failed",
      item_count: 0,
      items: [],
      supportsDismissal: definition.supportsDismissal,
      error: text(error?.message || error) || "Provider feed refresh failed",
    };
  }
}

async function propagateKnownProgress(items, config) {
  const progressItems = (Array.isArray(items) ? items : [])
    .slice(0, MAX_REQUEST_ITEMS)
    .map(actionableProgressItem)
    .filter(Boolean);
  if (!progressItems.length) return [];
  const loopStore = createLoopStore();
  return Promise.all(progressItems.map(async (media) => {
    try {
      const summary = await syncMediaProgress(media, config, loopStore, { lane: "interactive" });
      return {
        id: media.media_key || media.title,
        title: media.title,
        status: summary.status || "skipped",
        targetStates: summary.targetStates || [],
        details: summary.details || "",
      };
    } catch (error) {
      return {
        id: media.media_key || media.title,
        title: media.title,
        status: "error",
        targetStates: [],
        details: text(error?.message || error) || "Resume propagation failed",
      };
    }
  }));
}

async function applyDismissals(plan, definitions) {
  const definitionByFeed = new Map(definitions.map((definition) => [
    `${definition.provider}:${definition.feedKind}`,
    definition,
  ]));
  return Promise.all(plan.dismissals.map(async (action) => {
    const definition = definitionByFeed.get(`${action.provider}:${action.feed_kind}`);
    if (!definition?.hide) {
      return { ...action, status: "failed", details: "Provider Up Next push is not supported" };
    }
    try {
      await definition.hide(action.provider_item_id);
      return {
        ...action,
        status: "fulfilled",
        details: `Removed from ${action.provider === "plex" ? "Continue Watching" : "Resume"}`,
      };
    } catch (error) {
      return { ...action, status: "failed", details: text(error?.message || error) || "Provider dismissal failed" };
    }
  }));
}

// Push Plembfin's authoritative Up Next snapshot to a dedicated provider
// playlist in Plex and Emby, while also applying native dismissal actions and
// replaying only known positive resume positions. Plex Continue Watching and
// Emby Resume/Next Up are calculated feeds: their native APIs can hide or read
// membership, but cannot add an arbitrary future episode. The playlist is the
// complete provider-side representation, and failed/incomplete feeds never
// trigger native removals. Jellyfin is deliberately not consulted by this
// feature at all.
export async function syncUpNextToProviders({ desiredItems = [], config = {} } = {}) {
  const definitions = feedDefinitions(config);
  const configuredDefinitions = definitions.filter((definition) => definition.configured);
  const skippedFeeds = definitions
    .filter((definition) => !definition.configured)
    .map((definition) => ({
      provider: definition.provider,
      feed_kind: definition.feedKind,
      status: config?.[definition.provider]?.disabled ? "disabled" : "not_configured",
      item_count: 0,
      items: [],
      supportsDismissal: definition.supportsDismissal,
    }));
  const feeds = await Promise.all(configuredDefinitions.map(fetchAndRecordFeed));
  const plan = planUpNextProviderSync({ desiredItems, feeds });
  const dismissalDefinitions = configuredDefinitions.filter((definition) => (
    definition.supportsDismissal === true && PUSH_PROVIDERS.includes(definition.provider)
  ));
  const providerDismissals = await applyDismissals(plan, dismissalDefinitions);
  const progress = await propagateKnownProgress(desiredItems, config);
  const pushProviders = PUSH_PROVIDERS.filter((provider) => (
    configuredDefinitions.some((definition) => definition.provider === provider)
  ));
  // Resolve every desired item to its native id once per provider. The
  // playlist reconciliation and the rail seed then work from the same answer;
  // resolving separately let the two disagree and left the playlist holding a
  // stale entry while the seed found the item without trouble.
  const targetsByProvider = Object.fromEntries(await Promise.all(pushProviders.map(async (provider) => [
    provider,
    await resolveUpNextProviderTargets({
      provider,
      config: config[provider],
      items: desiredItems,
      limit: MAX_REQUEST_ITEMS,
    }).catch(() => ({ provider, resolved: [], unresolved: [] })),
  ])));

  const playlists = await syncUpNextProviderPlaylists({ desiredItems, config, targetsByProvider });
  // The managed playlist is the complete mirror; the native rails are
  // calculated and only accept a playback position. Seed the ones that are not
  // already there, using the ids the successful resume feeds just reported so
  // a real position is never overwritten by a synthetic one.
  const existingResumeIds = Object.fromEntries(pushProviders.map((provider) => [
    provider,
    new Set(feeds
      .filter((feed) => feed.provider === provider && feed.feed_kind === "resume" && feed.status === "succeeded")
      .flatMap((feed) => feed.items.map((candidate) => text(candidate?.provider_item_id)))
      .filter(Boolean)),
  ]));
  const railSeeds = await seedUpNextProviderRails({
    config,
    providers: pushProviders,
    targetsByProvider,
    existingResumeIds,
  });
  const pushedProviders = playlists
    .filter((playlist) => playlist.status === "succeeded" && playlist.missing_count === 0)
    .map((playlist) => playlist.provider);

  return {
    ok: true,
    desired_count: Math.min(Array.isArray(desiredItems) ? desiredItems.length : 0, MAX_REQUEST_ITEMS),
    feeds: [...feeds, ...skippedFeeds].map((feed) => ({
      provider: feed.provider,
      feed_kind: feed.feed_kind,
      status: feed.status,
      item_count: feed.item_count,
      error: feed.error || null,
    })),
    pushedProviders,
    playlists,
    railSeeds,
    providerDismissals,
    unsupported: plan.unsupported.map((item) => ({
      provider: item.provider,
      feed_kind: item.feed_kind,
      title: item.title,
    })),
    progress,
  };
}
