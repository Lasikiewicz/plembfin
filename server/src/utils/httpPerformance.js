import path from "node:path";
import compression from "compression";

const STATIC_ASSET_EXTENSIONS = /\.(?:m?js|css|svg|png|jpe?g|webp|gif|ico|webmanifest|woff2?)$/i;

function originFromUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function mediaImageOrigins(config = {}) {
  const urls = [
    config.plex?.baseUrl || config.plex?.serverUrl,
    config.emby?.baseUrl || config.emby?.serverUrl,
    config.jellyfin?.baseUrl || config.jellyfin?.serverUrl,
    config.seerr?.baseUrl,
  ];
  return [...new Set(urls.map(originFromUrl).filter(Boolean))];
}

// The CSP only needs the configured media-server origins. Keep that projection
// memoized, but key it to the settings row so a save in another same-host role
// invalidates it without making provider-resolution work part of every request.
export function createCspImageOriginMemo({ readRevision, loadConfig }) {
  let cachedRevision = Symbol("empty-csp-cache");
  let cachedOrigins = [];

  return async function getCspImageOrigins() {
    const revision = await readRevision();
    if (Object.is(revision, cachedRevision)) return cachedOrigins;

    const config = await loadConfig();
    cachedOrigins = mediaImageOrigins(config);
    cachedRevision = revision;
    return cachedOrigins;
  };
}

// Keep the index and manifest revalidating. Other public assets are also
// explicitly revalidated in 2a; long immutable max-age belongs to phase 2b,
// after the asset-version inventory has passed.
export function setPublicAssetCacheHeaders(response, filePath) {
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName === "index.html" || fileName === "manifest.webmanifest") {
    response.setHeader("Cache-Control", "no-cache");
    return;
  }
  if (STATIC_ASSET_EXTENSIONS.test(fileName)) {
    response.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  }
}

export function createResponseCompression() {
  return compression({
    threshold: 1024,
    filter(request, response) {
      const contentType = String(response.getHeader("Content-Type") || "").toLowerCase();
      if (request.path === "/api/live-updates" || contentType.startsWith("text/event-stream")) return false;
      return compression.filter(request, response);
    },
  });
}
