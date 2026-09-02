import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(file);
    return entry.isFile() && entry.name.endsWith(".js") ? [file] : [];
  });
}

test("production watch-action imports use one module URL", () => {
  const versions = new Set();
  const importPattern = /["']([^"']*watch-action\.js(?:\?v=[^"']+)?)['"]/g;

  for (const file of javascriptFiles(path.join(root, "public"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      versions.add(match[1].split("?v=")[1] || "");
    }
  }

  assert.equal(versions.size, 1, `watch-action.js was imported under multiple module URLs: ${[...versions].join(", ")}`);
});
