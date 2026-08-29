#!/usr/bin/env node

// Target-branch guard for the newest generated changelog entry. Historical
// manifests can contain entries written before this check existed; the entry
// being published by the current workflow must not contain release-process
// bookkeeping.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntryProcessViolations } from "./changelog-message.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const channel = String(process.argv[2] || "main").toLowerCase();
const fileName = channel === "alpha" ? "changelog.alpha.json" : channel === "main" ? "changelog.json" : "";

if (!fileName) {
  console.error(`Unknown changelog channel: ${channel}. Use alpha or main.`);
  process.exit(1);
}

const filePath = path.join(root, fileName);
const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
const entry = Array.isArray(manifest.entries) ? manifest.entries[0] : null;
if (!entry) {
  console.error(`No newest ${channel} changelog entry found in ${fileName}.`);
  process.exit(1);
}

const violations = changelogEntryProcessViolations(entry);
if (violations.length > 0) {
  console.error(`Refusing to publish ${channel}: the newest changelog entry contains release-process notes.`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`${channel} changelog entry passed the release-content guard.`);
