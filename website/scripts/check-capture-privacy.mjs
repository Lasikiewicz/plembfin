import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(websiteRoot, "public", "assets");
const privacyPath = path.join(websiteRoot, "capture-privacy.json");
const rasterExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const imageExtensions = new Set([...rasterExtensions, ".svg"]);

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath));
    else files.push(absolutePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function relativeAsset(absolutePath) {
  return path.relative(websiteRoot, absolutePath).replaceAll(path.sep, "/");
}

const failures = [];
if (!fs.existsSync(privacyPath)) {
  failures.push("missing website/capture-privacy.json");
} else {
  let privacy;
  try {
    privacy = JSON.parse(fs.readFileSync(privacyPath, "utf8"));
  } catch (error) {
    failures.push(`could not parse website/capture-privacy.json: ${error.message}`);
  }

  if (privacy) {
    const safeAssets = Array.isArray(privacy.safeAssets) ? privacy.safeAssets : [];
    const redactedAssets = privacy.redactedAssets && typeof privacy.redactedAssets === "object"
      ? privacy.redactedAssets
      : {};
    const reviewed = new Set([...safeAssets, ...Object.keys(redactedAssets)]);
    const discovered = new Set(
      walkFiles(assetsRoot)
        .filter((file) => imageExtensions.has(path.extname(file).toLowerCase()))
        .map(relativeAsset),
    );

    for (const asset of discovered) {
      if (!reviewed.has(asset)) failures.push(`unreviewed raster asset ${asset}`);
    }
    for (const asset of reviewed) {
      if (!discovered.has(asset)) failures.push(`privacy manifest references missing asset ${asset}`);
    }
    for (const asset of safeAssets) {
      if (redactedAssets[asset]) failures.push(`${asset} is listed as both safe and redacted`);
    }
    for (const [asset, redaction] of Object.entries(redactedAssets)) {
      if (!redaction || typeof redaction !== "object") {
        failures.push(`${asset} needs a redaction record`);
        continue;
      }
      if (!Array.isArray(redaction.regions) || redaction.regions.length === 0) {
        failures.push(`${asset} is redacted but has no blur regions`);
      }
      if (redaction.method !== "blur") {
        failures.push(`${asset} must record method: blur`);
      }
    }
    if (!privacy.policy || !String(privacy.policy).toLowerCase().includes("user-identifiable")) {
      failures.push("privacy manifest must state the user-identifiable-information policy");
    }
  }
}

if (failures.length) {
  console.error(`Capture privacy check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  const count = walkFiles(assetsRoot)
    .filter((file) => imageExtensions.has(path.extname(file).toLowerCase())).length;
  console.log(`Capture privacy check passed (${count} image assets explicitly reviewed).`);
}
