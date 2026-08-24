#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRootFile(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function minimumNodeVersion(engineRange) {
  const match = String(engineRange || "").match(/>=\s*(\d+(?:\.\d+){0,2})/);
  if (!match) {
    throw new Error(`Could not derive a minimum Node.js version from engines.node: ${engineRange || "missing"}`);
  }
  return match[1];
}

export function checkDocumentationConsistency({ packageJson, readme } = {}) {
  const pkg = packageJson || JSON.parse(readRootFile("package.json"));
  const markdown = readme || readRootFile("README.md");
  const nodeMinimum = minimumNodeVersion(pkg.engines?.node);
  const failures = [];

  if (!markdown.includes(`Node.js-%3E%3D${nodeMinimum}-blue`)) {
    failures.push(`README Node.js badge does not match package.json engines.node (>=${nodeMinimum})`);
  }

  if (!markdown.includes(`Requires Node.js ${nodeMinimum}+`)) {
    failures.push(`README bare-metal setup does not state Node.js ${nodeMinimum}+`);
  }

  if (/ADMIN_PASSWORD\s*[:=]\s*(?:changeme|password|admin)\b/i.test(markdown)) {
    failures.push("README contains a weak/default ADMIN_PASSWORD example");
  }

  const requiredComposePassword = /ADMIN_PASSWORD:\s*"\$\{ADMIN_PASSWORD:\?[^"}]+\}"/;
  if (!requiredComposePassword.test(markdown)) {
    failures.push("README Docker Compose setup does not require ADMIN_PASSWORD from a local .env file");
  }

  if (failures.length) {
    throw new Error(`Documentation consistency check failed:\n- ${failures.join("\n- ")}`);
  }

  return { nodeMinimum };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { nodeMinimum } = checkDocumentationConsistency();
  console.log(`Documentation consistency check passed (Node.js >=${nodeMinimum}).`);
}
