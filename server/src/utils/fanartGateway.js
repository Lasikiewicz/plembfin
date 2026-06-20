import { loadMediaConfig } from "./configStore.js";

const PROJECT_KEY = "bab936b0927ec594f22c16cef458f742";
const API_ROOT = "https://webservice.fanart.tv/v3";

async function userKey() {
  const config = await loadMediaConfig();
  return String(config.fanart?.apiKey || "").trim();
}

async function fetchFanart(path) {
  const clientKey = await userKey();
  const url = new URL(`${API_ROOT}/${path}`);
  url.searchParams.set("api_key", PROJECT_KEY);
  if (clientKey) url.searchParams.set("client_key", clientKey);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  return response.json().catch(() => null);
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
