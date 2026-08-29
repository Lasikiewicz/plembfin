#!/usr/bin/env node

// Consolidates develop entries into a simplified, user-friendly Alpha changelog entry,
// bumps the alpha build (4th segment, setting develop 5th segment to 0), and resets develop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterChangelogEntries } from "./changelog-message.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const alphaChangelogPath = path.join(root, "changelog.alpha.json");
const developChangelogPath = path.join(root, "changelog.develop.json");

export function categorizeEntries(entries = []) {
  const newFeatures = [];
  const majorBugFixes = [];
  const tweaks = [];

  for (const entry of filterChangelogEntries(entries)) {
    const lines = [
      entry.message,
      ...(Array.isArray(entry.details) ? entry.details : []),
    ].filter(Boolean);

    for (const rawLine of lines) {
      let line = String(rawLine).trim();
      if (!line) continue;

      // Strip all emoji/icon characters
      line = line.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "").trim();

      const entryType = String(entry.message || "").match(/^([a-zA-Z]+)(?:\([^)]*\))?\s*(?::|\s+-)/)?.[1]?.toLowerCase() || "";
      const isTweak = /^(internal|docs?|documentation|test|refactor|chore|style)\b/i.test(line);
      const explicitFeat = /^(feat|feature|add)\b/i.test(line);
      const explicitFix = /^(fix|bug|repair|patch|security)\b/i.test(line);
      let isFeat = explicitFeat || (!explicitFix && !isTweak && ["feat", "feature"].includes(entryType));
      let isFix = explicitFix || (!explicitFeat && !isTweak && ["fix", "security"].includes(entryType));

      while (/^(feat|feature|enhancement|enhance|add|fix|bug|repair|patch)\s*[:-]\s*/i.test(line)) {
        if (/^(feat|feature|enhancement|enhance|add)\b/i.test(line)) isFeat = true;
        if (/^(fix|bug|repair|patch)\b/i.test(line)) isFix = true;
        line = line.replace(/^(feat|feature|enhancement|enhance|add|fix|bug|repair|patch)\s*[:-]\s*/i, "").trim();
      }

      line = line.replace(/^(docs?|documentation|test|refactor|chore|style|perf|performance)\s*[:-]\s*/i, "").trim();

      if (!line) continue;
      line = line.charAt(0).toUpperCase() + line.slice(1);

      if (isFeat) {
        newFeatures.push(line);
      } else if (isFix) {
        majorBugFixes.push(line);
      } else {
        tweaks.push(line);
      }
    }
  }

  // Deduplicate and simplify
  const dedup = (arr) => Array.from(new Set(arr.map((s) => s.trim()))).filter(Boolean);
  const cleanFeatures = dedup(newFeatures);
  const cleanFixes = dedup(majorBugFixes).filter((item) => !cleanFeatures.includes(item));
  const cleanTweaks = dedup(tweaks).filter((item) => !cleanFeatures.includes(item) && !cleanFixes.includes(item));

  return { newFeatures: cleanFeatures, majorBugFixes: cleanFixes, tweaks: cleanTweaks };
}

export function simplifyEntries(entries = []) {
  const { newFeatures, majorBugFixes, tweaks } = categorizeEntries(entries);

  const result = [];
  if (newFeatures.length) {
    result.push(...newFeatures.map((item) => `Feature: ${item}`));
  }
  if (majorBugFixes.length) {
    result.push(...majorBugFixes.map((item) => `Fix: ${item}`));
  }
  if (tweaks.length) {
    result.push(...tweaks.map((item) => `Tweak: ${item}`));
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

  const publicEntries = filterChangelogEntries(develop.entries);
  const sections = categorizeEntries(publicEntries);
  const simplifiedDetails = simplifyEntries(publicEntries);
  const mainMessage = publicEntries[0]?.message || "Consolidated develop updates";

  const alphaEntry = {
    build: nextAlphaBuild,
    version: alphaVersion5Digit,
    shortVersion: alphaVersionShort,
    date: sourceDate,
    commit: commit || publicEntries[0]?.commit || "",
    message: mainMessage,
    author: sourceAuthor,
    details: simplifiedDetails,
    sections,
  };

  alpha.build = nextAlphaBuild;
  alpha.version = alphaVersion5Digit;
  alpha.updatedAt = sourceDate;
  alpha.entries.unshift(alphaEntry);
  alpha.entries = alpha.entries.slice(0, 100);

  // Reset develop's build counter now that its work has been consolidated
  // into the alpha entry above. Unlike the old ${mainVersion}.${alphaBuild}.${developBuild}
  // scheme, this reset is safe: it's an explicit, deliberate action taken as
  // part of this promotion itself, not a passive comparison against a parent
  // version string that could be stale or wrong. It's the same shape as
  // alpha's own reset-on-promotion-to-main, which already works safely.
  develop = {
    build: 0,
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
