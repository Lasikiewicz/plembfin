import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  escapeAttribute,
  formatDuration,
  formatPlaybackClock,
  computeProgress,
  normalizePlatformSource,
  platformSourceValues,
  platformIconUrl,
  platformIconMarkup,
  sourceBadgeHtml,
  platformName,
  showName,
  episodeCode,
  seasonLabel,
  formatSeasonTitle,
} from "../public/modules/utils.js";

test("frontend escaping utilities encode markup and attribute delimiters", () => {
  assert.equal(escapeHtml(`<a title="Tom & Jerry's">`), "&lt;a title=&quot;Tom &amp; Jerry&#39;s&quot;&gt;");
  assert.equal(escapeAttribute("value` onclick='x'"), "value&#96; onclick=&#39;x&#39;");
});

test("frontend playback formatting clamps progress and renders clocks", () => {
  assert.equal(computeProgress(45_000, 60_000), 75);
  assert.equal(computeProgress(90_000, 60_000), 100);
  assert.equal(computeProgress(-1_000, 60_000), 0);
  assert.equal(formatDuration(3_661_000), "01:01:01");
  assert.equal(formatPlaybackClock(65_000, 3_600_000), "00:01:05 / 01:00:00");
});

test("frontend platform and title helpers normalize user-facing labels", () => {
  assert.equal(normalizePlatformSource("Emby webhook"), "emby");
  assert.equal(normalizePlatformSource("Jellyfin_scheduler"), "jellyfin");
  assert.equal(normalizePlatformSource("force_sync"), "plembfin");
  assert.equal(normalizePlatformSource("plembfin"), "plembfin");
  assert.equal(normalizePlatformSource("unknown"), "plex");
  assert.deepEqual(
    platformSourceValues({ sources: ["jellyfin", "plex"], source: "manual", playHistory: [{ source: "plex_webhook" }] }),
    ["jellyfin", "plex"],
  );
  assert.deepEqual(
    platformSourceValues({ sources: ["manual"], source: "force_sync", playHistory: [{ source: "plembfin" }] }),
    ["plembfin"],
  );
  assert.match(sourceBadgeHtml("plembfin"), /source-plembfin/);
  assert.match(platformIconMarkup("plembfin"), /source-badge-icon-set/);
  assert.match(platformIconMarkup("plembfin"), /plembfin-light\.png\?v=0\.15\.0/);
  assert.match(platformIconMarkup("plembfin"), /plembfin\.png\?v=0\.15\.0/);
  assert.match(sourceBadgeHtml("plembfin"), />Plembfin<\/span>/);
  assert.equal(platformIconUrl("manual"), "/icons/plembfin.png?v=0.15.0");
  assert.equal(platformName("jellyfin_webhook"), "Jellyfin");
  assert.equal(showName("Harbor Nine - S02E03 - Low Tide"), "Harbor Nine");
  assert.equal(episodeCode(2, 3), "S02E03");
  assert.equal(seasonLabel(1), "Season 1");
});

test("formatSeasonTitle preserves season numbers even when custom season titles exist", () => {
  assert.equal(formatSeasonTitle(1, "Fantasy High"), "Season 1 - Fantasy High");
  assert.equal(formatSeasonTitle(2, "Escape from the Bloodkeep"), "Season 2 - Escape from the Bloodkeep");
  assert.equal(formatSeasonTitle(7, "Fantasy High 2: Sophomore Year"), "Season 7 - Fantasy High 2: Sophomore Year");
  assert.equal(formatSeasonTitle(28, "City Council of Darkness"), "Season 28 - City Council of Darkness");
  assert.equal(formatSeasonTitle(29, "Season 29"), "Season 29");
  assert.equal(formatSeasonTitle(1, "Season 1"), "Season 1");
  assert.equal(formatSeasonTitle(1, ""), "Season 1");
  assert.equal(formatSeasonTitle(0, "Specials"), "Specials");
  assert.equal(formatSeasonTitle(0, "Trailers & Extras"), "Specials - Trailers & Extras");
  assert.equal(formatSeasonTitle(3, "Season 3: The Unsleeping City"), "Season 3 - The Unsleeping City");
});
