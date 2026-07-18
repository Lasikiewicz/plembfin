import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-multiprocess-primitives-");
const dbModule = await import("../server/src/db.js");
const leaseStore = await import("../server/src/utils/schedulerLease.js");
const jobs = await import("../server/src/utils/backgroundJobs.js");
const runtime = await import("../server/src/utils/configStore.js");
const roles = await import("../server/src/utils/processRole.js");

test("shared cache version observes another SQLite connection within the staleness bound", async () => {
  const before = dbModule.getDataVersion();
  const other = new Database(path.join(dataDir, "plembfin.db"));
  other.pragma("busy_timeout = 5000");
  other.prepare("UPDATE cache_versions SET version=version+1, updated_at=? WHERE id='history'").run(Date.now());
  other.close();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.ok(dbModule.getDataVersion() > before);
});

test("scheduler lease permits one holder, fences stale holders, and transfers after expiry", () => {
  const first = leaseStore.claimSchedulerLease({ holderId: "worker-a", role: "worker", ttlMs: 100, now: 1_000 });
  assert.equal(first.holderId, "worker-a");
  assert.equal(leaseStore.claimSchedulerLease({ holderId: "worker-b", role: "worker", ttlMs: 100, now: 1_050 }), null);
  assert.equal(leaseStore.renewSchedulerLease({ holderId: "worker-a", generation: first.generation, ttlMs: 100, now: 1_050 }), true);
  const second = leaseStore.claimSchedulerLease({ holderId: "worker-b", role: "worker", ttlMs: 100, now: 1_151 });
  assert.equal(second.holderId, "worker-b");
  assert.ok(second.generation > first.generation);
  assert.equal(leaseStore.renewSchedulerLease({ holderId: "worker-a", generation: first.generation, ttlMs: 100, now: 1_152 }), false);
  assert.equal(leaseStore.releaseSchedulerLease({ holderId: "worker-b", generation: second.generation, now: 1_153 }), true);
});

test("background jobs are durably claimed, logged, cancelled, and completed", () => {
  const lease = leaseStore.claimSchedulerLease({ holderId: "job-worker", role: "worker", ttlMs: 10_000, now: 2_000 });
  const job = jobs.enqueueBackgroundJob("force_sync", {}, 2_001);
  const claimed = jobs.claimNextBackgroundJob({ holderId: "job-worker", generation: lease.generation, now: 2_002 });
  assert.equal(claimed.id, job.id);
  jobs.appendBackgroundJobLog(job.id, "working", 2_003);
  assert.deepEqual(jobs.getBackgroundJobLogs(job.id).map((entry) => entry.message), ["working"]);
  assert.equal(jobs.requestBackgroundJobCancellation(job.id, 2_004).cancelRequested, true);
  assert.equal(jobs.finishBackgroundJob({ id: job.id, holderId: "job-worker", generation: lease.generation, status: "cancelled", result: { aborted: true }, now: 2_005 }), true);
  assert.equal(jobs.getBackgroundJob(job.id).status, "cancelled");
  const queued = jobs.enqueueBackgroundJob("force_sync", {}, 2_006);
  assert.equal(jobs.requestBackgroundJobCancellation(queued.id, 2_007).status, "cancelled");
});

test("runtime state merges preserve unrelated fields", async () => {
  await runtime.setRuntimeState({ alpha: 1 });
  await runtime.setRuntimeState({ beta: 2 });
  await runtime.appendRuntimeLog("lines", ["one"]);
  await runtime.appendRuntimeLog("lines", ["two"]);
  const state = await runtime.loadRuntimeState();
  assert.equal(state.alpha, 1);
  assert.equal(state.beta, 2);
  assert.deepEqual(state.lines, ["one", "two"]);
});

test("runtime state merges serialize across real processes", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const run = (field) => new Promise((resolve, reject) => {
    const source = `import('./server/src/utils/configStore.js').then(async (store) => { await store.setRuntimeState({ ${field}: true }); const { db } = await import('./server/src/db.js'); db.close(); })`;
    const child = spawn(process.execPath, ["-e", source], { cwd: root, env: { ...process.env, DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `runtime child exited ${code}`)));
  });
  await Promise.all([run("childA"), run("childB")]);
  const state = await runtime.loadRuntimeState();
  assert.equal(state.childA, true);
  assert.equal(state.childB, true);
});

test("process roles default safely and reject invalid values", () => {
  assert.equal(roles.resolveProcessRole("ALL"), "all");
  assert.equal(roles.roleHasWeb("web"), true);
  assert.equal(roles.roleHasWorker("web"), false);
  assert.throws(() => roles.resolveProcessRole("replica"), /Invalid ROLE/);
});
