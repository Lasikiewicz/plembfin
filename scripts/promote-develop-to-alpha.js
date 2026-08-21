#!/usr/bin/env node

// Consolidates develop entries into a simplified, user-friendly Alpha changelog entry,
// bumps the alpha build (4th segment, setting develop 5th segment to 0), and resets develop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const alphaChangelogPath = path.join(root, "changelog.alpha.json");
const developChangelogPath = path.join(root, "changelog.develop.json");

export function simplifyEntries(entries = []) {
  const features = [];
  const fixes = [];
  const other = [];

  for (const entry of entries) {
    const lines = [
      entry.message,
      ...(Array.isArray(entry.details) ? entry.details : []),
    ].filter(Boolean);

    for (const rawLine of lines) {
      let line = String(rawLine).trim();
      if (!line) continue;

      // Strip all emoji/icon characters
      line = line.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "").trim();

      let isFeat = /^(feat|feature|add)\b/i.test(line);
      let isFix = /^(fix|bug|repair|patch)\b/i.test(line);

      while (/^(feat|feature|enhancement|enhance|add|fix|bug|repair|patch)\s*[:-]\s*/i.test(line)) {
        if (/^(feat|feature|enhancement|enhance|add)\b/i.test(line)) isFeat = true;
        if (/^(fix|bug|repair|patch)\b/i.test(line)) isFix = true;
        line = line.replace(/^(feat|feature|enhancement|enhance|add|fix|bug|repair|patch)\s*[:-]\s*/i, "").trim();
      }

      if (!line) continue;
      line = line.charAt(0).toUpperCase() + line.slice(1);

      if (isFeat) {
        features.push(line);
      } else if (isFix) {
        fixes.push(line);
      } else {
        other.push(line);
      }
    }
  }

  // Deduplicate and simplify
  const dedup = (arr) => Array.from(new Set(arr.map((s) => s.trim()))).filter(Boolean);
  const cleanFeatures = dedup(features);
  const cleanFixes = dedup(fixes);
  const cleanOther = dedup(other).filter((o) => !cleanFeatures.includes(o) && !cleanFixes.includes(o));

  const result = [];
  if (cleanFeatures.length) {
    result.push(...cleanFeatures.map((f) => `Feature: ${f}`));
  }
  if (cleanFixes.length) {
    result.push(...cleanFixes.map((f) => `Fix: ${f}`));
  }
  if (cleanOther.length && result.length === 0) {
    result.push(...cleanOther);
  }

  return result.length ? result : ["Consolidated updates and improvements from develop"];
}

export function promoteDevelopToAlpha({ sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "" } = {}) {
  let mainVersion = "0.0.0";
  try {
    mainVersion = JSON.parse(fs.readFileSync(changelogPath, "utf8")).version || "0.0.0";
  } catch { }

  let alpha;
  try {
    alpha = JSON.parse(fs.readFileSync(alphaChangelogPath, "utf8"));
  } catch {
    alpha = { baseVersion: mainVersion, build: 0, entries: [] };
  }
  if (!Array.isArray(alpha.entries)) alpha.entries = [];

  // Always sync baseVersion with main if main has moved forward
  if (alpha.baseVersion !== mainVersion) {
    alpha = { baseVersion: mainVersion, build: 0, entries: [] };
  }

  let develop;
  try {
    develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
  } catch {
    develop = { build: 0, entries: [] };
  }
  if (!Array.isArray(develop.entries)) develop.entries = [];

  const nextAlphaBuild = Number(alpha.build || 0) + 1;
  const alphaVersion5Digit = `${alpha.baseVersion || mainVersion}.${nextAlphaBuild}.0`;
  const alphaVersionShort = `${alpha.baseVersion || mainVersion}.${nextAlphaBuild}`;

  const simplifiedDetails = simplifyEntries(develop.entries);
  const mainMessage = develop.entries[0]?.message || "Consolidated develop updates";

  const alphaEntry = {
    build: nextAlphaBuild,
    version: alphaVersion5Digit,
    shortVersion: alphaVersionShort,
    date: sourceDate,
    commit: commit || develop.entries[0]?.commit || "",
    message: mainMessage,
    author: sourceAuthor,
    details: simplifiedDetails,
  };

  alpha.build = nextAlphaBuild;
  alpha.version = alphaVersion5Digit;
  alpha.updatedAt = sourceDate;
  alpha.entries.unshift(alphaEntry);
  alpha.entries = alpha.entries.slice(0, 100);

  // Clear develop's entry list now that it's been consolidated into the alpha
  // entry above - the build counter itself is never reset (see
  // update-develop-changelog.js): it counts pushes to develop for the
  // lifetime of the branch, independent of alpha/main's version, so it can
  // never appear to regress relative to a branch it was promoted from.
  develop = {
    build: develop.build || 0,
    updatedAt: sourceDate,
    entries: [],
  };

  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(alpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);

  console.log(`Promoted develop to Alpha build ${nextAlphaBuild} (${alphaVersion5Digit})`);
  return { alpha, develop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  promoteDevelopToAlpha({
    commit: process.env.SOURCE_COMMIT || "",
    sourceAuthor: process.env.SOURCE_AUTHOR || "system",
  });
}
