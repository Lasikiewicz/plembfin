import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const outputPath = path.join(websiteRoot, "src", "generated", "release.json");

const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const changelog = fs.readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");

function parseEntries(markdown) {
  return markdown
    .split(/^##\s+/m)
    .slice(1)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/);
      const header = lines.shift()?.trim() || "";
      const match = header.match(/^(v[^\s]+)(?:\s+-\s+(.+))?$/);
      if (!match) return null;

      const body = lines.join("\n").trim();
      const paragraphs = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
      const summary = paragraphs.find((part) => !part.startsWith("#") && !part.startsWith("-")) || "Release notes for this version.";
      const bullets = [...body.matchAll(/^[-*]\s+(.+)$/gm)]
        .map((item) => item[1].trim())
        .filter(Boolean)
        .slice(0, 10);

      return {
        version: match[1].replace(/^v/, ""),
        date: match[2] || "",
        title: match[1],
        summary: summary.replace(/\s+/g, " "),
        bullets,
      };
    })
    .filter(Boolean);
}

function formatDate(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function readAlphaChangelog() {
  const alphaPath = path.join(repositoryRoot, "changelog.alpha.json");
  if (!fs.existsSync(alphaPath)) return null;

  const source = JSON.parse(fs.readFileSync(alphaPath, "utf8"));
  const entries = Array.isArray(source.entries) ? source.entries : [];
  const normalizedEntries = entries.map((entry) => {
    const details = Array.isArray(entry.details) ? entry.details.filter(Boolean) : [];
    const sectionBullets = Object.values(entry.sections || {}).flatMap((section) => Array.isArray(section) ? section : []);
    const bullets = details.length ? details : sectionBullets;
    const version = String(entry.version || source.version || `${entry.build ?? source.build ?? "current"}`).replace(/^v/, "");
    const build = entry.build ?? source.build ?? null;

    return {
      build,
      version,
      date: formatDate(entry.date || source.updatedAt),
      title: build === null ? `v${version}` : `Alpha build ${build}`,
      summary: entry.message || bullets[0] || "Alpha build updates.",
      bullets,
    };
  });

  if (!normalizedEntries.length) return null;

  return {
    baseVersion: source.baseVersion || "",
    build: source.build ?? null,
    version: source.version || normalizedEntries[0].version,
    updatedAt: source.updatedAt || "",
    entries: normalizedEntries,
  };
}

const entries = parseEntries(changelog);
const alpha = readAlphaChangelog();
const current = entries[0] || {
  version: packageJson.version,
  date: "",
  title: `v${packageJson.version}`,
  summary: "Current release information is generated from the repository changelog.",
  bullets: [],
};

const output = {
  version: packageJson.version,
  date: current.date,
  summary: current.summary,
  entries: entries.length ? entries : [current],
  alpha,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Generated release data for Plembfin v${output.version}.`);
