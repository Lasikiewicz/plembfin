#!/usr/bin/env node

// Every documentation page carries a `sourceVersion` marker in its frontmatter
// recording the released application version its content was verified against.
// This check enforces that those markers match the version actually released.
//
// Why it exists: the v1.1.0 release shipped a website whose 36 pages all still
// claimed `sourceVersion: "1.0.2"`. Nothing compared the two, so the drift was
// invisible - the published site documented one release while describing itself
// as current. docs/websiteupdate.md already listed "baseline drift" as a known
// failure mode and told the operator to resolve the baseline from origin/main;
// it was prose with nothing enforcing it.
//
// The released version is read from PLEMBFIN_WEBSITE_RELEASE_REF when set,
// otherwise from origin/main when that ref resolves, and from the working tree otherwise.
// Cloudflare Pages clones a single commit with no
// remote-tracking refs, and builds `main` itself, so the fallback is correct
// there. Same pattern as build-release-data.mjs.
//
// A failure here is not a formatting problem. It means the documentation has not
// been re-verified against the current release, and the fix is to complete
// docs/websiteupdate.md and restamp - not to edit the number.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const docsDir = path.join(websiteRoot, "src", "content", "docs");
const releaseRef = process.env.PLEMBFIN_WEBSITE_RELEASE_REF || "origin/main";

export function releasedVersion({ readRef, readWorkingTree } = {}) {
  const fromRef = readRef ? readRef() : readReleasedFile("changelog.json");
  try {
    const parsed = JSON.parse(fromRef);
    if (parsed?.version) return String(parsed.version);
  } catch { /* fall through */ }
  if (readWorkingTree) {
    try {
      const parsed = JSON.parse(readWorkingTree());
      if (parsed?.version) return String(parsed.version);
    } catch { /* fall through */ }
  }
  return "";
}

function readReleasedFile(relativePath) {
  try {
    return execFileSync("git", ["show", `${releaseRef}:${relativePath}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  }
}

// Exported pure so the marker parsing can be tested without touching disk.
export function sourceVersionOf(contents) {
  const match = String(contents || "").match(/^sourceVersion:\s*["']?([^"'\s]+)["']?\s*$/m);
  return match ? match[1] : "";
}

function collectPages(dir) {
  const pages = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) pages.push(...collectPages(full));
    else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) pages.push(full);
  }
  return pages;
}

export function checkDocBaseline({ pages, expectedVersion } = {}) {
  const failures = [];
  if (!expectedVersion) {
    failures.push("could not resolve the released version from changelog.json");
    return failures;
  }
  for (const { file, version } of pages) {
    if (!version) failures.push(`${file}: no sourceVersion marker`);
    else if (version !== expectedVersion) failures.push(`${file}: verified against ${version}, released version is ${expectedVersion}`);
  }
  return failures;
}

function main() {
  const expectedVersion = releasedVersion();
  const pages = collectPages(docsDir).map((file) => ({
    file: path.relative(repositoryRoot, file).replace(/\\/g, "/"),
    version: sourceVersionOf(fs.readFileSync(file, "utf8")),
  }));

  const failures = checkDocBaseline({ pages, expectedVersion });
  if (failures.length > 0) {
    console.error(`Documentation baseline check failed against released v${expectedVersion}:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("");
    console.error("The pages above have not been re-verified against the current release.");
    console.error("Complete docs/websiteupdate.md against the released application, then let");
    console.error("the promotion restamp them. Do not edit the marker on its own - the number");
    console.error("is a record that the review happened, not the thing being fixed.");
    process.exit(1);
  }
  console.log(`Documentation baseline check passed (${pages.length} pages verified against v${expectedVersion}).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
