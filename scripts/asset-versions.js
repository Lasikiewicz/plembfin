#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const requestedVersion = process.argv.find((argument) => argument.startsWith("--version="))?.slice("--version=".length);
const assetVersion = String(requestedVersion || process.env.ASSET_VERSION || packageJson.version || "dev").trim();
const write = process.argv.includes("--write");

if (!/^[A-Za-z0-9._-]+$/.test(assetVersion)) {
  throw new Error(`Invalid asset version: ${assetVersion}`);
}

const assetReferencePattern = /(["'`])((?:\/|\.{1,2}\/)[^"'`)\s]+?\.(?:m?js|css|svg|png|jpe?g|webp|gif|ico|webmanifest|woff2?))(?:\?([^"'`)\s]*))?(["'`])/gi;

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
  if (!write || !fileReferences.some((reference) => reference.query !== `v=${assetVersion}`)) continue;

  const rewritten = source.replace(assetReferencePattern, (full, quote, assetPath, query, closingQuote) => {
    if (!managesAsset(assetPath)) return full;
    return `${quote}${assetPath}?v=${assetVersion}${closingQuote}`;
  });
  assetReferencePattern.lastIndex = 0;
  if (rewritten !== source) {
    fs.writeFileSync(filePath, rewritten);
    changedFiles += 1;
  }
}

if (write) {
  console.log(`Updated ${references} local public asset references in ${changedFiles} files to ?v=${assetVersion}.`);
  process.exit(0);
}

if (violations.length) {
  console.error(`Found ${violations.length} public asset references that do not use ?v=${assetVersion}:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Public asset version check passed: ${references} references use ?v=${assetVersion}.`);
