function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function requirePlexConfig(config = {}) {
  if (!config.baseUrl || !config.token) {
    throw new Error("Missing Plex baseUrl or token");
  }
}

function plexGuidCandidates(media) {
  const candidates = [];

  if (media.ids?.imdb) {
    candidates.push(`imdb://${media.ids.imdb}`);
    candidates.push(`com.plexapp.agents.imdb://${media.ids.imdb}`);
  }

  if (media.ids?.tmdb) {
    candidates.push(`tmdb://${media.ids.tmdb}`);
    candidates.push(`themoviedb://${media.ids.tmdb}`);
    candidates.push(`com.plexapp.agents.themoviedb://${media.ids.tmdb}`);
  }

  if (media.ids?.tvdb) {
    candidates.push(`tvdb://${media.ids.tvdb}`);
    candidates.push(`thetvdb://${media.ids.tvdb}`);
    candidates.push(`com.plexapp.agents.thetvdb://${media.ids.tvdb}`);
  }

  return [...new Set(candidates)];
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

async function searchPlexFallback(config, media, targetType) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/search`);

  const parsed = parseShowTitle(media.title);
  const queryTitle = (targetType === "show" || targetType === "series") ? parsed.title : media.title;

  url.searchParams.set("query", queryTitle);
  url.searchParams.set("X-Plex-Token", config.token);

  console.log("Plex search fallback started", { query: queryTitle, targetType });
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    console.error("Plex search fallback failed", { status: response.status });
    return undefined;
  }

  const body = await response.json();
  const results = body?.MediaContainer?.Metadata || [];

  const matched = results.find((item) => {
    const itemType = item.type === "series" ? "show" : item.type;
    const expectedType = targetType === "series" ? "show" : targetType;
    if (itemType !== expectedType) return false;

    const expectedTitle = (targetType === "show" || targetType === "series") ? parsed.title : media.title;
    if (!titleMatches(expectedTitle, item.title)) return false;
    if (!yearMatches(media.title, item.year)) return false;

    return true;
  });

  if (matched?.ratingKey) {
    console.log("Plex search fallback matched item", { ratingKey: matched.ratingKey, title: matched.title, year: matched.year });
    return matched;
  }

  return undefined;
}

async function findPlexSeries(config, media) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const candidates = plexGuidCandidates(media);

  for (const guid of candidates) {
    const url = new URL(`${baseUrl}/library/all`);
    url.searchParams.set("guid", guid);
    url.searchParams.set("type", "2"); // 2 is Show/Series in Plex
    url.searchParams.set("X-Plex-Token", config.token);

    console.log("Plex series lookup started", { guid });
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error("Plex series lookup failed", { status: response.status, guid });
      continue;
    }

    const body = await response.json();
    const item = body?.MediaContainer?.Metadata?.find(
      (m) => m.type === "show" || m.type === "series"
    ) || body?.MediaContainer?.Metadata?.[0];

    if (item?.ratingKey) {
      console.log("Plex series lookup matched item", { ratingKey: item.ratingKey, guid });
      return item;
    }
  }

  return searchPlexFallback(config, media, "show");
}

async function findPlexMovie(config, media) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const candidates = plexGuidCandidates(media);

  for (const guid of candidates) {
    const url = new URL(`${baseUrl}/library/all`);
    url.searchParams.set("guid", guid);
    url.searchParams.set("type", "1"); // 1 is Movie in Plex
    url.searchParams.set("X-Plex-Token", config.token);

    console.log("Plex movie lookup started", { guid });
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error("Plex movie lookup failed", { status: response.status, guid });
      continue;
    }

    const body = await response.json();
    const item = body?.MediaContainer?.Metadata?.find(
      (m) => m.type === "movie"
    ) || body?.MediaContainer?.Metadata?.[0];

    if (item?.ratingKey) {
      console.log("Plex movie lookup matched item", { ratingKey: item.ratingKey, guid });
      return item;
    }
  }

  return searchPlexFallback(config, media, "movie");
}

async function findPlexEpisode(config, media) {
  const series = await findPlexSeries(config, media);
  if (!series?.ratingKey) {
    return undefined;
  }

  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/library/metadata/${series.ratingKey}/allLeaves`);
  url.searchParams.set("X-Plex-Token", config.token);

  console.log("Plex episode lookup started via allLeaves", { seriesRatingKey: series.ratingKey });
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    console.error("Plex allLeaves lookup failed", { status: response.status, seriesRatingKey: series.ratingKey });
    return undefined;
  }

  const parsed = parseShowTitle(media.title);
  const season = media.season ?? parsed.season;
  const episodeNum = media.episode ?? parsed.episode;

  const body = await response.json();
  const children = body?.MediaContainer?.Metadata || [];
  const episode = children.find(
    (child) =>
      Number(child.index) === Number(episodeNum) &&
      Number(child.parentIndex) === Number(season)
  );

  if (episode?.ratingKey) {
    console.log("Plex episode matched from series leaves", {
      seriesId: series.ratingKey,
      itemId: episode.ratingKey,
      season,
      episode: episodeNum,
    });
    return episode;
  }

  return undefined;
}

