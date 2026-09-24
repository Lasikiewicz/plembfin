#!/usr/bin/env node

// The website content-impact release gate. The website is only ever updated
// during "Force to main" (docs/websiteupdate.md), so develop and alpha work is
// never documented while it can still change. Push to git only notes, on each
// commit, which website guides the change needs:
//   site-impact: none
//   site-impact: dashboard, media-details
// "Force to main" then updates those guides on develop, takes develop's
// website/ tree into the release (skill step 1a), and this gate checks that
// every guide the release needs actually changed in that website tree.
//
// What a commit needs:
// - `site-impact: none`: nothing.
// - `site-impact: <docSlug>[, <docSlug>...]`: exactly those guides. The note is
//   the author's statement for that commit, so it replaces the file mapping
//   (a shared file such as public/index.html maps to a dozen guides).
// - no note: every guide app-surface.json maps its changed files to. Changed
//   public/, server/ or docs/ paths no guide covers are listed for the
//   Force to main review instead of failing the release.
// A named slug must exist in app-surface.json, so a typo cannot silently pass.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFilesForCommit, commitsSinceLastEntry, fileAtRef, gitHeadCommit, refExists } from "./changelog-git-helpers.js";
import { isNoiseCommitMessage } from "./changelog-message.js";
import { loadSurfaces, mapWebsiteTargets } from "./update-local-updates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SITE_IMPACT_TRAILER = /^site-impact:\s*(.+)$/gim;
const RELEVANT_UNMAPPED_PATTERN = /^(?:public|server|docs)\//;
const GUIDE_DIR = "website/src/content/docs";

function normalisePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function guidePath(docSlug) {
  return `${GUIDE_DIR}/${docSlug}.mdx`;
}

// Takes the last occurrence so a corrected line (added without deleting an
// earlier mistaken one) wins, matching how git trailers are conventionally
// read.
export function parseSiteImpactTrailer(message) {
  const matches = [...String(message || "").matchAll(SITE_IMPACT_TRAILER)];
  if (!matches.length) return null;
  const raw = matches[matches.length - 1][1].trim();
  if (!raw) return null;
  if (/^none$/i.test(raw)) return { kind: "none", raw };
  const docSlugs = unique(raw.split(/[\s,]+/).map((slug) => slug.trim().toLowerCase()));
  return { kind: "target", docSlugs, raw };
}

// Pure and git-free so it can be unit tested directly. `commits` is
// [{ id | shortId, message, files }] for the release range; `updatedFiles` is
// every file whose content differs between the published website and the
// website tree being released (committed or not). `surfaces` overrides
// app-surface.json for tests, exactly like mapWebsiteTargets.
// `reviewedUnchanged` lists guides the Force to main review checked and found
// still accurate (website/src/data/release-review.json).
export function computeWebsiteContentImpact({ commits = [], updatedFiles = [], reviewedUnchanged = [], surfaces = null } = {}) {
  const available = loadSurfaces(surfaces);
  const knownSlugs = new Set(available.map((surface) => normalisePath(surface?.docSlug)).filter(Boolean));
  const updated = new Set(updatedFiles.map(normalisePath));
  for (const docSlug of reviewedUnchanged) updated.add(guidePath(normalisePath(docSlug).toLowerCase()));

  const required = new Map(); // docSlug -> { reasons: [{ commit, files }] }
  const unknownSlugs = [];
  const review = new Map(); // file -> commit ids

  function requireGuide(docSlug, commit, files) {
    const entry = required.get(docSlug) || { reasons: [] };
    entry.reasons.push({ commit, files });
    required.set(docSlug, entry);
  }

  // A release-bookkeeping commit (changelog rebuild/promotion, asset-version
  // restamp) mechanically touches most of public/ without being a real
  // product change, so it is left out of the walk.
  for (const raw of commits.filter((commit) => !isNoiseCommitMessage(commit.message))) {
    const shortId = String(raw.shortId || raw.id || "").slice(0, 7);
    const files = unique((raw.files || []).map(normalisePath));
    const decision = parseSiteImpactTrailer(raw.message);

    if (decision?.kind === "none") continue;

    if (decision?.kind === "target") {
      for (const docSlug of decision.docSlugs) {
        if (!knownSlugs.has(docSlug)) unknownSlugs.push({ docSlug, commit: shortId });
        else requireGuide(docSlug, shortId, []);
      }
      continue;
    }

    const targets = mapWebsiteTargets(files, available);
    const catalogued = new Set();
    for (const target of targets) {
      // website-infrastructure and release-and-site-surface are synthetic
      // groupings for shared layout/build bookkeeping, not a guide.
      if (!target.docSlug) continue;
      const sourceFiles = target.files.filter((file) => !file.startsWith(`${GUIDE_DIR}/`));
      for (const file of target.files) catalogued.add(file);
      if (sourceFiles.length) requireGuide(target.docSlug, shortId, sourceFiles);
    }
    for (const file of files) {
      if (catalogued.has(file) || !RELEVANT_UNMAPPED_PATTERN.test(file)) continue;
      review.set(file, unique([...(review.get(file) || []), shortId]));
    }
  }

  const failures = [];
  for (const { docSlug, commit } of unknownSlugs) {
    failures.push({ docSlug, kind: "unknown-slug", commits: [commit], files: [] });
  }
  for (const [docSlug, { reasons }] of required) {
    if (updated.has(guidePath(docSlug))) continue;
    failures.push({
      docSlug,
      kind: "not-updated",
      commits: unique(reasons.map((reason) => reason.commit)),
      files: unique(reasons.flatMap((reason) => reason.files)).sort(),
    });
  }

  return {
    requiredGuides: [...required.keys()].sort(),
    failures: failures.sort((left, right) => left.docSlug.localeCompare(right.docSlug)),
    review: [...review.entries()].map(([file, ids]) => ({ file, commits: ids })).sort((left, right) => left.file.localeCompare(right.file)),
  };
}

