import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state, elements } = await import("../public/modules/state.js?v=0.16.3.4");
const { telemetryTargetStates, targetStateUnavailable, categorizeIssues, nowPlayingPosterItem, setActiveSessions, loadActiveSessions, stopHistoryPolling, isMediaSyncing } = await import("../public/modules/sync.js");
const { posterMarkup, posterUrlFor } = await import("../public/modules/images.js");

class FakeElement {
  constructor(className = "") {
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.parentNode = null;
  }

  matches(selector) {
    if (selector === "[data-now-playing-card-id]") return Boolean(this.dataset.nowPlayingCardId);
    if (selector === ".media-detail-page") return this.className === "media-detail-page";
    return false;
  }

  querySelectorAll() {
    return [];
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  insertBefore(child, reference) {
    child.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
}

function fakeNowPlayingTemplate(html) {
  const template = { content: { children: [] } };
  Object.defineProperty(template, "innerHTML", {
    set(value) {
      template.content.children = [...String(value).matchAll(/<button\b([^>]*)>/g)].map((match) => {
        const card = new FakeElement("now-card-large live-now-card");
        card.dataset.nowPlayingCardId = match[1].match(/data-now-playing-card-id="([^"]*)"/)?.[1] || "";
        card.dataset.nowPlayingStaticKey = match[1].match(/data-now-playing-static-key="([^"]*)"/)?.[1] || "";
        return card;
      });
    },
  });
  return template;
}

function fakeNowPlayingGrid(initialChildren = []) {
  const grid = new FakeElement("now-playing-grid");
  grid.children = initialChildren;
  for (const child of initialChildren) child.parentNode = grid;
  Object.defineProperty(grid, "innerHTML", {
    set(value) {
      grid.children = [];
      if (String(value).includes("idle-state")) grid.insertBefore(new FakeElement("idle-state"), null);
    },
  });
  return grid;
}

// These strings intentionally mirror syncMatchReport.test.js so frontend and
// backend parsing stay locked to the same scheduler/webhook telemetry formats.
const FIXTURES = {
  successAll: ["Origin: plex", "Dispatch status: success", "Target emby status: success", "Target jellyfin status: success"].join("\n"),
  embyNotFound: ["Origin: plex", "Dispatch status: partial", "Target emby status: skipped - No matching item found", "Target jellyfin status: success"].join("\n"),
  webhookFormatJellyfinNotFound: ["Origin: emby", "Dispatch status: partial", "Plex status: success", "Jellyfin status: skipped - No matching item found"].join("\n"),
  allNotFound: ["Origin: jellyfin", "Dispatch status: skipped", "Target plex status: skipped - No matching item found", "Target emby status: skipped - No matching item found"].join("\n"),
  progressNotFound: ["Origin: plex", "Dispatch status: partial", "Target emby progress status: skipped - No matching item found", "Target jellyfin progress status: success"].join("\n"),
  forceSyncResolved: ["Origin: plex", "Dispatch status: partial", "Target emby status: skipped - No matching item found", "Force Sync resolved status to success"].join("\n"),
  legacyPlaceholder: ["Origin: plex_initial_sync", "Loop-check: Pending", "Dispatch status: pending", "Details: Awaiting outbound sync telemetry"].join("\n"),
};

test("telemetryTargetStates parses scheduler, webhook, and progress target lines", () => {
  assert.deepEqual(telemetryTargetStates(FIXTURES.progressNotFound), [
    { target: "emby", status: "skipped", rawStatus: "skipped", detail: "No matching item found" },
    { target: "jellyfin", status: "success", rawStatus: "success", detail: "" },
  ]);
  assert.deepEqual(telemetryTargetStates(FIXTURES.webhookFormatJellyfinNotFound).map((state) => state.target), ["plex", "jellyfin"]);
  assert.equal(telemetryTargetStates(FIXTURES.legacyPlaceholder).length, 0);
});

test("targetStateUnavailable recognizes every not-found spelling used by telemetry", () => {
  assert.equal(targetStateUnavailable({ detail: "No matching item found" }), true);
  assert.equal(targetStateUnavailable({ rawStatus: "not_found" }), true);
  assert.equal(targetStateUnavailable({ status: "unavailable" }), true);
  assert.equal(targetStateUnavailable({ status: "success" }), false);
});

test("detail sync state only blocks a visible item while its own import or dispatch is active", () => {
  const previous = state.syncProgress;
  state.syncProgress = { active: false, currentItemLabel: "" };
  try {
    assert.equal(isMediaSyncing({
      media_type: "episode",
      show_title: "Prison Break",
      season: 1,
      episode: 2,
      sync_dispatch_telemetry: "Dispatch status: pending",
    }), true);
    state.syncProgress = { active: true, currentItemLabel: "Prison Break S01E02" };
    assert.equal(isMediaSyncing({
      media_type: "episode",
      show_title: "Prison Break",
      season: 1,
      episode: 1,
      sync_dispatch_telemetry: "Dispatch status: success",
    }), false);
    assert.equal(isMediaSyncing({ media_type: "movie", title: "Other Movie" }), false);
  } finally {
    state.syncProgress = previous;
  }
});

