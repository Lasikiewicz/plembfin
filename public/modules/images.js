import { buildAuthHeaders } from "./auth.js";
import { state } from "./state.js";
import { safeImageUrl, escapeAttribute } from "./utils.js";

// /api/poster resolves most requests from an already-cached DB row or webp
// file (no outbound API call); the actual TMDB fallback downloads are
// throttled server-side (TMDB_POSTER_CONCURRENCY = 8 in server/src/index.js),
// so this only needs to stay under the browser's per-origin connection cap —
// it doesn't need to additionally protect TMDB itself.
const POSTER_LOOKUP_CONCURRENCY = 6;
const POSTER_LOOKUP_PERSISTED_CACHE_KEY = "plembfin:posterLookupCache:v3";
const POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const POSTER_LOOKUP_PERSISTED_CACHE_LIMIT = 800;
const TMDB_POSTER_SIZE = "w342";

export function isCachedStorageImageUrl(value = "") {
  const raw = String(value || "").trim();
  return raw.startsWith("/media/posters/") || raw.startsWith("/media/backdrops/");
}

export function compactPosterUrl(value) {
  const raw = String(value || "").trim();
  if (isCachedStorageImageUrl(raw)) return raw;
  const url = safeImageUrl(raw);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "image.tmdb.org") return "";
  } catch (error) {
    return "";
  }
  return url.replace(/(https:\/\/image\.tmdb\.org\/t\/p\/)original\//i, `$1${TMDB_POSTER_SIZE}/`);
}

// Poster responses are untrusted data. Keep the DOM image sink limited to
// local cached media and TMDB artwork, which are the only sources this module
// is expected to hydrate.
export function safePosterElementUrl(value) {
  const raw = String(value || "").trim();
  if (isCachedStorageImageUrl(raw)) return raw;
  return compactPosterUrl(raw);
}

function persistentPosterCacheKey() {
  const userKey = state.currentUser?.uid || state.currentUser?.email || "local";
  return `${POSTER_LOOKUP_PERSISTED_CACHE_KEY}:${userKey}`;
}

function readPersistentPosterCache() {
  try {
    const raw = localStorage.getItem(persistentPosterCacheKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    return [];
  }
}

// In-memory mirror of the persisted poster cache so each poster resolution
// doesn't pay a full localStorage JSON parse/stringify round trip. Writes are
// debounced and flushed when the page is hidden or unloaded.
let posterCacheMirror = null;
let posterCacheFlushTimer = null;

function flushPosterCacheMirror() {
  if (posterCacheFlushTimer) {
    clearTimeout(posterCacheFlushTimer);
    posterCacheFlushTimer = null;
  }
  if (!posterCacheMirror) return;
  try {
    localStorage.setItem(posterCacheMirror.key, JSON.stringify({ entries: posterCacheMirror.entries }));
  } catch (error) {
    // Poster storage is best-effort; missing entries can still resolve through the API.
  }
}

function schedulePosterCacheFlush() {
  if (posterCacheFlushTimer) return;
  posterCacheFlushTimer = setTimeout(() => {
    posterCacheFlushTimer = null;
    flushPosterCacheMirror();
  }, 500);
}

function posterCacheEntries() {
  const key = persistentPosterCacheKey();
  if (!posterCacheMirror || posterCacheMirror.key !== key) {
    flushPosterCacheMirror();
    posterCacheMirror = { key, entries: readPersistentPosterCache() };
  }
  return posterCacheMirror.entries;
}

window.addEventListener("pagehide", flushPosterCacheMirror);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPosterCacheMirror();
});

export function clearPersistentPosterLookupCache() {
  if (posterCacheFlushTimer) {
    clearTimeout(posterCacheFlushTimer);
    posterCacheFlushTimer = null;
  }
  posterCacheMirror = null;
  try {
    localStorage.removeItem(persistentPosterCacheKey());
  } catch (error) { }
}

export function cachedPosterLookup(posterId) {
  if (!posterId) return undefined;
  if (state.posterLookupCache.has(posterId)) return state.posterLookupCache.get(posterId) || "";

  const now = Date.now();
  const allEntries = posterCacheEntries();
  const entries = allEntries.filter((entry) => now - Number(entry.savedAt || 0) <= POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS);
  if (entries.length !== allEntries.length) {
    posterCacheMirror.entries = entries;
    schedulePosterCacheFlush();
  }
  const cached = entries.find((entry) => entry.id === posterId);
  if (!cached) return undefined;

  const url = typeof cached.url === "string" && isCachedStorageImageUrl(cached.url) ? cached.url : "";
  if (cached.url && !url) {
    posterCacheMirror.entries = entries.filter((entry) => entry.id !== posterId);
    schedulePosterCacheFlush();
    return undefined;
  }
  state.posterLookupCache.set(posterId, url);
  return url;
}