export async function findPlexItem(config, media) {
  if (media.type === "movie") return findPlexMovie(config, media);
  if (media.type === "episode") return findPlexEpisode(config, media);
  return undefined;
}

export async function markPlexPlayed(config, media) {
  try {
    requirePlexConfig(config);

    const item = await findPlexItem(config, media);
    if (!item?.ratingKey) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "plex", status: "not_found" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/scrobble`);
    url.searchParams.set("key", item.ratingKey);
    url.searchParams.set("identifier", "com.plexapp.plugins.library");
    url.searchParams.set("X-Plex-Token", config.token);

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Plex scrobble failed with status ${response.status}`);
    }

    console.log("Plex item marked played", { ratingKey: item.ratingKey });
    return { platform: "plex", status: "fulfilled", itemId: item.ratingKey, httpStatus: response.status };
  } catch (error) {
    console.error("Plex client failed", error);
    throw error;
  }
}

export async function markPlexUnplayed(config, media) {
  try {
    requirePlexConfig(config);

    const item = await findPlexItem(config, media);
    if (!item?.ratingKey) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "plex", status: "not_found" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/unscrobble`);
    url.searchParams.set("key", item.ratingKey);
    url.searchParams.set("identifier", "com.plexapp.plugins.library");
    url.searchParams.set("X-Plex-Token", config.token);

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Plex unscrobble failed with status ${response.status}`);
    }

    console.log("Plex item marked unplayed", { ratingKey: item.ratingKey });
    return { platform: "plex", status: "fulfilled", itemId: item.ratingKey, httpStatus: response.status };
  } catch (error) {
    console.error("Plex client failed", error);
    throw error;
  }
}

export async function setPlexProgress(config, media) {
  try {
    requirePlexConfig(config);

    const item = await findPlexItem(config, media);
    if (!item?.ratingKey) {
      console.log(`[SKIPPED] Match verification failed`);
      return { platform: "plex", status: "not_found" };
    }

    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    if (!positionMs) {
      return { platform: "plex", status: "skipped", detail: "No resume position supplied" };
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/progress`);
    url.searchParams.set("key", item.ratingKey);
    url.searchParams.set("identifier", "com.plexapp.plugins.library");
    url.searchParams.set("time", String(positionMs));
    url.searchParams.set("state", "stopped");
    url.searchParams.set("X-Plex-Token", config.token);

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Plex progress update failed with status ${response.status}`);
    }

    console.log("Plex item resume progress updated", { ratingKey: item.ratingKey, positionMs });
    return { platform: "plex", status: "fulfilled", itemId: item.ratingKey, positionMs, httpStatus: response.status };
  } catch (error) {
    console.error("Plex progress client failed", error);
    throw error;
  }
}
