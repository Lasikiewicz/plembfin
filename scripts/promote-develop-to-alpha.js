#!/usr/bin/env node

// Merges develop's current rolling entry (everything since the last "Force
// to alpha") into alpha's own current rolling entry, bumps the alpha build
// (4th segment, setting develop 5th segment to 0), and resets develop for the
// next cycle. Run locally as part of "Force to alpha", before the force-push
// - the pushed commit already carries the correct, complete alpha entry, so
// neither branch needs a CI job to generate or fix it up afterward.
//
// alpha keeps exactly one current entry, the same "always recompute in
// place" model changelog.develop.json uses (see rebuild-develop-changelog.js)
// rather than accumulating one entry per "Force to alpha" call within the
// same pre-release cycle - those used to need a manual consolidation pass
// before promoting to main; merging in place means there is never more than
// one entry to read or clean up.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntryProcessViolations, filterChangelogEntries } from "./changelog-message.js";
import { gitHeadAuthor, gitHeadCommit } from "./changelog-git-helpers.js";

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

export function promoteDevelopToAlpha({ sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "", resetAnchorCommit = "" } = {}) {
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

  // main moved forward since the last promotion (a "Force to main" landed) -
  // start a fresh alpha cycle instead of merging into now-stale content.
  if (alpha.baseVersion !== mainVersion) {
    alpha = { baseVersion: mainVersion, build: 0, entries: [] };
  }

  let develop;
  try {
    develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
  } catch {
    develop = { build: 0, resetCommit: "", entries: [] };
  }
  if (!Array.isArray(develop.entries)) develop.entries = [];

  const nextAlphaBuild = Number(alpha.build || 0) + 1;
  const alphaVersion5Digit = `${alpha.baseVersion || mainVersion}.${nextAlphaBuild}.0`;
  const alphaVersionShort = `${alpha.baseVersion || mainVersion}.${nextAlphaBuild}`;

  // Merge develop's new work (since the last reset) with whatever alpha
  // already has pending from an earlier "Force to alpha" this same cycle -
  // develop's entry never overlaps alpha's, since develop's own resetCommit
  // anchor only ever covers commits made after the last reset. Develop's
  // entry comes first so its most recent commit drives the headline message.
  const priorAlphaEntry = alpha.entries[0] || null;
  const sourceEntries = [...develop.entries, ...(priorAlphaEntry ? [priorAlphaEntry] : [])];
  const publicEntries = filterChangelogEntries(sourceEntries);
  const sections = categorizeEntries(sourceEntries);
  const simplifiedDetails = simplifyEntries(sourceEntries);
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

  // Safety net: categorizeEntries/simplifyEntries already filter recognized
  // release-process text, but check the assembled entry directly before it
  // is ever written, rather than relying only on a separate step run
  // afterward that could be skipped.
  const violations = changelogEntryProcessViolations(alphaEntry);
  if (violations.length > 0) {
    throw new Error(`Refusing to promote develop to alpha: the entry contains release-process notes:\n${violations.map((v) => `- ${v}`).join("\n")}`);
  }

  alpha.build = nextAlphaBuild;
  alpha.version = alphaVersion5Digit;
  alpha.updatedAt = sourceDate;
  // alpha holds exactly one current entry - see the module comment above for
  // why this replaces rather than accumulates.
  alpha.entries = [alphaEntry];

  // Reset develop for the next cycle: build never resets (it counts pushes
  // for the lifetime of the branch - see rebuild-develop-changelog.js),
  // but resetCommit moves to this promotion's own commit so the next
  // rebuild's git-history walk starts counting fresh from here, and entries
  // is cleared since that work is now folded into the alpha entry above.
  develop = {
    build: develop.build || 0,
    resetCommit: resetAnchorCommit || commit || develop.resetCommit || "",
    updatedAt: sourceDate,
    entries: [],
  };

  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(alpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);

  console.log(`Promoted develop to Alpha build ${nextAlphaBuild} (${alphaVersion5Digit})`);
  return { alpha, develop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const headCommit = gitHeadCommit(root);
  promoteDevelopToAlpha({
    commit: headCommit,
    resetAnchorCommit: headCommit,
    sourceAuthor: gitHeadAuthor(root),
  });
}