test("categorizeIssues preserves the existing Sync Issues buckets", () => {
  const jobs = [
    { id: "empty", sync_dispatch_telemetry: "" },
    { id: "plex", sync_dispatch_telemetry: FIXTURES.embyNotFound },
    { id: "none", sync_dispatch_telemetry: "Origin: emby\nSynced to no targets" },
    { id: "other", sync_dispatch_telemetry: FIXTURES.successAll },
  ];
  const categories = categorizeIssues(jobs);
  assert.deepEqual(categories.missingTelemetry.map((job) => job.id), ["empty"]);
  assert.deepEqual(categories.plexMismatch.map((job) => job.id), ["plex"]);
  assert.deepEqual(categories.targetMismatch.map((job) => job.id), ["none"]);
  assert.deepEqual(categories.otherIssues.map((job) => job.id), ["other"]);
});

test("cache-only poster surfaces keep authenticated proxy artwork", () => {
  const proxy = "/api/poster?id=movie%3Atitle%3Amoana&format=image&v=2";
  assert.equal(posterUrlFor({ id: "movie:title:moana", poster_url: proxy, cache_only_artwork: true }), proxy);
  assert.match(posterMarkup({ id: "movie:title:moana", poster_url: proxy, cache_only_artwork: true }), /src="\/api\/poster\?id=movie%3Atitle%3Amoana&amp;format=image&amp;v=2"/);
});

test("now-playing cards start from a media-key proxy when the provider path is browser-inaccessible", () => {
  const item = nowPlayingPosterItem({
    media_key: "movie:title:moana",
    posterUrl: "/library/metadata/43844/thumb/123",
  });

  assert.equal(item.cache_only_artwork, true);
  assert.equal(item.eager_poster, true);
  assert.equal(item.id, "movie:title:moana");
  assert.equal(item.poster_url, "/api/poster?format=image&id=movie%3Atitle%3Amoana&v=2");
});

test("now-playing reconciliation removes the empty placeholder when live cards arrive", () => {
  const originalCreateElement = document.createElement;
  const originalGrid = elements.nowPlayingGrid;
  const originalSessions = state.activeSessions;
  const originalSessionKey = state.nowPlayingSessionKey;
  const grid = fakeNowPlayingGrid([new FakeElement("idle-state")]);
  document.createElement = (tagName) => {
    assert.equal(tagName, "template");
    return fakeNowPlayingTemplate("");
  };

  try {
    elements.nowPlayingGrid = grid;
    state.activeSessions = [];
    state.nowPlayingSessionKey = "";
    const session = {
      source: "plex",
      sessionId: "session-1",
      mediaType: "episode",
      title: "Ted",
      season: 2,
      episode: 3,
      offsetMs: 1_000,
      durationMs: 60_000,
    };

    setActiveSessions([session]);
    assert.equal(grid.children.length, 1);
    assert.equal(grid.children[0].className, "now-card-large live-now-card");

    setActiveSessions([]);
    assert.equal(grid.children.length, 1);
    assert.equal(grid.children[0].className, "idle-state");

    setActiveSessions([session]);
    assert.equal(grid.children.length, 1);
    assert.equal(grid.children[0].className, "now-card-large live-now-card");
  } finally {
    document.createElement = originalCreateElement;
    if (originalGrid === undefined) delete elements.nowPlayingGrid;
    else elements.nowPlayingGrid = originalGrid;
    state.activeSessions = originalSessions;
    state.nowPlayingSessionKey = originalSessionKey;
  }
});

test("forced resume refresh replaces a suspended now-playing request", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = state.token;
  const previousSessions = state.activeSessions;
  const previousSessionKey = state.nowPlayingSessionKey;
  const previousRequestActive = state.nowPlayingRequestActive;
  const previousRefreshToken = state.nowPlayingRefreshToken;
  const previousLastFetchAt = state.nowPlayingLastFetchAt;
  let calls = 0;
  let aborts = 0;

  state.token = "session";
  state.activeSessions = [{ source: "plex", sessionId: "stale-session", title: "Finished" }];
  state.nowPlayingSessionKey = "stale-session";
  state.nowPlayingRequestActive = false;
  globalThis.fetch = (_url, options = {}) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        aborts += 1;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
      if (calls === 2) {
        resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "" },
          clone: () => ({ text: async () => "[]" }),
        });
      }
    });
  };

  try {
    const firstRequest = loadActiveSessions();
    await new Promise((resolve) => setImmediate(resolve));
    const refreshed = await loadActiveSessions({ force: true });
    await firstRequest;

    assert.equal(calls, 2);
    assert.equal(aborts, 1);
    assert.deepEqual(refreshed, []);
    assert.deepEqual(state.activeSessions, []);
    assert.equal(state.nowPlayingRequestActive, false);
  } finally {
    stopHistoryPolling();
    globalThis.fetch = originalFetch;
    state.token = previousToken;
    state.activeSessions = previousSessions;
    state.nowPlayingSessionKey = previousSessionKey;
    state.nowPlayingRequestActive = previousRequestActive;
    state.nowPlayingRefreshToken = previousRefreshToken;
    state.nowPlayingLastFetchAt = previousLastFetchAt;
  }
});
