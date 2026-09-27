import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// History, Posters only: episode name, watched date and app over the bottom of
// each folded poster (public/modules/history-poster-overlay.js, theme-styles
// step 15).

const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
const { historyPosterOverlay } = await import("../public/modules/history-poster-overlay.js");

const episode = { id: 1, media_type: "episode", watched_at: "2026-09-20T19:30:00Z", source: "jellyfin" };

test("an episode shows its name, the watched date and the app badge", () => {
  const html = historyPosterOverlay(episode, "The <One> & Only");
  assert.match(html, /^<div class="history-poster-overlay">/);
  assert.match(html, /class="history-poster-overlay-episode" title="The &lt;One&gt; &amp; Only">The &lt;One&gt; &amp; Only<\/div>/);
  assert.match(html, /<time class="history-poster-overlay-date" datetime="2026-09-20T19:30:00Z"/);
  assert.match(html, /2026<\/time>/, "the date shows the day without the time");
  assert.match(html, /class="source-badge source-badge--icon/);
});

test("a movie has no episode line", () => {
  const html = historyPosterOverlay({ ...episode, media_type: "movie" }, false);
  assert.doesNotMatch(html, /history-poster-overlay-episode/);
  assert.match(html, /history-poster-overlay-date/);
});

test("a missing date or app does not break the overlay", () => {
  const html = historyPosterOverlay({ media_type: "movie" }, "");
  assert.match(html, />Unknown<\/time>/);
  assert.doesNotMatch(html, /source-badge/);
});

test("all three History views put the overlay on the poster and refresh its episode name", () => {
  const source = read("public/modules/explorer.js");
  assert.match(source, /import \{ historyPosterOverlay \} from "\.\/history-poster-overlay\.js\?v=/);
  for (const poster of ["history-grid-poster", "history-list-poster", "history-page-poster"]) {
    assert.ok(source.includes(`\${posterMarkup(entry, "${poster}")}\${historyPosterOverlay(entry, isEpisode && epTitle)}`), `${poster} has no overlay`);
  }
  assert.ok(source.includes(":is(.history-card-episode, .history-poster-overlay-episode)"));
  assert.match(read("public/modules/tmdb.js"), /for \(const target of element\?\.forEach \? element : \[element\]\)/);
});

test("the overlay shows only on folded History posters, over a blur", () => {
  const css = read("public/styles.css");
  assert.match(css, /\n\.history-poster-overlay \{\s*display: none;/);
  for (const selector of [
    ".page-card-mode-compact .history-grid-view .history-grid-card:not(.page-card-open) .history-poster-overlay,",
    ".page-card-mode-compact .history-list .history-page-card:not(.page-card-open) .history-poster-overlay,",
    ".page-card-mode-compact .history-table-view .history-list-row:not(.page-card-open) > .history-poster-overlay,",
    // Playlist episode posters share the same overlay.
    ".page-card-mode-compact .personal-media-list-row > .shared-media-card:not(.page-card-open) .playlist-poster-overlay {",
  ]) assert.ok(css.includes(selector), `missing: ${selector}`);
  assert.match(css, /backdrop-filter: blur\(8px\)/);
  assert.match(css, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  assert.match(css, /-webkit-line-clamp: 2;/);
});
