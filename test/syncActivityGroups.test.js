import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-sync-activity-groups-");

const { appendSyncHistory, getSyncActivityGroupsPage, getSyncActivityGroupEvents } = await import("../server/src/utils/configStore.js");

const movieDebug = { ids: { tmdb: "98765" }, mediaKey: "movie:tmdb:98765" };

test("sync activity groups repeated checkpoints and exposes every event", async () => {
  await appendSyncHistory({
    mediaType: "movie",
    title: "Jackass Presents: Bad Grandpa",
    source: "plex",
    status: "success",
    action: "watched",
    targetStates: [{ target: "jellyfin", status: "success" }],
    rawPayloadDebug: movieDebug,
  });
  await appendSyncHistory({
    mediaType: "movie",
    title: "Bad Grandpa (different event label)",
    source: "plex",
    status: "success",
    action: "progress",
    targetStates: [{ target: "trakt", status: "success" }],
    rawPayloadDebug: movieDebug,
  });

  const page = await getSyncActivityGroupsPage({ limit: 25 });
  assert.equal(page.total, 1);
  assert.equal(page.groups.length, 1);
  assert.equal(page.groups[0].title, "Bad Grandpa (different event label)");
  assert.equal(page.groups[0].eventCount, 2);

  const detail = await getSyncActivityGroupEvents({ groupKey: page.groups[0].groupKey, limit: 25 });
  assert.equal(detail.total, 2);
  assert.equal(detail.events.length, 2);
  assert.deepEqual(detail.events.map((event) => event.action), ["progress", "watched"]);
});

test("episode activity groups by show while retaining episode events", async () => {
  const debug = { ids: { tvdb: "oak-123" }, showTitle: "The Curse of Oak Island" };
  await appendSyncHistory({
    mediaType: "episode",
    title: "The Curse of Oak Island - S12E01",
    showTitle: "The Curse of Oak Island",
    season: 12,
    episode: 1,
    source: "trakt",
    status: "success",
    action: "watched",
    rawPayloadDebug: { ...debug, season: 12, episode: 1 },
  });
  await appendSyncHistory({
    mediaType: "episode",
    title: "The Curse of Oak Island - S12E02",
    showTitle: "The Curse of Oak Island",
    season: 12,
    episode: 2,
    source: "trakt",
    status: "success",
    action: "watched",
    rawPayloadDebug: { ...debug, season: 12, episode: 2 },
  });

  const page = await getSyncActivityGroupsPage({ search: "Oak Island", limit: 25 });
  assert.equal(page.total, 1);
  assert.equal(page.groups[0].mediaType, "show");
  assert.equal(page.groups[0].title, "The Curse of Oak Island");
  assert.equal(page.groups[0].eventCount, 2);
  const detail = await getSyncActivityGroupEvents({ groupKey: page.groups[0].groupKey, limit: 25 });
  assert.deepEqual(detail.events.map((event) => event.rawPayloadDebug.episode), [2, 1]);
});
