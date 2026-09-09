import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-active-sessions-");
const { deleteActiveSession, listActiveSessions, upsertActiveSession } = await import("../server/src/utils/activeSessions.js");

test("finished episodes are deleted when start and stop provider ids differ", async () => {
  await upsertActiveSession({
    source: "jellyfin",
    type: "episode",
    title: "Scrubs - S01E03",
    season: 1,
    episode: 3,
    ids: { tmdb: "184604" },
    progress: 98,
    offsetMs: 1_000,
    durationMs: 2_000,
  });

  const remaining = await deleteActiveSession({
    source: "jellyfin",
    type: "episode",
    title: "Scrubs - S01E03",
    season: 1,
    episode: 3,
    ids: { tvdb: "76156" },
  });

  assert.equal(remaining.length, 0);
  assert.equal((await listActiveSessions()).length, 0);
});
