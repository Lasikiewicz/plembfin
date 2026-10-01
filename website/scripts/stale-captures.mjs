#!/usr/bin/env node
// Print the website app images to retake for a set of changed application files.
//
//   node scripts/stale-captures.mjs                      files changed since origin/main (committed and uncommitted)
//   node scripts/stale-captures.mjs --since=<ref>        files changed since another ref
//   node scripts/stale-captures.mjs <file> [<file> ...]  these files (paths from the repository root)
//
// An image is stale when one of its catalogue `sources` changed. Every view the image has
// (Classic and Modern, dark and light) is retaken. Shared files in `commonSources` drive every
// image, and the Modern ones every image with a Modern view. Changed files under public/ or
// server/ that no image lists are printed for review. The last line is the retake command.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const catalogue = JSON.parse(fs.readFileSync(path.join(websiteRoot, "capture-catalogue.json"), "utf8"));

const args = process.argv.slice(2);
const sinceArg = args.find((a) => a.startsWith("--since="));
const fileArgs = args.filter((a) => !a.startsWith("--"));

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((l) => l.trim()).filter(Boolean);

const normalize = (file) => path.relative(repositoryRoot, path.resolve(repositoryRoot, file)).split(path.sep).join("/");

let changed;
let label;
if (fileArgs.length) {
  changed = fileArgs.map(normalize);
  label = "the given files";
} else {
  const since = sinceArg ? sinceArg.slice("--since=".length) : "origin/main";
  try {
    const base = git("merge-base", since, "HEAD")[0];
    changed = [...new Set([...git("diff", "--name-only", base), ...git("ls-files", "--others", "--exclude-standard")])];
  } catch {
    console.error(`Cannot resolve ${since}. Pass --since=<ref> or a list of files.`);
    process.exit(2);
  }
  label = `files changed since ${since}`;
}
const changedSet = new Set(changed);

const modernViews = (variants) => variants.filter((v) => catalogue.variants[v]?.style === "modern");
const stale = new Map();
const mark = (id, variants, file) => {
  if (!variants.length) return;
  const hit = stale.get(id) || { variants: new Set(), files: new Set() };
  variants.forEach((v) => hit.variants.add(v));
  hit.files.add(file);
  stale.set(id, hit);
};

const shared = (catalogue.commonSources.all || []).filter((f) => changedSet.has(f));
const sharedModern = (catalogue.commonSources.modern || []).filter((f) => changedSet.has(f));
const used = new Set([...(catalogue.commonSources.all || []), ...(catalogue.commonSources.modern || [])]);

for (const [id, entry] of Object.entries(catalogue.images)) {
  for (const file of entry.sources || []) {
    used.add(file);
    if (changedSet.has(file)) mark(id, entry.variants, file);
  }
  for (const file of shared) mark(id, entry.variants, file);
  for (const file of sharedModern) mark(id, modernViews(entry.variants), file);
}

const unmapped = changed.filter((f) => /^(public|server)\//.test(f) && !used.has(f));

console.log(`Checked ${label}: ${changed.length} file(s).`);
if (shared.length || sharedModern.length) {
  console.log(`Shared files changed (drive every image): ${[...shared, ...sharedModern].join(", ")}`);
}
if (!stale.size) {
  console.log("No website images to retake.");
} else {
  const views = [...stale.values()].reduce((n, s) => n + s.variants.size, 0);
  console.log(`\n${stale.size} image(s), ${views} view(s) to retake:`);
  for (const [id, { variants, files }] of [...stale.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const live = catalogue.images[id].live ? `  [needs live state: ${catalogue.images[id].live}]` : "";
    const shownFiles = [...files].filter((f) => !shared.includes(f) && !sharedModern.includes(f));
    const why = shownFiles.length ? shownFiles.join(", ") : "shared files";
    console.log(`  ${id} (${[...variants].join(", ")})${live}\n      ${why}`);
  }
}
if (unmapped.length) {
  console.log(`\nChanged app files no image lists (review whether any image shows them):`);
  for (const file of unmapped) console.log(`  ${file}`);
}
if (stale.size) {
  // Only a Modern shared file can leave an image needing some views; those get their own command.
  const ids = [...stale.keys()].sort();
  const whole = ids.filter((id) => stale.get(id).variants.size === catalogue.images[id].variants.length);
  const modernOnly = ids.filter((id) => !whole.includes(id));
  console.log("");
  if (whole.length) console.log(`Retake: npm run captures:retake -- ${whole.join(" ")}`);
  if (modernOnly.length) console.log(`Retake: npm run captures:retake -- --variant=modern-dark,modern-light ${modernOnly.join(" ")}`);
}
