#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");

const sourceCommit = String(process.env.SOURCE_COMMIT || "").trim();
const rawMessage = String(process.env.SOURCE_MESSAGE || "Update application").trim();
const sourceMessage = rawMessage.split(/\r?\n/, 1)[0];
const sourceDate = String(process.env.SOURCE_DATE || new Date().toISOString()).trim();
const sourceAuthor = String(process.env.SOURCE_AUTHOR || "unknown").trim();

// Extract bullet-point lines from the commit body as structured details
const sourceDetails = rawMessage
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.trim())
  .filter((l) => /^[-*]\s+/.test(l))
  .map((l) => l.replace(/^[-*]\s+/, ""));

if (!sourceCommit) {
  console.error("SOURCE_COMMIT is required");
  process.exit(1);
}

const changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));
if (!Array.isArray(changelog.entries)) changelog.entries = [];
if (changelog.entries.some((entry) => entry.commit === sourceCommit)) {
  console.log(`Changelog already contains ${sourceCommit}`);
  process.exit(0);
}

const match = String(changelog.version || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) throw new Error(`Invalid changelog version: ${changelog.version}`);
const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;

changelog.version = nextVersion;
changelog.updatedAt = sourceDate;
const entry = {
  version: nextVersion,
  date: sourceDate,
  commit: sourceCommit,
  message: sourceMessage,
  author: sourceAuthor,
};
if (sourceDetails.length > 0) entry.details = sourceDetails;
changelog.entries.unshift(entry);

const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.version = nextVersion;

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
packageLock.version = nextVersion;
if (packageLock.packages?.[""]) packageLock.packages[""].version = nextVersion;

fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
console.log(`Prepared Plembfin ${nextVersion} for ${sourceCommit.slice(0, 7)}`);
