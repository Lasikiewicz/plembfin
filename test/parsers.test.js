import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeHtmlEntities,
  parseEmbyWebhook,
  parseJellyfinWebhook,
  parsePlexGuids,
  parsePlexWebhook,
} from "../server/src/utils/parsers.js";
import { applyTuningConfig, resetTuningForTests } from "../server/src/utils/tuning.js";

function plexForm(event, metadata = {}) {
  const form = new FormData();
  form.set("payload", JSON.stringify({ event, Metadata: { type: "movie", title: "Arrival", ...metadata } }));
  return form;
}

test("parsePlexWebhook derives completed, ended, active, and ignored phases", async () => {
  const scrobble = await parsePlexWebhook(plexForm("media.scrobble", { guid: "tmdb://329865" }));
  assert.equal(scrobble.phase, "completed");
  assert.equal(scrobble.isValid, true);

  const stopEarly = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 89_000 }));
  assert.equal(stopEarly.phase, "ended");

  const stopComplete = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 91_000 }));
  assert.equal(stopComplete.phase, "completed");

  const progress = await parsePlexWebhook(plexForm("media.progress", { duration: 100_000, viewOffset: 45_000 }));
  assert.equal(progress.phase, "active");

  const malformed = await parsePlexWebhook(new FormData());
  assert.equal(malformed.phase, "ignored");
  assert.equal(malformed.isValid, false);
});

test("parseEmbyWebhook derives phase boundaries", () => {
  const base = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 89, ...base }).phase, "ended");
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 91, ...base }).phase, "completed");
  assert.equal(parseEmbyWebhook({ Event: "item.markunplayed", ...base }).phase, "unplayed");
  assert.equal(parseEmbyWebhook({ Event: "playback.progress", ...base }).phase, "active");
  assert.equal(parseEmbyWebhook({ Event: "something.else", ...base }).phase, "ignored");
});

test("Emby and Jellyfin webhooks derive progress from position when a stale zero percentage is present", () => {
  const item = {
    Type: "Movie",
    Name: "Arrival",
    RunTimeTicks: 4_000_000_000,
    ProviderIds: { Tmdb: "329865" },
  };
  const emby = parseEmbyWebhook({
    Event: "playback.stop",
    Progress: 0,
    PlayState: { PositionTicks: 1_000_000_000 },
    Item: item,
  });
  const jellyfin = parseJellyfinWebhook({
    NotificationType: "PlaybackStop",
    PlayedPercentage: 0,
    PlayState: { PositionTicks: 1_000_000_000 },
    Item: item,
  });

  assert.equal(emby.progress, 25);
  assert.equal(emby.phase, "ended");
  assert.equal(jellyfin.progress, 25);
  assert.equal(jellyfin.phase, "ended");
});

test("parseJellyfinWebhook derives phase boundaries", () => {
  const base = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 89, ...base }).phase, "ended");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 91, ...base }).phase, "completed");
  assert.equal(parseJellyfinWebhook({ NotificationType: "ItemMarkUnplayed", ...base }).phase, "unplayed");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackProgress", ...base }).phase, "active");
  assert.equal(parseJellyfinWebhook({ NotificationType: "SomethingElse", ...base }).phase, "ignored");
});

test("parsePlexGuids supports modern and legacy agent formats", () => {
  assert.deepEqual(parsePlexGuids({
    guid: "plex://movie/abc",
    Guid: [
      { id: "imdb://tt2543164" },
      { id: "tmdb://329865" },
      { id: "tvdb://12345" },
    ],
  }), { imdb: "tt2543164", tmdb: "329865", tvdb: "12345" });

  assert.deepEqual(parsePlexGuids({
    Guid: [
      { id: "com.plexapp.agents.imdb://tt0068646?lang=en" },
      { id: "com.plexapp.agents.themoviedb://238?lang=en" },
      { id: "com.plexapp.agents.thetvdb://81189?lang=en" },
    ],
  }), { imdb: "tt0068646?lang=en", tmdb: "238?lang=en", tvdb: "81189?lang=en" });
});

test("decodeHtmlEntities decodes once without double-unescaping", () => {
  assert.equal(decodeHtmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeHtmlEntities("Tom &#38;amp; Jerry"), "Tom &amp; Jerry");
});

test("phase boundaries follow the configured watched threshold", async (t) => {
  t.after(() => resetTuningForTests());

  applyTuningConfig({ watchedThresholdPercent: 70 });

  const stopBelow = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 69_000 }));
  assert.equal(stopBelow.phase, "ended");
  const stopAtThreshold = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 70_000 }));
  assert.equal(stopAtThreshold.phase, "completed");

  const embyBase = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 69, ...embyBase }).phase, "ended");
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 70, ...embyBase }).phase, "completed");

  const jellyfinBase = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 69, ...jellyfinBase }).phase, "ended");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 70, ...jellyfinBase }).phase, "completed");

  applyTuningConfig({ watchedThresholdPercent: 95 });

  const stopBelowHigh = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 94_000 }));
  assert.equal(stopBelowHigh.phase, "ended");
  const stopAtHighThreshold = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 95_000 }));
  assert.equal(stopAtHighThreshold.phase, "completed");

  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 94, ...embyBase }).phase, "ended");
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 95, ...embyBase }).phase, "completed");

  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 94, ...jellyfinBase }).phase, "ended");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 95, ...jellyfinBase }).phase, "completed");
});

test("phase boundaries fall back to the default 90% threshold once tuning is reset", async () => {
  resetTuningForTests();
  const stopBelow = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 89_000 }));
  assert.equal(stopBelow.phase, "ended");
  const stopAt = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 90_000 }));
  assert.equal(stopAt.phase, "completed");
});
