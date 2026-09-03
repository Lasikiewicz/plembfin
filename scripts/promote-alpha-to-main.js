#!/usr/bin/env node

// Consolidates every alpha build entry accumulated this cycle (see
// promoteDevelopToAlpha - alpha holds one entry per "Force to alpha" call,
// not a single rolling entry) into one clean, permanent Main release entry,
// bumps the real semver, and regenerates every derived file (package.json,
// package-lock.json, CHANGELOG.md) - then resets alpha and develop for the
// next cycle. Run locally as part of "Force to main", before the force-push,
// so the pushed commit already carries the finished release; CI no longer
// needs to generate or fix up changelog content afterward.
//
// Passing --preview runs the same release computation read-only (no files are
// written or reset) and prints the version + merged release entry that would be
// committed to main, so a human can confirm the changelog before "Force to main"
// stages, commits, and force-pushes it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntryProcessViolations, filterChangelogEntries, synthesizeHeadline } from "./changelog-message.js";
import { formatSections, mergeSections } from "./promote-develop-to-alpha.js";
import { generateChangelogMarkdown } from "./generate-changelog-md.js";
import { gitHeadAuthor, gitHeadCommit } from "./changelog-git-helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const alphaChangelogPath = path.join(root, "changelog.alpha.json");
const developChangelogPath = path.join(root, "changelog.develop.json");
const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");

