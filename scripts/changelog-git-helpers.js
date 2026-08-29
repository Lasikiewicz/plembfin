#!/usr/bin/env node

import { execFileSync } from "node:child_process";

// The changelog pipeline computes entries locally (as part of "Push to git" /
// "Force to alpha" / "Force to main", run against a real local clone with
// full history) rather than from GitHub's push-event payload - that payload
// only reliably lists commits for a plain incremental push, and is empty or
// incomplete for a force-push, which is how develop's tip always reaches
// alpha and alpha's tip always reaches main. Git history itself is the only
// authoritative source of "what's new since the anchor commit", inclusive of
// the head commit itself.
export function commitsSinceLastEntry(root, anchorCommit, headCommit) {
  if (!anchorCommit || anchorCommit === headCommit) return [];
  // Real ASCII Unit/Record Separator control characters, not empty strings -
  // a commit body can legitimately contain any printable character (including
  // literal "%H"-looking text), so the split points must be characters git
  // guarantees never appear in a commit message on their own.
  const unitSep = "\x1f";
  const recordSep = "\x1e";
  try {
    const raw = execFileSync(
      "git",
      ["log", "--reverse", `--pretty=format:%H${unitSep}%B${recordSep}`, `${anchorCommit}..${headCommit}`],
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
      .filter((commit) => commit.id);
  } catch (error) {
    console.error(`Could not walk git history from ${anchorCommit} to ${headCommit}: ${error.message}`);
    return [];
  }
}

export function gitHeadCommit(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

export function gitHeadAuthor(root) {
  try {
    return execFileSync("git", ["log", "-1", "--pretty=format:%an"], { cwd: root, encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function changedFilesForCommit(root, commitId) {
  if (!commitId) return [];
  try {
    return execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", commitId], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function changeAreaDetails(files) {
  const areas = new Set();
  for (const file of files) {
    if (/^(public\/|server\/)/.test(file)) areas.add("Updated application behavior and the web interface.");
    if (/^docs\//.test(file) || /\.md$/.test(file)) areas.add("Updated user and developer documentation.");
    if (/^(scripts\/|\.github\/)/.test(file)) areas.add("Updated build, release, or repository automation.");
    if (/^(test\/|tests\/)/.test(file)) areas.add("Updated automated regression coverage.");
  }
  return [...areas];
}
