import { loadLiveTrackingCache as loadLiveTrackingCacheFromDb } from "./firestoreRepo.js";
import { decodeHtmlEntities } from "./parsers.js";

function trimTrailingSlash(value = "") {
  return String(value).trim().replace(/\/+$/, "");
}

function imagePath(path, params = {}) {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return "";

  try {
    const url = new URL(cleanPath, "https://media.local");
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    return "";
  }
}

function plexPosterUrl(attributes = {}, mediaType = "unknown") {
  const path =
    mediaType === "episode"
      ? attributes.grandparentThumb || attributes.parentThumb || attributes.thumb
      : attributes.thumb || attributes.grandparentThumb || attributes.parentThumb;

  return imagePath(path);
}

function embyLikePosterUrl(item = {}, mediaType = "unknown") {
  const imageTags = item.ImageTags || {};
  const itemId = mediaType === "episode" ? item.SeriesId || item.ParentId || item.Id : item.Id;
  const tag =
    mediaType === "episode"
      ? item.SeriesPrimaryImageTag || item.ParentPrimaryImageTag || imageTags.Primary
      : imageTags.Primary || item.PrimaryImageTag;

  if (!itemId) return "";
  return imagePath(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, {
    tag,
  });
}

export function normalizeStoredConfig(stored = {}) {
  return {
    plex: {
      baseUrl: trimTrailingSlash(stored.plex?.baseUrl || stored.plex?.url || ""),
      token: String(stored.plex?.token || stored.plex?.apiKey || "").trim(),
      username: String(stored.plex?.username || "").trim(),
    },
    emby: {
      baseUrl: trimTrailingSlash(stored.emby?.baseUrl || stored.emby?.url || ""),
      apiKey: String(stored.emby?.apiKey || stored.emby?.api_key || "").trim(),
      userId: String(stored.emby?.userId || "").trim(),
    },
    jellyfin: {
      baseUrl: trimTrailingSlash(stored.jellyfin?.baseUrl || stored.jellyfin?.url || ""),
      apiKey: String(stored.jellyfin?.apiKey || stored.jellyfin?.api_key || "").trim(),
      userId: String(stored.jellyfin?.userId || "").trim(),
    },
  };
}

function parseAttributes(chunk = "") {
  const attributes = {};
  const matcher = /([A-Za-z_:][A-Za-z0-9_:\-.]*)="([^"]*)"/g;
  let match;
  while ((match = matcher.exec(chunk))) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function childAttributes(body = "", tagName = "") {
  const matcher = new RegExp(`<${tagName}\\b([^>]*)\\/?\\s*>`, "i");
  const match = body.match(matcher);
  return parseAttributes(match?.[1] || "");
}

function ticksToMilliseconds(value) {
  const ticks = Number(value || 0);
  if (!Number.isFinite(ticks) || ticks <= 0) return 0;
  return Math.round(ticks / 10000);
}

function millisecondsFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function progressPercent(offsetMs, durationMs) {
  if (!durationMs || durationMs <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((offsetMs / durationMs) * 100)));
}

function formatEpisodeTitle(title, season, episode) {
  const base = String(title || "Unknown Show").trim() || "Unknown Show";
  const seasonText = Number.isFinite(Number(season)) ? String(Number(season)).padStart(2, "0") : "??";
  const episodeText = Number.isFinite(Number(episode)) ? String(Number(episode)).padStart(2, "0") : "??";
  return `${base} - S${seasonText}E${episodeText}`;
}

function sessionKey(source, sessionId, fallbackTitle, season, episode) {
  return [source, sessionId || fallbackTitle || "unknown", season ?? "none", episode ?? "none"].join(":");
}

