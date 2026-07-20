import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { schedulerLeaseStatus } from "./schedulerLease.js";

const selectJob = db.prepare("SELECT * FROM background_jobs WHERE id = ?");
const selectLatestType = db.prepare("SELECT * FROM background_jobs WHERE type = ? ORDER BY requested_at DESC LIMIT 1");
const selectLogs = db.prepare("SELECT seq, timestamp, message FROM background_job_logs WHERE job_id = ? ORDER BY seq");
const insertJob = db.prepare(`INSERT INTO background_jobs
  (id,type,status,requested_at,cancel_requested,payload) VALUES (@id,@type,'queued',@requestedAt,0,@payload)`);

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    claimedBy: row.claimed_by || "",
    claimGeneration: Number(row.claim_generation || 0),
    cancelRequested: Boolean(row.cancel_requested),
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, null),
    error: row.error || "",
  };
}

export function workerAvailable(now = Date.now()) {
  return schedulerLeaseStatus(now).available;
}

export function enqueueBackgroundJob(type, payload = {}, now = Date.now()) {
  if (!["cron_sync", "force_sync", "force_sync_plan"].includes(type)) throw new Error(`Unsupported background job type: ${type}`);
  const job = { id: crypto.randomUUID(), type, requestedAt: now, payload: toJson(payload || {}) };
  return db.transaction(() => {
    if (type === "force_sync" || type === "force_sync_plan") {
      const active = db.prepare("SELECT id FROM background_jobs WHERE type=? AND status IN ('queued','running') LIMIT 1").get(type);
      if (active) {
        const error = new Error("Another force sync job is already running.");
        error.code = "JOB_ACTIVE";
        throw error;
      }
    }
    insertJob.run(job);
    return shape(selectJob.get(job.id));
  }).immediate();
}

export function getBackgroundJob(id) {
  return shape(selectJob.get(String(id || "")));
}

export function getLatestBackgroundJob(type) {
  return shape(selectLatestType.get(type));
}

export function getBackgroundJobLogs(id) {
  return selectLogs.all(String(id || "")).map((row) => ({ seq: row.seq, timestamp: row.timestamp, message: row.message }));
}

export function appendBackgroundJobLog(id, message, now = Date.now()) {
  return db.transaction(() => {
    const seq = Number(db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM background_job_logs WHERE job_id = ?").get(id)?.seq || 1);
    db.prepare("INSERT INTO background_job_logs (job_id,seq,timestamp,message) VALUES (?,?,?,?)").run(id, seq, now, String(message));
    return seq;
  }).immediate();
}

export function claimNextBackgroundJob({ holderId, generation, staleAfterMs = 90_000, now = Date.now() }) {
  return db.transaction(() => {
    const lease = db.prepare("SELECT holder_id, generation, expires_at FROM scheduler_lease WHERE id='scheduler'").get();
    if (lease?.holder_id !== holderId || Number(lease.generation) !== Number(generation) || Number(lease.expires_at) <= now) return null;
    const row = db.prepare(`SELECT * FROM background_jobs
      WHERE status = 'queued' OR (status = 'running' AND heartbeat_at < ?)
      ORDER BY requested_at LIMIT 1`).get(now - staleAfterMs);
    if (!row) return null;
    const changed = db.prepare(`UPDATE background_jobs
      SET status='running', started_at=COALESCE(started_at, @now), heartbeat_at=@now,
          claimed_by=@holderId, claim_generation=@generation, error=NULL
      WHERE id=@id AND (status='queued' OR (status='running' AND heartbeat_at < @staleBefore))`).run({
        id: row.id, holderId, generation, now, staleBefore: now - staleAfterMs,
      }).changes;
    return changed === 1 ? shape(selectJob.get(row.id)) : null;
  }).immediate();
}

export function heartbeatBackgroundJob({ id, holderId, generation, now = Date.now() }) {
  return db.prepare(`UPDATE background_jobs SET heartbeat_at=?
    WHERE id=? AND status='running' AND claimed_by=? AND claim_generation=?`).run(now, id, holderId, generation).changes === 1;
}

export function finishBackgroundJob({ id, holderId, generation, status = "succeeded", result = null, error = "", now = Date.now() }) {
  if (!["succeeded", "failed", "cancelled"].includes(status)) throw new Error(`Invalid terminal job status: ${status}`);
  return db.prepare(`UPDATE background_jobs SET status=@status, result=@result, error=@error,
      finished_at=@now, heartbeat_at=@now
    WHERE id=@id AND status='running' AND claimed_by=@holderId AND claim_generation=@generation`).run({
      id, holderId, generation, status, result: toJson(result), error: error || null, now,
    }).changes === 1;
}

export function requestBackgroundJobCancellation(id, now = Date.now()) {
  return db.transaction(() => {
    const job = shape(selectJob.get(id));
    if (!job) return null;
    if (job.status === "queued") {
      db.prepare("UPDATE background_jobs SET status='cancelled', cancel_requested=1, finished_at=? WHERE id=? AND status='queued'").run(now, id);
    } else if (job.status === "running") {
      db.prepare("UPDATE background_jobs SET cancel_requested=1 WHERE id=? AND status='running'").run(id);
    }
    return shape(selectJob.get(id));
  }).immediate();
}

export function pruneBackgroundJobs(now = Date.now()) {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM background_jobs WHERE finished_at IS NOT NULL AND finished_at < ?").run(cutoff);
  db.prepare(`DELETE FROM background_jobs WHERE id IN (
    SELECT id FROM background_jobs WHERE finished_at IS NOT NULL ORDER BY requested_at DESC LIMIT -1 OFFSET 200
  )`).run();
}
