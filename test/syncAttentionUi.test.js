import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { attentionIssueMarkup } = await import("../public/modules/sync-activity.js");

test("restore attention rows expose a target-specific retry action alongside skip", () => {
  const markup = attentionIssueMarkup("restore:run-123:projection-failed", {
    key: "restore-target:jellyfin:episode-key:1:1",
    provider: "jellyfin",
    title: "A Thousand Blows - S01E01",
    type: "episode",
    sourceMediaKey: "episode:1:1:imdb:tt21974956",
    watchedAt: "2026-08-22T01:21:00.000Z",
    reason: "timed out after 30000ms: jellyfin: A Thousand Blows - S01E01",
    localHref: "/tvshow/a-thousand-blows/season/1/episode/1?historyId=watch-1",
    canRepair: true,
    repairLabel: "Retry on Jellyfin",
  });

  assert.match(markup, /data-sync-attention-retry-item="restore:run-123:projection-failed"/);
  assert.match(markup, /data-sync-attention-item-key="restore-target:jellyfin:episode-key:1:1"/);
  assert.match(markup, />Retry on Jellyfin<\/button>/);
  assert.match(markup, /data-sync-attention-skip-item/);
});
test("media-server rows with retained source data stay retryable when the capability flag is stale", () => {
  const markup = attentionIssueMarkup("restore:run-789:projection-failed", {
    key: "restore-target:jellyfin:episode-key:1:1",
    provider: "jellyfin",
    title: "A Thousand Blows - S01E01",
    type: "episode",
    sourceMediaKey: "episode:1:1:imdb:tt21974956",
    canRepair: false,
    repairLabel: "Retry on Jellyfin",
  });

  assert.match(markup, /data-sync-attention-retry-item/);
  assert.match(markup, />Retry on Jellyfin<\/button>/);
  assert.match(markup, /data-sync-attention-skip-item/);
});

test("restore attention rows without repair data do not advertise a retry", () => {
  const markup = attentionIssueMarkup("restore:run-456:projection-failed", {
    key: "restore-example:missing-row",
    provider: "jellyfin",
    title: "Unknown media",
    candidate: true,
    canRepair: false,
  });

  assert.doesNotMatch(markup, /data-sync-attention-retry-item/);
  assert.doesNotMatch(markup, /data-sync-attention-skip-item/);
});

test("groupAttentionIssues groups episodes by show and separates movies", async () => {
  const { groupAttentionIssues } = await import("../public/modules/sync-activity.js");
  const issues = [
    { key: "item-1", title: "Risky Rewards - S01E01", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 1 },
    { key: "item-2", title: "Risky Rewards - S01E02", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 2 },
    { key: "item-3", title: "Inception", type: "movie" },
  ];

  const groups = groupAttentionIssues(issues);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, "show");
  assert.equal(groups[0].title, "Risky Rewards");
  assert.equal(groups[0].issues.length, 2);
  assert.equal(groups[1].kind, "movie");
  assert.equal(groups[1].title, "Inception");
  assert.equal(groups[1].issues.length, 1);
});

test("attentionIssueList groups multiple show episodes under an expandable show group", async () => {
  const syncActivity = await import("../public/modules/sync-activity.js");
  const { state } = await import("../public/modules/state.js");

  const item = {
    id: "restore:run-123:trakt-rejected",
    context: {
      issueItems: [
        { key: "row-1", sourceRowId: "watch-1", title: "Risky Rewards - S01E01", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 1, provider: "trakt", canRepair: true },
        { key: "row-2", sourceRowId: "watch-2", title: "Risky Rewards - S01E02", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 2, provider: "trakt", canRepair: true },
      ],
      issueCount: 2,
      issueItemsComplete: true,
    },
  };

  // When collapsed (default)
  state.syncAttentionExpandedShows.clear();
  const collapsedMarkup = syncActivity.syncAttentionItemMarkup(item);
  assert.match(collapsedMarkup, /data-sync-attention-toggle-show/);
  assert.match(collapsedMarkup, /data-sync-attention-retry-show/);
  assert.match(collapsedMarkup, /data-sync-attention-skip-show/);
  assert.match(collapsedMarkup, />Risky Rewards<\/h4>/);
  assert.match(collapsedMarkup, /2 affected plays/);
  // Episodes should not be rendered when collapsed
  assert.doesNotMatch(collapsedMarkup, /data-sync-attention-retry-item/);

  // When expanded
  const actionKey = `${item.id}:riskyrewards`;
  state.syncAttentionExpandedShows.add(actionKey);
  const expandedMarkup = syncActivity.syncAttentionItemMarkup(item);
  assert.match(expandedMarkup, /sync-attention-show-episodes/);
  assert.match(expandedMarkup, /Risky Rewards - S01E01/);
  assert.match(expandedMarkup, /Risky Rewards - S01E02/);
  assert.match(expandedMarkup, /data-sync-attention-retry-item="restore:run-123:trakt-rejected"/);
  assert.match(expandedMarkup, /data-sync-attention-skip-item/);
});
