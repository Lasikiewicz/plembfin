import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-live-sessions-");
const {
  canInferLiveSessionCompletion,
  isSessionActive,
  isStaleLiveSessionRow,
  LIVE_SESSION_COMPLETION_MAX_AGE_MS,
  isTerminalLiveSession,
  parsePlexSessions,
  sessionIdentity,
} = await import("../server/src/utils/liveSessions.js");

test("stale live-session cache rows are not trusted as completion evidence", () => {
  const now = Date.UTC(2026, 8, 12, 10, 0, 0);
  assert.equal(
    isStaleLiveSessionRow({ updated_at: now - LIVE_SESSION_COMPLETION_MAX_AGE_MS + 1 }, now),
    false,
  );
  assert.equal(
    isStaleLiveSessionRow({ updated_at: now - LIVE_SESSION_COMPLETION_MAX_AGE_MS - 1 }, now),
    true,
  );
  assert.equal(isStaleLiveSessionRow({ updated_at: 0 }, now), true);
  assert.equal(
    canInferLiveSessionCompletion({
      updated_at: now - 1_000,
      payload_json: JSON.stringify({ playbackState: "playing" }),
    }, now),
    true,
  );
  assert.equal(
    canInferLiveSessionCompletion({
      updated_at: now - 1_000,
      payload_json: JSON.stringify({ playbackState: "paused", paused: true }),
    }, now),
    false,
  );
});

test("live sessions are terminal only when playback has reached the final grace window", () => {
  assert.equal(isTerminalLiveSession({ offsetMs: 3_590_000, durationMs: 3_600_000 }), true);
  assert.equal(isTerminalLiveSession({ offsetMs: 3_589_999, durationMs: 3_600_000 }), false);
  assert.equal(isTerminalLiveSession({ offsetMs: 0, durationMs: 0 }), false);
});

function plexSessionXml(state) {
  return `<MediaContainer size="1">
<Video type="episode" grandparentTitle="Ludwig (2024)" parentIndex="2" index="2" title="Episode 2" duration="3189360" viewOffset="219000" ratingKey="2752" sessionKey="4">
<User />
<Player address="192.168.1.102" machineIdentifier="i0kdarajoqmdwfh1k0xn558x" state="${state}" title="Chrome" userID="1" />
</Video>
</MediaContainer>`;
}

// A paused session must stay in the poll result. When it dropped out,
// refreshLiveSessions() read the absence as the session having ended and
// recorded a stopped play, propagating resume progress to every configured
// server - on a pause rather than a stop.
test("a paused Plex session is still reported as a live session", () => {
  for (const state of ["playing", "buffering", "paused"]) {
    const sessions = parsePlexSessions(plexSessionXml(state), {});
    assert.equal(sessions.length, 1, `expected ${state} to be a live session`);
    assert.equal(sessions[0].paused, state === "paused");
    assert.equal(sessions[0].playbackState, state === "paused" ? "paused" : "playing");
  }
});

test("a stopped Plex session is not reported as a live session", () => {
  assert.equal(parsePlexSessions(plexSessionXml("stopped"), {}).length, 0);
});

test("terminal provider states do not remain active while paused sessions do", () => {
  const session = (overrides = {}) => ({
    NowPlayingItem: { Type: "Episode", Id: "episode-1", Name: "Episode" },
    PlayState: { PositionTicks: 1_000, PlayMethod: "DirectPlay" },
    ...overrides,
  });

  for (const state of ["stopped", "completed", "ended", "media-ended", "playback-stopped", "not-playing"]) {
    assert.equal(isSessionActive(session({ State: state })), false, state);
    assert.equal(
      isSessionActive(session({ PlayState: { PositionTicks: 1_000, PlayMethod: "DirectPlay", State: state } })),
      false,
      `PlayState ${state}`,
    );
  }

  assert.equal(isSessionActive(session({ IsPlaying: false })), false);
  assert.equal(
    isSessionActive(session({ PlayState: { PositionTicks: 1_000, IsPaused: true, IsPlaying: false } })),
    true,
  );
});

// Plex can return <User /> with no attributes on an owner's own stream. The
// account is still identified by <Player userID>, which is what the username
// filter resolves against.
test("Plex sessions carry the player account id when <User> is empty", () => {
  const [session] = parsePlexSessions(plexSessionXml("playing"), {});
  assert.equal(session.client.userName, "");
  assert.equal(session.client.userId, "1");
});

// Two movies played back to back on one client share every field the session
// key used to be built from - the client id, and a null season and episode. The
// second overwrote the first in live_tracking_cache, reconciliation saw the id
// still present, and the first movie's completion was never processed.
test("two movies on the same client get distinct session keys", () => {
  const client = "i0kdarajoqmdwfh1k0xn558x";
  const first = { source: "plex", sessionId: client, mediaId: "1726", title: "War of the Worlds", season: null, episode: null };
  const second = { source: "plex", sessionId: client, mediaId: "9331", title: "The Martian", season: null, episode: null };

  assert.notEqual(sessionIdentity(first), sessionIdentity(second));
});

test("the same item on the same client keeps a stable session key", () => {
  const base = { source: "plex", sessionId: "i0kdarajoqmdwfh1k0xn558x", mediaId: "2752", title: "Ludwig (2024) - S02E02", season: 2, episode: 2 };
  // A transcode or quality switch changes neither the client nor the item, so
  // the key must not move underneath an in-progress session.
  assert.equal(sessionIdentity({ ...base }), sessionIdentity({ ...base, progress: 47 }));
});
