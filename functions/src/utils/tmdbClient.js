const posterCache = new Map();

function cleanString(value) {
  return String(value || "").trim();
}

function showTitleFrom(title = "") {
  const text = cleanString(title) || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

export async function fetchPosterFromTmdb(row, tmdbApiKey) {
  const keysToCache = [];
  if (row.media_type === "episode") {
    const showTitle = showTitleFrom(row.title);
    keysToCache.push(`tv:title:${showTitle.toLowerCase()}`);
    if (row.tmdb_id) keysToCache.push(`tv:tmdb:${row.tmdb_id}`);
    if (row.imdb_id) keysToCache.push(`tv:imdb:${row.imdb_id}`);
  } else {
    keysToCache.push(`movie:title:${row.title.toLowerCase()}`);
    if (row.tmdb_id) keysToCache.push(`movie:tmdb:${row.tmdb_id}`);
    if (row.imdb_id) keysToCache.push(`movie:imdb:${row.imdb_id}`);
  }

  for (const key of keysToCache) {
    if (posterCache.has(key)) {
      return posterCache.get(key);
    }
  }

  let posterPath = null;

  // Helper to fetch and extract poster_path from tmdb details endpoint
  const getPosterFromDetails = async (type, id) => {
    try {
      const res = await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbApiKey}`);
      if (res.ok) {
        const data = await res.json();
        return data.poster_path || null;
      }
    } catch (e) {
      console.error(`TMDB details fetch failed for ${type}/${id}`, e);
    }
    return null;
  };

  // Helper to fetch and extract poster_path from TMDB find endpoint
  const getPosterFromFind = async (externalId, source) => {
    try {
      const res = await fetch(`https://api.themoviedb.org/3/find/${externalId}?api_key=${tmdbApiKey}&external_source=${source}`);
      if (res.ok) {
        const data = await res.json();
        const firstMatch = (data.movie_results?.[0]) || (data.tv_results?.[0]) || (data.tv_episode_results?.[0]);
        return firstMatch?.poster_path || firstMatch?.still_path || null;
      }
    } catch (e) {
      console.error(`TMDB find fetch failed for ${externalId} via ${source}`, e);
    }
    return null;
  };

  // Helper to search by title
  const getPosterFromSearch = async (type, query) => {
    try {
      const res = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${tmdbApiKey}&query=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        return data.results?.[0]?.poster_path || null;
      }
    } catch (e) {
      console.error(`TMDB search fetch failed for ${type}/${query}`, e);
    }
    return null;
  };

  // 1. Try TMDB ID details lookup
  if (row.tmdb_id) {
    if (row.media_type === "movie") {
      posterPath = await getPosterFromDetails("movie", row.tmdb_id);
    } else {
      posterPath = await getPosterFromDetails("tv", row.tmdb_id);
    }
  }

  // 2. Try IMDB ID find lookup
  if (!posterPath && row.imdb_id) {
    posterPath = await getPosterFromFind(row.imdb_id, "imdb_id");
  }

  // 3. Try TVDB ID find lookup
  if (!posterPath && row.tvdb_id) {
    posterPath = await getPosterFromFind(row.tvdb_id, "tvdb_id");
  }

  // 4. Fallback: Search by title if still no poster found
  if (!posterPath && row.title) {
    if (row.media_type === "movie") {
      posterPath = await getPosterFromSearch("movie", row.title);
    } else {
      const showTitle = showTitleFrom(row.title);
      posterPath = await getPosterFromSearch("tv", showTitle);
    }
  }

  const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;

  for (const key of keysToCache) {
    posterCache.set(key, posterUrl);
  }

  return posterUrl;
}
