import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-background-sync-progress-");

const {
  BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS,
  BACKGROUND_SYNC_PROGRESS_STALE_MS,
  loadBackgroundSyncProgress,
  loadRuntimeState,
  releaseBackgroundSyncProgressOwner,
  setRuntimeState,
  startBackgroundSyncProgressOwner,
  updateBackgroundSyncProgressOwner,
} = await import("../server/src/utils/configStore.js");

async function resetProgressState() {
  await setRuntimeState({
    backgroundSyncProgressOwners: null,
    backgroundSyncProgress: { total: 0, completed: 0, updatedAt: 0 },
  });
}

test("active background sync progress survives while its heartbeat is fresh", async () => {
  await resetProgressState();
  const now = 1_000_000;
  const active = {
    total: 37,
    completed: 31,
    ownerId: "worker:active",
    heartbeatAt: now - BACKGROUND_SYNC_PROGRESS_STALE_MS + 1,
    updatedAt: now - BACKGROUND_SYNC_PROGRESS_STALE_MS + 1,
  };
  await setRuntimeState({ backgroundSyncProgress: active });

  const progress = await loadBackgroundSyncProgress({ now });

  assert.equal(progress.total, 37);
  assert.equal(progress.completed, 31);
  assert.equal(progress.ownerId, "worker:active");
});

test("orphaned incomplete background sync progress is reset after its heartbeat expires", async () => {
  await resetProgressState();
  const now = 2_000_000;
  await setRuntimeState({
    backgroundSyncProgress: {
      total: 37,
      completed: 31,
      ownerId: "worker:interrupted",
      heartbeatAt: now - BACKGROUND_SYNC_PROGRESS_STALE_MS - 1,
      updatedAt: now - BACKGROUND_SYNC_PROGRESS_STALE_MS - 1,
    },
  });

  const progress = await loadBackgroundSyncProgress({ now });

  assert.equal(progress.total, 0);
  assert.equal(progress.completed, 0);
  assert.equal(progress.recoveredAt, now);
  const runtime = await loadRuntimeState();
  assert.equal(runtime.backgroundSyncProgress.total, 0);
  assert.equal(runtime.backgroundSyncProgress.completed, 0);
});

test("legacy incomplete progress without a timestamp is treated as orphaned", async () => {
  await setRuntimeState({ backgroundSyncProgressOwners: null, backgroundSyncProgress: { total: 8, completed: 3 } });

  const progress = await loadBackgroundSyncProgress({ now: 3_000_000 });

  assert.equal(progress.total, 0);
  assert.equal(progress.completed, 0);
});

test("a completed persisted burst is already idle and is not rewritten as interrupted", async () => {
  await resetProgressState();
  const completed = { total: 5, completed: 5, updatedAt: 1 };
  await setRuntimeState({ backgroundSyncProgress: completed });

  const progress = await loadBackgroundSyncProgress({ now: 4_000_000 });

  assert.equal(progress.total, 5);
  assert.equal(progress.completed, 5);
  assert.equal(progress.recoveredAt, undefined);
});

test("multiple owners aggregate atomically and releasing one cannot clear another", async () => {
  await resetProgressState();
  const now = 5_000_000;
  await Promise.all([
    startBackgroundSyncProgressOwner({ ownerId: "web:one", total: 5, completed: 2, now }),
    startBackgroundSyncProgressOwner({ ownerId: "worker:two", total: 7, completed: 3, now: now + 1 }),
  ]);

  const combined = await loadBackgroundSyncProgress({ now: now + 2 });
  assert.equal(combined.total, 12);
  assert.equal(combined.completed, 5);
  assert.equal(combined.ownerCount, 2);

  await releaseBackgroundSyncProgressOwner({ ownerId: "web:one", now: now + 3 });
  const remaining = await loadBackgroundSyncProgress({ now: now + 4 });
  assert.equal(remaining.total, 7);
  assert.equal(remaining.completed, 3);
  assert.equal(remaining.ownerCount, 1);
  const runtime = await loadRuntimeState();
  assert.deepEqual(Object.keys(runtime.backgroundSyncProgressOwners), ["worker:two"]);
});

test("owners started concurrently by separate processes are both preserved", async () => {
  await resetProgressState();
  const root = path.resolve(import.meta.dirname, "..");
  const run = (ownerId, total, completed) => new Promise((resolve, reject) => {
    const source = `import('./server/src/utils/configStore.js').then(async (store) => { await store.startBackgroundSyncProgressOwner(${JSON.stringify({ ownerId, total, completed })}); const { db } = await import('./server/src/db.js'); db.close(); })`;
    const child = spawn(process.execPath, ["-e", source], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `owner child exited ${code}`)));
  });

  await Promise.all([
    run("web:child", 11, 5),
    run("worker:child", 13, 7),
  ]);

  const progress = await loadBackgroundSyncProgress();
  assert.equal(progress.total, 24);
  assert.equal(progress.completed, 12);
  assert.equal(progress.ownerCount, 2);
});

test("an owner expires at its hard lease even when its heartbeat keeps updating", async () => {
  await resetProgressState();
  const now = 6_000_000;
  const maxOwnerMs = 100;
  await startBackgroundSyncProgressOwner({ ownerId: "web:leaked", total: 10, completed: 4, now, maxOwnerMs });

  const refreshed = await updateBackgroundSyncProgressOwner({
    ownerId: "web:leaked",
    total: 10,
    completed: 4,
    now: now + 99,
    staleMs: BACKGROUND_SYNC_PROGRESS_STALE_MS,
    maxOwnerMs,
  });
  assert.equal(refreshed.updated, true);

  const expired = await updateBackgroundSyncProgressOwner({
    ownerId: "web:leaked",
    total: 10,
    completed: 4,
    now: now + 101,
    staleMs: BACKGROUND_SYNC_PROGRESS_STALE_MS,
    maxOwnerMs,
  });
  assert.equal(expired.updated, false);
  assert.equal(expired.progress.total, 0);
  assert.equal(expired.progress.completed, 0);
  assert.equal(expired.progress.recoveredAt, now + 101);
});

test("the production owner lease is longer than the dead-process heartbeat window", () => {
  assert.ok(BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS > BACKGROUND_SYNC_PROGRESS_STALE_MS);
});
