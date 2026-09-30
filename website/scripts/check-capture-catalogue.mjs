import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every app capture must be described in capture-catalogue.json: referenced images with how to
// retake them, crop-source frames, or retired files. Sizes must match the published files, and
// every named application source file must exist.

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(websiteRoot, "..");
const captureRoot = path.join(websiteRoot, "public", "assets", "app-captures");
const catalogue = JSON.parse(fs.readFileSync(path.join(websiteRoot, "capture-catalogue.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(websiteRoot, "src", "generated", "capture-manifest.json"), "utf8"));
const VARIANT = /^(.*?)-((?:modern-)?(?:dark|light))\.png$/;
const FRAMING = new Set(Object.keys(catalogue.framingTypes));
const failures = [];

function readPngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const files = {};
for (const name of fs.readdirSync(captureRoot)) {
  const match = name.match(VARIANT);
  if (!match) {
    failures.push(`capture ${name} does not follow the <id>-<variant>.png naming`);
    continue;
  }
  (files[match[1]] ??= {})[match[2]] = readPngDimensions(path.join(captureRoot, name));
}

const referenced = new Set();
for (const asset of manifest.assets) {
  if (!asset.path.startsWith("public/assets/app-captures/") || !asset.referencedBy.length) continue;
  const match = path.basename(asset.path).match(VARIANT);
  if (match) referenced.add(match[1]);
}

function checkSizes(kind, id, sizes) {
  const actual = files[id];
  if (!actual) {
    failures.push(`${kind} ${id} has no capture files`);
    return;
  }
  for (const variant of new Set([...Object.keys(sizes ?? {}), ...Object.keys(actual)])) {
    const want = sizes?.[variant];
    const have = actual[variant];
    if (!want) failures.push(`${kind} ${id}: ${variant} file exists but is not in the catalogue`);
    else if (!have) failures.push(`${kind} ${id}: ${variant} is catalogued but the file is missing`);
    else if (want.width !== have.width || want.height !== have.height) {
      failures.push(`${kind} ${id}: ${variant} is ${have.width}x${have.height}, catalogue says ${want.width}x${want.height}`);
    }
  }
}

const images = catalogue.images ?? {};
const cropSources = catalogue.cropSources ?? {};
const retired = new Set(catalogue.retired ?? []);

for (const [id, entry] of Object.entries(images)) {
  if (!referenced.has(id)) failures.push(`image ${id} is referenced by no website page (move it to retired or cropSources)`);
  if (!entry.route?.startsWith("/")) failures.push(`image ${id} has no app route`);
  if (!entry.state) failures.push(`image ${id} has no state`);
  if (!FRAMING.has(entry.framing?.type)) failures.push(`image ${id} has unknown framing ${entry.framing?.type}`);
  if (entry.framing?.type === "crop" && !cropSources[entry.framing.source]) {
    failures.push(`image ${id} crops from unknown source ${entry.framing.source}`);
  }
  if (entry.live && !catalogue.live?.[entry.live]) failures.push(`image ${id} has unknown live state ${entry.live}`);
  if (!entry.sources?.length) failures.push(`image ${id} names no application source files`);
  for (const source of entry.sources ?? []) {
    if (!fs.existsSync(path.join(repoRoot, source))) failures.push(`image ${id} names missing source ${source}`);
  }
  if (JSON.stringify(entry.variants) !== JSON.stringify(Object.keys(entry.sizes ?? {}))) {
    failures.push(`image ${id}: variants and sizes disagree`);
  }
  checkSizes("image", id, entry.sizes);
}
for (const [id, entry] of Object.entries(cropSources)) {
  if (!entry.route?.startsWith("/")) failures.push(`crop source ${id} has no app route`);
  checkSizes("crop source", id, entry.sizes);
}
for (const id of retired) {
  if (!files[id]) failures.push(`retired ${id} has no capture files (remove it from retired)`);
  if (referenced.has(id)) failures.push(`retired ${id} is still referenced by a website page`);
}
for (const source of [...catalogue.commonSources.all, ...catalogue.commonSources.modern]) {
  if (!fs.existsSync(path.join(repoRoot, source))) failures.push(`common source ${source} is missing`);
}
for (const id of referenced) if (!images[id]) failures.push(`referenced capture ${id} is missing from the catalogue`);
for (const id of Object.keys(files)) {
  if (!images[id] && !cropSources[id] && !retired.has(id)) failures.push(`capture ${id} is not catalogued`);
}

if (failures.length) {
  console.error(`Capture catalogue check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Capture catalogue check passed: ${Object.keys(images).length} images, ${Object.keys(cropSources).length} crop sources, ${retired.size} retired.`);