function plexGuidIds(attributes = {}) {
  const guidValues = [attributes.guid, attributes.Guid, attributes.GUID]
    .filter(Boolean)
    .map((value) => String(value));

  return {
    imdb: guidValues.find((value) => value.includes("imdb"))?.split(/:\/\/|\//).pop(),
    tmdb: guidValues.find((value) => value.includes("tmdb"))?.split(/:\/\/|\//).pop(),
    tvdb: guidValues.find((value) => value.includes("tvdb"))?.split(/:\/\/|\//).pop(),
  };
}

function plexTitle(attributes = {}, mediaType = "unknown") {
  if (mediaType === "episode") {
    return formatEpisodeTitle(decodeHtmlEntities(attributes.grandparentTitle || attributes.title), attributes.parentIndex, attributes.index);
  }

  if (mediaType === "track") {
    const artist = decodeHtmlEntities(attributes.grandparentTitle || attributes.originalTitle || "");
    const title = decodeHtmlEntities(attributes.title || "Unknown Track");
    return artist ? `${artist} - ${title}` : title;
  }

  return decodeHtmlEntities(attributes.title) || "Unknown Movie";
}

function parsePlexSessions(xmlText = "", config = {}) {
  const sessions = [];
  const tagMatcher = /<(Video|Track)\b([^>]*)>([\s\S]*?)<\/\1>|<(Video|Track)\b([^>]*)\/>/gi;
  let match;

  while ((match = tagMatcher.exec(xmlText))) {
    const nodeName = String(match[1] || match[4] || "").toLowerCase();
    const attributes = parseAttributes(match[2] || match[5] || "");
    const body = match[3] || "";
    const player = childAttributes(body, "Player");
    const user = childAttributes(body, "User");
    const mediaType = String(attributes.type || nodeName || "").toLowerCase();
    const state = String(player.state || attributes.state || "").toLowerCase();

    if (!["movie", "episode", "track"].includes(mediaType)) continue;
    if (!["playing", "buffering"].includes(state)) continue;

    const offsetMs = millisecondsFrom(attributes.viewOffset);
    const durationMs = millisecondsFrom(attributes.duration);

    sessions.push({
      source: "plex",
      sessionId: player.machineIdentifier || attributes.sessionKey || attributes.ratingKey || attributes.key || "",
      title: plexTitle(attributes, mediaType),
      mediaType,
      offsetMs,
      durationMs,
      progress: progressPercent(offsetMs, durationMs),
      season: Number(attributes.parentIndex || 0) || null,
      episode: Number(attributes.index || 0) || null,
      posterUrl: plexPosterUrl(attributes, mediaType),
      client: {
        deviceName: player.title || player.product || player.platform || "",
        userName: user.title || attributes.user || "",
      },
      ids: plexGuidIds(attributes),
      raw: { attributes, player, user },
    });
  }

  return sessions;
}

function mediaTypeFrom(item = {}, session = {}) {
  const raw = String(item.Type || item.MediaType || session.MediaType || "").toLowerCase();
  if (raw === "audio") return "track";
  return raw;
}

function playStateFrom(session = {}) {
  return session.PlayState || session.PlaybackState || session.PlayerState || {};
}

function isSessionActive(session = {}) {
  const item = session.NowPlayingItem || session.NowPlayingItemInfo || session.Item || session.MediaItem;
  if (!item) return false;

  const playState = playStateFrom(session);
  const stateText = String(
    session.State ||
      session.Status ||
      session.PlaybackState ||
      playState.State ||
      playState.Status ||
      playState.PlaybackState ||
      "",
  ).toLowerCase();
  const isPaused = Boolean(playState.IsPaused || session.IsPaused);
  const positionTicks = Number(playState.PositionTicks || session.PositionTicks || session.PlaybackPositionTicks || 0);
  const hasPlaybackData = Boolean(Object.keys(playState).length || Number.isFinite(positionTicks));
  const explicitlyPlaying = Boolean(session.IsPlaying || session.Playing || playState.IsPlaying || playState.PlayMethod || ["playing", "buffering", "transcoding", "directplay", "directstream"].includes(stateText));
  const explicitlyStopped = ["stopped", "idle", "paused"].includes(stateText);

  return hasPlaybackData && !isPaused && !explicitlyStopped && (explicitlyPlaying || item);
}

function normalizeSessionItem(session = {}, source = "unknown", config = {}) {
  const item = session.NowPlayingItem || session.NowPlayingItemInfo || session.Item || session.MediaItem || {};
  const playState = playStateFrom(session);
  const mediaType = mediaTypeFrom(item, session);

  if (!["movie", "episode", "track"].includes(mediaType)) return null;
  if (!isSessionActive(session)) return null;

  const offsetMs = ticksToMilliseconds(
    playState.PositionTicks ||
      session.PositionTicks ||
      session.PlaybackPositionTicks ||
      item.PositionTicks ||
      item.PlaybackPositionTicks,
  );
  const durationMs = ticksToMilliseconds(item.RunTimeTicks || item.DurationTicks || session.RunTimeTicks || session.DurationTicks);

  return {
    source,
    sessionId: session.Id || session.SessionId || item.Id || "",
    title:
      mediaType === "episode"
        ? formatEpisodeTitle(decodeHtmlEntities(item.SeriesName || item.ParentName || item.Name || session.SeriesName), item.ParentIndexNumber, item.IndexNumber)
        : mediaType === "track"
          ? [decodeHtmlEntities(item.Artists?.[0] || item.AlbumArtist || item.SeriesName || ""), decodeHtmlEntities(item.Name || item.Title || session.Name || "Unknown Track")].filter(Boolean).join(" - ")
        : decodeHtmlEntities(item.Name || item.Title || session.Name || "Unknown Movie"),
    mediaType,
    offsetMs,
    durationMs,
    progress: progressPercent(offsetMs, durationMs),
    season: Number(item.ParentIndexNumber || 0) || null,
    episode: Number(item.IndexNumber || 0) || null,
    posterUrl: embyLikePosterUrl(item, mediaType),
    ids: {
      imdb: item.ProviderIds?.Imdb || item.ProviderIds?.IMDb || undefined,
      tmdb: item.ProviderIds?.Tmdb || undefined,
      tvdb: item.ProviderIds?.Tvdb || undefined,
    },
    client: {
      deviceName: session.DeviceName || session.Client || session.ApplicationVersion || "",
      userName: session.UserName || session.UserId || "",
    },
    raw: session,
  };
}

async function fetchJson(url, headers) {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    return response.json();
  } catch (error) {
    console.error("Live session fetch failed", { url: String(url), error: error?.message || String(error) });
    return null;
  }
}

async function fetchPlexSessions(config) {
  if (!config.plex.baseUrl || !config.plex.token) return [];
  const url = new URL(`${config.plex.baseUrl}/status/sessions`);
  url.searchParams.set("X-Plex-Token", config.plex.token);

  try {
    const response = await fetch(url, { headers: { Accept: "application/xml, text/xml, application/json" } });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const text = await response.text();
    const sessions = parsePlexSessions(text, config.plex);
    return sessions.filter((session) => !config.plex.username || String(session.client?.userName || "").toLowerCase() === String(config.plex.username).toLowerCase());
  } catch (error) {
    console.error("Plex live session fetch failed", { url: String(url), error: error?.message || String(error) });
    return [];
  }
}

async function fetchEmbySessions(config) {
  if (!config.emby.baseUrl || !config.emby.apiKey) return [];
  const url = new URL(`${config.emby.baseUrl}/Sessions`);
  url.searchParams.set("api_key", config.emby.apiKey);
  const json = await fetchJson(url, { Accept: "application/json", "X-Emby-Token": config.emby.apiKey });
  if (!json) return [];
  const sessions = Array.isArray(json) ? json : json.Items || json.Sessions || [];
  return sessions
    .map((session) => normalizeSessionItem(session, "emby", config.emby))
    .filter(Boolean)
    .filter((session) => !config.emby.userId || String(session.raw?.UserId || "").toLowerCase() === String(config.emby.userId).toLowerCase());
}

async function fetchJellyfinSessions(config) {
  if (!config.jellyfin.baseUrl || !config.jellyfin.apiKey) return [];
  const url = new URL(`${config.jellyfin.baseUrl}/Sessions`);
  const headers = {
    Accept: "application/json",
    Authorization: `MediaBrowser Token="${config.jellyfin.apiKey}"`,
    "X-Emby-Token": config.jellyfin.apiKey,
    "X-MediaBrowser-Token": config.jellyfin.apiKey,
  };
  const json = await fetchJson(url, headers);
  if (!json) return [];
  const sessions = Array.isArray(json) ? json : json.Items || json.Sessions || [];
  return sessions
    .map((session) => normalizeSessionItem(session, "jellyfin", config.jellyfin))
    .filter(Boolean)
    .filter((session) => !config.jellyfin.userId || String(session.raw?.UserId || "").toLowerCase() === String(config.jellyfin.userId).toLowerCase());
}

export async function fetchLiveSessions(config) {
  const results = await Promise.allSettled([fetchPlexSessions(config), fetchEmbySessions(config), fetchJellyfinSessions(config)]);
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error("Live session resolver failed", { source: ["plex", "emby", "jellyfin"][index], error: result.reason?.message || String(result.reason) });
    }
  }
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

export async function loadLiveTrackingCache(db, options = {}) {
  return loadLiveTrackingCacheFromDb(db, options);
}

export function buildCacheRow(session) {
  return {
    session_id: sessionKey(session.source, session.sessionId, session.title, session.season, session.episode),
    title: session.title || "Unknown media",
    source_platform: session.source || "unknown",
    last_progress: Number(session.progress || 0),
    updated_at: Date.now(),
    completed_at: null,
    payload_json: JSON.stringify(session),
  };
}

export function sessionIdentity(session) {
  return sessionKey(session.source, session.sessionId, session.title, session.season, session.episode);
}

export function hydrateCachedSession(row = {}) {
  let payload = {};
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch (error) {
      payload = {};
    }
  }
  return {
    ...payload,
    source: row.source_platform || payload.source || "unknown",
    sessionId: row.session_id,
    title: decodeHtmlEntities(row.title || payload.title || "Unknown media"),
    progress: Number(row.last_progress || payload.progress || 0),
    offsetMs: payload.offsetMs || 0,
    durationMs: payload.durationMs || 0,
    mediaType: payload.mediaType || payload.media_type || "unknown",
    season: payload.season ?? null,
    episode: payload.episode ?? null,
    posterUrl: payload.posterUrl || payload.poster_url || "",
    updatedAt: Number(row.updated_at || Date.now()),
    completedAt: row.completed_at || null,
  };
}
