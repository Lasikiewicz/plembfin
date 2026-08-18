#!/usr/bin/env node

import { execFileSync } from "node:child_process";

// A `git push` can carry several commits, but GitHub's push event only exposes
// head_commit - everything else would silently vanish from a changelog if a
// multi-commit push isn't summarized by hand in the final commit message.
// Worse, if an earlier push's CI run failed before this script ever ran, that
// push's commit never got an entry at all, and it won't appear in *this*
// push's event payload either. So the authoritative source of "what's new
// since the last entry" is git history itself: walk every commit between the
// last recorded changelog commit and the current one.
export function commitsSinceLastEntry(root, lastCommit, headCommit) {
  if (!lastCommit || lastCommit === headCommit) return [];
  const unitSep = "";
  const recordSep = "";
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
