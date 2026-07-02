#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");

const sourceCommit = String(process.env.SOURCE_COMMIT || "").trim();
const rawMessage = String(process.env.SOURCE_MESSAGE || "Update application").trim();
const sourceMessage = rawMessage.split(/\r?\n/, 1)[0];
const sourceDate = String(process.env.SOURCE_DATE || new Date().toISOString()).trim();
const sourceAuthor = String(process.env.SOURCE_AUTHOR || "unknown").trim();

// Extract bullet-point lines from a commit message body as structured details
function bulletPointsFrom(message) {
  return String(message || "")
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

const sourceDetails = bulletPointsFrom(rawMessage);

// A `git push` can carry several commits, but GitHub's push event only exposes
// head_commit — everything else would silently vanish from the changelog if a
// multi-commit push isn't summarized by hand in the final commit message.
// COMMITS_JSON (every commit in this push) backfills the rest: each earlier
// commit contributes its own bullet points, or its subject line if it has none,
// so no commit's work is ever dropped just because it wasn't the last one pushed.
let backfilledDetails = [];
try {
  const commits = JSON.parse(process.env.COMMITS_JSON || "[]");
  const others = commits.filter((c) => c.id !== sourceCommit && !/^chore: update changelog for /.test(String(c.message || "")));
  for (const commit of others) {
    const bullets = bulletPointsFrom(commit.message);
    if (bullets.length) backfilledDetails.push(...bullets);
    else backfilledDetails.push(String(commit.message || "").split(/\r?\n/, 1)[0].trim());
  }
} catch {
  // COMMITS_JSON absent or malformed (e.g. a manual workflow run) — just skip backfill.
}

const allDetails = [...backfilledDetails, ...sourceDetails].filter((v, i, arr) => v && arr.indexOf(v) === i);

if (!sourceCommit) {
  console.error("SOURCE_COMMIT is required");
  process.exit(1);
}

const changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));
if (!Array.isArray(changelog.entries)) changelog.entries = [];
if (changelog.entries.some((entry) => entry.commit === sourceCommit)) {
  console.log(`Changelog already contains ${sourceCommit}`);
  process.exit(0);
}

const match = String(changelog.version || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) throw new Error(`Invalid changelog version: ${changelog.version}`);
const patchBumped = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;

// If package.json was manually set to a higher version (e.g. a major/minor bump),
// honour that instead of overwriting it with a patch increment.
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
function semverGt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}
const nextVersion = semverGt(packageJson.version, patchBumped) ? packageJson.version : patchBumped;

changelog.version = nextVersion;
changelog.updatedAt = sourceDate;
const entry = {
  version: nextVersion,
  date: sourceDate,
  commit: sourceCommit,
  message: sourceMessage,
  author: sourceAuthor,
};
if (allDetails.length > 0) entry.details = allDetails;
changelog.entries.unshift(entry);

packageJson.version = nextVersion;

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
packageLock.version = nextVersion;
if (packageLock.packages?.[""]) packageLock.packages[""].version = nextVersion;

fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
console.log(`Prepared Plembfin ${nextVersion} for ${sourceCommit.slice(0, 7)}`);
