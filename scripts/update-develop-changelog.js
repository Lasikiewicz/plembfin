#!/usr/bin/env node

// Bumps the rolling develop build counter (5th segment) and records a changelog
// entry for a push to the develop branch.
// Format: ${mainVersion}.${alphaBuild}.${developBuild} (e.g. "0.8.6.7.1")

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bulletPointsFrom, formatChangelogMessage, isNoiseCommitMessage, isReleaseTypeCommitMessage, validateReleaseMessage } from "./changelog-message.js";
import { changeAreaDetails, changedFilesForCommit, commitsSinceLastEntry } from "./changelog-git-helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const alphaChangelogPath = path.join(root, "changelog.alpha.json");
const developChangelogPath = path.join(root, "changelog.develop.json");

const sourceCommit = String(process.env.SOURCE_COMMIT || "").trim();
const rawMessage = String(process.env.SOURCE_MESSAGE || "Update application").trim();
const sourceDate = String(process.env.SOURCE_DATE || new Date().toISOString()).trim();
const sourceAuthor = String(process.env.SOURCE_AUTHOR || "unknown").trim();

if (!sourceCommit) {
  console.error("SOURCE_COMMIT is required");
  process.exit(1);
}

let mainVersion = "0.0.0";
try {
  mainVersion = JSON.parse(fs.readFileSync(changelogPath, "utf8")).version || "0.0.0";
} catch { }

let alpha = { baseVersion: mainVersion, build: 0 };
try {
  alpha = JSON.parse(fs.readFileSync(alphaChangelogPath, "utf8"));
} catch { }

const alphaBaseVersion = `${alpha.baseVersion || mainVersion}.${alpha.build || 0}`;

let develop;
try {
  develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
} catch {
  develop = { baseVersion: alphaBaseVersion, build: 0, entries: [] };
}
if (!Array.isArray(develop.entries)) develop.entries = [];

if (develop.entries.some((entry) => entry.commit === sourceCommit)) {
  console.log(`Develop changelog already contains ${sourceCommit}`);
  process.exit(0);
}

// If the underlying alpha base version changed, reset develop build counter to 0 for the new cycle
if (develop.baseVersion !== alphaBaseVersion) {
  develop = { baseVersion: alphaBaseVersion, build: 0, entries: [] };
}

let pushedCommits = [];
try {
  const parsedCommits = JSON.parse(process.env.COMMITS_JSON || "[]");
  if (Array.isArray(parsedCommits)) pushedCommits = parsedCommits;
} catch { }

const lastRecordedCommit = develop.entries[0]?.commit || "";
const gitHistoryCommits = commitsSinceLastEntry(root, lastRecordedCommit, sourceCommit);
const otherCommitsRaw = gitHistoryCommits.length > 0 ? gitHistoryCommits : pushedCommits;
const otherCommits = otherCommitsRaw.filter((commit) =>
  commit.id !== sourceCommit && !isNoiseCommitMessage(commit.message) && isReleaseTypeCommitMessage(commit.message));

let effectiveCommit = sourceCommit;
let effectiveMessage = rawMessage;
if (isNoiseCommitMessage(rawMessage) && otherCommits.length) {
  const latest = otherCommits.pop();
  effectiveCommit = latest.id;
  effectiveMessage = latest.message;
}
const sourceMessage = formatChangelogMessage(effectiveMessage.split(/\r?\n/, 1)[0]);

const messagesToValidate = [
  { id: effectiveCommit, message: effectiveMessage },
  ...otherCommits,
];
const messageErrors = messagesToValidate.flatMap((commit) =>
  validateReleaseMessage(commit.message).map((error) => `${String(commit.id || "head").slice(0, 7)}: ${error}`));
if (messageErrors.length > 0) {
  console.error("Refusing to generate an incomplete develop changelog entry:");
  for (const error of messageErrors) console.error(`- ${error}`);
  process.exit(1);
}

const sourceDetails = bulletPointsFrom(effectiveMessage);

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
  const source = pushedCommits.find((commit) => commit.id === effectiveCommit);
  const sourceFiles = [
    ...(Array.isArray(source?.added) ? source.added : []),
    ...(Array.isArray(source?.modified) ? source.modified : []),
    ...(Array.isArray(source?.removed) ? source.removed : []),
  ].filter(Boolean);
  const effectiveSourceFiles = sourceFiles.length ? sourceFiles : changedFilesForCommit(root, effectiveCommit);
  const generatedDetails = changeAreaDetails(effectiveSourceFiles);
  sourceDetails.push(...(generatedDetails.length ? generatedDetails : [sourceMessage]));
}

const allDetails = [...backfilledDetails, ...sourceDetails].filter((v, i, arr) => v && arr.indexOf(v) === i);

const nextBuild = Number(develop.build || 0) + 1;
const fullVersion = `${develop.baseVersion}.${nextBuild}`;
develop.build = nextBuild;
develop.version = fullVersion;
develop.updatedAt = sourceDate;

const entry = {
  build: nextBuild,
  version: fullVersion,
  date: sourceDate,
  commit: sourceCommit,
  message: sourceMessage,
  author: sourceAuthor,
};
if (allDetails.length > 0) entry.details = allDetails;
develop.entries.unshift(entry);
develop.entries = develop.entries.slice(0, 100);

fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);
console.log(`Prepared Plembfin ${fullVersion} develop for ${sourceCommit.slice(0, 7)}`);