export function rememberPosterLookup(posterId, posterUrl) {
  if (!posterId) return;
  const url = isCachedStorageImageUrl(posterUrl) ? posterUrl : "";
  const savedAt = Date.now();
  state.posterLookupCache.set(posterId, url);

  const entries = posterCacheEntries()
    .filter((entry) => entry.id !== posterId && savedAt - Number(entry.savedAt || 0) <= POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS)
    .concat({ id: posterId, url, savedAt });
  if (entries.length > POSTER_LOOKUP_PERSISTED_CACHE_LIMIT) {
    entries.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    entries.length = POSTER_LOOKUP_PERSISTED_CACHE_LIMIT;
  }
  posterCacheMirror.entries = entries;
  schedulePosterCacheFlush();
}

export function posterServerConfig(source = "") {
  const key = String(source || "").toLowerCase();
  if (key.includes("plex")) return { ...state.savedConfig.plex, source: "plex" };
  if (key.includes("emby")) return { ...state.savedConfig.emby, source: "emby" };
  if (key.includes("jellyfin")) return { ...state.savedConfig.jellyfin, source: "jellyfin" };
  return {};
}

export function configuredImageUrl(path, item = {}) {
  const raw = String(path || "").trim();
  const server = posterServerConfig(item.source);
  const baseUrl = String(server.baseUrl || server.url || "").trim().replace(/\/+$/, "");
  if (!raw || !baseUrl) return "";

  try {
    const url = new URL(raw, `${baseUrl}/`);
    // Credentials never reach the browser (/api/config is redacted), so direct
    // server-image URLs can't carry a token. Plex rejects unauthenticated image
    // requests — bail out so callers use the /api/poster pipeline (which fetches
    // and caches server artwork with the stored token) instead of a 401 <img>.
    // Emby/Jellyfin image endpoints serve without an api_key.
    if (server.source === "plex" && !url.searchParams.has("X-Plex-Token")) return "";
    if (window.location.protocol === "https:" && url.protocol === "http:") return "";
    return url.toString();
  } catch (error) {
    return "";
  }
}

export function posterUrlFor(item = {}) {
  const idValue = item.id != null ? item.id : item.media_key;
  if (idValue != null) {
    const cached = cachedPosterLookup(String(idValue));
    if (cached !== undefined) return cached || "";
  }
  const raw = item.poster_url || item.posterUrl || item.imageUrl || item.thumb || "";
  if (isCachedStorageImageUrl(raw)) return raw;
  if (raw.startsWith("https://img.youtube.com/")) return raw;
  if (idValue != null && !item.prefer_raw_poster) return "";
  if (raw) {
    return configuredImageUrl(raw, item);
  }
  return "";
}

export function posterMarkup(item = {}, className = "media-poster") {
  const url = posterUrlFor(item);
  const label = item.title || "Media poster";
  const idValue = item.id != null ? item.id : item.media_key;
  const posterId = idValue != null ? ` data-poster-id="${escapeAttribute(String(idValue))}"` : "";
  if (!url) return `<span class="${className} poster-fallback"${posterId} aria-hidden="true"></span>`;
  const loading = item.eager_poster ? "eager" : "lazy";
  return `<img class="${className}"${posterId} src="${escapeAttribute(url)}" alt="${escapeAttribute(label)} poster" loading="${loading}" decoding="async" fetchpriority="${item.eager_poster ? "high" : "auto"}" referrerpolicy="no-referrer" />`;
}

export function posterFallbackElement(className = "media-poster", posterId = "") {
  const fallback = document.createElement("span");
  fallback.className = `${className} poster-fallback`.trim();
  fallback.setAttribute("aria-hidden", "true");
  if (posterId) fallback.dataset.posterId = posterId;
  return fallback;
}

