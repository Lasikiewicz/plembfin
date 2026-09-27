import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-playlist-triggers-");

const { db } = await import("../server/src/db.js");
const {
  cancelPendingPlaylistSyncs,
  PLAYLIST_SYNC_INTERVAL_MS,
  runPlaylistSyncScheduler,
  schedulePlaylistSync,
} = await import("../server/src/utils/playlistSyncTriggers.js");

let counter = 0;
function createList({ targets = [] } = {}) {
  const id = `trigger-${++counter}`;
  const now = Date.now();
  db.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, `Trigger ${counter}`, now, now);
  for (const provider of targets) {
    db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, provider, now, now);
  }
  return id;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("edits in quick succession become one sync of that playlist", async () => {
  const listId = createList({ targets: ["plex"] });
  const calls = [];
  const sync = async (id) => { calls.push(id); };
  assert.equal(schedulePlaylistSync(listId, { delayMs: 20, sync, role: "all" }), true);
  assert.equal(schedulePlaylistSync(listId, { delayMs: 20, sync, role: "all" }), true);
  await wait(60);
  assert.deepEqual(calls, [listId]);
});

test("a Plembfin-only playlist and a web-only process never schedule a sync", async () => {
  const calls = [];
  const sync = async (id) => { calls.push(id); };
  assert.equal(schedulePlaylistSync(createList(), { delayMs: 0, sync, role: "all" }), false);
  assert.equal(schedulePlaylistSync(createList({ targets: ["emby"] }), { delayMs: 0, sync, role: "web" }), false);
  await wait(20);
  assert.deepEqual(calls, []);
});

test("a failed sync is logged, not thrown", async () => {
  const listId = createList({ targets: ["jellyfin"] });
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    schedulePlaylistSync(listId, { delayMs: 0, sync: async () => { throw new Error("boom"); }, role: "worker" });
    await wait(20);
  } finally {
    console.error = original;
  }
  assert.equal(errors.some((line) => line.includes(listId) && line.includes("boom")), true);
});

test("cancelled pending syncs never run", async () => {
  const calls = [];
  schedulePlaylistSync(createList({ targets: ["plex"] }), { delayMs: 20, sync: async (id) => { calls.push(id); }, role: "all" });
  cancelPendingPlaylistSyncs();
  await wait(40);
  assert.deepEqual(calls, []);
});

test("the scheduled pass runs once per interval", async () => {
  let runs = 0;
  let conversions = 0;
  const syncAll = async () => { runs += 1; return [{}, {}]; };
  const convertAll = async () => { conversions += 1; return [{}]; };
  let ruleChecks = 0;
  const checkRules = async () => { ruleChecks += 1; return [{}]; };
  const start = Date.now() + PLAYLIST_SYNC_INTERVAL_MS * 10;
  assert.deepEqual(await runPlaylistSyncScheduler({ now: start, syncAll, convertAll, checkRules }), { skipped: false, playlists: 2, converted: 1, rules: 1 });
  assert.equal((await runPlaylistSyncScheduler({ now: start + PLAYLIST_SYNC_INTERVAL_MS - 1, syncAll, convertAll, checkRules })).reason, "not_due");
  assert.equal((await runPlaylistSyncScheduler({ now: start + PLAYLIST_SYNC_INTERVAL_MS, syncAll, convertAll, checkRules })).skipped, false);
  assert.equal(runs, 2);
  assert.equal(conversions, 2);
  assert.equal(ruleChecks, 2);
});

test("a failed rule check pass does not stop the playlist pass", async () => {
  let runs = 0;
  const result = await runPlaylistSyncScheduler({
    force: true,
    syncAll: async () => { runs += 1; return [{}]; },
    convertAll: async () => [],
    checkRules: async () => { throw new Error("boom"); },
  });
  assert.equal(result.skipped, false);
  assert.equal(runs, 1);
});

test("the scheduled pass is skipped when no playlist targets an app", async () => {
  db.prepare("DELETE FROM personal_list_targets").run();
  let runs = 0;
  let conversions = 0;
  const result = await runPlaylistSyncScheduler({
    force: true,
    syncAll: async () => { runs += 1; return []; },
    convertAll: async () => { conversions += 1; return []; },
  });
  assert.equal(result.reason, "no_targets");
  assert.equal(runs, 0);
  // Plembfin-only playlists still get their shows converted.
  assert.equal(conversions, 1);
});
