// A restore-scoped cache for the expensive "find the native item" part of a
// media-server mutation.  The normal provider caches are intentionally
// process-wide and time based; this cache additionally deduplicates identical
// rows while one restore is fanning out, including concurrent requests that
// have not completed their first lookup yet.

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function typeOf(media = {}) {
  return clean(media.type || media.mediaType || media.media_type || "unknown").toLowerCase();
}

function coordinatesFrom(media = {}) {
  const titleMatch = clean(media.title).match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  const season = Number(media.season ?? titleMatch?.[1]);
  const episode = Number(media.episode ?? titleMatch?.[2]);
  return {
    season: Number.isInteger(season) && season >= 0 ? season : "x",
    episode: Number.isInteger(episode) && episode >= 0 ? episode : "x",
  };
}

function showTitleFrom(media = {}) {
  const explicit = clean(media.showTitle || media.show_title || media.seriesTitle || media.grandparentTitle);
  if (explicit) return explicit;
  return clean(media.title).replace(/\s*-?\s*S\d{1,3}E\d{1,3}\b.*$/i, "").trim();
}

function connectionScope(provider, config = {}) {
  const baseUrl = clean(config.baseUrl).replace(/\/+$/, "").toLowerCase();
  const user = clean(config.userId || config.username || "user").toLowerCase();
  return `${provider}|${baseUrl}|${user}`;
}

function identityParts(media = {}) {
  return ["imdb", "tmdb", "tvdb"]
    .map((provider) => `${provider}:${clean(media.ids?.[provider]).toLowerCase()}`)
    .filter((part) => !part.endsWith(":"));
}

function compoundPart(media = {}) {
  const descriptor = media.compound_episode || media.compoundEpisode;
  if (!descriptor) return "";
  const aliases = Array.isArray(descriptor.aliases)
    ? descriptor.aliases
      .map((alias) => `${Number(alias?.season)}:${Number(alias?.episode)}`)
      .sort()
      .join(",")
    : "";
  return `${clean(descriptor.sourceRepresentation || "split")}:${aliases}`;
}

// This key is deliberately based on the source title and coordinates as well
// as provider ids. Provider ids can be absent or can be rematched between
// imported rows; the title/coordinate portion is what lets a restore share the
// same title-fallback work, while ids still keep different remakes apart.
export function restoreLookupKey(provider, config, media = {}) {
  const type = typeOf(media);
  const coordinates = coordinatesFrom(media);
  const title = normalized(type === "episode" ? showTitleFrom(media) : clean(media.title).replace(/\s*\(\d{4}\)\s*$/, ""));
  const year = clean(media.title).match(/\((\d{4})\)/)?.[1] || "x";
  const identity = identityParts(media).join("|") || "identity:x";
  const compound = compoundPart(media);
  return [
    connectionScope(clean(provider).toLowerCase(), config),
    type,
    title || "untitled",
    year,
    `s:${coordinates.season}`,
    `e:${coordinates.episode}`,
    identity,
    compound || "compound:x",
  ].join("|");
}

export function createRestoreLookupCache({ maxEntries = 10_000 } = {}) {
  const values = new Map();
  const inFlight = new Map();
  const limit = Math.max(100, Math.floor(Number(maxEntries) || 10_000));

  const trim = () => {
    while (values.size > limit) values.delete(values.keys().next().value);
  };

  return {
    async resolve(key, media, resolver) {
      const cacheKey = clean(key);
      if (!cacheKey) return resolver();
      if (values.has(cacheKey)) return values.get(cacheKey).value;
      const pending = inFlight.get(cacheKey);
      if (pending) return pending;

      const promise = Promise.resolve().then(resolver);
      inFlight.set(cacheKey, promise);
      try {
        const value = await promise;
        values.set(cacheKey, { media, value });
        trim();
        return value;
      } finally {
        if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
      }
    },
    delete(key) {
      values.delete(clean(key));
    },
    clear() {
      values.clear();
      inFlight.clear();
    },
    get size() {
      return values.size;
    },
  };
}
