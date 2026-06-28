import { loadMediaConfig } from "./configStore.js";

const PROJECT_KEY = "bab936b0927ec594f22c16cef458f742";
const API_ROOT = "https://webservice.fanart.tv/v3";

async function userKey() {
  const config = await loadMediaConfig();
  return String(config.fanart?.apiKey || "").trim();
}

async function fetchFanart(path) {
  const clientKey = await userKey();
  const request = async (apiKey, extra = {}) => {
    const url = new URL(`${API_ROOT}/${path}`);
    url.searchParams.set("api_key", apiKey);
    for (const [key, value] of Object.entries(extra)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  };

  const projectResult = await request(PROJECT_KEY, clientKey ? { client_key: clientKey } : {});
  if (projectResult || !clientKey) return projectResult;
  return request(clientKey);
}

function bestImage(arr = []) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const sorted = [...arr].sort((a, b) => {
    const langScore = (x) => (x.lang === "en" ? 2 : x.lang === "" ? 1 : 0);
    return (Number(b.likes) || 0) + langScore(b) - ((Number(a.likes) || 0) + langScore(a));
  });
  return sorted[0]?.url || null;
}

export async function getFanartMovieArt(tmdbId) {
  if (!tmdbId) return null;
  try {
    const data = await fetchFanart(`movies/${tmdbId}`);
    if (!data) return null;
    return {
      poster: bestImage(data.movieposter),
      backdrop: bestImage(data.moviebackground),
      logo: bestImage(data.hdmovielogo || data.movielogo),
    };
  } catch {
    return null;
  }
}

export async function getFanartTvArt(tvdbId) {
  if (!tvdbId) return null;
  try {
    const data = await fetchFanart(`tv/${tvdbId}`);
    if (!data) return null;
    return {
      poster: bestImage(data.tvposter),
      backdrop: bestImage(data.showbackground || data.tvbackground),
      logo: bestImage(data.hdtvlogo || data.clearlogo),
    };
  } catch {
    return null;
  }
}

function allImages(arr = []) {
  if (!Array.isArray(arr)) return [];
  return [...arr]
    .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
    .map(x => ({ url: x.url, lang: x.lang || "" }));
}

export async function getAllFanartMovieImages(tmdbId) {
  if (!tmdbId) return null;
  try {
    const data = await fetchFanart(`movies/${tmdbId}`);
    if (!data) return null;
    return {
      posters: allImages(data.movieposter),
      logos: allImages([...(data.hdmovielogo || []), ...(data.movielogo || [])]),
      backdrops: allImages(data.moviebackground),
    };
  } catch {
    return null;
  }
}

export async function getAllFanartTvImages(tvdbId) {
  if (!tvdbId) return null;
  try {
    const data = await fetchFanart(`tv/${tvdbId}`);
    if (!data) return null;
    return {
      posters: allImages(data.tvposter),
      logos: allImages([...(data.hdtvlogo || []), ...(data.clearlogo || [])]),
      backdrops: allImages([...(data.showbackground || []), ...(data.tvbackground || [])]),
    };
  } catch {
    return null;
  }
}
