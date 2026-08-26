#!/usr/bin/env node

// Consolidates alpha entries into a simplified, clean Main release entry,
// bumps the patch version (3rd segment, resetting 4th and 5th segments to 0),
// updates package.json and changelog.json, and resets alpha and develop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { categorizeEntries, simplifyEntries } from "./promote-develop-to-alpha.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const alphaChangelogPath = path.join(root, "changelog.alpha.json");
const developChangelogPath = path.join(root, "changelog.develop.json");
const packagePath = path.join(root, "package.json");

export function bumpPatchVersion(currentVersion = "0.0.0") {
  const parts = currentVersion.split(".").map((n) => Number(n) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = (parts[2] ?? 0) + 1;
  return `${major}.${minor}.${patch}`;
}

export function promoteAlphaToMain({ targetVersion = "0.9.0", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
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

  const newMainVersion = targetVersion || bumpPatchVersion(changelog.version);
  const new5DigitVersion = `${newMainVersion}.0.0`;

  const sections = categorizeEntries(alpha.entries);
  const simplifiedDetails = simplifyEntries(alpha.entries);
  const mainMessage = alpha.entries[0]?.message || `Release v${newMainVersion}`;

  const mainEntry = {
    version: newMainVersion,
    version5Digit: new5DigitVersion,
    date: sourceDate,
    commit: commit || alpha.entries[0]?.commit || "",
    message: mainMessage,
    author: sourceAuthor,
    details: simplifiedDetails,
    sections,
  };

  changelog.version = newMainVersion;
  changelog.updatedAt = sourceDate;
  changelog.entries.unshift(mainEntry);

  // Update package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    pkg.version = newMainVersion;
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch { }

  // Reset alpha changelog for the new release cycle
  alpha = {
    baseVersion: newMainVersion,
    build: 0,
    version: `${newMainVersion}.0.0`,
    updatedAt: sourceDate,
    entries: [],
  };

  // Clear develop's entry list for the new release cycle. The build counter
  // is never reset (see update-develop-changelog.js): it counts pushes to
  // develop for the lifetime of the branch, independent of alpha/main's
  // version, so it can never appear to regress relative to a branch it was
  // promoted from.
  let develop = { build: 0, entries: [] };
  try {
    develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
  } catch { }
  develop = { build: develop.build || 0, updatedAt: sourceDate, entries: [] };

  fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(alpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);

  console.log(`Promoted Alpha to Main release v${newMainVersion} (${new5DigitVersion})`);
  return { changelog, alpha, develop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  promoteAlphaToMain({
    targetVersion: process.argv[2] || process.env.TARGET_VERSION || "0.9.0",
    commit: process.env.SOURCE_COMMIT || "",
    sourceAuthor: process.env.SOURCE_AUTHOR || "system",
  });
}
