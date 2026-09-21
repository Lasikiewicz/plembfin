import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const outputPath = path.join(websiteRoot, "src", "generated", "release.json");
const releaseRef = process.env.PLEMBFIN_WEBSITE_RELEASE_REF || "origin/main";

// Released data is read from PLEMBFIN_WEBSITE_RELEASE_REF when set, otherwise
// from origin/main when that ref resolves, and from the working tree otherwise.
// The override lets the pre-push website preview verify the release commit that
// is about to become main without mutating the local remote-tracking ref.
//
// The working tree is the normal path in production. Verified against the real
// Cloudflare Pages build log (deployment 8246ff18, main, 5f94ea0): Pages clones a
// single commit by SHA into FETCH_HEAD and keeps no remote-tracking refs, so
// origin/main does not exist there at all. That is correct anyway, because Pages
// builds `main` itself, so the working tree IS the released tree.
//
// origin/main matters for the other publishing path. "Push website live" deploys
// from a local checkout, usually `develop`, and the release commit is never merged
// back into develop (docs/decisions.md entry 18), so develop's CHANGELOG.md lacks
// the newest release. Reading the ref when it exists keeps that publish correct.
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

const packageJson = JSON.parse(readReleasedFile("package.json"));
const changelog = readReleasedFile("CHANGELOG.md");

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
        .filter(Boolean);

      const sections = [];
      let currentSection = null;
      let currentGroup = null;
      for (const line of body.split(/\r?\n/)) {
        const sectionMatch = line.match(/^###\s+(.+)$/);
        if (sectionMatch) {
          currentSection = { title: sectionMatch[1].trim(), groups: [] };
          sections.push(currentSection);
          currentGroup = null;
          continue;
        }

        const groupMatch = line.match(/^####\s+(.+)$/);
        if (groupMatch && currentSection) {
          currentGroup = { title: groupMatch[1].trim(), bullets: [] };
          currentSection.groups.push(currentGroup);
          continue;
        }

        const bulletMatch = line.match(/^[-*]\s+(.+)$/);
        if (!bulletMatch || !currentSection) continue;
        if (!currentGroup) {
          currentGroup = { title: "", bullets: [] };
          currentSection.groups.push(currentGroup);
        }
        currentGroup.bullets.push(bulletMatch[1].trim());
      }

      const hasNamedGroups = sections.some((section) =>
        section.groups.some((group) => group.title),
      );

      return {
        version: match[1].replace(/^v/, ""),
        date: match[2] || "",
        title: match[1],
        summary: summary.replace(/\s+/g, " "),
        bullets,
        ...(hasNamedGroups ? { sections } : {}),
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

// Guard the fallback. Because the working tree is the production path, a future
// change to the Pages production branch would otherwise silently publish a site
// with a blank or wrong changelog. Fail the build instead.
if (!packageJson.version) {
  throw new Error("Refusing to generate release data: no version found in package.json.");
}
if (!entries.length) {
  throw new Error("Refusing to generate release data: CHANGELOG.md parsed to zero release entries.");
}

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
