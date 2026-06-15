#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["public", "server", "scripts"];

function javascriptFiles(directory) {
  const absolute = path.join(root, directory);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(relative);
    return entry.isFile() && entry.name.endsWith(".js") ? [relative] : [];
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of sourceRoots.flatMap(javascriptFiles)) {
  run(process.execPath, ["--check", file]);
}

for (const file of ["package.json", "package-lock.json", "changelog.json"]) {
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-build-check-"));
try {
  run(process.execPath, ["server/server.js"], {
    env: {
      ...process.env,
      DATA_DIR: temporaryData,
      PORT: "0",
      PLEMBFIN_BUILD_CHECK: "1",
    },
  });
} finally {
  fs.rmSync(temporaryData, { recursive: true, force: true });
}

console.log("Plembfin build check passed.");
