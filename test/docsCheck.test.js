import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocumentationConsistency } from "../scripts/docs-check.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("README released-version marker matches the current package version", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const expectedNodeMinimum = packageJson.engines.node.match(/>=\s*(\d+(?:\.\d+){0,2})/)[1];
  assert.equal(checkDocumentationConsistency({ packageJson, readme }).nodeMinimum, expectedNodeMinimum);
});

test("documentation check rejects a stale README released-version marker", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8")
    .replace(/^>\s+\*\*v[^*\s]+\.\*\*/m, "> **v0.0.0.**");
  assert.throws(
    () => checkDocumentationConsistency({ packageJson, readme }),
    new RegExp(`README released-version marker \\(0\\.0\\.0\\) does not match package\\.json \\(${packageJson.version.replaceAll(".", "\\.")}\\)`),
  );
});
