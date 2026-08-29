#!/usr/bin/env node

// Renders changelog.json into a plain, human-readable CHANGELOG.md at the repo
// root, so release history is readable directly on GitHub without needing to
// log into a running instance. Regenerated automatically by
// promote-alpha-to-main.js on every release; safe to re-run manually at any
// time since it only reads changelog.json and overwrites CHANGELOG.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const outputPath = path.join(root, "CHANGELOG.md");

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
}

export function generateChangelogMarkdown() {
  const changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));
  const entries = Array.isArray(changelog.entries) ? changelog.entries : [];

  const lines = [
    "# Changelog",
    "",
    "Release history for Plembfin. This file covers published releases on `main` only -",
    "for the current pre-release build on `alpha` or `develop`, open **Settings → About**",
    "in a running instance, which lists that channel's build history separately.",
    "",
  ];

  for (const entry of entries) {
    lines.push(`## v${entry.version}${entry.date ? ` - ${formatDate(entry.date)}` : ""}`);
    lines.push("");
    lines.push(entry.message || "Release update");
    lines.push("");
    const sections = entry.sections && typeof entry.sections === "object" ? entry.sections : null;
    const sectionGroups = sections ? [
      ["New Features", sections.newFeatures],
      ["Major Bug Fixes", sections.majorBugFixes],
      ["Tweaks", sections.tweaks],
    ] : [];
    if (sectionGroups.some(([, details]) => Array.isArray(details) && details.length)) {
      for (const [heading, details] of sectionGroups) {
        if (!Array.isArray(details) || !details.length) continue;
        lines.push(`### ${heading}`, "");
        for (const detail of details) lines.push(`- ${detail}`);
        lines.push("");
      }
    } else if (Array.isArray(entry.details) && entry.details.length) {
      for (const detail of entry.details) lines.push(`- ${detail}`);
      lines.push("");
    }
  }

  fs.writeFileSync(outputPath, `${lines.join("\n").trimEnd()}\n`);
  return outputPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = generateChangelogMarkdown();
  console.log(`Wrote ${written}`);
}
