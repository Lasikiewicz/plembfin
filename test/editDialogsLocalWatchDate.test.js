import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

import { state } from "../public/modules/state.js";
import { applyWatchedAtToLocalWatchRecord } from "../public/modules/edit-dialogs.js";

test("editing a movie watch date updates the retained Movies page record", () => {
  const original = "2026-06-05T12:00:00.000Z";
  const updated = "2025-12-25T12:00:00.000Z";
  state.history = [{ id: "snowman-watch", media_type: "movie", title: "The Snowman", watched_at: original }];
  state.historyViewRaw = [];
  state.moviesRaw = [{
    id: "snowman-watch",
    media_type: "movie",
    title: "The Snowman",
    watched_at: original,
    playHistory: [{ id: "snowman-watch", watched_at: original }],
  }];

  const record = applyWatchedAtToLocalWatchRecord("snowman-watch", updated);

  assert.equal(record, state.moviesRaw[0]);
  assert.equal(state.moviesRaw[0].watched_at, updated);
  assert.equal(state.moviesRaw[0].playHistory[0].watched_at, updated);
});

test("editing one rewatch keeps the movie card on the latest remaining watch date", () => {
  state.history = [];
  state.historyViewRaw = [];
  state.moviesRaw = [{
    id: "latest-watch",
    media_type: "movie",
    watched_at: "2026-06-05T12:00:00.000Z",
    playHistory: [
      { id: "older-watch", watched_at: "2025-01-01T12:00:00.000Z" },
      { id: "latest-watch", watched_at: "2026-06-05T12:00:00.000Z" },
    ],
  }];

  applyWatchedAtToLocalWatchRecord("latest-watch", "2024-12-25T12:00:00.000Z");

  assert.equal(state.moviesRaw[0].watched_at, "2025-01-01T12:00:00.000Z");
});
