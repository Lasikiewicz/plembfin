import { watchedThresholdPercent } from "./tuning.js";

const EMPTY_IDS = { imdb: undefined, tmdb: undefined, tvdb: undefined };
const PLEX_ACTIVE_EVENTS = ["media.play", "media.resume", "media.progress", "media.pause"];
const PLEX_COMPLETE_EVENTS = ["media.scrobble", "user.playrate"];
const EMBY_ACTIVE_EVENTS = ["playback.start", "playback.unpause", "playback.progress", "playback.pause"];
const JELLYFIN_ACTIVE_EVENTS = ["PlaybackStart", "PlaybackProgress", "PlaybackPause"];

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Single-pass decode so each entity is expanded exactly once. Decoding in chained
// .replace() calls double-unescapes inputs like "&#38;amp;" (numeric -> "&amp;" -> "&");
// matching all forms in one regex avoids that.
export function decodeHtmlEntities(str) {
  return String(str ?? "").replace(
    /&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos|#39);/gi,
    (match, hex, dec, named) => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      if (dec !== undefined) return String.fromCharCode(Number(dec));
      if (named === "#39") return "'";
      return NAMED_ENTITIES[named.toLowerCase()] ?? match;
    }
  );
}

function normalizeType(value) {
  const type = String(value || "").toLowerCase();
  if (type === "movie") return "movie";
  if (type === "episode" || type === "tvchannel") return "episode";
  if (type === "season") return "season";
  if (type === "series" || type === "show") return "series";
  return undefined;
}

function firstDefined(...values) {
  return values.find((value) => value != null && value !== "");
}

export function normalizeProviderIds(providerIds = {}) {
  const ids = { ...EMPTY_IDS };
  for (const [key, value] of Object.entries(providerIds || {})) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "imdb") ids.imdb = String(value);
    if (normalizedKey === "tmdb") ids.tmdb = String(value);
    if (normalizedKey === "tvdb") ids.tvdb = String(value);
  }
  return ids;
}

