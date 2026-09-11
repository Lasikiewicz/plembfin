import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const surface = JSON.parse(fs.readFileSync(path.join(websiteRoot, "src", "data", "app-surface.json"), "utf8"));
const failures = [];

function exists(relativePath) {
  return fs.existsSync(path.join(repositoryRoot, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function readWebsite(relativePath) {
  return fs.readFileSync(path.join(websiteRoot, relativePath), "utf8");
}

for (const item of surface) {
  const docPath = path.join("src", "content", "docs", `${item.docSlug}.mdx`);
  if (!fs.existsSync(path.join(websiteRoot, docPath))) {
    failures.push(`${item.id}: missing website guide ${docPath}`);
    continue;
  }

  for (const sourcePath of item.sourcePaths) {
    if (!exists(sourcePath)) failures.push(`${item.id}: missing source path ${sourcePath}`);
  }

  const source = readWebsite(docPath);
  for (const required of ["title:", "description:", "sourceVersion:", "sourcePaths:"]) {
    if (!source.includes(required)) failures.push(`${item.id}: ${docPath} is missing ${required}`);
  }
}

const appShell = read("public/index.html");
const settingsShell = read("public/modules/settings-shell.js");
for (const label of ["Dashboard", "Movies", "TV Shows", "Upcoming", "Discover", "Watchlist", "Ratings", "Custom Lists", "History", "Stats", "Settings"]) {
  if (!appShell.includes(`>${label}<`) && !appShell.includes(`"${label}"`)) {
    failures.push(`app shell no longer contains the expected user-facing label: ${label}`);
  }
}

for (const label of ["General", "Media servers", "Webhooks", "Connections", "Metadata", "Sync", "Backup", "Restore", "Tools", "Logs"]) {
  if (!settingsShell.includes(`label: "${label}"`)) {
    failures.push(`settings shell no longer contains the expected group: ${label}`);
  }
}

const allWebsiteDocs = fs.readdirSync(path.join(websiteRoot, "src", "content", "docs"))
  .filter((name) => name.endsWith(".mdx"))
  .map((name) => name.replace(/\.mdx$/, ""));
const documentedSlugs = new Set(surface.map((item) => item.docSlug));
for (const slug of allWebsiteDocs) {
  if (!documentedSlugs.has(slug)) failures.push(`website guide ${slug}.mdx is not represented in app-surface.json`);
}

if (failures.length) {
  console.error(`Website content check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Website content check passed (${surface.length} app surfaces mapped).`);
}
