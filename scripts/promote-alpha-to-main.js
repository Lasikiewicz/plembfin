#!/usr/bin/env node

// Consolidates alpha entries into a simplified, clean Main release entry,
// bumps the patch version (3rd segment, resetting 4th and 5th segments to 0),
// updates package.json and changelog.json, and resets alpha and develop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simplifyEntries } from "./promote-develop-to-alpha.js";

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

export function promoteAlphaToMain({ sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
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

  const newMainPatch = bumpPatchVersion(changelog.version);
  const new5DigitVersion = `${newMainPatch}.0.0`;

  const simplifiedDetails = simplifyEntries(alpha.entries);
  const mainMessage = alpha.entries[0]?.message || `Release v${newMainPatch}`;

  const mainEntry = {
    version: newMainPatch,
    version5Digit: new5DigitVersion,
    date: sourceDate,
    commit: commit || alpha.entries[0]?.commit || "",
    message: mainMessage,
    author: sourceAuthor,
    details: simplifiedDetails,
  };

  changelog.version = newMainPatch;
  changelog.updatedAt = sourceDate;
  changelog.entries.unshift(mainEntry);

  // Update package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    pkg.version = newMainPatch;
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch { }

  // Reset alpha changelog for the new release cycle
  alpha = {
    baseVersion: newMainPatch,
    build: 0,
    version: `${newMainPatch}.0.0`,
    updatedAt: sourceDate,
    entries: [],
  };

  // Reset develop changelog for the new release cycle
  const develop = {
    baseVersion: `${newMainPatch}.0`,
    build: 0,
    version: `${newMainPatch}.0.0`,
    updatedAt: sourceDate,
    entries: [],
  };

  fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(alpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);

  console.log(`Promoted Alpha to Main release v${newMainPatch} (${new5DigitVersion})`);
  return { changelog, alpha, develop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  promoteAlphaToMain({
    commit: process.env.SOURCE_COMMIT || "",
    sourceAuthor: process.env.SOURCE_AUTHOR || "system",
  });
}
