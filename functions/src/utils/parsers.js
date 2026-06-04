const EMPTY_IDS = { imdb: undefined, tmdb: undefined, tvdb: undefined };
const PLEX_ACTIVE_EVENTS = ["media.play", "media.resume", "media.progress", "media.pause"];
const PLEX_COMPLETE_EVENTS = ["media.scrobble", "user.playrate"];
const EMBY_ACTIVE_EVENTS = ["playback.start", "playback.unpause"];
const JELLYFIN_ACTIVE_EVENTS = ["PlaybackStart", "PlaybackProgress"];

function normalizeType(value) {
  const type = String(value || "").toLowerCase();
  if (type === "movie") return "movie";
  if (type === "episode" || type === "tvchannel") return "episode";
  return undefined;
}

function normalizeProviderIds(providerIds = {}) {
  const ids = { ...EMPTY_IDS };
  for (const [key, value] of Object.entries(providerIds || {})) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "imdb") ids.imdb = String(value);
    if (normalizedKey === "tmdb") ids.tmdb = String(value);
    if (normalizedKey === "tvdb") ids.tvdb = String(value);
  }
  return ids;
}

function parsePlexGuids(metadata = {}) {
  const ids = { ...EMPTY_IDS };
  const guidEntries = Array.isArray(metadata.Guid) ? metadata.Guid : [];
  const rawGuids = [
    metadata.guid,
    ...guidEntries.map((entry) => (typeof entry === "string" ? entry : entry.id)),
  ].filter(Boolean);

  for (const rawGuid of rawGuids) {
    const guid = String(rawGuid);
    // Flexible parsing supporting both slug styles: proto://id and proto/id
    if (guid.includes("imdb")) ids.imdb = guid.split(/:\/\/|\//).pop();
    if (guid.includes("tmdb")) ids.tmdb = guid.split(/:\/\/|\//).pop();
    if (guid.includes("tvdb")) ids.tvdb = guid.split(/:\/\/|\//).pop();
  }
  return ids;
}

function extractTitle(type, metadata, source) {
  const season = metadata.parentIndex ?? metadata.ParentIndexNumber;
  const episode = metadata.index ?? metadata.IndexNumber;
  const hasEpisodeCoordinates = season != null || episode != null;

  if (source === "plex") {
    if (type === "episode") {
      if (hasEpisodeCoordinates) {
        return `${metadata.grandparentTitle || metadata.title || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`;
      }
      return metadata.grandparentTitle || metadata.title || "Unknown Episode";
    }
    return metadata.title || "Unknown Movie";
  }
  
  // Jellyfin / Emby
  if (type === "episode") {
    if (hasEpisodeCoordinates) {
      return `${metadata.SeriesName || metadata.Name || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`;
    }
    return metadata.SeriesName || metadata.Name || "Unknown Episode";
  }
  return metadata.Name || "Unknown Movie";
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
  const direct = Number(
    values.progress ??
      values.Progress ??
      values.PercentComplete ??
      values.PlayedPercentage ??
      values.PlaybackProgress ??
      values.PlaybackProgressPercentage,
  );
  if (Number.isFinite(direct)) return direct > 1 ? direct : direct * 100;

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
  if (event === "media.stop") return progress >= 90 ? "completed" : "ended";
  if (PLEX_ACTIVE_EVENTS.includes(event)) return "active";
  return "ignored";
}

function phaseFromEmbyEvent(event, json, item) {
  const progress = progressPercentFrom({ ...json, ...item });
  const eventKey = String(event || "").toLowerCase();
  const played = readPlayedState(json, item);
  if (eventKey === "item.markplayed") return "completed";
  if (eventKey === "item.markunplayed") return "unplayed";
  if (["userdata.saved", "userdatasaved", "user data saved", "user.data.saved"].includes(eventKey) && played === true) return "completed";
  if (["userdata.saved", "userdatasaved", "user data saved", "user.data.saved"].includes(eventKey) && played === false) return "unplayed";
  if (eventKey === "playback.pause") return progress >= 90 ? "completed" : "ended";
  if (eventKey === "playback.stop") return progress >= 90 ? "completed" : "ended";
  if (EMBY_ACTIVE_EVENTS.includes(eventKey)) return "active";
  return "ignored";
}

function phaseFromJellyfinEvent(event, json, item) {
  const progress = progressPercentFrom({ ...json, ...item });
  const eventKey = String(event || "").toLowerCase();
  const played = readPlayedState(json, item);
  if (eventKey === "itemmarkedasplayed") return "completed";
  if (eventKey === "itemmarkedasunplayed") return "unplayed";
  if (["userdata.saved", "userdatasaved", "user data saved", "user.data.saved"].includes(eventKey) && played === true) return "completed";
  if (["userdata.saved", "userdatasaved", "user data saved", "user.data.saved"].includes(eventKey) && played === false) return "unplayed";
  if (eventKey === "playbackstop") return progress >= 90 ? "completed" : "ended";
  if (JELLYFIN_ACTIVE_EVENTS.map((activeEvent) => activeEvent.toLowerCase()).includes(eventKey)) return "active";
  return "ignored";
}

function pickWebhookItem(json = {}) {
  return json.Item || json.Metadata || json.MediaItem || json.ItemInfo || {};
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
        poster: plexPosterInfo(metadata, type),
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
      poster: plexPosterInfo(metadata, type),
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

export function parseJellyfinWebhook(json) {
  try {
    const item = pickWebhookItem(json);
    const event = json?.NotificationType || "unknown";
    const type = normalizeType(item.Type || item.MediaType);
    const phase = phaseFromJellyfinEvent(event, json, item);
    const title = extractTitle(type, item, "jellyfin");
    const progress = progressPercentFrom({ ...json, ...item });
    const offsetMs = positionMillisecondsFrom({ ...json, ...item });
    const durationMs = durationMillisecondsFrom({ ...json, ...item });
    const user = json?.UserId || json?.User?.Id || json?.User?.Name || "";

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "jellyfin",
        ids: normalizeProviderIds(item.ProviderIds),
        title: `Jellyfin Raw Event: ${event} - ${title}`,
        season: item.ParentIndexNumber,
        episode: item.IndexNumber,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        poster: embyLikePosterInfo(item, type),
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
      ids: normalizeProviderIds(item.ProviderIds),
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      poster: embyLikePosterInfo(item, type),
      rawPayloadDebug: {
        payloadKeys: Object.keys(json || {}),
        itemKeys: Object.keys(item),
        providerKeys: Object.keys(item.ProviderIds || {}),
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
    const type = normalizeType(item.Type || item.MediaType);
    const phase = phaseFromEmbyEvent(event, json, item);
    const title = extractTitle(type, item, "emby");
    const progress = progressPercentFrom({ ...json, ...item });
    const offsetMs = positionMillisecondsFrom({ ...json, ...item });
    const durationMs = durationMillisecondsFrom({ ...json, ...item });
    const user = json?.UserId || json?.User?.Id || json?.User?.Name || "";

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "emby",
        ids: normalizeProviderIds(item.ProviderIds),
        title: `Emby Raw Event: ${event} - ${title}`,
        season: item.ParentIndexNumber,
        episode: item.IndexNumber,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        poster: embyLikePosterInfo(item, type),
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
      ids: normalizeProviderIds(item.ProviderIds),
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      poster: embyLikePosterInfo(item, type),
      rawPayloadDebug: {
        payloadKeys: Object.keys(json || {}),
        itemKeys: Object.keys(item),
        providerKeys: Object.keys(item.ProviderIds || {}),
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
