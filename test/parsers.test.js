import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeHtmlEntities,
  parseEmbyWebhook,
  parseJellyfinWebhook,
  parsePlexGuids,
  parsePlexWebhook,
} from "../server/src/utils/parsers.js";

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
