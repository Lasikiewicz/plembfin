#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { bulletPointsFrom, formatChangelogMessage, validateReleaseMessage } from "./changelog-message.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");

const sourceCommit = String(process.env.SOURCE_COMMIT || "").trim();
const rawMessage = String(process.env.SOURCE_MESSAGE || "Update application").trim();
const sourceMessage = formatChangelogMessage(rawMessage.split(/\r?\n/, 1)[0]);
const sourceDate = String(process.env.SOURCE_DATE || new Date().toISOString()).trim();
const sourceAuthor = String(process.env.SOURCE_AUTHOR || "unknown").trim();

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

let pushedCommits = [];
try {
  const parsedCommits = JSON.parse(process.env.COMMITS_JSON || "[]");
  if (Array.isArray(parsedCommits)) pushedCommits = parsedCommits;
} catch {
  // COMMITS_JSON absent or malformed — the head commit is still validated below.
}

// A `git push` can carry several commits, but GitHub's push event only exposes
// head_commit — everything else would silently vanish from the changelog if a
// multi-commit push isn't summarized by hand in the final commit message.
// Worse, if an earlier push's CI run failed before this script ever ran (e.g. a
// flaky test on the runner), that push's commit never got a changelog entry at
// all, and it won't appear in *this* push's event payload either — from
// GitHub's perspective it was already on `main` before this push started. So
// the authoritative source of "what's new since the last entry" is git history
// itself: walk every commit between the last recorded changelog commit and the
// current one, not just whatever commits this particular push happened to carry.
function commitsSinceLastEntry(lastCommit, headCommit) {
  if (!lastCommit || lastCommit === headCommit) return [];
  const unitSep = "";
  const recordSep = "";
  try {
    const raw = execFileSync(
      "git",
      ["log", "--reverse", `--pretty=format:%H${unitSep}%B${recordSep}`, `${lastCommit}..${headCommit}`],
      { cwd: root, encoding: "utf8" },
    );
    return raw
      .split(recordSep)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [id, ...rest] = chunk.split(unitSep);
        return { id, message: rest.join(unitSep).trim() };
      })
      .filter((commit) => commit.id && commit.id !== headCommit);
  } catch (error) {
    console.error(`Could not walk git history from ${lastCommit} to ${headCommit}: ${error.message}`);
    return [];
  }
}

const lastRecordedCommit = changelog.entries[0]?.commit || "";
const gitHistoryCommits = commitsSinceLastEntry(lastRecordedCommit, sourceCommit);

// Prefer git history (authoritative and immune to a prior push's CI failure);
// fall back to the push event's commit list only when history isn't usable
// (e.g. the changelog has no prior entry to anchor a range from).
const otherCommitsRaw = gitHistoryCommits.length > 0 ? gitHistoryCommits : pushedCommits;
const otherCommits = otherCommitsRaw.filter((commit) =>
  commit.id !== sourceCommit && !/^chore: update changelog for /.test(String(commit.message || "")));

const messagesToValidate = [
  { id: sourceCommit, message: rawMessage },
  ...otherCommits,
];
const messageErrors = messagesToValidate.flatMap((commit) =>
  validateReleaseMessage(commit.message).map((error) => `${String(commit.id || "head").slice(0, 7)}: ${error}`));
if (messageErrors.length > 0) {
  console.error("Refusing to generate an incomplete changelog entry:");
  for (const error of messageErrors) console.error(`- ${error}`);
  process.exit(1);
}

const sourceDetails = bulletPointsFrom(rawMessage);

let backfilledDetails = [];
for (const commit of otherCommits) {
  const bullets = bulletPointsFrom(commit.message);
  if (bullets.length) backfilledDetails.push(...bullets);
  else backfilledDetails.push(String(commit.message || "").split(/\r?\n/, 1)[0].trim());
}

// Do not allow a subject-only head commit to create a release with no details.
// Commit bodies remain the preferred source, but changed files provide a useful
// automatic fallback when a contributor only supplies a one-line summary.
if (sourceDetails.length === 0) {
  const source = pushedCommits.find((commit) => commit.id === sourceCommit);
  const sourceFiles = [
    ...(Array.isArray(source?.added) ? source.added : []),
    ...(Array.isArray(source?.modified) ? source.modified : []),
    ...(Array.isArray(source?.removed) ? source.removed : []),
  ].filter(Boolean);
  sourceDetails.push(sourceFiles.length
    ? `Changed files: ${sourceFiles.slice(0, 8).join(", ")}${sourceFiles.length > 8 ? " (and more)" : ""}`
    : sourceMessage);
}

const allDetails = [...backfilledDetails, ...sourceDetails].filter((v, i, arr) => v && arr.indexOf(v) === i);

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
