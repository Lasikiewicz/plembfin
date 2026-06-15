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

    const matched = results.filter((item) => {
      if (!titleMatches(queryTitle, item.Name)) return false;
      if (!yearMatches(media.title, item.ProductionYear)) return false;
      return true;
    });

    if (matched.length > 0) {
      console.log("Jellyfin search fallback matched items", { count: matched.length, itemIds: matched.map(i => i.Id) });
      return matched;
    }
  } catch (error) {
    console.error("Jellyfin search fallback failed", error);
  }
  return [];
}

async function findByProviderIds(config, media, itemTypes) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const allMatched = new Map();

  for (const providerTerm of providerTerms(media.ids)) {
    const url = new URL(`${baseUrl}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", itemTypes);
    url.searchParams.set("Fields", "ProviderIds");
    url.searchParams.set("AnyProviderIdEquals", providerTerm);
    url.searchParams.set("api_key", jellyfinApiKey(config));

    console.log("Jellyfin lookup started", { itemTypes, providerTerm });
    try {
      const body = await fetchJson(url, config);
      const [prov, val] = providerTerm.split(".");
      const providerKey = prov.charAt(0).toUpperCase() + prov.slice(1);

      const items = body?.Items?.filter((it) => {
        const pIds = it.ProviderIds || {};
        return String(pIds[providerKey] || "").toLowerCase() === String(val).toLowerCase();
      }) || [];

      for (const item of items) {
        if (item?.Id) {
          allMatched.set(item.Id, item);
        }
      }
    } catch (error) {
      console.error(`Jellyfin lookup failed for providerTerm: ${providerTerm}`, error);
    }
  }

  const results = Array.from(allMatched.values());
  if (results.length > 0) {
    console.log("Jellyfin lookup matched items", { count: results.length, itemIds: results.map(i => i.Id) });
    return results;
  }

  return [];
}

async function findEpisode(config, media) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  let seriesList = await findByProviderIds(config, media, "Series");
  if (!seriesList || seriesList.length === 0) {
    seriesList = await searchJellyfinFallback(config, media, "Series");
  }
  if (!seriesList || seriesList.length === 0) {
    return [];
  }

  const parsed = parseShowTitle(media.title);
  const season = media.season ?? parsed.season;
  const episodeNum = media.episode ?? parsed.episode;

  const matchedEpisodes = [];

  for (const series of seriesList) {
    const url = new URL(`${baseUrl}/Items`);
    url.searchParams.set("ParentId", series.Id);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", "Episode");
    url.searchParams.set("Fields", "ProviderIds");
    url.searchParams.set("api_key", jellyfinApiKey(config));

    try {
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
        matchedEpisodes.push(episode);
      }
    } catch (error) {
      console.error(`Failed to fetch episodes for series ${series.Id}`, error);
    }
  }

  return matchedEpisodes;
}

async function findJellyfinItems(config, media) {
  if (media.type === "movie") {
    let movies = await findByProviderIds(config, media, "Movie");
    if (!movies || movies.length === 0) {
      movies = await searchJellyfinFallback(config, media, "Movie");
    }
    return movies;
  }
  if (media.type === "episode") return findEpisode(config, media);
  return [];
}

export async function markJellyfinPlayed(config, media) {
  try {
    requireJellyfinConfig(config);

    const items = await findJellyfinItems(config, media);
    if (!items || items.length === 0) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "jellyfin", status: "not_found" };
    }

    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
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
        throw new Error(`Jellyfin mark played failed with status ${response.status} for item ${item.Id}`);
      }
      console.log("Jellyfin item marked played", { itemId: item.Id });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "jellyfin", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    console.error("Jellyfin client failed", error);
    throw error;
  }
}

export async function markJellyfinUnplayed(config, media) {
  try {
    requireJellyfinConfig(config);

    const items = await findJellyfinItems(config, media);
    if (!items || items.length === 0) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "jellyfin", status: "not_found" };
    }

    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
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
        throw new Error(`Jellyfin mark unplayed failed with status ${response.status} for item ${item.Id}`);
      }
      console.log("Jellyfin item marked unplayed", { itemId: item.Id });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "jellyfin", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    console.error("Jellyfin client failed", error);
    throw error;
  }
}

export async function setJellyfinProgress(config, media) {
  try {
    requireJellyfinConfig(config);

    const items = await findJellyfinItems(config, media);
    if (!items || items.length === 0) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "jellyfin", status: "not_found" };
    }

    const apiKey = jellyfinApiKey(config);
    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    if (!positionMs) {
      return { platform: "jellyfin", status: "skipped", detail: "No resume position supplied" };
    }

    let lastHttpStatus = 200;
    const progressJobs = items.map(async (item) => {
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
        throw new Error(`Jellyfin progress update failed with status ${response.status} for item ${item.Id}`);
      }
      console.log("Jellyfin item resume progress updated", { itemId: item.Id, positionMs });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(progressJobs);
    return { platform: "jellyfin", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), positionMs, httpStatus: lastHttpStatus };
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
  url.searchParams.set("Fields", "ProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("api_key", apiKey);

  const data = await fetchJson(url, config);
  return data?.Items || [];
}

export async function fetchJellyfinWatchedItems(config, { limit = 0 } = {}) {
  requireJellyfinConfig(config);
  const apiKey = jellyfinApiKey(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsPlayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("SortBy", "DatePlayed");
  url.searchParams.set("SortOrder", "Descending");
  if (Number(limit) > 0) url.searchParams.set("Limit", String(Math.max(1, Math.round(Number(limit)))));
  url.searchParams.set("api_key", apiKey);

  const data = await fetchJson(url, config);
  return data?.Items || [];
}