export function formatWebsiteContentImpactFailure(failure) {
  const commits = failure.commits.length ? ` (${failure.commits.join(", ")})` : "";
  if (failure.kind === "unknown-slug") {
    return `site-impact names "${failure.docSlug}"${commits}, which is not a docSlug in website/src/data/app-surface.json`;
  }
  const files = failure.files.length ? `\n    changed: ${failure.files.join(", ")}` : "\n    named by a site-impact note";
  return `${guidePath(failure.docSlug)} needs updating for this release${commits}${files}`;
}

function gitLines(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split(/\r?\n/).map(normalisePath).filter(Boolean);
  } catch {
    return [];
  }
}

// Guides whose content differs between the published website (origin/main's
// tree; fromCommit only when there is no remote) and the website tree in this
// checkout: committed, staged (skill step 1a stages develop's website/ tree),
// unstaged, or new and untracked. A sourceVersion restamp alone is release
// bookkeeping, not a content update, so it does not count.
function updatedGuideFiles(fromCommit) {
  const published = refExists(root, "origin/main") ? "origin/main" : fromCommit;
  return unique([
    ...gitLines(["diff", "--name-only", "-I", "^sourceVersion:", published, "--", GUIDE_DIR]),
    ...gitLines(["ls-files", "--others", "--exclude-standard", "--", GUIDE_DIR]),
  ]);
}

// Guides the Force to main review checked and left unchanged, from
// website/src/data/release-review.json in this checkout:
//   { "publishedVersion": "1.2.1", "unchanged": { "stats": "only the asset restamp touched it" } }
// It only counts while publishedVersion is the version live on main, so a
// previous release's review never carries over into the next one.
const REVIEW_FILE = "website/src/data/release-review.json";

function reviewedUnchangedGuides() {
  const published = fileAtRef(root, "origin/main", "package.json");
  let publishedVersion = "";
  try { publishedVersion = JSON.parse(published)?.version || ""; } catch { return []; }
  let review = null;
  try { review = JSON.parse(fs.readFileSync(path.join(root, REVIEW_FILE), "utf8")); } catch { return []; }
  if (!publishedVersion || review?.publishedVersion !== publishedVersion) return [];
  return Object.keys(review?.unchanged || {});
}

// Walks the real commit range with git and runs the pure check above.
// fromCommit/toCommit are the previous main release's commit and the current
// HEAD; see promote-alpha-to-main.js for how those are resolved.
export function websiteContentImpactReport({ fromCommit, toCommit, surfaces = null } = {}) {
  if (!fromCommit || !toCommit || fromCommit === toCommit) return { requiredGuides: [], failures: [], review: [] };
  const commits = commitsSinceLastEntry(root, fromCommit, toCommit).map((commit) => ({
    id: commit.id,
    message: commit.message,
    files: changedFilesForCommit(root, commit.id),
  }));
  return computeWebsiteContentImpact({
    commits,
    updatedFiles: updatedGuideFiles(fromCommit),
    reviewedUnchanged: reviewedUnchangedGuides(),
    surfaces,
  });
}

export function websiteContentImpactViolations(options = {}) {
  return websiteContentImpactReport(options).failures.map(formatWebsiteContentImpactFailure);
}

// Reads the commit the currently published main release was built from, out
// of origin/main's own changelog.json, so the standalone CLI check below (and
// the gate embedded in promote-alpha-to-main.js) always compares against what
// is actually live rather than a local guess.
function resolvePreviousMainReleaseCommit() {
  const remoteChangelog = fileAtRef(root, "origin/main", "changelog.json");
  if (!remoteChangelog) return "";
  try {
    return JSON.parse(remoteChangelog)?.entries?.[0]?.commit || "";
  } catch {
    return "";
  }
}

function main() {
  const fromCommit = resolvePreviousMainReleaseCommit();
  const toCommit = gitHeadCommit(root);
  if (!fromCommit) {
    console.log("Website content-impact gate: no previous main release commit found (origin/main unreachable, or first release) - nothing to check.");
    return;
  }
  const report = websiteContentImpactReport({ fromCommit, toCommit });
  const range = `${fromCommit.slice(0, 7)}..${toCommit.slice(0, 7)}`;
  if (report.review.length) {
    console.log(`Review during Force to main (changed, no guide mapped, no site-impact note):\n${report.review.map((item) => `- ${item.file} (${item.commits.join(", ")})`).join("\n")}\n`);
  }
  if (report.failures.length) {
    console.error(`Website content-impact gate: FAILED (${range})\n\n${report.failures.map((f) => `- ${formatWebsiteContentImpactFailure(f)}`).join("\n")}\n\nUpdate these guides on develop during Force to main step 0 (the release takes develop's website/ tree), or list a guide the review found still accurate under "unchanged" in ${REVIEW_FILE}.`);
    process.exitCode = 1;
  } else {
    console.log(`Website content-impact gate: passed (${range}; ${report.requiredGuides.length} guide(s) needed, all updated).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
