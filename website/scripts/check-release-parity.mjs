#!/usr/bin/env node
// Push website live publishes the local website straight to production, outside a release.
// The live website must never show anything the released main build does not have, so this
// stops when the application in this checkout (committed or not) differs from origin/main:
// images or text taken from it could show unreleased behaviour. Force to main is the route
// for documenting new application work. Not part of check:deploy, because Force to main runs
// those checks in the release candidate, which differs from main by definition.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const git = (...args) =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((l) => l.trim()).filter(Boolean);

try {
  git("fetch", "--quiet", "origin", "main");
} catch {
  console.warn("Could not fetch origin/main; comparing with the local copy of it.");
}

let changed;
try {
  const appPaths = ["public", "server", "package.json", "package-lock.json"];
  changed = [...new Set([
    ...git("diff", "--name-only", "origin/main", "--", ...appPaths),
    ...git("ls-files", "--others", "--exclude-standard", "--", "public", "server"),
  ])];
} catch {
  console.error("Cannot resolve origin/main, so the website cannot be checked against the released build.");
  process.exit(2);
}

if (changed.length) {
  console.error(`Release parity check failed: ${changed.length} application file(s) differ from the released main build:`);
  for (const file of changed) console.error(`  ${file}`);
  console.error("Website images or text taken from this app could show unreleased behaviour. Confirm with the user that none do, or publish through Force to main.");
  process.exit(1);
}
console.log("Release parity check passed: the application matches the released main build.");