export async function lookupPosterUrl(posterId, { fallback = false } = {}) {
  if (!posterId) return "";
  if (!fallback) {
    const cached = cachedPosterLookup(posterId);
    if (cached !== undefined) return cached || "";
  }
  if (!state.token) {
    return "";
  }

  const cacheKey = fallback ? `${posterId}:fallback` : posterId;
  let lookup = state.posterLookupInflight.get(cacheKey);
  if (!lookup) {
    const url = new URL("/api/poster", window.location.origin);
    url.searchParams.set("id", posterId);
    if (fallback) url.searchParams.set("fallback", "1");
    lookup = fetch(url, { headers: buildAuthHeaders(state.token) })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (response.status === 404) {
          return "MISSING";
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        if (!body.url) {
          return "MISSING";
        }
        const usableUrl = compactPosterUrl(body.url);
        if (usableUrl || fallback) return usableUrl;
        return lookupPosterUrl(posterId, { fallback: true });
      })
      .catch((error) => {
        console.warn("Poster lookup failed", error);
        return "ERROR";
      })
      .finally(() => state.posterLookupInflight.delete(cacheKey));
    state.posterLookupInflight.set(cacheKey, lookup);
  }

  const posterUrl = await lookup;
  if (posterUrl === "ERROR") {
    return "";
  }
  const finalUrl = posterUrl === "MISSING" ? "" : posterUrl;
  rememberPosterLookup(posterId, finalUrl || "");
  return finalUrl || "";
}

function shouldHydratePosterElement(element) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  return rect.bottom >= -120 && rect.right >= -120 && rect.top <= viewportHeight + 360 && rect.left <= viewportWidth + 120;
}

export async function hydratePosterFallbacks(container = document.body) {
  if (!container) return;
  const fallbacks = [...container.querySelectorAll("[data-poster-id].poster-fallback")].filter((fallback) => {
    const posterId = fallback.dataset.posterId;
    return posterId && !state.posterLookupCache.has(posterId) && shouldHydratePosterElement(fallback);
  });
  if (!fallbacks.length) return;

  const hydrateOne = async (fallback) => {
    const posterId = fallback.dataset.posterId;
    if (!posterId || state.posterLookupCache.has(posterId)) return;

    const posterUrl = await lookupPosterUrl(posterId);
    const safeUrl = safePosterElementUrl(posterUrl);
    if (!safeUrl || !fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

    const image = document.createElement("img");
    image.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
    bindPosterImageErrorHandler(image);
    image.src = encodeURI(safeUrl);
    image.alt = `${fallback.getAttribute("aria-label") || "Media poster"}`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.dataset.posterId = posterId;
    fallback.replaceWith(image);
  };

  const workers = Array.from({ length: Math.min(POSTER_LOOKUP_CONCURRENCY, fallbacks.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < fallbacks.length; index += POSTER_LOOKUP_CONCURRENCY) {
      await hydrateOne(fallbacks[index]);
    }
  });

  await Promise.allSettled(workers);
}

export function bindPosterImageErrorHandler(image) {
  if (image.dataset.posterErrorBound) return;
  image.dataset.posterErrorBound = "1";
  image.addEventListener("error", async () => {
    const posterId = image.dataset.posterId;
    if (!posterId || image.dataset.posterFallbackAttempted === "1") {
      if (posterId) state.posterLookupCache.set(posterId, "");
      image.replaceWith(posterFallbackElement(image.className, posterId));
      return;
    }

    image.dataset.posterFallbackAttempted = "1";
    const brokenUrl = image.currentSrc || image.src;
    const fallbackUrl = await lookupPosterUrl(posterId, { fallback: true });
    const safeFallbackUrl = safePosterElementUrl(fallbackUrl);
    if (safeFallbackUrl && safeFallbackUrl !== brokenUrl && image.isConnected) {
      image.src = encodeURI(safeFallbackUrl);
      return;
    }

    state.posterLookupCache.set(posterId, "");
    if (image.isConnected) image.replaceWith(posterFallbackElement(image.className, posterId));
  });
}

export function hydratePosterImages(container = document.body) {
  if (!container) return;
  for (const image of container.querySelectorAll("img[data-poster-id]")) {
    bindPosterImageErrorHandler(image);
  }
}

export function hydratePosters(container = document.body) {
  hydratePosterImages(container);
  hydratePosterFallbacks(container).catch(() => { });
}

export function tmdbImage(path, size = "w300") {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

export function tmdbPoster(path, tmdbId = "", mediaType = "") {
  if (!path) return "";
  let url = `/api/tmdb-poster?path=${encodeURIComponent(path)}`;
  if (tmdbId) url += `&tmdbId=${encodeURIComponent(tmdbId)}`;
  if (mediaType) url += `&mediaType=${encodeURIComponent(mediaType)}`;
  return url;
}

export function bestTmdbLogo(tmdbData) {
  const logos = tmdbData?.images?.logos || [];
  const logo = logos.find(l => l.iso_639_1 === "en") || logos.find(l => !l.iso_639_1) || logos[0];
  if (logo) return tmdbImage(logo.file_path, "original");
  return tmdbData?.cached_logo_url || null;
}

export function tmdbProfile(path) {
  return path ? `/api/tmdb-profile?path=${encodeURIComponent(path)}` : "";
}
