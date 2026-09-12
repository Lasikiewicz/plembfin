#!/usr/bin/env node

// Builds the Markdown body used by GitHub Releases for the main and alpha
// channels. The release promotion scripts already compute the changelog locally;
// this renderer keeps the published release page in the same readable shape as
// the repository's release format without asking CI to infer changes from a push
// event.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SECTION_GROUPS = [
  ["newFeatures", "New Features"],
  ["majorBugFixes", "Major Bug Fixes"],
  ["tweaks", "Tweaks"],
];

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function uniqueItems(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
}

function repositoryUrl(serverUrl, repository) {
  return `${String(serverUrl || "https://github.com").replace(/\/$/, "")}/${repository}`;
}

export function loadReleaseManifest(channel) {
  if (channel !== "main" && channel !== "alpha") {
    throw new Error(`Unsupported release channel "${channel}". Expected main or alpha.`);
  }
  const filename = channel === "main" ? "changelog.json" : "changelog.alpha.json";
  return JSON.parse(fs.readFileSync(path.join(root, filename), "utf8"));
}

export function getReleaseMetadata({ channel, manifest } = {}) {
  if (channel !== "main" && channel !== "alpha") {
    throw new Error(`Unsupported release channel "${channel}". Expected main or alpha.`);
  }

  const entry = manifest?.entries?.[0];
  if (!entry || typeof entry !== "object") {
    throw new Error(`No current ${channel} changelog entry is available.`);
  }

  if (channel === "alpha") {
    const baseVersion = normalizeText(manifest.baseVersion);
    const build = Number(manifest.build || entry.build || 0);
    if (!baseVersion || !Number.isInteger(build) || build < 1) {
      throw new Error("Alpha changelog metadata must contain a baseVersion and a positive build number.");
    }
    const tagName = `v${baseVersion}-alpha.${build}`;
    return {
      channel,
      entry,
      version: normalizeText(entry.version || `${baseVersion}.${build}`),
      build,
      tagName,
      title: `Plembfin ${tagName}`,
    };
  }

  const version = normalizeText(manifest.version || entry.version);
  if (!version) throw new Error("Main changelog metadata must contain a version.");
  const tagName = `v${version}`;
  return {
    channel,
    entry,
    version,
    build: null,
    tagName,
    title: `Plembfin ${tagName}`,
  };
}

function addSection(lines, heading, values) {
  const items = uniqueItems(values);
  if (!items.length) return false;
  lines.push(`### ${heading}`, "");
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
  return true;
}

export function generateReleaseNotes({ channel, manifest, repository = "Lasikiewicz/plembfin", serverUrl = "https://github.com", commit = "" } = {}) {
  const metadata = getReleaseMetadata({ channel, manifest });
  const entry = metadata.entry;
  const repoUrl = repositoryUrl(serverUrl, repository);
  const releaseUrl = `${repoUrl}/releases/tag/${encodeURIComponent(metadata.tagName)}`;
  const commitUrl = commit ? `${repoUrl}/commit/${commit}` : "";
  const changeHeading = channel === "alpha" ? "What changed in this alpha build" : "What changed in this release";
  const lines = [
    `## ${changeHeading}`,
    "",
    normalizeText(entry.message) || "Release update",
    "",
  ];

  const sections = entry.sections && typeof entry.sections === "object" ? entry.sections : {};
  const renderedSections = SECTION_GROUPS.some(([key]) => uniqueItems(sections[key]).length);
  if (renderedSections) {
    for (const [key, heading] of SECTION_GROUPS) addSection(lines, heading, sections[key]);
  } else {
    addSection(lines, "Changes", entry.details);
  }

  lines.push(
    "## Start safely",
    "",
    "1. Read the [fresh-install and provider setup notes](https://plembfin.com/docs).",
    "2. Create a backup before the first write-back.",
    "3. Start with a small library or a limited provider scope.",
    "4. Inspect Sync Activity after the first run and retry only the rows that need it.",
    "",
    "## Known limitations",
    "",
    "- Provider APIs and rate limits can still make delivery delayed.",
    "- Cross-provider matching can remain ambiguous for unusual titles, alternate cuts, or inconsistent episode metadata.",
    "- The canonical database is local to the deployment and must be included in your backup plan.",
  );
  if (channel === "alpha") {
    lines.push("- Alpha builds are pre-release software and may contain unfinished changes.");
  }
  lines.push(
    "",
    "## Get the build",
    "",
  );
  if (channel === "alpha") {
    lines.push(
      `- Docker: \`ghcr.io/${repository.toLowerCase()}:alpha\` for the rolling alpha tag, or \`ghcr.io/${repository.toLowerCase()}:alpha-${metadata.build}\` for this exact build.`,
      `- Windows: the installer and \`SHA256SUMS.txt\` are attached to the [${metadata.tagName} prerelease](${releaseUrl}) when the Windows build completes.`,
    );
  } else {
    lines.push(
      `- Docker: \`ghcr.io/${repository.toLowerCase()}:latest\` for the stable tag, or \`ghcr.io/${repository.toLowerCase()}:${metadata.version}\` for this exact release.`,
      `- Windows: the installer and \`SHA256SUMS.txt\` are attached to this [GitHub Release](${releaseUrl}).`,
    );
  }
  lines.push(
    "",
    "## Feedback",
    "",
    "When reporting a bug, include the provider, version, media type, and the relevant Sync Activity reason. Please do not include credentials or private server URLs.",
    "",
    "## Project",
    "",
    `Plembfin is licensed under AGPL-3.0. [Repository](${repoUrl}) · [Documentation](https://plembfin.com/docs)`,
    "",
    "Development and release work were heavily AI-assisted under my direction. I reviewed the generated changes, tested the integrations and browser flows, and maintain the project. AI is not required at runtime.",
  );

  if (commitUrl) {
    lines.push(`Build commit: [${commit.slice(0, 7)}](${commitUrl})`, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function outputPathFromArgs(args) {
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  return outputArg ? outputArg.slice("--output=".length) : "";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const channel = args.find((arg) => !arg.startsWith("--"));
  if (!channel) {
    console.error("Usage: node scripts/generate-release-notes.js <main|alpha> [--output=<path>]");
    process.exit(1);
  }

  try {
    const manifest = loadReleaseManifest(channel);
    const notes = generateReleaseNotes({
      channel,
      manifest,
      repository: process.env.GITHUB_REPOSITORY || "Lasikiewicz/plembfin",
      serverUrl: process.env.GITHUB_SERVER_URL || "https://github.com",
      commit: process.env.GITHUB_SHA || "",
    });
    const outputPath = outputPathFromArgs(args);
    if (outputPath) {
      fs.writeFileSync(outputPath, notes);
      console.log(`Wrote ${outputPath}`);
    } else {
      process.stdout.write(notes);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
