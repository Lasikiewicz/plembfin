import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-live-sessions-");
const { isTerminalLiveSession } = await import("../server/src/utils/liveSessions.js");

test("live sessions are terminal only when playback has reached the final grace window", () => {
  assert.equal(isTerminalLiveSession({ offsetMs: 3_590_000, durationMs: 3_600_000 }), true);
  assert.equal(isTerminalLiveSession({ offsetMs: 3_589_999, durationMs: 3_600_000 }), false);
  assert.equal(isTerminalLiveSession({ offsetMs: 0, durationMs: 0 }), false);
});
