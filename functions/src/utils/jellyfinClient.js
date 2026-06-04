function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function requireJellyfinConfig(config = {}) {
  if (!config.baseUrl || !jellyfinApiKey(config) || !config.userId) {
    throw new Error("Missing Jellyfin baseUrl, apiKey, or userId");
  }
}

function jellyfinApiKey(config = {}) {
  return config.apiKey || config.api_key || config.token;
}

function authHeaders(config) {
  const apiKey = jellyfinApiKey(config);
  return {
    Accept: "application/json",
    "X-Emby-Token": apiKey,
    "X-MediaBrowser-Token": apiKey,
  };
}

function providerTerms(ids = {}) {
  return [
    ids.imdb ? `imdb.${ids.imdb}` : undefined,
    ids.tmdb ? `tmdb.${ids.tmdb}` : undefined,
    ids.tvdb ? `tvdb.${ids.tvdb}` : undefined,
  ].filter(Boolean);
}

async function fetchJson(url, config) {
  const response = await fetch(url, { headers: authHeaders(config) });
  if (!response.ok) {
    throw new Error(`Jellyfin request failed with status ${response.status}`);
  }
  return response.json();
}

function extractYear(title) {
  const match = String(title || "").match(/\((\d{4})\)/);
  return match ? Number(match[1]) : undefined;
}

function titleMatches(a, b) {
  const clean = (s) => String(s || "").toLowerCase().replace(/\(\d{4}\)/g, "").trim().replace(/[^a-z0-9]/g, "");
  return clean(a) === clean(b);
}

function yearMatches(dbTitle, resultYear) {
  const dbYear = extractYear(dbTitle);
  if (!dbYear || !resultYear) return true;
  return Number(dbYear) === Number(resultYear);
}

function parseShowTitle(title) {
  const str = String(title || "");
  const regex = /(?:\s*-\s*|\s+)S(\d+)E(\d+)/i;
  const match = str.match(regex);
  if (match) {
    const cleanTitle = str.slice(0, match.index).replace(/\s*-\s*$/, "").trim();
    return {
      title: cleanTitle,
      season: Number(match[1]),
      episode: Number(match[2])
    };
  }
  const cleanTitle = str.replace(/\s*-\s*$/, "").trim();
  return {
    title: cleanTitle,
    season: undefined,
    episode: undefined
  };
}

async function searchJellyfinFallback(config, media, targetType) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Items`);

  const parsed = parseShowTitle(media.title);
  const queryTitle = (targetType === "Series" || targetType === "show") ? parsed.title : media.title;

  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", targetType);
  url.searchParams.set("SearchTerm", queryTitle);
  url.searchParams.set("api_key", jellyfinApiKey(config));

  console.log("Jellyfin search fallback started", { query: queryTitle, targetType });
  try {
    const body = await fetchJson(url, config);
    const results = body?.Items || [];

    const matched = results.find((item) => {
      if (!titleMatches(queryTitle, item.Name)) return false;
      if (!yearMatches(media.title, item.ProductionYear)) return false;
      return true;
    });

    if (matched?.Id) {
      console.log("Jellyfin search fallback matched item", { itemId: matched.Id, name: matched.Name, year: matched.ProductionYear });
      return matched;
    }
  } catch (error) {
    console.error("Jellyfin search fallback failed", error);
  }
  return undefined;
}

async function findByProviderIds(config, media, itemTypes) {
  const baseUrl = trimTrailingSlash(config.baseUrl);

  for (const providerTerm of providerTerms(media.ids)) {
    const url = new URL(`${baseUrl}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", itemTypes);
    url.searchParams.set("Fields", "ProviderIds");
    url.searchParams.set("AnyProviderIdEquals", providerTerm);
    url.searchParams.set("api_key", jellyfinApiKey(config));

    console.log("Jellyfin lookup started", { itemTypes, providerTerm });
    const body = await fetchJson(url, config);
    const [prov, val] = providerTerm.split(".");
    const providerKey = prov.charAt(0).toUpperCase() + prov.slice(1);

    const item = body?.Items?.find((it) => {
      const pIds = it.ProviderIds || {};
      return String(pIds[providerKey] || "").toLowerCase() === String(val).toLowerCase();
    });

    if (item?.Id) {
      console.log("Jellyfin lookup matched item", { itemId: item.Id, providerTerm });
      return item;
    }
  }

  return undefined;
}

