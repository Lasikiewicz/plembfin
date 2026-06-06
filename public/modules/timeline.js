const LOCAL_FETCH_TIMEOUT_MS = 6500;

function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
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

function embyLikePosterUrl(server = {}, item = {}, mediaType = "unknown") {
  const imageTags = item.ImageTags || {};
  const itemId = mediaType === "episode" ? item.SeriesId || item.ParentId || item.Id : item.Id;
  const tag =
    mediaType === "episode"
      ? item.SeriesPrimaryImageTag || item.ParentPrimaryImageTag || imageTags.Primary
      : imageTags.Primary || item.PrimaryImageTag;

  if (!itemId) return "";
  return imagePath(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, { tag });
}

function numberFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function ticksToMilliseconds(value) {
  const ticks = numberFrom(value);
  return ticks ? Math.round(ticks / 10000) : 0;
}

function progressPercent(offsetMs, durationMs) {
  if (!durationMs) return 0;
  return Math.max(0, Math.min(100, Math.round((offsetMs / durationMs) * 100)));
}

function episodeTitle(show, season, episode) {
  const base = String(show || "Unknown Show").trim() || "Unknown Show";
  const seasonText = Number.isFinite(Number(season)) ? String(Number(season)).padStart(2, "0") : "??";
  const episodeText = Number.isFinite(Number(episode)) ? String(Number(episode)).padStart(2, "0") : "??";
  return `${base} - S${seasonText}E${episodeText}`;
}

function parsePlexXml(xmlText = "") {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const nodes = [...doc.querySelectorAll("Video, Track")];
    return nodes.map((node) => {
      const player = node.querySelector("Player");
      const user = node.querySelector("User");
      const mediaType = String(node.getAttribute("type") || node.tagName || "").toLowerCase();
      const state = String(player?.getAttribute("state") || node.getAttribute("state") || "").toLowerCase();
      if (!["movie", "episode", "track"].includes(mediaType) || !["playing", "buffering"].includes(state)) return null;

      const offsetMs = numberFrom(node.getAttribute("viewOffset"));
      const durationMs = numberFrom(node.getAttribute("duration"));
      const season = Number(node.getAttribute("parentIndex") || 0) || null;
      const episode = Number(node.getAttribute("index") || 0) || null;

      const posterPath = mediaType === "episode"
        ? node.getAttribute("grandparentThumb") || node.getAttribute("parentThumb") || node.getAttribute("thumb")
        : node.getAttribute("thumb") || node.getAttribute("grandparentThumb") || node.getAttribute("parentThumb");

      return {
        source: "plex",
        sessionId: player?.getAttribute("machineIdentifier") || node.getAttribute("sessionKey") || node.getAttribute("ratingKey") || node.getAttribute("key") || "",
        title:
          mediaType === "episode"
            ? episodeTitle(node.getAttribute("grandparentTitle") || node.getAttribute("title"), season, episode)
            : mediaType === "track"
              ? [node.getAttribute("grandparentTitle") || node.getAttribute("originalTitle") || "", node.getAttribute("title") || "Unknown Track"].filter(Boolean).join(" - ")
              : node.getAttribute("title") || "Unknown Movie",
        mediaType,
        offsetMs,
        durationMs,
        progress: progressPercent(offsetMs, durationMs),
        season,
        episode,
        posterUrl: imagePath(posterPath),
        client: {
          deviceName: player?.getAttribute("title") || player?.getAttribute("product") || player?.getAttribute("platform") || "",
          userName: user?.getAttribute("title") || "",
        },
        raw: { localFallback: true },
      };
    }).filter(Boolean);
  }

  return [];
}

function isSessionActive(session = {}) {
  const item = session.NowPlayingItem || session.NowPlayingItemInfo || session.Item || session.MediaItem;
  if (!item) return false;

  const playState = session.PlayState || session.PlaybackState || session.PlayerState || {};
  const stateText = String(session.State || session.Status || playState.State || playState.Status || "").toLowerCase();
  const isPaused = Boolean(playState.IsPaused || session.IsPaused);
  const explicitlyStopped = ["stopped", "idle", "paused"].includes(stateText);
  const explicitlyPlaying = Boolean(session.IsPlaying || session.Playing || playState.IsPlaying || playState.PlayMethod || ["playing", "buffering", "transcoding", "directplay", "directstream"].includes(stateText));

  return !isPaused && !explicitlyStopped && explicitlyPlaying;
}

