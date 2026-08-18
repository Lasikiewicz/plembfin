#!/usr/bin/env node

// Bumps the rolling alpha build counter and records a changelog entry for a
// push to the alpha branch. Deliberately separate from update-changelog.js /
// changelog.json: alpha pushes must never advance the real semver or
// package.json version (see docker-publish-alpha.yml and CLAUDE.md's
// branching model) - that field only changes when alpha is promoted to main.
// The build counter instead tracks "which alpha build is this" independently,
// displayed as `${baseVersion}.${build} alpha` (e.g. "0.8.0.7 alpha").

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bulletPointsFrom, formatChangelogMessage, validateReleaseMessage } from "./changelog-message.js";
import { changeAreaDetails, changedFilesForCommit, commitsSinceLastEntry } from "./changelog-git-helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const alphaChangelogPath = path.join(root, "changelog.alpha.json");

const sourceCommit = String(process.env.SOURCE_COMMIT || "").trim();
const rawMessage = String(process.env.SOURCE_MESSAGE || "Update application").trim();
const sourceMessage = formatChangelogMessage(rawMessage.split(/\r?\n/, 1)[0]);
const sourceDate = String(process.env.SOURCE_DATE || new Date().toISOString()).trim();
const sourceAuthor = String(process.env.SOURCE_AUTHOR || "unknown").trim();

if (!sourceCommit) {
  console.error("SOURCE_COMMIT is required");
  process.exit(1);
}

const mainVersion = JSON.parse(fs.readFileSync(changelogPath, "utf8")).version || "0.0.0";

let alpha;
try {
  alpha = JSON.parse(fs.readFileSync(alphaChangelogPath, "utf8"));
} catch {
  alpha = { baseVersion: mainVersion, build: 0, entries: [] };
}
if (!Array.isArray(alpha.entries)) alpha.entries = [];

if (alpha.entries.some((entry) => entry.commit === sourceCommit)) {
  console.log(`Alpha changelog already contains ${sourceCommit}`);
  process.exit(0);
}

// alpha is merged from main at the start of every "Merge alpha with main" run,
// so a base-version mismatch here means main just moved forward - start a
// fresh build count and entry list for this new cycle.
if (alpha.baseVersion !== mainVersion) {
  alpha = { baseVersion: mainVersion, build: 0, entries: [] };
}

let pushedCommits = [];
try {
  const parsedCommits = JSON.parse(process.env.COMMITS_JSON || "[]");
  if (Array.isArray(parsedCommits)) pushedCommits = parsedCommits;
} catch {
  // COMMITS_JSON absent or malformed - the head commit is still validated below.
}

const lastRecordedCommit = alpha.entries[0]?.commit || "";
const gitHistoryCommits = commitsSinceLastEntry(root, lastRecordedCommit, sourceCommit);
const otherCommitsRaw = gitHistoryCommits.length > 0 ? gitHistoryCommits : pushedCommits;
const otherCommits = otherCommitsRaw.filter((commit) =>
  commit.id !== sourceCommit && !/^chore: bump alpha build for /.test(String(commit.message || "")));

const messagesToValidate = [
  { id: sourceCommit, message: rawMessage },
  ...otherCommits,
];
const messageErrors = messagesToValidate.flatMap((commit) =>
  validateReleaseMessage(commit.message).map((error) => `${String(commit.id || "head").slice(0, 7)}: ${error}`));
if (messageErrors.length > 0) {
  console.error("Refusing to generate an incomplete alpha changelog entry:");
  for (const error of messageErrors) console.error(`- ${error}`);
  process.exit(1);
}

const sourceDetails = bulletPointsFrom(rawMessage);

let backfilledDetails = [];
for (const commit of otherCommits) {
  const bullets = bulletPointsFrom(commit.message);
  if (bullets.length) backfilledDetails.push(...bullets);
  else {
    const generatedDetails = changeAreaDetails(changedFilesForCommit(root, commit.id));
    backfilledDetails.push(...(generatedDetails.length
      ? generatedDetails
      : [String(commit.message || "").split(/\r?\n/, 1)[0].trim()]));
  }
}

if (sourceDetails.length === 0) {
  const source = pushedCommits.find((commit) => commit.id === sourceCommit);
  const sourceFiles = [
    ...(Array.isArray(source?.added) ? source.added : []),
    ...(Array.isArray(source?.modified) ? source.modified : []),
    ...(Array.isArray(source?.removed) ? source.removed : []),
  ].filter(Boolean);
  const effectiveSourceFiles = sourceFiles.length ? sourceFiles : changedFilesForCommit(root, sourceCommit);
  const generatedDetails = changeAreaDetails(effectiveSourceFiles);
  sourceDetails.push(...(generatedDetails.length ? generatedDetails : [sourceMessage]));
}

const allDetails = [...backfilledDetails, ...sourceDetails].filter((v, i, arr) => v && arr.indexOf(v) === i);

const nextBuild = Number(alpha.build || 0) + 1;
alpha.build = nextBuild;
alpha.updatedAt = sourceDate;
const entry = {
  build: nextBuild,
  version: `${alpha.baseVersion}.${nextBuild}`,
  date: sourceDate,
  commit: sourceCommit,
  message: sourceMessage,
  author: sourceAuthor,
};
if (allDetails.length > 0) entry.details = allDetails;
alpha.entries.unshift(entry);
// Rolling window - alpha builds are ephemeral and reset on every merge, so
// there is no need to keep more history than fits comfortably in the UI.
alpha.entries = alpha.entries.slice(0, 100);

fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(alpha, null, 2)}\n`);
console.log(`Prepared Plembfin ${alpha.baseVersion}.${nextBuild} alpha for ${sourceCommit.slice(0, 7)}`);