async function findEpisode(config, media) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  let series = await findByProviderIds(config, media, "Series");
  if (!series?.Id) {
    series = await searchJellyfinFallback(config, media, "Series");
  }
  if (!series?.Id) {
    return undefined;
  }

  const url = new URL(`${baseUrl}/Items`);
  url.searchParams.set("ParentId", series.Id);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  url.searchParams.set("Fields", "ProviderIds");
  url.searchParams.set("api_key", jellyfinApiKey(config));

  const parsed = parseShowTitle(media.title);
  const season = media.season ?? parsed.season;
  const episodeNum = media.episode ?? parsed.episode;

  const body = await fetchJson(url, config);
  const episode = body?.Items?.find(
    (item) =>
      Number(item.ParentIndexNumber) === Number(season) &&
      Number(item.IndexNumber) === Number(episodeNum),
  );

  if (episode?.Id) {
    console.log("Jellyfin episode matched from series children", {
      seriesId: series.Id,
      itemId: episode.Id,
      season,
      episode: episodeNum,
    });
    return episode;
  }

  return undefined;
}

async function findJellyfinItem(config, media) {
  if (media.type === "movie") {
    let movie = await findByProviderIds(config, media, "Movie");
    if (!movie?.Id) {
      movie = await searchJellyfinFallback(config, media, "Movie");
    }
    return movie;
  }
  if (media.type === "episode") return findEpisode(config, media);
  return undefined;
}

export async function markJellyfinPlayed(config, media) {
  try {
    requireJellyfinConfig(config);

    const item = await findJellyfinItem(config, media);
    if (!item?.Id) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "jellyfin", status: "not_found" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
    url.searchParams.set("api_key", jellyfinApiKey(config));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(`Jellyfin mark played failed with status ${response.status}`);
    }

    console.log("Jellyfin item marked played", { itemId: item.Id });
    return { platform: "jellyfin", status: "fulfilled", itemId: item.Id, httpStatus: response.status };
  } catch (error) {
    console.error("Jellyfin client failed", error);
    throw error;
  }
}

export async function markJellyfinUnplayed(config, media) {
  try {
    requireJellyfinConfig(config);

    const item = await findJellyfinItem(config, media);
    if (!item?.Id) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "jellyfin", status: "not_found" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
    url.searchParams.set("api_key", jellyfinApiKey(config));

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        ...authHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(`Jellyfin mark unplayed failed with status ${response.status}`);
    }

    console.log("Jellyfin item marked unplayed", { itemId: item.Id });
    return { platform: "jellyfin", status: "fulfilled", itemId: item.Id, httpStatus: response.status };
  } catch (error) {
    console.error("Jellyfin client failed", error);
    throw error;
  }
}

export async function setJellyfinProgress(config, media) {
  try {
    requireJellyfinConfig(config);

    const item = await findJellyfinItem(config, media);
    if (!item?.Id) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "jellyfin", status: "not_found" };
    }

    const apiKey = jellyfinApiKey(config);
    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    if (!positionMs) {
      return { platform: "jellyfin", status: "skipped", detail: "No resume position supplied" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
    url.searchParams.set("api_key", apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        PlaybackPositionTicks: positionMs * 10000,
        Played: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Jellyfin progress update failed with status ${response.status}`);
    }

    console.log("Jellyfin item resume progress updated", { itemId: item.Id, positionMs });
    return { platform: "jellyfin", status: "fulfilled", itemId: item.Id, positionMs, httpStatus: response.status };
  } catch (error) {
    console.error("Jellyfin progress client failed", error);
    throw error;
  }
}

export async function fetchJellyfinEpisodes(config, parentId) {
  requireJellyfinConfig(config);
  const apiKey = jellyfinApiKey(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("ParentId", parentId);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  url.searchParams.set("Fields", "ProviderIds,UserData");
  url.searchParams.set("api_key", apiKey);

  const data = await fetchJson(url, config);
  return data?.Items || [];
}

export async function fetchJellyfinWatchedItems(config) {
  requireJellyfinConfig(config);
  const apiKey = jellyfinApiKey(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsPlayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,UserData");
  url.searchParams.set("api_key", apiKey);

  const data = await fetchJson(url, config);
  return data?.Items || [];
}


