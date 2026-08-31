import {
  escapeAttribute,
  escapeHtml,
  episodeCode,
  movieHref,
  movieTmdbHref,
  slug,
  tvShowTmdbHref,
  tvShowTvdbHref,
} from "./utils.js?v=20260824h";
import { posterMarkup, posterOverflowMenu, proxiedArtworkUrl, tmdbPoster } from "./images.js?v=20260831m";

function normalizedType(item = {}) {
  const raw = String(item.media_type || item.mediaType || item.type || "").toLowerCase();
  if (["tv", "show", "series", "episode"].includes(raw)) return raw === "episode" ? "episode" : "tv";
  return "movie";
}

function titleFor(item, type) {
  if (type === "episode") return item.show_title || item.showTitle || item.title || "Unknown show";
  return item.title || item.name || "Untitled";
}

function episodeDetailHref(showHref, item = {}) {
  const season = Number(item.season ?? item.seasonNumber);
  const episode = Number(item.episode ?? item.episodeNumber);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) return showHref;
  return `${showHref}/season/${season}/episode/${episode}`;
}

export function mediaCardHref(item = {}) {
  if (item.href) return String(item.href);
  const type = normalizedType(item);
  const title = titleFor(item, type);
  if (type === "movie") {
    return item.tmdb_id || item.tmdbId
      ? movieTmdbHref(item.tmdb_id || item.tmdbId, title)
      : movieHref({ ...item, title });
  }
  const showTmdbId = item.show_tmdb_id || item.showTmdbId || "";
  const showTvdbId = item.show_tvdb_id || item.showTvdbId || "";
  if (showTmdbId) return episodeDetailHref(tvShowTmdbHref(showTmdbId, title), item);
  if (showTvdbId) return episodeDetailHref(tvShowTvdbHref(showTvdbId, title), item);
  return episodeDetailHref(`/tvshow/${encodeURIComponent(slug(title))}`, item);
}

function mediaYear(item = {}) {
  return String(item.year || item.release_date || item.first_air_date || "").slice(0, 4);
}

function mediaPoster(item = {}, type = "movie") {
  const raw = item.poster_url || item.posterUrl || item.imageUrl || item.poster || "";
  const showPoster = item.show_poster_url || item.showPosterUrl || item.canonical_poster_url || item.canonicalPosterUrl || "";
  // A TV/show card represents the series, so a saved show override must win
  // over the stale poster that may still be carried by a personal-media row.
  // Episode cards are the exception: their own poster can be a still and must
  // remain independent from the show's shared poster.
  if (type === "tv" && showPoster) return proxiedArtworkUrl(showPoster, "poster");
  if (raw) return proxiedArtworkUrl(raw, "poster");
  if (showPoster) return proxiedArtworkUrl(showPoster, "poster");
  const path = item.poster_path || item.posterPath || "";
  if (!path) return "";
  const tmdbId = item.tmdb_id || item.tmdbId || (item.source === "TMDB" ? item.id : "");
  return tmdbPoster(path, tmdbId, type === "episode" ? "tv" : type);
}

export function normalizeMediaCardRecord(item = {}, options = {}) {
  const type = normalizedType(item);
  const title = titleFor(item, type);
  const tmdbId = item.tmdb_id || item.tmdbId || (item.source === "TMDB" ? item.id : "") || "";
  const tvdbId = item.tvdb_id || item.tvdbId || "";
  const poster = mediaPoster(item, type);
  const meta = options.meta
    || item.meta
    || (type === "episode" && item.season != null && item.episode != null
      ? episodeCode(item.season, item.episode)
      : [mediaYear(item), item.media_label || item.mediaLabel].filter(Boolean).join(" · "));
  return {
    ...item,
    id: item.id || (tmdbId ? `tmdb:${type}:${tmdbId}` : undefined),
    title,
    media_type: type,
    tmdb_id: tmdbId,
    tvdb_id: tvdbId,
    poster_url: poster,
    show_poster_url: item.show_poster_url || item.showPosterUrl || item.canonical_poster_url || item.canonicalPosterUrl || "",
    prefer_raw_poster: Boolean(poster),
    href: mediaCardHref({ ...item, title, tmdb_id: tmdbId, tvdb_id: tvdbId, media_type: type }),
    meta,
    description: options.description ?? item.overview ?? item.description ?? "",
  };
}

export function renderMediaCard(item = {}, options = {}) {
  const record = normalizeMediaCardRecord(item, options);
  const variant = String(options.variant || "default").replace(/[^a-z0-9_-]/gi, "-");
  const cardClass = ["shared-media-card", variant && `shared-media-card--${variant}`, options.compact && "is-compact"]
    .filter(Boolean)
    .join(" ");
  const href = record.href;
  const poster = posterMarkup(record, "shared-media-card-poster-image");
  const menuHtml = options.menuMode
    ? posterOverflowMenu(record, {
      menuMode: options.menuMode,
      mediaType: record.media_type === "tv" ? "tv" : "movie",
      title: record.title,
      label: record.title,
      watchlisted: Boolean(options.watchlisted),
    })
    : "";
  const title = escapeHtml(record.title);
  const meta = record.meta ? `<span class="shared-media-card-meta">${escapeHtml(record.meta)}</span>` : "";
  const description = record.description
    ? `<p class="shared-media-card-description">${escapeHtml(record.description)}</p>`
    : "";
  const badges = [];
  if (options.badge) badges.push(options.badge);
  if (record.source && options.showSource !== false) badges.push(record.source);
  if (record.vote_average && Number(record.vote_average) > 0) badges.push(`★ ${Number(record.vote_average).toFixed(1)}`);
  const badgesHtml = badges.length
    ? `<div class="shared-media-card-badges">${badges.map((badge) => `<span class="status-pill status-muted">${escapeHtml(badge)}</span>`).join("")}</div>`
    : "";
  const status = options.status || record.status || "";
  const statusHtml = status ? `<span class="shared-media-card-status">${escapeHtml(status)}</span>` : "";
  const actions = options.actionsHtml || "";

  return `
    <article class="${cardClass}" data-media-card-type="${escapeAttribute(record.media_type)}">
      <div class="shared-media-card-poster-wrap">
        <a class="shared-media-card-poster" href="${escapeAttribute(href)}" data-media-card-href="${escapeAttribute(href)}" aria-label="View ${escapeAttribute(record.title)}">
          ${poster}
        </a>
        ${menuHtml}
      </div>
      <div class="shared-media-card-body">
        <a class="shared-media-card-title" href="${escapeAttribute(href)}" data-media-card-href="${escapeAttribute(href)}" title="${escapeAttribute(record.title)}">${title}</a>
        ${meta}
        ${statusHtml}
        ${badgesHtml}
        ${description}
        ${actions ? `<div class="shared-media-card-actions">${actions}</div>` : ""}
      </div>
    </article>
  `;
}