function normalizeEmbyLikeSession(session = {}, source = "unknown", server = {}) {
  if (!isSessionActive(session)) return null;

  const item = session.NowPlayingItem || session.NowPlayingItemInfo || session.Item || session.MediaItem || {};
  const playState = session.PlayState || session.PlaybackState || session.PlayerState || {};
  const rawType = String(item.Type || item.MediaType || session.MediaType || "").toLowerCase();
  const mediaType = rawType === "audio" ? "track" : rawType;
  if (!["movie", "episode", "track"].includes(mediaType)) return null;

  const offsetMs = ticksToMilliseconds(playState.PositionTicks || session.PositionTicks || session.PlaybackPositionTicks || item.PositionTicks);
  const durationMs = ticksToMilliseconds(item.RunTimeTicks || item.DurationTicks || session.RunTimeTicks || session.DurationTicks);
  const season = Number(item.ParentIndexNumber || 0) || null;
  const episode = Number(item.IndexNumber || 0) || null;

  return {
    source,
    sessionId: session.Id || session.SessionId || item.Id || "",
    title:
      mediaType === "episode"
        ? episodeTitle(item.SeriesName || item.ParentName || item.Name || session.SeriesName, season, episode)
        : mediaType === "track"
          ? [item.Artists?.[0] || item.AlbumArtist || "", item.Name || item.Title || "Unknown Track"].filter(Boolean).join(" - ")
          : item.Name || item.Title || session.Name || "Unknown Movie",
    mediaType,
    offsetMs,
    durationMs,
    progress: progressPercent(offsetMs, durationMs),
    season,
    episode,
    posterUrl: embyLikePosterUrl(server, item, mediaType),
    ids: {
      imdb: item.ProviderIds?.Imdb || item.ProviderIds?.IMDb || undefined,
      tmdb: item.ProviderIds?.Tmdb || undefined,
      tvdb: item.ProviderIds?.Tvdb || undefined,
    },
    client: {
      deviceName: session.DeviceName || session.Client || "",
      userName: session.UserName || session.UserId || "",
    },
    raw: { localFallback: true },
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), LOCAL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchPlexLocal(config, logDebug) {
  const plexConfig = config?.plex || {};
  if (plexConfig.disabled) return [];
  const baseUrl = trimTrailingSlash(plexConfig.baseUrl || plexConfig.url);
  const token = String(plexConfig.token || plexConfig.apiKey || "").trim();
  if (!baseUrl || !token) return [];

  const url = new URL(`${baseUrl}/status/sessions`);
  url.searchParams.set("X-Plex-Token", token);
  logDebug("Initiating direct browser request loop to Plex local host address...", { url: `${url.origin}${url.pathname}` });

  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: "application/xml, text/xml, application/json" } });
    const text = await response.text();
    logDebug(`Plex local API returned HTTP ${response.status}`, { bodyPreview: text.slice(0, 800) });
    if (!response.ok) return [];
    return parsePlexXml(text);
  } catch (error) {
    logDebug(`Plex fetch failed. Reason: FETCH_FAILED (${error?.message || "Failed to open socket connection or CORS blocked the local request"})`);
    return [];
  }
}

async function fetchEmbyLikeLocal(config, source, logDebug) {
  const server = config?.[source] || {};
  if (server.disabled) return [];
  const baseUrl = trimTrailingSlash(server.baseUrl || server.url);
  const apiKey = String(server.apiKey || server.api_key || "").trim();
  if (!baseUrl || !apiKey) return [];

  const url = new URL(`${baseUrl}/Sessions`);
  url.searchParams.set("api_key", apiKey);
  logDebug(`Initiating direct browser request loop to ${source} local host address...`, { url: `${url.origin}${url.pathname}` });

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/json",
        "X-Emby-Token": apiKey,
        "X-MediaBrowser-Token": apiKey,
      },
    });
    const text = await response.text();
    logDebug(`${source} local API returned HTTP ${response.status}`, { bodyPreview: text.slice(0, 800) });
    if (!response.ok) return [];

    const json = JSON.parse(text);
    const sessions = Array.isArray(json) ? json : json.Items || json.Sessions || [];
    return sessions.map((session) => normalizeEmbyLikeSession(session, source, server)).filter(Boolean);
  } catch (error) {
    logDebug(`${source} fetch failed. Reason: FETCH_FAILED (${error?.message || "Failed to open socket connection or CORS blocked the local request"})`);
    return [];
  }
}

export async function fetchLocalActiveSessions(config, logDebug = () => {}) {
  const results = await Promise.allSettled([
    fetchPlexLocal(config, logDebug),
    fetchEmbyLikeLocal(config, "emby", logDebug),
    fetchEmbyLikeLocal(config, "jellyfin", logDebug),
  ]);

  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    logDebug(`Local fallback resolver failed for ${["plex", "emby", "jellyfin"][index]}.`, result.reason?.message || String(result.reason));
    return [];
  });
}
