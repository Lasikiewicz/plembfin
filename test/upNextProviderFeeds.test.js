import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-feeds-");

const {
  completeUpNextProviderFeed,
  failUpNextProviderFeed,
  getActiveUpNextProviderItemById,
  getUpNextFeedSourceVersion,
  listActiveUpNextProviderItems,
  listUpNextProviderFeedStates,
  recordUpNextProviderFeed,
  redactUpNextProviderError,
  startUpNextProviderFeed,
} = await import("../server/src/utils/upNextRepository.js");

test("provider feed generations keep the last good snapshot through partial failures", () => {
  const first = recordUpNextProviderFeed("emby", "next_up", [{
    Id: "emby-episode-1",
    Type: "Episode",
    Name: "Pilot",
    SeriesName: "Example Show",
    SeriesId: "emby-series-1",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    SeriesProviderIds: { Tmdb: "123" },
    ProviderIds: { Tmdb: "456" },
    PremiereDate: "2026-08-01",
    poster_url: "/media/posters/emby-episode-1.jpg",
  }], { now: 1_000 });

  assert.equal(first.changed, true);
  assert.equal(listActiveUpNextProviderItems().length, 1);
  assert.equal(listActiveUpNextProviderItems()[0].provider_item_id, "emby-episode-1");
  assert.equal(listActiveUpNextProviderItems()[0].poster_url, "/media/posters/emby-episode-1.jpg");
  const firstSourceVersion = getUpNextFeedSourceVersion();

  const acknowledgement = recordUpNextProviderFeed("emby", "next_up", [{
    Id: "emby-episode-1",
    Type: "Episode",
    Name: "Pilot",
    SeriesName: "Example Show",
    SeriesId: "emby-series-1",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    SeriesProviderIds: { Tmdb: "123" },
    ProviderIds: { Tmdb: "456" },
    PremiereDate: "2026-08-01",
    poster_url: "/media/posters/emby-episode-1.jpg",
  }], { now: 1_500 });
  assert.equal(acknowledgement.changed, false);
  assert.equal(getUpNextFeedSourceVersion(), firstSourceVersion);

  const failedGeneration = startUpNextProviderFeed("emby", "next_up", { now: 2_000 });
  failUpNextProviderFeed("emby", "next_up", failedGeneration, new Error("GET /Shows/NextUp?api_key=secret-token failed"), {
    now: 2_100,
    partial: true,
  });

  const failedState = listUpNextProviderFeedStates().find(
    (feed) => feed.provider === "emby" && feed.feed_kind === "next_up",
  );
  assert.equal(failedState.status, "partial");
  assert.equal(failedState.active_generation, acknowledgement.generation);
  assert.equal(failedState.last_success_at, 1_500);
  assert.equal(listActiveUpNextProviderItems()[0].provider_item_id, "emby-episode-1");
  assert.match(failedState.last_error, /api_key=\[redacted\]/);
  assert.doesNotMatch(failedState.last_error, /secret-token/);

  const emptyGeneration = startUpNextProviderFeed("emby", "next_up", { now: 3_000 });
  const completed = completeUpNextProviderFeed("emby", "next_up", emptyGeneration, [], { now: 3_100 });
  assert.equal(completed.itemCount, 0);
  assert.equal(listActiveUpNextProviderItems().length, 0);
  const completedState = listUpNextProviderFeedStates().find(
    (feed) => feed.provider === "emby" && feed.feed_kind === "next_up",
  );
  assert.equal(completedState.status, "succeeded");
  assert.equal(completedState.active_generation, emptyGeneration);
  assert.equal(completedState.item_count, 0);
});

test("provider feed error redaction removes credentials without hiding the useful message", () => {
  const message = redactUpNextProviderError(new Error("request api_key=abc123 for Next Up failed"));
  assert.equal(message, "request api_key=[redacted] for Next Up failed");
});

test("Emby image tags become show poster paths in the provider snapshot", () => {
  recordUpNextProviderFeed("emby", "next_up", [{
    Id: "emby-poster-episode",
    Type: "Episode",
    Name: "Pilot",
    SeriesName: "Example Show",
    SeriesId: "emby-poster-series",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    SeriesPrimaryImageTag: "series-tag",
    ImageTags: { Primary: "episode-tag" },
  }], { now: 4_000 });

  const item = listActiveUpNextProviderItems().find((entry) => entry.provider_item_id === "emby-poster-episode");
  assert.equal(item.show_poster_url, "/Items/emby-poster-series/Images/Primary?tag=series-tag");
  assert.equal(item.poster_url, "/Items/emby-poster-series/Images/Primary?tag=series-tag");
  assert.equal(getActiveUpNextProviderItemById("emby", "emby-poster-episode").provider_item_id, "emby-poster-episode");
});
