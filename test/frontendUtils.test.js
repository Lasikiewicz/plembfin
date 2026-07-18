import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  escapeAttribute,
  formatDuration,
  formatPlaybackClock,
  computeProgress,
  normalizePlatformSource,
  platformName,
  showName,
  episodeCode,
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
  assert.equal(normalizePlatformSource("unknown"), "plex");
  assert.equal(platformName("jellyfin_webhook"), "Jellyfin");
  assert.equal(showName("Harbor Nine - S02E03 - Low Tide"), "Harbor Nine");
  assert.equal(episodeCode(2, 3), "S02E03");
});
