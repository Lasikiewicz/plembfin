#!/usr/bin/env node

// Rebuilds changelog.develop.json's single rolling entry from scratch, from
// real local git history, as part of "Push to git" - run locally, before the
// commit is pushed, so the pushed commit already carries correct changelog
// content. This replaces the old model of a CI job appending one entry per
// push (each entry building up alongside the others, later needing manual
// consolidation before a promotion) with always recomputing the one entry
// that represents everything since the last "Force to alpha" reset, so there
// is only ever one develop entry to read and it is always current.
//
// changelog.develop.json's `resetCommit` field is the anchor: the commit at
// which the last reset happened (see promoteDevelopToAlpha in
// promote-develop-to-alpha.js). Every real, user-facing commit between that
// anchor and HEAD is folded into the rebuilt entry; noise (bot/merge)
// commits, changelog-process commits, and non-release-type commits (test:,
// chore:, refactor:, style:, ci:) are excluded, same rules as before.
//
// The `build` counter is unrelated to content and keeps counting up across
// the whole lifetime of the branch (see the comment on promoteDevelopToAlpha
// for why it never chases a parent version string) - it bumps by one on every
// rebuild that finds real content, independent of how many commits that
// rebuild covers.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bulletPointsFrom, filterChangelogDetails, formatChangelogMessage, isChangelogProcessMessage, isNoiseCommitMessage, isReleaseTypeCommitMessage, synthesizeHeadline, validateReleaseMessage } from "./changelog-message.js";
import { changeAreaDetails, changedFilesForCommit, commitsSinceLastEntry, gitHeadAuthor, gitHeadCommit } from "./changelog-git-helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const developChangelogPath = path.join(root, "changelog.develop.json");

// Pure and exported for testing: given the full set of commits between the
// reset anchor and HEAD, builds the single consolidated entry, or returns
// null when there is nothing user-facing to report (the caller then leaves
// changelog.develop.json untouched rather than publishing an empty entry).
export function buildDevelopEntry({ commits, headCommit, date, author, nextBuild, changedFilesForCommitFn = () => [] }) {
  const releaseCommits = commits.filter((commit) =>
    !isNoiseCommitMessage(commit.message)
    && !isChangelogProcessMessage(commit.message)
    && isReleaseTypeCommitMessage(commit.message));

  if (releaseCommits.length === 0) return null;

  const messageErrors = releaseCommits.flatMap((commit) =>
    validateReleaseMessage(commit.message).map((error) => `${String(commit.id || "").slice(0, 7)}: ${error}`));
  if (messageErrors.length > 0) {
    throw new Error(`Refusing to rebuild the develop changelog:\n${messageErrors.map((e) => `- ${e}`).join("\n")}`);
  }

  let details = [];
  for (const commit of releaseCommits) {
    const bullets = bulletPointsFrom(commit.message);
    if (bullets.length) {
      details.push(...filterChangelogDetails(bullets));
    } else {
      const generated = changeAreaDetails(changedFilesForCommitFn(commit.id));
      details.push(...filterChangelogDetails(generated.length
        ? generated
        : [formatChangelogMessage(String(commit.message || "").split(/\r?\n/, 1)[0])]));
    }
  }
  details = details.filter((v, i, arr) => v && arr.indexOf(v) === i);

  // Every real commit since the reset anchor contributes its own headline -
  // not just the most recent one - so a develop entry spanning several
  // separate "Push to git" runs reads as one sentence covering all of them
  // instead of silently showing only the last push's subject line.
  const message = synthesizeHeadline(releaseCommits.map((commit) =>
    formatChangelogMessage(String(commit.message || "").split(/\r?\n/, 1)[0])));

  const entry = { build: nextBuild, date, commit: headCommit, message, author };
  if (details.length > 0) entry.details = details;
  return entry;
}

