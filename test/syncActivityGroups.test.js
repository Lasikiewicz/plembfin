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

test("resolved duplicate item events stop counting as live issues", async () => {
  const identity = { showTitle: "Newest Result Show", season: 1, episode: 1 };
  await appendSyncHistory({
    mediaType: "episode",
    title: "Newest Result Show - S01E01",
    showTitle: "Newest Result Show",
    season: "01",
    episode: "01",
    source: "plex",
    status: "error",
    action: "watched",
    targetStates: [{ target: "jellyfin", status: "error", detail: "Temporary failure" }],
    rawPayloadDebug: { ids: { tvdb: "show-123" }, ...identity },
  });
  await appendSyncHistory({
    mediaType: "episode",
    title: "Newest Result Show - S01E01",
    showTitle: "Newest Result Show",
    source: "plex",
    status: "success",
    action: "watched",
    targetStates: [{ target: "jellyfin", status: "success" }],
    rawPayloadDebug: { ids: { imdb: "tt-show-123" }, ...identity, season: "01", episode: "01" },
  });

  const page = await getSyncActivityGroupsPage({ search: "Newest Result Show", limit: 25 });
  assert.equal(page.total, 1);
  assert.equal(page.groups[0].problemCount, 0);

  const detail = await getSyncActivityGroupEvents({ groupKey: page.groups[0].groupKey, limit: 25 });
  assert.equal(detail.events.length, 2);
  assert.equal(detail.events[0].isLatestForItem, true);
  assert.equal(detail.events[1].isLatestForItem, false);
  const current = await getSyncActivityGroupEvents({ groupKey: page.groups[0].groupKey, limit: 25, latestOnly: true });
  assert.equal(current.total, 1);
  assert.equal(current.events.length, 1);
  assert.equal(current.events[0].status, "success");
});

test("the newest unresolved result is the only live issue for an item", async () => {
  const identity = { showTitle: "Still Failing Show", season: 2, episode: 3 };
  await appendSyncHistory({
    mediaType: "episode",
    title: "Still Failing Show - S02E03",
    showTitle: "Still Failing Show",
    source: "plex",
    status: "error",
    action: "watched",
    targetStates: [{ target: "jellyfin", status: "error" }],
    rawPayloadDebug: { ids: { tvdb: "show-456" }, ...identity },
  });
  await appendSyncHistory({
    mediaType: "episode",
    title: "Still Failing Show - S02E03",
    showTitle: "Still Failing Show",
    source: "plex",
    status: "partial",
    action: "watched",
    targetStates: [{ target: "jellyfin", status: "error" }],
    rawPayloadDebug: { ids: { imdb: "tt-show-456" }, ...identity },
  });

  const page = await getSyncActivityGroupsPage({ search: "Still Failing Show", limit: 25 });
  assert.equal(page.total, 1);
  assert.equal(page.groups[0].problemCount, 1);
  const detail = await getSyncActivityGroupEvents({ groupKey: page.groups[0].groupKey, limit: 25 });
  assert.equal(detail.events.filter((event) => event.isLatestForItem).length, 1);
  const current = await getSyncActivityGroupEvents({ groupKey: page.groups[0].groupKey, limit: 25, latestOnly: true });
  assert.equal(current.total, 1);
  assert.equal(current.events.length, 1);
  assert.equal(current.events[0].isLatestForItem, true);
});

test("resolved duplicate movie events stop being retryable", async () => {
  const title = "Latest Result Movie";
  await appendSyncHistory({
    mediaType: "movie",
    title,
    source: "plex",
    status: "error",
    action: "watched",
    targetStates: [{ target: "jellyfin", status: "error" }],
    rawPayloadDebug: { ids: { tmdb: "movie-123" }, mediaKey: "movie:tmdb:movie-123" },
  });
  await appendSyncHistory({
    mediaType: "movie",
    title,
    source: "plex",
    status: "success",
    action: "watched",
    targetStates: [{ target: "jellyfin", status: "success" }],
    rawPayloadDebug: { ids: { imdb: "tt-movie-123" }, mediaKey: "movie:imdb:tt-movie-123" },
  });

  const page = await getSyncActivityGroupsPage({ search: title, limit: 25 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.groups.map((group) => group.problemCount), [0, 0]);
  const details = await Promise.all(page.groups.map((group) => getSyncActivityGroupEvents({ groupKey: group.groupKey, limit: 25 })));
  assert.deepEqual(details.flatMap((detail) => detail.events).map((event) => event.isLatestForItem).sort(), [false, true]);
  const currentDetails = await Promise.all(page.groups.map((group) => getSyncActivityGroupEvents({ groupKey: group.groupKey, limit: 25, latestOnly: true })));
  assert.deepEqual(currentDetails.flatMap((detail) => detail.events).map((event) => event.isLatestForItem), [true]);
});

test("missing library media is skipped, while a Trakt error remains an issue", async () => {
  await appendSyncHistory({
    mediaType: "movie",
    title: "Only Missing From Libraries",
    source: "trakt_import",
    status: "partial",
    action: "watched",
    details: "Synced to no targets; no match on Plex, Emby & Jellyfin",
    targetStates: [
      { target: "plex", status: "skipped", detail: "No matching item found" },
      { target: "emby", status: "skipped", detail: "No matching item found" },
      { target: "jellyfin", status: "skipped", detail: "No matching item found" },
    ],
    rawPayloadDebug: { ids: { tmdb: "missing-libraries-1" } },
  });
  await appendSyncHistory({
    mediaType: "movie",
    title: "Trakt Failed After Library Skip",
    source: "trakt_import",
    status: "partial",
    action: "watched",
    details: "Synced to no targets; Trakt failed",
    targetStates: [
      { target: "plex", status: "skipped", detail: "No matching item found" },
      { target: "trakt", status: "error", detail: "HTTP 503" },
    ],
    rawPayloadDebug: { ids: { tmdb: "trakt-failure-1" } },
  });

  const page = await getSyncActivityGroupsPage({ search: "Missing From Libraries", limit: 25 });
  assert.equal(page.groups[0].problemCount, 0);
  assert.equal(page.retryableCount, 0);

  const failedPage = await getSyncActivityGroupsPage({ search: "Trakt Failed After Library Skip", limit: 25 });
  assert.equal(failedPage.groups[0].problemCount, 1);
  assert.equal(failedPage.currentIssueGroupCount, 1);
  assert.equal(failedPage.currentIssueCount, 1);
  assert.equal(failedPage.retryableCount, 1);

  const failedOnlyPage = await getSyncActivityGroupsPage({ search: "Trakt Failed After Library Skip", limit: 25, failedOnly: true });
  assert.equal(failedOnlyPage.total, 1);
  assert.equal(failedOnlyPage.groups.length, 1);
  assert.equal(failedOnlyPage.currentIssueGroupCount, 1);
  assert.equal(failedOnlyPage.currentIssueCount, 1);

  const skippedOnlyPage = await getSyncActivityGroupsPage({ search: "Only Missing From Libraries", limit: 25, failedOnly: true });
  assert.equal(skippedOnlyPage.total, 0);
  assert.equal(skippedOnlyPage.groups.length, 0);
  assert.equal(skippedOnlyPage.currentIssueGroupCount, 0);
  assert.equal(skippedOnlyPage.currentIssueCount, 0);
});
