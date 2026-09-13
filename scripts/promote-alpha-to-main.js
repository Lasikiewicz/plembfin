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
// written or reset) and prints the version + release entry that would be committed
// to main. The mutating command requires --confirm, which is only run after a human
// has approved that exact preview in the "Force to main" workflow.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntryProcessViolations, filterChangelogEntries } from "./changelog-message.js";
import { formatSections, mergeSections } from "./promote-develop-to-alpha.js";
import { generateChangelogMarkdown } from "./generate-changelog-md.js";
import { fileAtRef, gitHeadAuthor, gitHeadCommit } from "./changelog-git-helpers.js";
import { buildVersion, compareBuildVersions } from "./version.js";
import { spawnSync } from "node:child_process";

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

// The dev counter returns to 0 so the first "Push to git" of the new cycle is
// <release>.0.1, and the recorded version is the five-segment release itself,
// which is also what the freshly stamped public assets carry.
export function createDevelopReset({ version = "0.0.0", resetCommit = "", updatedAt = "" } = {}) {
  return {
    version: buildVersion(version, 0, 0),
    build: 0,
    resetCommit: String(resetCommit || ""),
    updatedAt,
    entries: [],
  };
}

// Five-segment aware. The old implementation split on "." and read only three
// positions, so anything past the patch was silently dropped and a non-numeric
// segment became NaN, which `(NaN || 0)` then collapsed to 0. This feeds the
// release-version decision below, so a wrong answer here picks the wrong version
// to publish to every user.
function semverGt(a, b) {
  return compareBuildVersions(a, b) > 0;
}

// Pure step shared by preview and the real promotion: read the current
// changelog, alpha, and package.json and return the release entry that would
// be written (new version + the merged main entry), refusing to proceed if the
// assembled entry still contains recognized release-process text. Nothing here
// touches disk other than reading the source files, so it can back a
// non-mutating --preview pass used to show the changelog to a human before
// "Force to main" is allowed to stage and push it.
function computeAlphaToMainRelease({ targetVersion = "", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
  // The released history must come from origin/main, not the working tree.
  //
  // This promotion runs from alpha's checkout. Alpha's tree came from develop,
  // and the release commit is never merged back into develop, so neither branch
  // holds main's release history. Reading the working tree would publish a
  // changelog containing only this release - and the loss compounds silently:
  // release N is absent from develop, so next cycle's alpha carries a file
  // missing release N, and release N+1 is appended to that. Every release would
  // erase the one before it, in the shipped image and on the website.
  //
  // CHANGELOG.md needs no separate handling: generateChangelogMarkdown() renders
  // it from changelog.json, so restoring the history here restores both files.
  //
  // The working tree is the fallback for a first release or a clone with no
  // remote-tracking refs. promoteAlphaToMain() gates on the result either way.
  let changelog = { version: "0.8.6", entries: [] };
  const remoteChangelog = fileAtRef(root, "origin/main", "changelog.json");
  let historySource = "origin/main";
  try {
    changelog = JSON.parse(remoteChangelog ?? fs.readFileSync(changelogPath, "utf8"));
    if (!remoteChangelog) historySource = "working tree";
  } catch {
    try {
      changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));
      historySource = "working tree";
    } catch { }
  }
  if (!Array.isArray(changelog.entries)) changelog.entries = [];

  let alpha = { baseVersion: changelog.version, build: 0, releaseMessage: "", entries: [] };
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
  // Alpha entries remain detailed and build-specific, but the final Main release
  // must carry one concise, human-approved headline instead of concatenating every
  // alpha build into a paragraph. The Force-to-main workflow writes this field after
  // reviewing the accumulated sections and before showing the preview.
  const configuredReleaseMessage = String(alpha.releaseMessage || "").trim();
  if (!configuredReleaseMessage) {
    throw new Error("Refusing to promote alpha to main: changelog.alpha.json must contain a concise releaseMessage after review.");
  }
  if (configuredReleaseMessage.length > 240 || /[\r\n]/.test(configuredReleaseMessage)) {
    throw new Error("Refusing to promote alpha to main: releaseMessage must be one line and at most 240 characters.");
  }
  const mainMessage = configuredReleaseMessage;

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

  return { changelog, alpha, newMainVersion, new5DigitVersion, mainEntry, historySource };
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