export function parsePlexGuids(metadata = {}) {
  const ids = { ...EMPTY_IDS };
  const guidEntries = Array.isArray(metadata.Guid) ? metadata.Guid : [];
  const rawGuids = [
    metadata.guid,
    ...guidEntries.map((entry) => (typeof entry === "string" ? entry : entry.id)),
  ].filter(Boolean);

  for (const rawGuid of rawGuids) {
    const guid = String(rawGuid);
    // Flexible parsing supporting both slug styles (proto://id and proto/id)
    // and both the modern (tmdb/tvdb) and legacy Plex agent (themoviedb/thetvdb) prefixes.
    if (guid.includes("imdb")) ids.imdb = guid.split(/:\/\/|\//).pop();
    if (guid.includes("tmdb") || guid.includes("themoviedb")) ids.tmdb = guid.split(/:\/\/|\//).pop();
    if (guid.includes("tvdb") || guid.includes("thetvdb")) ids.tvdb = guid.split(/:\/\/|\//).pop();
  }
  return ids;
}

function extractTitle(type, metadata, source) {
  const season = seasonNumberFrom(metadata);
  const episode = episodeNumberFrom(metadata);
  const hasEpisodeCoordinates = season != null || episode != null;

  if (source === "plex") {
    const showTitle = decodeHtmlEntities(metadata.grandparentTitle || "");
    const movieTitle = decodeHtmlEntities(metadata.title);
    if (type === "episode") {
      if (hasEpisodeCoordinates) {
        return `${showTitle || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`;
      }
      return showTitle || "Unknown Episode";
    }
    return movieTitle || "Unknown Movie";
  }
  
  // Jellyfin / Emby
  if (type === "episode") {
    if (hasEpisodeCoordinates) {
      return `${seriesTitleFrom(metadata) || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`;
    }
    return seriesTitleFrom(metadata) || itemTitleFrom(metadata) || "Unknown Episode";
  }
  return itemTitleFrom(metadata) || "Unknown Movie";
}

function itemTitleFrom(item = {}) {
  return firstDefined(item.Name, item.name, item.Title, item.title, item.ItemName, item.itemName);
}

function seriesTitleFrom(item = {}) {
  return firstDefined(item.SeriesName, item.seriesName, item.ShowTitle, item.showTitle, item.GrandparentTitle, item.grandparentTitle, item.ParentName, item.parentName, item.Name, item.name);
}

function seasonNumberFrom(item = {}) {
  return firstDefined(item.ParentIndexNumber, item.parentIndexNumber, item.SeasonNumber, item.seasonNumber, item.Season, item.season, item.ParentIndex, item.parentIndex);
}

function episodeNumberFrom(item = {}) {
  return firstDefined(item.IndexNumber, item.indexNumber, item.EpisodeNumber, item.episodeNumber, item.Episode, item.episode, item.Index, item.index);
}

function providerIdsFrom(item = {}, json = {}) {
  return item.ProviderIds || item.providerIds || json.ProviderIds || json.providerIds || {};
}

function embyLikeTypeFrom(item = {}, json = {}) {
  return normalizeType(firstDefined(item.Type, item.type, item.MediaType, item.mediaType, item.ItemType, item.itemType, json.Type, json.type, json.MediaType, json.mediaType, json.ItemType, json.itemType));
}

function embyLikeUserFrom(json = {}) {
  return firstDefined(json.UserId, json.userId, json.User?.Id, json.User?.Name, json.UserName, json.Username, json.userName, json.username) || "";
}

function plexPosterInfo(metadata = {}, type = "unknown") {
  const path =
    type === "episode"
      ? metadata.grandparentThumb || metadata.parentThumb || metadata.thumb
      : metadata.thumb || metadata.grandparentThumb || metadata.parentThumb;
  return path ? { path } : undefined;
}

function embyLikePosterInfo(item = {}, type = "unknown") {
  const imageTags = item.ImageTags || {};
  const itemId = type === "episode" ? item.SeriesId || item.ParentId || item.Id : item.Id;
  const tag =
    type === "episode"
      ? item.SeriesPrimaryImageTag || item.ParentPrimaryImageTag || imageTags.Primary
      : imageTags.Primary || item.PrimaryImageTag;

  return itemId ? { itemId, tag } : undefined;
}

function progressPercentFrom(values = {}) {
  const position =
    Number(values.viewOffset) ||
    Number(values.PlaybackPositionTicks) ||
    Number(values.PositionTicks) ||
    Number(values.PlayState?.PositionTicks) ||
    Number(values.UserData?.PlaybackPositionTicks);
  const duration =
    Number(values.duration) ||
    Number(values.RunTimeTicks) ||
    Number(values.DurationTicks) ||
    Number(values.Item?.RunTimeTicks);

  if (position > 0 && duration > 0) {
    return Math.max(0, Math.min(100, (position / duration) * 100));
  }

  const direct = Number(
    values.progress ??
      values.Progress ??
      values.PercentComplete ??
      values.PlayedPercentage ??
      values.PlaybackProgress ??
      values.PlaybackProgressPercentage,
  );
  if (Number.isFinite(direct)) return direct > 1 ? direct : direct * 100;

  return 0;
}

function readPlayedState(...values) {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidates = [
      value.Played,
      value.IsPlayed,
      value.played,
      value.isPlayed,
      value.UserData?.Played,
      value.UserData?.IsPlayed,
      value.Item?.UserData?.Played,
      value.Item?.UserData?.IsPlayed,
      value.NowPlayingItem?.UserData?.Played,
      value.NowPlayingItem?.UserData?.IsPlayed,
    ];
    for (const candidate of candidates) {
      if (candidate === true || candidate === "true" || candidate === 1 || candidate === "1") return true;
      if (candidate === false || candidate === "false" || candidate === 0 || candidate === "0") return false;
    }
  }
  return undefined;
}

function ticksToMilliseconds(value) {
  const ticks = Number(value || 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

function millisecondsFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function positionMillisecondsFrom(values = {}) {
  const directMs = millisecondsFrom(values.viewOffset || values.offsetMs || values.positionMs);
  if (directMs) return directMs;

  return ticksToMilliseconds(
    values.PlaybackPositionTicks ||
      values.PositionTicks ||
      values.PlayState?.PositionTicks ||
      values.UserData?.PlaybackPositionTicks ||
      values.Item?.UserData?.PlaybackPositionTicks ||
      values.Item?.PlaybackPositionTicks,
  );
}

function durationMillisecondsFrom(values = {}) {
  const directMs = millisecondsFrom(values.duration || values.durationMs || values.Duration);
  if (directMs) return directMs;

  return ticksToMilliseconds(
    values.RunTimeTicks ||
      values.DurationTicks ||
      values.Item?.RunTimeTicks ||
      values.Item?.DurationTicks,
  );
}

function phaseFromPlexEvent(event, metadata) {
  const progress = progressPercentFrom(metadata);
  if (PLEX_COMPLETE_EVENTS.includes(event)) return "completed";
  if (event === "media.stop") return progress >= watchedThresholdPercent() ? "completed" : "ended";
  if (PLEX_ACTIVE_EVENTS.includes(event)) return "active";
  return "ignored";
}

function phaseFromEmbyEvent(event, json, item) {
  const progress = progressPercentFrom({ ...json, ...item });
  const eventKey = String(event || "").toLowerCase();
  const compactEventKey = eventKey.replace(/[^a-z0-9]/g, "");
  const played = readPlayedState(json, item);
  if (["itemmarkplayed", "itemmarkedplayed", "itemmarkedasplayed", "itemplayed"].includes(compactEventKey)) return "completed";
  if (["itemmarkunplayed", "itemmarkedunplayed", "itemmarkedasunplayed", "itemunplayed"].includes(compactEventKey)) return "unplayed";
  if (["userdatasaved", "userdatachanged", "itemuserdatachanged"].includes(compactEventKey) && played === true) return "completed";
  if (["userdatasaved", "userdatachanged", "itemuserdatachanged"].includes(compactEventKey) && played === false) return "unplayed";
  if (compactEventKey === "playbackstop") return progress >= watchedThresholdPercent() ? "completed" : "ended";
  if (EMBY_ACTIVE_EVENTS.map((activeEvent) => activeEvent.replace(/[^a-z0-9]/g, "")).includes(compactEventKey)) return "active";
  return "ignored";
}

function phaseFromJellyfinEvent(event, json, item) {
  const progress = progressPercentFrom({ ...json, ...item });
  const eventKey = String(event || "").toLowerCase();
  const compactEventKey = eventKey.replace(/[^a-z0-9]/g, "");
  const played = readPlayedState(json, item);
  if (["itemmarkplayed", "itemmarkedplayed", "itemmarkedasplayed", "itemplayed"].includes(compactEventKey)) return "completed";
  if (["itemmarkunplayed", "itemmarkedunplayed", "itemmarkedasunplayed", "itemunplayed"].includes(compactEventKey)) return "unplayed";
  if (["userdatasaved", "userdatachanged", "itemuserdatachanged"].includes(compactEventKey) && played === true) return "completed";
  if (["userdatasaved", "userdatachanged", "itemuserdatachanged"].includes(compactEventKey) && played === false) return "unplayed";
  if (compactEventKey === "playbackstop") return progress >= watchedThresholdPercent() ? "completed" : "ended";
  if (JELLYFIN_ACTIVE_EVENTS.map((activeEvent) => activeEvent.toLowerCase()).includes(eventKey)) return "active";
  return "ignored";
}

function pickWebhookItem(json = {}) {
  return json.Item || json.Metadata || json.MediaItem || json.ItemInfo || json.NowPlayingItem || json;
}

function buildPayload({
  type,
  source,
  ids,
  season,
  episode,
  title,
  event,
  phase = "completed",
  progress = 0,
  offsetMs = 0,
  durationMs = 0,
  user,
  posterUrl,
  poster,
  itemId,
  episodeTitle,
  rawPayloadDebug = {},
}) {
  const isActionable = ["active", "completed", "ended", "unplayed"].includes(phase);
  return {
    title: title || "Unknown media",
    type,
    source,
    ids: { ...EMPTY_IDS, ...ids },
    season: season == null ? undefined : Number(season),
    episode: episode == null ? undefined : Number(episode),
    event,
    phase,
    progress: Number.isFinite(Number(progress)) ? Number(progress) : 0,
    offsetMs: Number.isFinite(Number(offsetMs)) ? Math.max(0, Math.round(Number(offsetMs))) : 0,
    durationMs: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : 0,
    user,
    posterUrl,
    poster,
    itemId,
    episodeTitle,
    rawPayloadDebug,
    isValid: Boolean(isActionable && type && source && title),
  };
}

export async function parsePlexWebhook(formData) {
  const formKeys = [...formData.keys()];
  try {
    const rawPayload = formData.get("payload");
    if (!rawPayload) {
      return buildPayload({
        source: "plex",
        ids: EMPTY_IDS,
        title: "Plex Raw Event: missing payload",
        phase: "ignored",
        rawPayloadDebug: { formKeys, hasPayload: false },
      });
    }

    const payload = JSON.parse(rawPayload);
    const metadata = payload.Metadata || {};
    const type = normalizeType(metadata.type);
    const event = payload.event || "unknown";
    const rawPayloadDebug = {
      formKeys,
      hasPayload: true,
      event,
      payloadKeys: Object.keys(payload),
      metadataKeys: Object.keys(metadata),
      guidCount: Array.isArray(metadata.Guid) ? metadata.Guid.length : 0,
      rawPayload,
    };
    const title = extractTitle(type, metadata, "plex");

    const phase = phaseFromPlexEvent(event, metadata);
    const progress = progressPercentFrom(metadata);
    const offsetMs = positionMillisecondsFrom(metadata);
    const durationMs = durationMillisecondsFrom(metadata);
    const ids = parsePlexGuids(metadata);
    const user = payload.Account?.title || "";

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "plex",
        title: event ? `Plex Raw Event: ${event} - ${title}` : title,
        ids,
        season: metadata.parentIndex,
        episode: metadata.index,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        itemId: metadata.ratingKey,
        poster: plexPosterInfo(metadata, type),
        episodeTitle: type === "episode" ? metadata.title : null,
        rawPayloadDebug,
      });
    }

    return buildPayload({
      type,
      source: "plex",
      title,
      ids,
      season: metadata.parentIndex,
      episode: metadata.index,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      itemId: metadata.ratingKey,
      poster: plexPosterInfo(metadata, type),
      episodeTitle: type === "episode" ? metadata.title : null,
      rawPayloadDebug,
    });
  } catch (error) {
    console.error("Plex parser failed", error);
    return buildPayload({
      source: "plex",
      ids: EMPTY_IDS,
      title: "Plex Raw Event: parser failure",
      phase: "ignored",
      rawPayloadDebug: { formKeys, error: error.message },
    });
  }
}

// Builds a normalized media object from a Plex `/library/metadata/{ratingKey}` item
// (i.e. without a webhook event payload). Plex never emits a webhook when an item is
// marked unwatched, so the real-time notification listener resolves the changed
// ratingKey to its metadata and runs it through this builder. It reuses the exact same
// GUID/title/coordinate extraction as the webhook path, so `media.ids`, `media.title`,
// `media.season` and `media.episode` are identical to a Plex webhook — which is what
// lets the Emby and Jellyfin clients match the item the same way they do for any sync.
export function buildPlexMediaFromMetadata(metadata = {}, { phase = "unplayed" } = {}) {
  const type = normalizeType(metadata.type);
  const ids = parsePlexGuids(metadata);
  const title = extractTitle(type, metadata, "plex");
  return buildPayload({
    type,
    source: "plex",
    title,
    ids,
    season: metadata.parentIndex,
    episode: metadata.index,
    event: "notification.viewstate",
    phase,
    user: "",
    itemId: metadata.ratingKey,
    poster: plexPosterInfo(metadata, type),
    episodeTitle: type === "episode" ? metadata.title : null,
    rawPayloadDebug: { source: "plex_notification", ratingKey: metadata.ratingKey },
  });
}

export function parseJellyfinWebhook(json) {
  try {
    const item = pickWebhookItem(json);
    const event = json?.NotificationType || "unknown";
    const type = embyLikeTypeFrom(item, json);
    const phase = phaseFromJellyfinEvent(event, json, item);
    const title = extractTitle(type, item, "jellyfin");
    const progress = progressPercentFrom({ ...json, ...item });
    const offsetMs = positionMillisecondsFrom({ ...json, ...item });
    const durationMs = durationMillisecondsFrom({ ...json, ...item });
    const user = embyLikeUserFrom(json);
    const providerIds = providerIdsFrom(item, json);
    const season = seasonNumberFrom(item);
    const episode = episodeNumberFrom(item);
    const episodeTitle = type === "episode" ? itemTitleFrom(item) : null;

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "jellyfin",
        ids: normalizeProviderIds(providerIds),
        title: `Jellyfin Raw Event: ${event} - ${title}`,
        season,
        episode,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        itemId: item.Id,
        poster: embyLikePosterInfo(item, type),
        episodeTitle,
        rawPayloadDebug: {
          payloadKeys: Object.keys(json || {}),
          itemKeys: Object.keys(item || {}),
          rawPayload: JSON.stringify(json),
        },
      });
    }

    return buildPayload({
      type,
      source: "jellyfin",
      title,
      ids: normalizeProviderIds(providerIds),
      season,
      episode,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      itemId: item.Id,
      poster: embyLikePosterInfo(item, type),
      episodeTitle,
      rawPayloadDebug: {
        payloadKeys: Object.keys(json || {}),
        itemKeys: Object.keys(item),
        providerKeys: Object.keys(providerIds || {}),
        rawPayload: JSON.stringify(json),
      },
    });
  } catch (error) {
    console.error("Jellyfin parser failed", error);
    return buildPayload({
      source: "jellyfin",
      ids: EMPTY_IDS,
      title: "Jellyfin Raw Event: parser failure",
      phase: "ignored",
      rawPayloadDebug: { error: error.message },
    });
  }
}

