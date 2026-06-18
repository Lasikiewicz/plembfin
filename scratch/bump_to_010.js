import fs from "node:fs";
import path from "node:path";

const root = "c:\\Github\\plembfin";
const changelogPath = path.join(root, "changelog.json");
const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");

// Read files
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
const changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));

const newVersion = "0.1.0";
const oldVersion = packageJson.version;
console.log(`Bumping version from ${oldVersion} to ${newVersion}...`);

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n");

// Update package-lock.json
packageLock.version = newVersion;
if (packageLock.packages && packageLock.packages[""]) {
  packageLock.packages[""].version = newVersion;
}
fs.writeFileSync(packageLockPath, JSON.stringify(packageLock, null, 2) + "\n");

// Get latest git commit hash for the changelog entry
import { execSync } from "node:child_process";
let latestCommit = "";
try {
  // Let's stage current changes and commit them first so we have the commit hash
  execSync("git add .", { cwd: root });
  execSync('git commit -m "feat: move search filter tabs to middle top inline and center them"', { cwd: root });
  latestCommit = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  console.log(`Committed changes. Latest commit hash: ${latestCommit}`);
} catch (err) {
  console.error("Git commit failed. Creating version files with placeholder commit.", err.message);
  latestCommit = "0000000000000000000000000000000000000000";
}

// Update changelog.json
changelog.version = newVersion;
changelog.updatedAt = new Date().toISOString();
changelog.entries.unshift({
  version: newVersion,
  date: new Date().toISOString(),
  commit: latestCommit,
  message: "feat: move search filter tabs to middle top inline, center them, and fix show poster fallbacks",
  author: "Lasikiewicz"
});
fs.writeFileSync(changelogPath, JSON.stringify(changelog, null, 2) + "\n");

console.log("Version 0.1.0 update complete!");