// Writing the merged history is not enough; it has to be checked before the
// force-push. A release that drops history cannot be recovered from the
// published image once users have pulled it, so this refuses the promotion
// rather than shipping a truncated changelog.
//
// Exported pure so it can be tested without touching disk or the network.
export function verifyReleaseHistory({ priorVersions = [], newVersions = [], newMainVersion = "" } = {}) {
  const failures = [];
  const present = new Set(newVersions.map((v) => String(v)));

  const missing = priorVersions.map(String).filter((v) => !present.has(v));
  if (missing.length > 0) {
    failures.push(`releases missing from the new history: ${missing.join(", ")}`);
  }

  const added = newVersions.map(String).filter((v) => !priorVersions.map(String).includes(v));
  if (added.length !== 1) {
    failures.push(`expected exactly one new release, found ${added.length}${added.length ? ` (${added.join(", ")})` : ""}`);
  } else if (added[0] !== String(newMainVersion)) {
    failures.push(`the one new release is ${added[0]}, expected ${newMainVersion}`);
  }

  if (newVersions.length !== priorVersions.length + 1) {
    failures.push(`history length went from ${priorVersions.length} to ${newVersions.length}, expected ${priorVersions.length + 1}`);
  }

  return failures;
}

export function promoteAlphaToMain({ targetVersion = "", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
  const { changelog, alpha, newMainVersion, new5DigitVersion, mainEntry, historySource } = computeAlphaToMainRelease({ targetVersion, sourceDate, sourceAuthor, commit });

  const priorVersions = changelog.entries.map((entry) => entry.version);

  changelog.version = newMainVersion;
  changelog.updatedAt = sourceDate;
  changelog.entries.unshift(mainEntry);

  const historyFailures = verifyReleaseHistory({
    priorVersions,
    newVersions: changelog.entries.map((entry) => entry.version),
    newMainVersion,
  });
  if (historyFailures.length > 0) {
    throw new Error(`Refusing to promote alpha to main: the release history is not intact (source: ${historySource}):\n${historyFailures.map((f) => `- ${f}`).join("\n")}`);
  }

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
    version: buildVersion(newMainVersion, 0, 0),
    updatedAt: sourceDate,
    releaseMessage: "",
    entries: [],
  };

  // Start local develop at the released version's first build for the new
  // cycle. The rebuild anchor moves to this promotion commit, so the next
  // rebuild only walks commits made after it.
  let develop = { build: 0, resetCommit: "", entries: [] };
  try {
    develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
  } catch { }
  develop = createDevelopReset({
    version: newMainVersion,
    resetCommit: commit || develop.resetCommit || "",
    updatedAt: sourceDate,
  });

  fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(resetAlpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);
  generateChangelogMarkdown();

  // Keep the no-JavaScript fallback on the About page aligned with the
  // installed release. The client updates this value from /api/changelog once
  // it boots, but the static HTML is also covered by startup smoke tests and
  // is what a disabled or delayed script initially shows.
  const indexPath = path.join(root, "public", "index.html");
  const indexSource = fs.readFileSync(indexPath, "utf8");
  const updatedIndexSource = indexSource.replace(
    /(id="aboutCurrentVersion">)v[^<]+/,
    `$1v${newMainVersion}`,
  );
  if (updatedIndexSource === indexSource) {
    throw new Error("Could not update the About page's installed version fallback.");
  }
  fs.writeFileSync(indexPath, updatedIndexSource);

  // Alpha's build number is gone once this release resets it, so the public
  // assets have to move to the new release version here or the version check
  // fails and browsers keep serving the last alpha build's JavaScript.
  const assetResult = spawnSync(process.execPath, [path.join(root, "scripts", "asset-versions.js"), "--write", `--version=${new5DigitVersion}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (assetResult.status !== 0) {
    throw new Error(`Failed to stamp public assets with ${new5DigitVersion}: ${assetResult.stderr || assetResult.stdout}`);
  }
  console.log(String(assetResult.stdout || "").trim());

  console.log(`Promoted Alpha to Main release v${newMainVersion} (${new5DigitVersion})`);
  console.log(`Release history: ${changelog.entries.length} entries, read from ${historySource}.`);
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
    console.log("\n[preview only - nothing written. After explicit approval, rerun with --confirm to promote.]");
  } else if (!args.includes("--confirm")) {
    console.error("Refusing to promote alpha to main without explicit confirmation.");
    console.error("Run --preview, obtain approval for that exact changelog, then rerun with --confirm.");
    process.exitCode = 1;
  } else {
    promoteAlphaToMain({
      targetVersion,
      commit: gitHeadCommit(root),
      sourceAuthor: gitHeadAuthor(root),
    });
  }
}