export function parseEmbyWebhook(json) {
  try {
    const item = pickWebhookItem(json);
    const event = json?.Event || "unknown";
    const type = embyLikeTypeFrom(item, json);
    const phase = phaseFromEmbyEvent(event, json, item);
    const title = extractTitle(type, item, "emby");
    const progress = progressPercentFrom({ ...json, ...item });
    const offsetMs = positionMillisecondsFrom({ ...json, ...item });
    const durationMs = durationMillisecondsFrom({ ...json, ...item });
    const user = embyLikeUserFrom(json);
    const providerIds = providerIdsFrom(item, json);
    const season = seasonNumberFrom(item);
    const episode = episodeNumberFrom(item);
    const episodeTitle = type === "episode" ? itemTitleFrom(item) : null;

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "emby",
        ids: normalizeProviderIds(providerIds),
        title: `Emby Raw Event: ${event} - ${title}`,
        season,
        episode,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        itemId: item.Id,
        poster: embyLikePosterInfo(item, type),
        episodeTitle,
        rawPayloadDebug: {
          payloadKeys: Object.keys(json || {}),
          itemKeys: Object.keys(item || {}),
          rawPayload: JSON.stringify(json),
        },
      });
    }

    return buildPayload({
      type,
      source: "emby",
      title,
      ids: normalizeProviderIds(providerIds),
      season,
      episode,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      itemId: item.Id,
      poster: embyLikePosterInfo(item, type),
      episodeTitle,
      rawPayloadDebug: {
        payloadKeys: Object.keys(json || {}),
        itemKeys: Object.keys(item),
        providerKeys: Object.keys(providerIds || {}),
        rawPayload: JSON.stringify(json),
      },
    });
  } catch (error) {
    console.error("Emby parser failed", error);
    return buildPayload({
      source: "emby",
      ids: EMPTY_IDS,
      title: "Emby Raw Event: parser failure",
      phase: "ignored",
      rawPayloadDebug: { error: error.message },
    });
  }
}

export function parseCustomWebhook(json) {
  if (!json || json.source !== "plex" || json.event !== "media.unscrobble") {
    return { isValid: false };
  }
  const type = normalizeType(json.type);
  const phase = "unplayed";
  const user = json.user || "";
  const title = json.title || "";
  
  const ids = {
    imdb: json.imdb_id || undefined,
    tmdb: json.tmdb_id || undefined,
    tvdb: json.tvdb_id || undefined,
  };
  
  return buildPayload({
    type,
    source: "plex",
    title,
    ids,
    season: json.season != null && json.season !== "" ? Number(json.season) : undefined,
    episode: json.episode != null && json.episode !== "" ? Number(json.episode) : undefined,
    event: json.event,
    phase,
    user,
    posterUrl: json.posterUrl || json.poster_url,
    rawPayloadDebug: json,
  });
}
