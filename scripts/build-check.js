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

// Guard: every outbound call in server code must carry a timeout. Bare global
// fetch hangs on an unresponsive upstream (media server, metadata API, backup
// destination) — use fetchWithTimeout from server/src/utils/outbound.js, or an
// explicit `signal: AbortSignal.timeout(...)` on the same call.
{
  const barePattern = /(?:await|return)\s+fetch\(/;
  const offenders = [];
  for (const file of javascriptFiles("server")) {
    if (file.replace(/\\/g, "/").endsWith("utils/outbound.js")) continue;
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!barePattern.test(line)) return;
      // Allow calls that attach their own AbortSignal.timeout within the next few lines.
      const window = lines.slice(index, index + 8).join("\n");
      if (window.includes("AbortSignal.timeout")) return;
      offenders.push(`${file}:${index + 1}`);
    });
  }
  if (offenders.length) {
    console.error("Bare fetch() without a timeout found — use fetchWithTimeout (server/src/utils/outbound.js):");
    for (const offender of offenders) console.error(`  ${offender}`);
    process.exit(1);
  }
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
