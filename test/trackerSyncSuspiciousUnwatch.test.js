import test from "node:test";
import assert from "node:assert/strict";

// partitionSuspiciousUnwatches (server/src/utils/trackerSync.js) protects
// against the incident this test is named for: Trakt's watched-progress
// response came back missing a large chunk of one show's episodes (a
// transient/incomplete response, not a real unwatch) right after a burst of
// outbound Trakt API calls, and pollTrakt trusted the diff, cascading a real
// unwatch to Plex/Emby/Jellyfin and Plembfin's own history across three
// seasons of Parks and Recreation. This only exercises the pure partitioning
// logic (no DB/network) - pollTrakt itself wires it to a live Trakt poll.

const { partitionSuspiciousUnwatches, showIdentityFromMediaKey } = await import("../server/src/utils/trackerSync.js");

function episodeItem(showId, season, episode) {
  const mediaKey = `episode:${showId}:s${season}e${episode}`;
  return { mediaKey, media: { type: "episode", season, episode, ids: {} }, remoteWatchedAt: Date.now() };
}

test("showIdentityFromMediaKey extracts the show id ignoring season/episode", () => {
  assert.equal(showIdentityFromMediaKey("episode:imdb:tt1266020:s7e2"), "imdb:tt1266020");
  assert.equal(showIdentityFromMediaKey("movie:imdb:tt1234567"), null);
});

test("a small drop from a show propagates immediately", () => {
  const showId = `imdb:tt${Date.now()}a`;
  const previous = Array.from({ length: 22 }, (_, i) => episodeItem(showId, 6, i + 1));
  const unwatchedCandidates = [episodeItem(showId, 6, 1), episodeItem(showId, 6, 2)];
  const currentByKey = new Map();

  const { unwatched, heldBack } = partitionSuspiciousUnwatches(unwatchedCandidates, previous, currentByKey);
  assert.equal(unwatched.length, 2);
  assert.equal(heldBack.length, 0);
});

test("a large simultaneous drop from one show is held back on the first poll", () => {
  const showId = `imdb:tt${Date.now()}b`;
  const previous = Array.from({ length: 22 }, (_, i) => episodeItem(showId, 6, i + 1));
  // 20 of 22 episodes vanish at once, matching the real incident's shape.
  const unwatchedCandidates = Array.from({ length: 20 }, (_, i) => episodeItem(showId, 6, i + 1));
  const currentByKey = new Map();

  const { unwatched, heldBack } = partitionSuspiciousUnwatches(unwatchedCandidates, previous, currentByKey);
  assert.equal(unwatched.length, 0);
  assert.equal(heldBack.length, 20);
});

test("a held-back drop that self-heals on the next poll never propagates", () => {
  const showId = `imdb:tt${Date.now()}c`;
  const previous = Array.from({ length: 22 }, (_, i) => episodeItem(showId, 6, i + 1));
  const unwatchedCandidates = Array.from({ length: 20 }, (_, i) => episodeItem(showId, 6, i + 1));

  const firstPoll = partitionSuspiciousUnwatches(unwatchedCandidates, previous, new Map());
  assert.equal(firstPoll.heldBack.length, 20);

  // Next poll: Trakt's response recovered and shows all 22 episodes again.
  const recoveredByKey = new Map(previous.map((item) => [item.mediaKey, item]));
  const secondPoll = partitionSuspiciousUnwatches([], previous, recoveredByKey);
  assert.equal(secondPoll.unwatched.length, 0);
  assert.equal(secondPoll.heldBack.length, 0);
});

test("a held-back drop that is still missing on the next poll is treated as genuine", () => {
  const showId = `imdb:tt${Date.now()}d`;
  const previous = Array.from({ length: 22 }, (_, i) => episodeItem(showId, 6, i + 1));
  const unwatchedCandidates = Array.from({ length: 20 }, (_, i) => episodeItem(showId, 6, i + 1));

  const firstPoll = partitionSuspiciousUnwatches(unwatchedCandidates, previous, new Map());
  assert.equal(firstPoll.heldBack.length, 20);
  assert.equal(firstPoll.unwatched.length, 0);

  // Next poll: still missing the same 20 episodes - now trusted as real.
  const secondPoll = partitionSuspiciousUnwatches(unwatchedCandidates, previous, new Map());
  assert.equal(secondPoll.unwatched.length, 20);
  assert.equal(secondPoll.heldBack.length, 0);
});