export function bumpPatchVersion(currentVersion = "0.0.0") {
  const parts = currentVersion.split(".").map((n) => Number(n) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = (parts[2] ?? 0) + 1;
  return `${major}.${minor}.${patch}`;
}

function semverGt(a, b) {
  const pa = String(a || "0.0.0").split(".").map(Number);
  const pb = String(b || "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Pure step shared by preview and the real promotion: read the current
// changelog, alpha, and package.json and return the release entry that would
// be written (new version + the merged main entry), refusing to proceed if the
// assembled entry still contains recognized release-process text. Nothing here
// touches disk other than reading the source files, so it can back a
// non-mutating --preview pass used to show the changelog to a human before
// "Force to main" is allowed to stage and push it.
function computeAlphaToMainRelease({ targetVersion = "", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
  let changelog = { version: "0.8.6", entries: [] };
  try {
    changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));
  } catch { }
  if (!Array.isArray(changelog.entries)) changelog.entries = [];

  let alpha = { baseVersion: changelog.version, build: 0, entries: [] };
  try {
    alpha = JSON.parse(fs.readFileSync(alphaChangelogPath, "utf8"));
  } catch { }
  if (!Array.isArray(alpha.entries)) alpha.entries = [];

  // If package.json was manually set to a higher version (a deliberate
  // major/minor bump), honour that instead of overwriting it with a patch
  // increment - same rule update-changelog.js used to apply in CI.
  const patchBumped = bumpPatchVersion(changelog.version);
  let manualVersion = "";
  try {
    manualVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "";
  } catch { }
  const newMainVersion = targetVersion || (semverGt(manualVersion, patchBumped) ? manualVersion : patchBumped);
  const new5DigitVersion = `${newMainVersion}.0.0`;

  const publicEntries = filterChangelogEntries(alpha.entries);

  // Each alpha build entry already carries its own correctly categorized `sections`
  // (categorizeEntries ran once, in promoteDevelopToAlpha, over that build's own raw
  // develop commits) - merge those directly rather than re-running categorizeEntries
  // over the entries themselves, which would treat each entry's synthesized `message`
  // sentence as an uncategorized bullet and land it in tweaks as a garbled duplicate.
  const sections = publicEntries.reduce(
    (acc, entry) => mergeSections(acc, entry.sections || {}),
    { newFeatures: [], majorBugFixes: [], tweaks: [] },
  );
  const simplifiedDetails = formatSections(sections);
  // alpha.entries is newest-first (see promoteDevelopToAlpha); read oldest-first here so
  // the release headline narrates the cycle in the order the builds actually happened.
  // Use each build's own atomic messageFragments when present rather than its single
  // flattened `message` - a build's message is already a composite whenever that build
  // bundled more than one develop commit/push - so synthesizeHeadline always gets the
  // true flat list of every commit's own headline across the whole cycle to join,
  // instead of treating an already-composite build message as one unsplittable piece.
  const messageFragments = [...publicEntries].reverse().flatMap((entry) =>
    Array.isArray(entry.messageFragments) && entry.messageFragments.length ? entry.messageFragments : [entry.message]);
  const mainMessage = synthesizeHeadline(messageFragments) || `Release v${newMainVersion}`;

  const mainEntry = {
    version: newMainVersion,
    version5Digit: new5DigitVersion,
    date: sourceDate,
    commit: commit || publicEntries[0]?.commit || "",
    message: mainMessage,
    author: sourceAuthor,
    details: simplifiedDetails,
    sections,
  };

  // Safety net: filterChangelogEntries above, and categorizeEntries when each alpha
  // build entry was originally built, already filter recognized release-process text,
  // but check the assembled entry directly before it is ever written, rather than
  // relying only on a separate step run afterward that could be skipped.
  const violations = changelogEntryProcessViolations(mainEntry);
  if (violations.length > 0) {
    throw new Error(`Refusing to promote alpha to main: the entry contains release-process notes:\n${violations.map((v) => `- ${v}`).join("\n")}`);
  }

  return { changelog, alpha, newMainVersion, new5DigitVersion, mainEntry };
}

// Renders the would-be release for a human review pass. Used by --preview so
// the changelog can be confirmed before "Force to main" actually promotes.
function renderReleasePreview({ newMainVersion, new5DigitVersion, mainEntry }) {
  const lines = [];
  lines.push("=== PREVIEW: Force-to-main release (nothing written yet) ===");
  lines.push(`Version: v${newMainVersion}  (5-digit: ${new5DigitVersion})`);
  lines.push("");
  lines.push("Message:");
  lines.push(`  ${mainEntry.message}`);
  lines.push("");
  const renderSection = (title, values) => {
    if (!values || values.length === 0) return;
    lines.push(`${title}:`);
    for (const value of values) lines.push(`  - ${value}`);
    lines.push("");
  };
  renderSection("New Features", mainEntry.sections?.newFeatures);
  renderSection("Major Bug Fixes", mainEntry.sections?.majorBugFixes);
  renderSection("Tweaks", mainEntry.sections?.tweaks);
  lines.push("(details[] carries the same items each prefixed Feature:/Fix:/Tweak:.)");
  console.log(lines.join("\n"));
}

export function promoteAlphaToMain({ targetVersion = "", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
  const { changelog, alpha, newMainVersion, new5DigitVersion, mainEntry } = computeAlphaToMainRelease({ targetVersion, sourceDate, sourceAuthor, commit });

  changelog.version = newMainVersion;
  changelog.updatedAt = sourceDate;
  changelog.entries.unshift(mainEntry);

  // Update package.json and package-lock.json
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    pkg.version = newMainVersion;
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch { }
  try {
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
    packageLock.version = newMainVersion;
    if (packageLock.packages?.[""]) packageLock.packages[""].version = newMainVersion;
    fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  } catch { }

  // Reset alpha changelog for the new release cycle
  const resetAlpha = {
    baseVersion: newMainVersion,
    build: 0,
    version: `${newMainVersion}.0.0`,
    updatedAt: sourceDate,
    entries: [],
  };

  // Clear develop's entry list for the new release cycle and move its
  // rebuild anchor to this promotion commit, so the next rebuild only walks
  // commits made after it. The build counter is never reset (see
  // rebuild-develop-changelog.js): it counts pushes to develop for the
  // lifetime of the branch, independent of alpha/main's version, so it can
  // never appear to regress relative to a branch it was promoted from.
  let develop = { build: 0, resetCommit: "", entries: [] };
  try {
    develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
  } catch { }
  develop = { build: develop.build || 0, resetCommit: commit || develop.resetCommit || "", updatedAt: sourceDate, entries: [] };

  fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(resetAlpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);
  generateChangelogMarkdown();

  console.log(`Promoted Alpha to Main release v${newMainVersion} (${new5DigitVersion})`);
  return { changelog, alpha: resetAlpha, develop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const targetArg = args.find((arg) => arg && !arg.startsWith("--"));
  const targetVersion = targetArg || process.env.TARGET_VERSION || "";

  if (preview) {
    // Non-mutating review pass: show exactly what "Force to main" would write
    // (version + the merged release entry) so the operator can confirm the
    // changelog with the user before anything is staged or pushed.
    const pending = computeAlphaToMainRelease({ targetVersion });
    renderReleasePreview(pending);
    console.log("\n[preview only - nothing written. Run without --preview to promote.]");
  } else {
    promoteAlphaToMain({
      targetVersion,
      commit: gitHeadCommit(root),
      sourceAuthor: gitHeadAuthor(root),
    });
  }
}
