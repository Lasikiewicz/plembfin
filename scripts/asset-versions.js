#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Versioned assets are cached immutably for a year, so the query has to change
// whenever the served files change or a browser keeps the old module forever.
// package.json only moves on a release to main, which left every alpha build in
// a cycle sharing one asset version: an alpha tester (and anyone developing
// locally) could pull a new build and still be running the previous build's
// JavaScript. Track the alpha build's own version while a cycle is open, and
// fall back to the package version once alpha has been reset by a release.
export function currentAssetVersion() {
  const packageVersion = String(packageJson.version || "dev").trim();
  try {
    const alpha = JSON.parse(fs.readFileSync(path.join(root, "changelog.alpha.json"), "utf8"));
    const alphaVersion = String(alpha?.version || "").trim();
    const baseVersion = String(alpha?.baseVersion || "").trim();
    // Only trust alpha's version while it is still building on this release.
    // After "Force to main" bumps the package version, alpha's stale entry must
    // not hold the assets back on the previous release's number.
    if (alphaVersion && baseVersion === packageVersion && alphaVersion.startsWith(`${packageVersion}.`)) {
      return alphaVersion;
    }
  } catch { /* no alpha changelog: fall back to the package version */ }
  return packageVersion;
}

const requestedVersion = process.argv.find((argument) => argument.startsWith("--version="))?.slice("--version=".length);
const assetVersion = String(requestedVersion || process.env.ASSET_VERSION || currentAssetVersion()).trim();
const write = process.argv.includes("--write");

if (!/^[A-Za-z0-9._-]+$/.test(assetVersion)) {
  throw new Error(`Invalid asset version: ${assetVersion}`);
}

const assetReferencePattern = /(["'`])((?:\/|\.{1,2}\/)[^"'`)\s]+?\.(?:m?js|css|svg|png|jpe?g|webp|gif|ico|webmanifest|woff2?))(?:\?([^"'`)\s]*))?(["'`])/gi;

// The pattern above only recognizes a URL written as one complete literal, so a
// path assembled at runtime - `/icons/${target}.svg?v=...` - was invisible to
// both the check and the rewrite. Two of those kept a hardcoded token through
// several releases, and the browser then fetched the same icon under both that
// token and the canonical one. This second pass reads the version query alone,
// wherever it appears on a managed path, so a dynamic reference cannot drift.
const dynamicVersionPattern = /(\/(?:icons|modules)\/[^"'`\s>]*?|\/app\.js|\/styles\.css)\?v=([A-Za-z0-9._-]+)/g;

function textFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(absolute);
    if (!entry.isFile() || !/\.(?:js|html|css|webmanifest)$/i.test(entry.name)) return [];
    return [absolute];
  });
}

function managesAsset(assetPath) {
  if (assetPath.startsWith("/media/")) return false;
  return assetPath.startsWith("/modules/")
    || assetPath.startsWith("/icons/")
    || assetPath === "/app.js"
    || assetPath === "/styles.css"
    || assetPath === "/manifest.webmanifest"
    || assetPath.startsWith("./")
    || assetPath.startsWith("../");
}

function inspectFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const references = [];
  let match;
  while ((match = assetReferencePattern.exec(source))) {
    const [, quote, assetPath, query, closingQuote] = match;
    if (!managesAsset(assetPath)) continue;
    references.push({
      assetPath,
      query: query || "",
      start: match.index,
      end: assetReferencePattern.lastIndex,
      quote,
      closingQuote,
    });
  }
  assetReferencePattern.lastIndex = 0;
  return { source, references };
}

const files = textFiles(publicDir);
const violations = [];
let references = 0;
let dynamicVersions = 0;
let changedFiles = 0;
for (const filePath of files) {
  const { source, references: fileReferences } = inspectFile(filePath);
  references += fileReferences.length;
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
  for (const reference of fileReferences) {
    if (reference.query !== `v=${assetVersion}`) {
      violations.push(`${relative}: ${reference.assetPath}${reference.query ? `?${reference.query}` : " (unversioned)"}`);
    }
  }
  let dynamicMatch;
  while ((dynamicMatch = dynamicVersionPattern.exec(source))) {
    const [, assetPath, version] = dynamicMatch;
    dynamicVersions += 1;
    if (version !== assetVersion) violations.push(`${relative}: ${assetPath}?v=${version}`);
  }
  dynamicVersionPattern.lastIndex = 0;

  if (!write) continue;

  let rewritten = source.replace(assetReferencePattern, (full, quote, assetPath, query, closingQuote) => {
    if (!managesAsset(assetPath)) return full;
    return `${quote}${assetPath}?v=${assetVersion}${closingQuote}`;
  });
  assetReferencePattern.lastIndex = 0;
  rewritten = rewritten.replace(dynamicVersionPattern, (full, assetPath) => `${assetPath}?v=${assetVersion}`);
  dynamicVersionPattern.lastIndex = 0;
  if (rewritten !== source) {
    fs.writeFileSync(filePath, rewritten);
    changedFiles += 1;
  }
}

if (write) {
  console.log(`Updated ${references + dynamicVersions} local public asset references in ${changedFiles} files to ?v=${assetVersion}.`);
  process.exit(0);
}

if (violations.length) {
  console.error(`Found ${violations.length} public asset references that do not use ?v=${assetVersion}:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Public asset version check passed: ${references} literal and ${dynamicVersions} dynamic references use ?v=${assetVersion}.`);
