function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function requireEmbyConfig(config = {}) {
  if (!config.baseUrl || !config.apiKey || !config.userId) {
    throw new Error("Missing Emby baseUrl, apiKey, or userId");
  }
}

function authHeaders(config) {
  return {
    Accept: "application/json",
    "X-Emby-Token": config.apiKey,
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
    throw new Error(`Emby request failed with status ${response.status}`);
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

async function searchEmbyFallback(config, media, targetType) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Items`);

  const parsed = parseShowTitle(media.title);
  const queryTitle = (targetType === "Series" || targetType === "show") ? parsed.title : media.title;

  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", targetType);
  url.searchParams.set("SearchTerm", queryTitle);
  url.searchParams.set("api_key", config.apiKey);

  console.log("Emby search fallback started", { query: queryTitle, targetType });
  try {
    const body = await fetchJson(url, config);
    const results = body?.Items || [];

    const matched = results.find((item) => {
      if (!titleMatches(queryTitle, item.Name)) return false;
      if (!yearMatches(media.title, item.ProductionYear)) return false;
      return true;
    });

    if (matched?.Id) {
      console.log("Emby search fallback matched item", { itemId: matched.Id, name: matched.Name, year: matched.ProductionYear });
      return matched;
    }
  } catch (error) {
    console.error("Emby search fallback failed", error);
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
    url.searchParams.set("api_key", config.apiKey);

    console.log("Emby lookup started", { itemTypes, providerTerm });
    const body = await fetchJson(url, config);
    const [prov, val] = providerTerm.split(".");
    const providerKey = prov.charAt(0).toUpperCase() + prov.slice(1);

    const item = body?.Items?.find((it) => {
      const pIds = it.ProviderIds || {};
      return String(pIds[providerKey] || "").toLowerCase() === String(val).toLowerCase();
    });

    if (item?.Id) {
      console.log("Emby lookup matched item", { itemId: item.Id, providerTerm });
      return item;
    }
  }

  return undefined;
}

async function findEpisode(config, media) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  let series = await findByProviderIds(config, media, "Series");
  if (!series?.Id) {
    series = await searchEmbyFallback(config, media, "Series");
  }
  if (!series?.Id) {
    return undefined;
  }

  const url = new URL(`${baseUrl}/Items`);
  url.searchParams.set("ParentId", series.Id);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  url.searchParams.set("Fields", "ProviderIds");
  url.searchParams.set("api_key", config.apiKey);

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
    console.log("Emby episode matched from series children", {
      seriesId: series.Id,
      itemId: episode.Id,
      season,
      episode: episodeNum,
    });
    return episode;
  }

  return undefined;
}

async function findEmbyItem(config, media) {
  if (media.type === "movie") {
    let movie = await findByProviderIds(config, media, "Movie");
    if (!movie?.Id) {
      movie = await searchEmbyFallback(config, media, "Movie");
    }
    return movie;
  }
  if (media.type === "episode") return findEpisode(config, media);
  return undefined;
}

export async function markEmbyPlayed(config, media) {
  try {
    requireEmbyConfig(config);

    const item = await findEmbyItem(config, media);
    if (!item?.Id) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "emby", status: "not_found" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
    url.searchParams.set("api_key", config.apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(config),
    });
    if (!response.ok) {
      throw new Error(`Emby mark played failed with status ${response.status}`);
    }

    console.log("Emby item marked played", { itemId: item.Id });
    return { platform: "emby", status: "fulfilled", itemId: item.Id, httpStatus: response.status };
  } catch (error) {
    console.error("Emby client failed", error);
    throw error;
  }
}

export async function markEmbyUnplayed(config, media) {
  try {
    requireEmbyConfig(config);

    const item = await findEmbyItem(config, media);
    if (!item?.Id) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "emby", status: "not_found" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
    url.searchParams.set("api_key", config.apiKey);

    const response = await fetch(url, {
      method: "DELETE",
      headers: authHeaders(config),
    });
    if (!response.ok) {
      throw new Error(`Emby mark unplayed failed with status ${response.status}`);
    }

    console.log("Emby item marked unplayed", { itemId: item.Id });
    return { platform: "emby", status: "fulfilled", itemId: item.Id, httpStatus: response.status };
  } catch (error) {
    console.error("Emby client failed", error);
    throw error;
  }
}

export async function setEmbyProgress(config, media) {
  try {
    requireEmbyConfig(config);

    const item = await findEmbyItem(config, media);
    if (!item?.Id) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "emby", status: "not_found" };
    }

    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    if (!positionMs) {
      return { platform: "emby", status: "skipped", detail: "No resume position supplied" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
    url.searchParams.set("api_key", config.apiKey);

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
      throw new Error(`Emby progress update failed with status ${response.status}`);
    }

    console.log("Emby item resume progress updated", { itemId: item.Id, positionMs });
    return { platform: "emby", status: "fulfilled", itemId: item.Id, positionMs, httpStatus: response.status };
  } catch (error) {
    console.error("Emby progress client failed", error);
    throw error;
  }
}

export async function fetchEmbyEpisodes(config, parentId) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("ParentId", parentId);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  url.searchParams.set("Fields", "ProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("api_key", config.apiKey);

  const data = await fetchJson(url, config);
  return data?.Items || [];
}

export async function fetchEmbyWatchedItems(config, { limit = 0 } = {}) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsPlayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("SortBy", "DatePlayed");
  url.searchParams.set("SortOrder", "Descending");
  if (Number(limit) > 0) url.searchParams.set("Limit", String(Math.max(1, Math.round(Number(limit)))));
  url.searchParams.set("api_key", config.apiKey);

  const data = await fetchJson(url, config);
  return data?.Items || [];
}
