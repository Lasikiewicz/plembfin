#!/usr/bin/env node

// Consolidates alpha's current entry into a clean, permanent Main release
// entry, bumps the real semver, and regenerates every derived file
// (package.json, package-lock.json, CHANGELOG.md) - then resets alpha and
// develop for the next cycle. Run locally as part of "Force to main", before
// the force-push, so the pushed commit already carries the finished release;
// CI no longer needs to generate or fix up changelog content afterward.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntryProcessViolations, filterChangelogEntries } from "./changelog-message.js";
import { categorizeEntries, simplifyEntries } from "./promote-develop-to-alpha.js";
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

export function promoteAlphaToMain({ targetVersion = "", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
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
  const sections = categorizeEntries(publicEntries);
  const simplifiedDetails = simplifyEntries(publicEntries);
  const mainMessage = publicEntries[0]?.message || `Release v${newMainVersion}`;

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

  // Safety net: categorizeEntries/simplifyEntries already filter recognized
  // release-process text, but check the assembled entry directly before it
  // is ever written, rather than relying only on a separate step run
  // afterward that could be skipped.
  const violations = changelogEntryProcessViolations(mainEntry);
  if (violations.length > 0) {
    throw new Error(`Refusing to promote alpha to main: the entry contains release-process notes:\n${violations.map((v) => `- ${v}`).join("\n")}`);
  }

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
  alpha = {
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
  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(alpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);
  generateChangelogMarkdown();

  console.log(`Promoted Alpha to Main release v${newMainVersion} (${new5DigitVersion})`);
  return { changelog, alpha, develop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  promoteAlphaToMain({
    targetVersion: process.argv[2] || process.env.TARGET_VERSION || "",
    commit: gitHeadCommit(root),
    sourceAuthor: gitHeadAuthor(root),
  });
}