// Validates the committed changelog content against the user-facing commits
// since its reset anchor. The entry's generated timestamp and commit pointer
// are intentionally ignored: the changelog is rebuilt before its own commit,
// and the final push commit may be a consolidated commit that replaces that
// intermediate history. Message and details are the durable user-facing data.
export function validateDevelopChangelog({ changelog, commits, headCommit, changedFilesForCommitFn = () => [] } = {}) {
  const currentBuild = Number(changelog?.build || 0);
  const expected = buildDevelopEntry({
    commits,
    headCommit,
    date: "",
    author: "",
    nextBuild: Number.isFinite(currentBuild) ? currentBuild : 0,
    changedFilesForCommitFn,
  });
  if (!expected) return null;

  const entries = Array.isArray(changelog?.entries) ? changelog.entries : [];
  const actual = entries.length === 1 ? entries[0] : null;
  const failures = [];
  if (!actual) {
    failures.push("expected exactly one current entry");
  } else {
    if (actual.message !== expected.message) failures.push(`message should be \"${expected.message}\"`);
    const actualDetails = Array.isArray(actual.details) ? actual.details : [];
    const expectedDetails = Array.isArray(expected.details) ? expected.details : [];
    if (JSON.stringify(actualDetails) !== JSON.stringify(expectedDetails)) failures.push("details do not cover the current user-facing commits");
    if (Number(actual.build) !== currentBuild) failures.push("entry build does not match the changelog build");
    if (!actual.date || String(changelog.updatedAt || "") !== String(actual.date)) failures.push("updatedAt does not match the entry date");
  }

  if (failures.length) {
    throw new Error(`Develop changelog is stale for ${String(headCommit || "HEAD").slice(0, 7)}:\n- ${failures.join("\n- ")}\nRun node scripts/rebuild-develop-changelog.js, commit changelog.develop.json, and retry the push.`);
  }
  return expected;
}

function developChangelogAtCommit(headCommit) {
  try {
    const raw = execFileSync("git", ["show", `${headCommit}:changelog.develop.json`], { cwd: root, encoding: "utf8" });
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not read changelog.develop.json from ${String(headCommit || "HEAD").slice(0, 7)}: ${error.message}`);
  }
}

function verifyCommittedDevelopChangelog(headCommit) {
  const develop = developChangelogAtCommit(headCommit);
  const anchorCommit = String(develop.resetCommit || "").trim();
  if (!anchorCommit) throw new Error("changelog.develop.json has no resetCommit anchor.");
  if (anchorCommit === headCommit) {
    console.log("Develop changelog check passed: no commits since the reset anchor.");
    return;
  }

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", anchorCommit, headCommit], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(`changelog.develop.json resetCommit ${anchorCommit.slice(0, 7)} is not an ancestor of ${String(headCommit).slice(0, 7)}.`);
  }

  const commits = commitsSinceLastEntry(root, anchorCommit, headCommit);
  const entry = validateDevelopChangelog({
    changelog: develop,
    commits,
    headCommit,
    changedFilesForCommitFn: (commitId) => changedFilesForCommit(root, commitId),
  });
  console.log(entry
    ? `Develop changelog check passed for ${String(headCommit).slice(0, 7)}.`
    : "Develop changelog check passed: no user-facing commits since the reset anchor.");
}

function main() {
  if (process.argv[2] === "--check") {
    try {
      verifyCommittedDevelopChangelog(process.argv[3] || gitHeadCommit(root));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    return;
  }

  let develop;
  try {
    develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
  } catch {
    develop = { build: 0, resetCommit: "", entries: [] };
  }
  if (!Array.isArray(develop.entries)) develop.entries = [];

  const headCommit = gitHeadCommit(root);
  const anchorCommit = String(develop.resetCommit || "").trim();
  if (!anchorCommit) {
    console.error("changelog.develop.json has no resetCommit anchor. Force to alpha sets this on every reset - if this is a fresh repo or a one-time migration, set resetCommit to the current HEAD by hand first.");
    process.exit(1);
  }
  if (anchorCommit === headCommit) {
    console.log("No new commits since the last reset - leaving changelog.develop.json unchanged.");
    process.exit(0);
  }

  const commits = commitsSinceLastEntry(root, anchorCommit, headCommit);
  let entry;
  try {
    entry = buildDevelopEntry({
      commits,
      headCommit,
      date: new Date().toISOString(),
      author: gitHeadAuthor(root),
      nextBuild: Number(develop.build || 0) + 1,
      changedFilesForCommitFn: (commitId) => changedFilesForCommit(root, commitId),
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (!entry) {
    console.log("No user-facing commits since the last reset - leaving changelog.develop.json unchanged.");
    process.exit(0);
  }

  develop.build = entry.build;
  develop.entries = [entry];
  develop.updatedAt = entry.date;

  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);
  console.log(`Rebuilt develop changelog: build ${entry.build} covering ${commits.length} commit(s) since ${anchorCommit.slice(0, 7)}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
