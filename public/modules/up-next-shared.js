import { state } from "./state.js?v=1.1.1.8.1";
import { escapeAttribute, slug } from "./utils.js?v=1.1.1.8.1";

function identityValues(item = {}, kind = "tmdb") {
  const capitalized = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return [
    item[`${kind}_id`],
    item[`${kind}Id`],
    item[`show_${kind}_id`],
    item[`show${capitalized}Id`],
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

export function manualShowMatches(show = {}, candidate = {}) {
  const ids = ["tmdb", "tvdb", "imdb"];
  const sameId = ids.some((kind) => {
    const left = identityValues(show, kind);
    const right = identityValues(candidate, kind);
    return left.some((value) => right.includes(value));
  });
  if (sameId) return true;
  const leftTitle = slug(show.title || show.show_title || show.showTitle || "");
  const rightTitle = slug(candidate.title || candidate.show_title || candidate.showTitle || "");
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

export function isShowInUpNext(show = {}) {
  if ((state.upNextManualShows || []).some((candidate) => manualShowMatches(show, candidate))) return true;
  return (state.upNextItems || []).some((candidate) => (
    String(candidate?.media_type || candidate?.mediaType || "").toLowerCase() === "episode"
    && manualShowMatches(show, candidate)
  ));
}

export function upNextShowActionHtml(show = {}) {
  const selected = isShowInUpNext(show);
  const title = show.title || show.show_title || "TV show";
  const action = selected ? "remove" : "add";
  return `
    <button class="action-pill action-pill-ghost media-up-next-show-btn${selected ? " is-added" : ""}" type="button"
      data-up-next-show-add
      data-up-next-show-action="${action}"
      data-up-next-show-title="${escapeAttribute(title)}"
      data-up-next-show-tmdb-id="${escapeAttribute(show.tmdb_id || show.tmdbId || show.show_tmdb_id || "")}"
      data-up-next-show-tvdb-id="${escapeAttribute(show.tvdb_id || show.tvdbId || show.show_tvdb_id || "")}"
      data-up-next-show-imdb-id="${escapeAttribute(show.imdb_id || show.imdbId || show.show_imdb_id || "")}"
      data-up-next-show-poster-url="${escapeAttribute(show.poster_url || show.posterUrl || show.show_poster_url || "")}"
      title="${selected ? "Remove this show from the dashboard Up Next rail" : "Add the next unwatched episode to the dashboard Up Next rail"}">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        ${selected ? '<path d="M3 8h10" />' : '<path d="M8 3v10M3 8h10" />'}
      </svg>
      <span>${selected ? "Remove from <br>Up Next" : "Add to <br>Up Next"}</span>
    </button>
  `;
}
