#!/usr/bin/env node

// Packages develop's current rolling entry (everything since the last "Force
// to alpha") as its own standalone alpha build entry, bumps the alpha build
// (4th version segment), and resets develop for the next cycle. Run locally
// as part of "Force to alpha", before the force-push - the pushed commit
// already carries the correct, complete alpha entry, so neither branch needs
// a CI job to generate or fix it up afterward.
//
// alpha accumulates one entry per "Force to alpha" call within the same
// pre-release cycle (newest first, same convention as changelog.json's main
// entries) rather than merging each call into a single rolling entry - a
// user checking for updates mid-cycle sees exactly what changed in each
// build they haven't pulled yet (see describePendingAlphaBuild in
// server/src/routes/maintenance.js), instead of the same re-merged sentence
// growing a little longer every time. Consolidating the whole cycle into one
// clean release note happens once, in promoteAlphaToMain, when there is a
// complete and final set of builds to summarize - not speculatively on every
// intermediate "Force to alpha" call.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntryProcessViolations, filterChangelogEntries, synthesizeHeadline } from "./changelog-message.js";
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

// Formats an already-categorized {newFeatures, majorBugFixes, tweaks} section
// set into the flat "Feature:/Fix:/Tweak:" bullet list stored on a changelog
// entry. Split out from simplifyEntries so promoteDevelopToAlpha can format a
// *merged* sections object (see mergeSections) without re-deriving
// categorization from raw entry text - re-running categorizeEntries over a
// previously-built alpha entry would treat that entry's own synthesized
// headline sentence as a new bullet to categorize (it matches none of the
// feat/fix patterns, so it silently lands in tweaks).
export function formatSections({ newFeatures = [], majorBugFixes = [], tweaks = [] } = {}) {
  const result = [];
  if (newFeatures.length) result.push(...newFeatures.map((item) => `Feature: ${item}`));
  if (majorBugFixes.length) result.push(...majorBugFixes.map((item) => `Fix: ${item}`));
  if (tweaks.length) result.push(...tweaks.map((item) => `Tweak: ${item}`));
  return result.length ? result : ["Consolidated updates and improvements from develop"];
}

// Combines two already-categorized section sets, applying the same
// dedupe-and-cross-category-exclusion rules categorizeEntries uses so a bullet
// present in both never appears twice or in two sections at once. Used by
// promoteAlphaToMain to fold every alpha build entry's own sections together
// at Force-to-main time, since each entry already carries correctly
// categorized sections from when promoteDevelopToAlpha built it - re-running
// categorizeEntries over an entry's synthesized `message` sentence instead of
// merging its `sections` directly would treat that sentence as an uncategorized
// bullet and land it in tweaks as a garbled duplicate.
export function mergeSections(a = {}, b = {}) {
  const dedup = (arr) => Array.from(new Set(arr.filter(Boolean).map((s) => s.trim())));
  const newFeatures = dedup([...(a.newFeatures || []), ...(b.newFeatures || [])]);
  const majorBugFixes = dedup([...(a.majorBugFixes || []), ...(b.majorBugFixes || [])]).filter((item) => !newFeatures.includes(item));
  const tweaks = dedup([...(a.tweaks || []), ...(b.tweaks || [])]).filter((item) => !newFeatures.includes(item) && !majorBugFixes.includes(item));
  return { newFeatures, majorBugFixes, tweaks };
}

export function simplifyEntries(entries = []) {
  return formatSections(categorizeEntries(entries));
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
  // Four segments (base version + alpha build) is a complete, unambiguous version on
  // its own - a trailing fifth ".0" segment was never read by anything (no comparison
  // logic parses past the 4th segment; it only ever showed up in the changelog UI as a
  // confusing "v0.14.0.3.0").
  const alphaVersion = `${alpha.baseVersion || mainVersion}.${nextAlphaBuild}`;

  // This is a standalone entry for just this build - only develop's own current work,
  // not merged with any earlier alpha build this cycle. See the module comment above.
  const developEntries = filterChangelogEntries(develop.entries);
  const sections = categorizeEntries(develop.entries);
  const simplifiedDetails = formatSections(sections);

  // A develop entry can already be a synthesized composite of several commits or
  // several "Push to git" runs (rebuild-develop-changelog.js folds all of them into one
  // entry) - use its own atomic messageFragments when present instead of its single
  // flattened `message`, so this build's own headline, and later promoteAlphaToMain
  // folding several builds together, always work from true atomic fragments instead of
  // re-wrapping an already-composite sentence as if it were one unsplittable piece.
  const messageFragments = developEntries.flatMap((entry) =>
    Array.isArray(entry.messageFragments) && entry.messageFragments.length ? entry.messageFragments : [entry.message]);
  const mainMessage = synthesizeHeadline(messageFragments) || "Consolidated develop updates";

  const alphaEntry = {
    build: nextAlphaBuild,
    version: alphaVersion,
    shortVersion: alphaVersion,
    date: sourceDate,
    commit: commit || developEntries[0]?.commit || "",
    message: mainMessage,
    author: sourceAuthor,
    details: simplifiedDetails,
    sections,
  };
  if (messageFragments.length > 1) alphaEntry.messageFragments = messageFragments;

  // Safety net: categorizeEntries/simplifyEntries already filter recognized
  // release-process text, but check the assembled entry directly before it
  // is ever written, rather than relying only on a separate step run
  // afterward that could be skipped.
  const violations = changelogEntryProcessViolations(alphaEntry);
  if (violations.length > 0) {
    throw new Error(`Refusing to promote develop to alpha: the entry contains release-process notes:\n${violations.map((v) => `- ${v}`).join("\n")}`);
  }

  alpha.build = nextAlphaBuild;
  alpha.version = alphaVersion;
  alpha.shortVersion = alphaVersion;
  alpha.updatedAt = sourceDate;
  // Newest first, same convention as changelog.json's main entries - accumulates
  // across the cycle until promoteAlphaToMain consolidates and resets it.
  alpha.entries = [alphaEntry, ...alpha.entries];

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

  console.log(`Promoted develop to Alpha build ${nextAlphaBuild} (v${alphaVersion})`);
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
