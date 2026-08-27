import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-tracker-outbound-sequence-");

const { db } = await import("../server/src/db.js");

const FIXED_NOW = 1_900_000_000_000;
const writerScript = String.raw`
  Date.now = () => Number(process.env.TEST_FIXED_NOW);
  const repo = await import('./server/src/utils/trackerConnectionRepo.js');
  const client = await import('./server/src/utils/traktClient.js');
  const media = JSON.parse(process.env.TEST_TRACKER_MEDIA);
  process.send('ready');
  process.once('message', () => {
    try {
      repo.recordTrackerOutbound('trakt', client.trackerMediaKey(media), media, process.env.TEST_TRACKER_STATE);
      process.exit(0);
    } catch (error) {
      process.stderr.write(error?.stack || String(error));
      process.exit(1);
    }
  });
`;

function startWriter(media, state) {
  const child = spawn(process.execPath, ["-e", writerScript], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      TEST_FIXED_NOW: String(FIXED_NOW),
      TEST_TRACKER_MEDIA: JSON.stringify(media),
      TEST_TRACKER_STATE: state,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.once("message", (message) => message === "ready" && resolve());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(output || `tracker writer exited ${code}`));
    });
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `tracker writer exited ${code}`)));
  });
  return { child, ready, done };
}

async function withTimeout(promise, writers, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          for (const writer of writers) writer.child.kill();
          reject(new Error(`Timed out waiting for ${label}`));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("split processes allocate distinct outbound intent timestamps in one frozen millisecond", async () => {
  db.prepare("DELETE FROM tracker_item_state").run();
  const writers = [
    startWriter({ type: "episode", season: 3, episode: 3, ids: { tmdb: "125988" } }, "unwatched"),
    startWriter({ type: "episode", season: 3, episode: 3, ids: { imdb: "tt14688458", tmdb: "125988" } }, "watched"),
  ];

  await withTimeout(Promise.all(writers.map((writer) => writer.ready)), writers, "tracker writers to become ready");
  for (const writer of writers) writer.child.send("go");
  await withTimeout(Promise.all(writers.map((writer) => writer.done)), writers, "tracker writers to finish");

  const rows = db.prepare("SELECT last_outbound_at FROM tracker_item_state WHERE provider='trakt' ORDER BY last_outbound_at").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.last_outbound_at), [FIXED_NOW, FIXED_NOW + 1]);
});
