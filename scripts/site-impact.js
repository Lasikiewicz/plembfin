#!/usr/bin/env node

// The website content-impact release gate (see plan/website-content-impact-gate.md,
// now archived once implemented). A changed application surface must map to a
// reviewed website/docs update, or the commit(s) that touched it must carry an
// explicit `site-impact:` decision. This keeps Force to main from silently
// shipping a public-facing change the website never learned about, while still
// letting an author explain why a given change has no public content impact
// instead of forcing every commit to touch the website.
//
// The trailer is one line in the commit body:
//   site-impact: none
//   site-impact: sync-tuning
// "none" means the change has no public content impact. A value naming a
// docSlug means the author is attesting that guide already covers (or will,
// via a later commit in the same range) this change; it still has to name a
// slug that exists in app-surface.json, so a typo cannot silently pass.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFilesForCommit, commitsSinceLastEntry, fileAtRef, gitHeadCommit } from "./changelog-git-helpers.js";
import { isNoiseCommitMessage } from "./changelog-message.js";
import { mapWebsiteTargets } from "./update-local-updates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SITE_IMPACT_TRAILER = /^site-impact:\s*(.+)$/gim;
const RELEVANT_UNMAPPED_PATTERN = /^(?:public|server|docs)\//;

function normalisePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

// Takes the last occurrence so a corrected line (added without deleting an
// earlier mistaken one) wins, matching how git trailers are conventionally
// read.
export function parseSiteImpactTrailer(message) {
  const matches = [...String(message || "").matchAll(SITE_IMPACT_TRAILER)];
  if (!matches.length) return null;
  const raw = matches[matches.length - 1][1].trim();
  if (!raw) return null;
  if (/^none$/i.test(raw)) return { kind: "none", raw };
  return { kind: "target", docSlug: raw.toLowerCase(), raw };
}

function normaliseCommit(commit) {
  return {
    shortId: String(commit.shortId || commit.id || "").slice(0, 7),
    files: unique((commit.files || []).map(normalisePath)),
    decision: parseSiteImpactTrailer(commit.message),
  };
}

// Pure and git-free so it can be unit tested directly. `commits` is
// [{ id | shortId, message, files }]; `surfaces` overrides app-surface.json
// for tests, exactly like mapWebsiteTargets.
export function computeWebsiteContentImpactFailures({ commits = [], surfaces = null } = {}) {
  // A release-bookkeeping commit (changelog rebuild/promotion, asset-version
  // restamp) is exactly the kind of thing isNoiseCommitMessage already keeps
  // out of the changelog - it mechanically touches most of public/ without
  // being a real product change, and would otherwise swamp this gate with
  // false positives every single release.
  const normalisedCommits = commits.filter((commit) => !isNoiseCommitMessage(commit.message)).map(normaliseCommit);
  const changedFiles = unique(normalisedCommits.flatMap((commit) => commit.files));
  const targets = mapWebsiteTargets(changedFiles, surfaces);

  function commitsTouching(file) {
    return normalisedCommits.filter((commit) => commit.files.includes(file));
  }

  // expectedDocSlug is the target this file is catalogued under, or null when
  // the file matches no catalog entry at all. A "none" decision always
  // excuses; a "target" decision only excuses a catalogued file when it names
  // that same target, but excuses an uncatalogued file by naming any real
  // target at all (the author is attesting where it belongs).
  function isExcused(file, expectedDocSlug) {
    const touching = commitsTouching(file);
    if (!touching.length) return true;
    return touching.every((commit) => {
      if (!commit.decision) return false;
      if (commit.decision.kind === "none") return true;
      if (expectedDocSlug) return commit.decision.docSlug === expectedDocSlug;
      return true;
    });
  }

  const failures = [];
  const catalogued = new Set();

  for (const target of targets) {
    // website-infrastructure and release-and-site-surface are synthetic
    // groupings for shared layout/build bookkeeping, not a catalogued app
    // surface with its own guide - out of scope for this gate.
    if (!target.docSlug) continue;

    const docPath = `website/src/content/docs/${target.docSlug}.mdx`;
    for (const file of target.files) catalogued.add(file);
    if (target.files.includes(docPath)) continue; // a reviewed content update is present

    for (const file of target.files) {
      if (file === docPath) continue;
      if (isExcused(file, target.docSlug)) continue;
      failures.push({
        file,
        docSlug: target.docSlug,
        label: target.labels.join(" / ") || target.docSlug,
        commits: commitsTouching(file).map((commit) => commit.shortId),
      });
    }
  }

  for (const file of changedFiles) {
    if (catalogued.has(file)) continue;
    if (!RELEVANT_UNMAPPED_PATTERN.test(file)) continue;
    if (isExcused(file, null)) continue;
    failures.push({
      file,
      docSlug: "",
      label: "not represented in app-surface.json",
      commits: commitsTouching(file).map((commit) => commit.shortId),
    });
  }

  return failures.sort((left, right) => left.file.localeCompare(right.file));
}

export function formatWebsiteContentImpactFailure(failure) {
  const commits = failure.commits.length ? ` (touched by ${failure.commits.join(", ")})` : "";
  const target = failure.docSlug
    ? `maps to website guide ${failure.docSlug}.mdx, not updated in this release`
    : failure.label;
  return `${failure.file}${commits}\n    ${target}`;
}

// Walks the real commit range with git and runs the pure check above.
// fromCommit/toCommit are the previous main release's commit and the current
// HEAD; see promote-alpha-to-main.js for how those are resolved.
export function websiteContentImpactViolations({ root, fromCommit, toCommit, surfaces = null } = {}) {
  if (!root || !fromCommit || !toCommit || fromCommit === toCommit) return [];
  const commits = commitsSinceLastEntry(root, fromCommit, toCommit).map((commit) => ({
    id: commit.id,
    message: commit.message,
    files: changedFilesForCommit(root, commit.id),
  }));
  return computeWebsiteContentImpactFailures({ commits, surfaces }).map(formatWebsiteContentImpactFailure);
}

// Reads the commit the currently published main release was built from, out
// of origin/main's own changelog.json, so the standalone CLI check below (and
// the gate embedded in promote-alpha-to-main.js) always compares against what
// is actually live rather than a local guess.
function resolvePreviousMainReleaseCommit() {
  const remoteChangelog = fileAtRef(root, "origin/main", "changelog.json");
  if (!remoteChangelog) return "";
  try {
    return JSON.parse(remoteChangelog)?.entries?.[0]?.commit || "";
  } catch {
    return "";
  }
}

function main() {
  const fromCommit = resolvePreviousMainReleaseCommit();
  const toCommit = gitHeadCommit(root);
  if (!fromCommit) {
    console.log("Website content-impact gate: no previous main release commit found (origin/main unreachable, or first release) - nothing to check.");
    return;
  }
  const failures = websiteContentImpactViolations({ root, fromCommit, toCommit });
  if (failures.length) {
    console.error(`Website content-impact gate: FAILED\n\n${failures.map((f) => `- ${f}`).join("\n")}\n\nAdd a website update for the change, or add a "site-impact: none" (or "site-impact: <docSlug>") line to the commit body explaining why no public content change is needed, then retry.`);
    process.exitCode = 1;
  } else {
    console.log(`Website content-impact gate: passed (checked ${fromCommit.slice(0, 7)}..${toCommit.slice(0, 7)}).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
