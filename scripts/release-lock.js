#!/usr/bin/env node

// Stops two sessions running a release workflow in the same checkout at once.
//
// This is not hypothetical. Two agents ran overlapping `git reset --soft` and
// `git commit` sequences in this worktree, and the interleaving amended the
// published v1.1.0 release commit, diverging develop from origin/develop. The
// reflog showed commits and resets neither session had issued. Recovery was
// possible only because the original commit was still reachable. The same
// overlap also rewrote `?v=` asset stamps inside another session's in-flight
// files, because the restamp touches every file under public/ by design.
//
// Usage:
//   node scripts/release-lock.js acquire <label>   exit 1 if someone else holds it
//   node scripts/release-lock.js release
//   node scripts/release-lock.js status
//
// The lock is advisory: it guards the workflows that rewrite history, not every
// git command. A lock older than STALE_AFTER_MS is treated as abandoned, because
// a crashed session must not block the repository forever.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, ".git", "plembfin-release.lock");
const STALE_AFTER_MS = 30 * 60 * 1000;

// Exported pure so the decision can be tested without touching the filesystem.
export function lockDecision({ existing, now = Date.now(), pid = process.pid } = {}) {
  if (!existing) return { action: "acquire" };
  if (existing.pid === pid) return { action: "acquire", note: "already held by this process" };
  // startedAt is an ISO string; Number() on it yields NaN, which made every
  // comparison below false and would have let an abandoned lock block the
  // repository forever.
  const startedAt = Date.parse(existing.startedAt);
  if (!Number.isFinite(startedAt)) return { action: "acquire", note: "taking over a lock with an unreadable timestamp" };
  const age = now - startedAt;
  if (age > STALE_AFTER_MS) {
    return { action: "acquire", note: `taking over a lock abandoned ${Math.round(age / 60000)} minutes ago` };
  }
  return { action: "refuse", holder: existing, ageMinutes: Math.round(age / 60000) };
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const [command, label] = process.argv.slice(2);

  if (command === "release") {
    try {
      fs.unlinkSync(lockPath);
      console.log("Release lock released.");
    } catch {
      console.log("No release lock held.");
    }
    return;
  }

  if (command === "status") {
    const existing = readLock();
    console.log(existing ? `Held by pid ${existing.pid} for "${existing.label}" since ${existing.startedAt}` : "No release lock held.");
    return;
  }

  if (command !== "acquire") {
    console.error("Usage: release-lock.js acquire <label> | release | status");
    process.exit(2);
  }

  const decision = lockDecision({ existing: readLock() });
  if (decision.action === "refuse") {
    console.error(`Refusing to start: another session is running "${decision.holder.label}" in this checkout.`);
    console.error(`  pid ${decision.holder.pid}, started ${decision.holder.startedAt} (${decision.ageMinutes} minutes ago)`);
    console.error("");
    console.error("Two sessions rewriting history in one worktree corrupts it - this is how the");
    console.error("v1.1.0 release commit was once amended by accident. Wait for that session to");
    console.error("finish, or if it is gone, clear the lock:");
    console.error("");
    console.error("  node scripts/release-lock.js release");
    console.error("");
    process.exit(1);
  }

  if (decision.note) console.log(`Release lock: ${decision.note}.`);
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    label: label || "release workflow",
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`Release lock acquired for "${label || "release workflow"}".`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
