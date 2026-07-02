import { state } from "./state.js";
import { buildAuthHeaders } from "./auth.js";
import { escapeHtml, escapeAttribute, slug, formatTmdbDate } from "./utils.js";
import { tmdbImage, tmdbPoster, tmdbProfile } from "./images.js";
import { fetchTmdbDetails } from "./tmdb.js?v=20260626";

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export function renderCastSection(tmdbData) {
  const cast = tmdbData?.credits?.cast || [];
  if (!cast.length) return "";
  return `
    <section class="seasons-section cast-section">
      <div class="show-section-title"><h3>Cast</h3></div>
      <div class="cast-compact-row cast-scroll-row">
        ${cast.slice(0, 20).map((actor) => {
    const avatarUrl = tmdbProfile(actor.profile_path) || "/favicon.svg";
    return `
            <div class="cast-member-card" style="cursor: pointer;" data-person-id="${actor.id}" data-person-name="${escapeAttribute(actor.name)}">
              <img class="cast-avatar-img" src="${escapeAttribute(avatarUrl)}" alt="${escapeAttribute(actor.name)}" data-err="fav" />
              <span class="cast-actor-name">${escapeHtml(actor.name)}</span>
              <span class="cast-character-name">${escapeHtml(actor.character)}</span>
            </div>
          `;
  }).join("")}
      </div>
    </section>
  `;
}
export function renderTrailersReviewsSection(tmdbData) {
  if (!tmdbData) return "";
  const trailers = (tmdbData.videos?.results || []).filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"));
  const reviews = tmdbData.reviews?.results || [];
  let html = "";
  if (trailers.length > 0) {
    html += `
      <section class="seasons-section trailers-section">
        <div class="show-section-title"><h3>Trailers & Clips</h3><span>${trailers.length} available</span></div>
        <div class="horizontal-scroll-row trailer-scroll-row" style="margin-top: 0.5rem;">
          ${trailers.map((video) => `
            <div class="trailer-card">
              <div class="trailer-thumb-container" data-video-key="${video.key}" data-video-name="${escapeAttribute(video.name)}">
                <img class="trailer-thumb" src="https://img.youtube.com/vi/${video.key}/mqdefault.jpg" alt="${escapeAttribute(video.name)}" data-err="fav" />
                <div class="play-overlay"><svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
              </div>
              <span class="trailer-title" title="${escapeAttribute(video.name)}">${escapeHtml(video.name)}</span>
            </div>
          `).join("")}
        </div>
      </section>
    `;
  }
  if (reviews.length > 0) {
    html += `
      <section class="seasons-section reviews-section">
        <div class="show-section-title"><h3>Reviews</h3><span>${reviews.length} reviews</span></div>
        <div class="review-list" style="margin-top: 0.5rem;">
          ${reviews.slice(0, 3).map((review) => {
      const hasLong = review.content?.length > 300;
      return `
              <div class="review-card">
                <div class="review-header">
                  <span class="review-author">${escapeHtml(review.author)}</span>
                  ${review.author_details?.rating ? `<span class="review-rating">★ ${review.author_details.rating}/10</span>` : ""}
                </div>
                <div class="review-content-wrapper"><p class="review-content">${escapeHtml(review.content)}</p></div>
                ${hasLong ? `<button class="action-pill review-toggle-btn" type="button">Read More</button>` : ""}
              </div>
            `;
    }).join("")}
        </div>
      </section>
    `;
  }
  return html;
}
export function renderRelatedShowsSection(tmdbData) {
  const related = tmdbData?.similar?.results || [];
  if (!related.length) return "";
  return `
    <section class="seasons-section related-section">
      <div class="show-section-title"><h3>Related Shows</h3></div>
      <div class="horizontal-scroll-row" style="margin-top: 0.5rem;">
        ${related.slice(0, 20).map((item) => {
    const poster = tmdbPoster(item.poster_path) || "/favicon.svg";
    const year = (item.first_air_date || "").slice(0, 4);
    return `
            <a class="season-poster-card related-show-card" data-immersive-related-tmdb="${item.id}" href="/tvshow/tmdb/${item.id}">
              <img class="season-poster-img" src="${escapeAttribute(poster)}" alt="${escapeAttribute(item.name || "")}" data-err="fav" />
              <span class="season-poster-name">${escapeHtml(item.name || "")}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
            </a>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

function recommendationTitle(item = {}, mediaType = "movie") {
  if (!item) return "";
  return mediaType === "tv" ? (item.name || item.original_name || "") : (item.title || item.original_title || "");
}

function recommendationDate(item = {}, mediaType = "movie") {
  if (!item) return "";
  return mediaType === "tv" ? (item.first_air_date || "") : (item.release_date || "");
}

export function rankedRecommendations(tmdbData, mediaType = "movie", { includeSource = false } = {}) {
  const ranked = [];
  const add = (items = [], sourceRank = 0) => {
    items.forEach((item, index) => {
      if (!item?.id) return;
      ranked.push({ ...item, _sourceRank: sourceRank, _sourceIndex: index });
    });
  };

  if (includeSource && tmdbData?.id) add([tmdbData], 0);
  add(tmdbData?.similar?.results || [], includeSource ? 1 : 0);
  add(tmdbData?.recommendations?.results || [], includeSource ? 2 : 1);

  const byId = new Map();
  for (const item of ranked) {
    const key = String(item.id);
    const existing = byId.get(key);
    if (!existing || item._sourceRank < existing._sourceRank || (item._sourceRank === existing._sourceRank && item._sourceIndex < existing._sourceIndex)) {
      byId.set(key, item);
    }
  }

  return [...byId.values()]
    .sort((a, b) => a._sourceRank - b._sourceRank || a._sourceIndex - b._sourceIndex)
    .filter((item) => recommendationTitle(item, mediaType));
}

function titleCandidatesForTvRecommendations(movieTitle, tmdbData = null) {
  const candidates = [];
  const add = (title) => {
    const cleaned = String(title || "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned && !candidates.some((candidate) => slug(candidate) === slug(cleaned))) candidates.push(cleaned);
  };

  add(tmdbData?.title);
  add(tmdbData?.original_title);
  add(movieTitle);
  for (const title of [...candidates]) {
    const colonBase = title.split(":")[0]?.trim();
    if (colonBase && colonBase.length >= 4) add(colonBase);
  }
  return candidates.slice(0, 4);
}

function titlesLookRelated(movieTitle, tvTitle) {
  const movieSlug = slug(movieTitle || "");
  const tvSlug = slug(tvTitle || "");
  if (!movieSlug || !tvSlug) return false;
  return movieSlug === tvSlug || movieSlug.startsWith(`${tvSlug}-`) || tvSlug.startsWith(`${movieSlug}-`) || movieSlug.includes(tvSlug) || tvSlug.includes(movieSlug);
}

export async function recommendedTvShowsForMovie(movieTitle, tmdbData = null) {
  for (const candidate of titleCandidatesForTvRecommendations(movieTitle, tmdbData)) {
    const tvData = await fetchTmdbDetails("tv", null, candidate).catch(() => null);
    if (!tvData) continue;
    const tvTitle = recommendationTitle(tvData, "tv");
    if (!tvData.id || !titlesLookRelated(candidate, tvTitle)) continue;
    return rankedRecommendations(tvData, "tv", { includeSource: true }).slice(0, 15);
  }
  return [];
}

export function renderRecommendationSection({ title, items = [], mediaType = "movie" }) {
  if (!items.length) return "";
  const isTv = mediaType === "tv";
  return `
        <section class="seasons-section">
          <h3>${escapeHtml(title)}</h3>
          <div class="horizontal-scroll-row">
            ${items.slice(0, 15).map((item) => {
    const itemTitle = recommendationTitle(item, mediaType);
    const year = recommendationDate(item, mediaType).slice(0, 4);
    const poster = item.poster_path ? tmdbPoster(item.poster_path, item.id, mediaType) : "/favicon.svg";
    return `
                  <a class="season-poster-card" ${isTv ? `data-immersive-related-tmdb="${escapeAttribute(String(item.id))}" href="/tvshow/tmdb/${escapeAttribute(String(item.id))}"` : `data-immersive-movie-id="${escapeAttribute(String(item.id))}" href="/movie/tmdb/${escapeAttribute(String(item.id))}"`}>
                    <img class="season-poster-img" src="${escapeAttribute(poster)}" alt="${escapeAttribute(itemTitle)}" data-err="fav" />
                    <span class="season-poster-name">${escapeHtml(itemTitle)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
                  </a>
                `;
  }).join("")}
          </div>
        </section>
      `;
}
export function renderRichTmdbDetails(tmdbData) {
  return renderTrailersReviewsSection(tmdbData);
}
export function renderMediaImagesSection(tmdbData) {
  if (!tmdbData?.images) return "";
  const seen = new Set();
  const dedupe = (imgs) => imgs.filter((img) => {
    if (!img.file_path || seen.has(img.file_path)) return false;
    seen.add(img.file_path);
    return true;
  });
  // Prefer language-neutral backdrops (no text overlay); fall back to all if too few.
  const raw = tmdbData.images.backdrops || [];
  const clean = dedupe(raw.filter((img) => !img.iso_639_1));
  const backdrops = (clean.length >= 3 ? clean : dedupe(raw))
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
    .slice(0, 20);
  if (!backdrops.length) return "";
  return `
    <section class="seasons-section media-images-section">
      <div class="show-section-title"><h3>Images</h3><span>${backdrops.length} available</span></div>
      <div class="media-images-scroll-row">
        ${backdrops.map((img, i) => {
    const thumb = tmdbImage(img.file_path, "w780");
    const full = tmdbImage(img.file_path, "original");
    return `<button class="media-image-card" type="button" data-lightbox-index="${i}" data-lightbox-src="${escapeAttribute(full)}">
            <img class="media-image-thumb" src="${escapeAttribute(thumb)}" alt="Scene image" loading="lazy" data-err="hide-parent" />
          </button>`;
  }).join("")}
      </div>
    </section>
  `;
}
export function renderCollectionSection(tmdbData) {
  if (!tmdbData) return "";
  const collection = tmdbData.belongs_to_collection;
  if (!collection || !collection.id) return "";
  return `
    <section class="seasons-section collection-section">
      <div class="show-section-title"><h3>Collection</h3></div>
      <div class="horizontal-scroll-row" style="margin-top: 0.5rem;">
        <div class="season-poster-card collection-card" data-collection-id="${collection.id}" style="text-align: center; padding: 0.5rem; opacity: 0.7;">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">📚</div>
          <span class="season-poster-name">${escapeHtml(collection.name || "Collection")}</span>
          <span style="display: block; margin-top: 0.25rem; font-size: 0.8rem; color: var(--muted);">View collection</span>
        </div>
      </div>
    </section>
  `;
}

export function renderMediaFacts(tmdbData, mediaType = "movie", placement = "inline") {
  if (!tmdbData) return "";
  const providers = tmdbData["watch/providers"]?.results?.GB?.flatrate || tmdbData["watch/providers"]?.results?.US?.flatrate || [];
  const runtime = mediaType === "movie"
    ? (tmdbData.runtime ? `${tmdbData.runtime} min` : "")
    : (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min episodes` : "");
  const facts = [
    ["Status", tmdbData.status],
    [mediaType === "movie" ? "Release" : "First aired", formatTmdbDate(tmdbData.release_date || tmdbData.first_air_date)],
    ["Runtime", runtime],
    ["Language", String(tmdbData.original_language || "").toUpperCase()],
    ["Genres", (tmdbData.genres || []).map((genre) => genre.name).join(", ")],
    ["Network", (tmdbData.networks || []).map((network) => network.name).join(", ")],
    ["Streaming", providers.map((provider) => provider.provider_name).join(", ")],
  ].filter(([, value]) => value);
  if (!facts.length) return "";
  const wideLabels = new Set(["Streaming", "Network"]);
  const tmdbId = tmdbData.id || tmdbData.tmdb_id || "";
  const imdbId = tmdbData.imdb_id || tmdbData.external_ids?.imdb_id || "";
  const tvdbId = tmdbData.external_ids?.tvdb_id || "";
  const title = mediaType === "tv" ? (tmdbData.name || tmdbData.original_name || "") : (tmdbData.title || tmdbData.original_title || "");
  return `<aside class="media-facts-rail ${placement === "sidebar" ? "media-facts-rail--sidebar" : ""}" aria-label="Media facts">${facts.map(([label, value]) => `
    <div class="media-fact${wideLabels.has(label) ? " media-fact--wide" : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
  `).join("")}
    <div class="media-fact media-fact--wide media-app-links" data-media-app-links
      data-media-type="${escapeAttribute(mediaType)}"
      data-tmdb-id="${escapeAttribute(String(tmdbId))}"
      data-imdb-id="${escapeAttribute(String(imdbId))}"
      data-tvdb-id="${escapeAttribute(String(tvdbId))}"
      data-title="${escapeAttribute(title)}"></div>
  </aside>`;
}

export async function hydrateMediaAppLinks(root = document) {
  const containers = [...root.querySelectorAll("[data-media-app-links]")];
  if (!containers.length) return;

  await Promise.all(containers.map(async (container) => {
    if (container.dataset.loaded === "true") return;
    container.dataset.loaded = "true";

    const params = new URLSearchParams();
    params.set("mediaType", container.dataset.mediaType || "movie");
    for (const [param, attr] of [["tmdbId", "tmdbId"], ["imdbId", "imdbId"], ["tvdbId", "tvdbId"], ["title", "title"]]) {
      const value = container.dataset[attr] || "";
      if (value) params.set(param, value);
    }

    const greyedOutHtml = `
      <span>Open in</span>
      <b class="media-app-link-row">
        <a class="media-app-link media-app-link--plex media-app-link--disabled" title="Checking Plex..." aria-label="Checking Plex..." style="opacity: 0.4; cursor: not-allowed;">
          <img class="media-app-link-logo" src="/icons/plex.svg" alt="" loading="lazy" data-err="hide-show-next" />
          <span>Plex</span>
        </a>
        <a class="media-app-link media-app-link--emby media-app-link--disabled" title="Checking Emby..." aria-label="Checking Emby..." style="opacity: 0.4; cursor: not-allowed;">
          <img class="media-app-link-logo" src="/icons/emby.svg" alt="" loading="lazy" data-err="hide-show-next" />
          <span>Emby</span>
        </a>
        <a class="media-app-link media-app-link--jellyfin media-app-link--disabled" title="Checking Jellyfin..." aria-label="Checking Jellyfin..." style="opacity: 0.4; cursor: not-allowed;">
          <img class="media-app-link-logo" src="/icons/jellyfin.svg" alt="" loading="lazy" data-err="hide-show-next" />
          <span>Jellyfin</span>
        </a>
      </b>
    `;

    container.innerHTML = greyedOutHtml;

    try {
      const response = await fetch(`/api/media-app-links?${params.toString()}`, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.links)) return;
      const links = body.links;
      const linkMap = new Map(links.map((link) => [link.target, link]));

      const activeLinkHtml = [...linkMap.values()].map((link) => `
        <a class="media-app-link media-app-link--${escapeAttribute(link.target || "")}" href="${escapeAttribute(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeAttribute(`Open in ${link.label}`)}" aria-label="${escapeAttribute(`Open in ${link.label}`)}">
          ${link.iconUrl ? `<img class="media-app-link-logo" src="${escapeAttribute(link.iconUrl)}" alt="" loading="lazy" data-err="hide-show-next" />` : ""}
          <span>${escapeHtml(link.label)}</span>
        </a>
      `).join("");

      if (activeLinkHtml) {
        container.innerHTML = `
          <span>Open in</span>
          <b class="media-app-link-row">
            ${activeLinkHtml}
          </b>
        `;
      }
    } catch {
      // App links are optional; leave the greyed-out versions if lookup fails.
    }
  }));
}
export function tmdbTitleUrl(mediaType, tmdbId) {
  const id = String(tmdbId || "");
  if (!id) return "";
  return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${encodeURIComponent(id)}`;
}
export function ratingPillHtml({ label, value = "View", href = "", title = "" } = {}) {
  if (!label || !href) return "";
  return `
    <a class="rating-pill rating-pill-link" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttribute(title || `${label} rating`)}">
      <span>${escapeHtml(label)}</span>
      <span>${escapeHtml(value)}</span>
    </a>
  `;
}
export function tvAvailabilityLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available = Number(status.availableEpisodes || 0);
  if (!total) return status.available ? "Available" : "";
  if (available >= total) return `${available}/${total} Available in 1080p`;
  if (available > 0) return `${available}/${total} Available in 1080p`;
  return "";
}
export function tvAvailability4kLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available4k = Number(status.available4kEpisodes || 0);
  if (!total) return status.available4k ? "Available in 4K" : "";
  if (available4k >= total) return `${available4k}/${total} Available in 4K`;
  if (available4k > 0) return `${available4k}/${total} Available in 4K`;
  return "";
}
export function tvSeasonAvailability(status = {}, seasonNumber) {
  return (status.seasons || []).find((season) => Number(season.seasonNumber) === Number(seasonNumber)) || null;
}
export function episodeResolutionPillHtml(status = {}, seasonNumber, episodeNumber) {
  const label = status.episodeResolutions?.[`${seasonNumber}|${episodeNumber}`];
  if (!label) return "";
  return `<span class="season-availability-pill episode-resolution-pill ${label === "4K" ? "is-4k" : ""}">${escapeHtml(label)}</span>`;
}
export function tvSeasonAvailabilityHtml(status = {}, seasonNumber, watchedInSeason = 0) {
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  if (!season || !Number(season.released || season.total || 0)) return "";
  const total = Number(season.released || season.total || 0);
  const available = Number(season.available || 0);
  const available4k = Number(season.available4k || 0);
  // Episodes already watched clearly weren't "missing" to the user, even if the
  // library/Seerr status hasn't caught up — don't flag them red on that basis alone.
  const effectiveAvailable = Math.min(total, Math.max(available, Number(watchedInSeason) || 0));
  const availabilityText = available >= total ? `All ${total} available` : `${available}/${total} available`;
  const fourKText = available4k >= total ? `All ${total} in 4K` : available4k > 0 ? `${available4k}/${total} in 4K` : "";
  const availabilityClass = effectiveAvailable >= total ? "is-complete" : effectiveAvailable > 0 ? "is-partial" : "is-missing";
  return `
    <span class="season-availability-pill ${availabilityClass}">${escapeHtml(availabilityText)}</span>
    ${fourKText ? `<span class="season-availability-pill is-4k ${available4k >= total ? "is-complete" : "is-partial"}">${escapeHtml(fourKText)}</span>` : ""}
  `;
}
export function renderSeasonSeerrControls(tmdbId, seasonNumber, status = {}) {
  if (!state.seerrConfigured || !tmdbId) return "";
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  const released = Number(season?.released || season?.total || 0);
  const missingStandard = !season || !released || Number(season.available || 0) < released;
  const missing4k = !season || !released || Number(season.available4k || 0) < released;
  const supports4k = state.seerrSupports4k.tv;
  return `
    <span class="season-request-controls">
      ${missingStandard ? `
        <button class="rating-pill seerr-request-btn season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}">
          <span>Request season</span>
        </button>
      ` : ""}
      ${supports4k && missing4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}"
          data-seerr-request-4k="true">
          <span>Request 4K</span>
        </button>
      ` : ""}
    </span>
  `;
}
export function renderSeerrRequestPill(mediaType, tmdbId, localAvailable = false) {
  if (!state.seerrConfigured || !tmdbId) return "";
  const status = state.seerrMediaStatusCache.get(`${mediaType}:${tmdbId}`) || {};
  const isTv = mediaType === "tv";
  const isAvailable = Boolean(status.available);
  const supports4k = mediaType === "movie" ? state.seerrSupports4k.movie : state.seerrSupports4k.tv;
  const seerrBaseUrl = String(state.savedConfig?.seerr?.baseUrl || "").replace(/\/+$/, "");
  const seerrIconHtml = seerrBaseUrl
    ? `<img class="seerr-request-icon" src="${escapeAttribute(`${seerrBaseUrl}/favicon.ico`)}" alt="" loading="lazy" data-err="hide-show-next" />`
    : "";
  const iconAndFallback = `${seerrIconHtml}<span class="seerr-request-fallback" aria-hidden="true">S</span>`;
  const tvAvailableLabel = isTv ? tvAvailabilityLabel(status) : "";
  const tv4kLabel = isTv ? tvAvailability4kLabel(status) : "";
  return `
    <span id="seerrRequestContainer" style="display: inline-flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;" data-media-type="${escapeAttribute(mediaType)}" data-tmdb-id="${escapeAttribute(String(tmdbId))}" data-local-available="${localAvailable}">
      ${isAvailable ? `<span class="rating-pill seerr-owned-pill">${escapeHtml(isTv ? tvAvailableLabel || "Available" : "Available in 1080p")}</span>` : tvAvailableLabel ? `<span class="rating-pill seerr-owned-pill seerr-owned-pill-partial">${escapeHtml(tvAvailableLabel)}</span>` : `
        <button class="rating-pill seerr-request-btn" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}">
          ${iconAndFallback}
          <span>${status.pending ? "Requested on Seerr" : "Request on Seerr"}</span>
        </button>
      `}
      ${tv4kLabel ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k ${status.available4k ? "" : "seerr-owned-pill-partial"}">${escapeHtml(tv4kLabel)}</span>
      ` : supports4k && !status.available4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-request-4k="true">
          ${iconAndFallback}
          <span>${status.pending4k ? "4K Requested" : "Request 4K"}</span>
        </button>
      ` : status.available4k ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k">${escapeHtml(isTv ? tv4kLabel || "Available in 4K" : "Available in 4K")}</span>
      ` : ""}
    </span>
  `;
}
export function fetchSeerrMediaStatus(mediaType, tmdbId) {
  if (!state.seerrConfigured || !tmdbId) return Promise.resolve(null);
  const cacheKey = `${mediaType}:${tmdbId}`;
  if (state.seerrMediaStatusCache.get(cacheKey)?.loading) return Promise.resolve(null);
  state.seerrMediaStatusCache.set(cacheKey, { ...(state.seerrMediaStatusCache.get(cacheKey) || {}), loading: true });
  return fetch(`/api/seerr/media-status?mediaType=${encodeURIComponent(mediaType)}&mediaId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() })
    .then((response) => response.json().then((body) => ({ response, body })).catch(() => ({ response, body: {} })))
    .then(({ response, body }) => {
      if (!response.ok || !body.ok) throw new Error(body.error || `Seerr status failed with ${response.status}`);
      state.seerrMediaStatusCache.set(cacheKey, { ...body, loading: false });
      return body;
    })
    .catch(() => {
      state.seerrMediaStatusCache.set(cacheKey, { loading: false });
      return null;
    });
}
export function refreshActiveMediaDetailAfterSeerrStatus(mediaType, tmdbId) {
  const container = document.getElementById("seerrRequestContainer");
  if (container && container.getAttribute("data-media-type") === mediaType && String(container.getAttribute("data-tmdb-id")) === String(tmdbId)) {
    const localAvailable = container.getAttribute("data-local-available") === "true";
    container.outerHTML = renderSeerrRequestPill(mediaType, tmdbId, localAvailable);
  }
}
export function renderExternalRatingPills(mediaType, tmdbData, title, rating = "") {
  const tmdbId = tmdbData?.id || tmdbData?.tmdb_id || "";
  const pills = [];
  if (rating) {
    pills.push(ratingPillHtml({
      label: "TMDB",
      value: rating,
      href: tmdbTitleUrl(mediaType, tmdbId),
      title: "Open this title on TMDB",
    }));
  }
  return pills.join("");
}
