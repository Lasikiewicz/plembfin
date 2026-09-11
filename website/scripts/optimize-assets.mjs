import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { optimize as optimizeSvg } from "svgo";
import { getImageVariantWidths, isOptimizableRasterPath } from "../src/utils/image-variants.js";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(websiteRoot, "public", "assets");
const optimizedRoot = path.join(assetsRoot, "optimized");
const generated = [];
const headerLogoPattern = /^plembfin_header_logo_(?:dark|light)\.(?:png|jpe?g|webp)$/i;

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

function outputRelative(absolutePath) {
  return path.relative(websiteRoot, absolutePath).replaceAll(path.sep, "/");
}

function sourceRelative(absolutePath) {
  return path.relative(assetsRoot, absolutePath).replaceAll(path.sep, "/");
}

function sourcePath(relativePath) {
  return path.join(assetsRoot, relativePath);
}

function outputPath(relativePath, width, extension) {
  const parsed = path.parse(relativePath);
  return path.join(optimizedRoot, parsed.dir, `${parsed.name}-${width}.${extension}`);
}

function webpQuality(relativePath) {
  // Keep text-heavy documentation captures crisp, but trim the landing-page
  // hero enough to avoid shipping a large fallback-sized payload.
  return /^app-captures[\\/]dashboard-home-(?:dark|light)\./i.test(relativePath) ? 78 : 82;
}

function targetWidths(relativePath, sourceWidth) {
  if (headerLogoPattern.test(path.basename(relativePath))) return [376];
  return getImageVariantWidths(sourceWidth);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function writeRasterVariants(relativePath) {
  const inputPath = sourcePath(relativePath);
  const metadata = await sharp(inputPath).metadata();
  if (!metadata.width) throw new Error(`Could not read dimensions for ${outputRelative(inputPath)}`);

  const widths = targetWidths(relativePath, metadata.width);
  for (const width of widths) {
    const webpPath = outputPath(relativePath, width, "webp");
    const pngPath = outputPath(relativePath, width, "png");
    fs.mkdirSync(path.dirname(webpPath), { recursive: true });

    await sharp(inputPath)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: webpQuality(relativePath), effort: 4 })
      .toFile(webpPath);
    await sharp(inputPath)
      .resize({ width, withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 90 })
      .toFile(pngPath);

    generated.push({
      source: relativePath,
      width,
      bytes: fs.statSync(webpPath).size + fs.statSync(pngPath).size,
    });
  }
}

async function writeHubVariant() {
  const inputPath = sourcePath("plembfin-hub.svg");
  if (!fs.existsSync(inputPath)) throw new Error(`Missing source asset ${outputRelative(inputPath)}`);

  let svg = fs.readFileSync(inputPath, "utf8");
  svg = svg.replace(
    'viewBox="0 0 1200 540" width="100%" height="100%"',
    'viewBox="0 0 1200 540" width="1200" height="540"',
  );

  const embeddedLogo = svg.match(/data:image\/png;base64,([^"]+)/i);
  if (embeddedLogo) {
    const logoBuffer = Buffer.from(embeddedLogo[1], "base64");
    const resizedLogo = await sharp(logoBuffer)
      .resize({ width: 300, height: 49, fit: "fill" })
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 90 })
      .toBuffer();
    svg = svg.replaceAll(
      embeddedLogo[0],
      `data:image/png;base64,${resizedLogo.toString("base64")}`,
    );
  }

  const optimized = optimizeSvg(svg, { multipass: true });
  const outputPathValue = path.join(optimizedRoot, "plembfin-hub.svg");
  fs.mkdirSync(path.dirname(outputPathValue), { recursive: true });
  fs.writeFileSync(outputPathValue, optimized.data);
  generated.push({ source: "plembfin-hub.svg", width: 1200, bytes: fs.statSync(outputPathValue).size });
}

async function mapWithConcurrency(items, worker, limit = 4) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

const rasterSources = walkFiles(assetsRoot)
  .filter((absolutePath) => !absolutePath.startsWith(`${optimizedRoot}${path.sep}`))
  .filter((absolutePath) => isOptimizableRasterPath(`/assets/${sourceRelative(absolutePath)}`));

if (!rasterSources.length) throw new Error("No optimizable raster assets were found under public/assets");

// This directory is entirely generated by this script. Removing it prevents stale variants from surviving a rename or deletion.
fs.rmSync(optimizedRoot, { recursive: true, force: true });
fs.mkdirSync(optimizedRoot, { recursive: true });

await mapWithConcurrency(rasterSources, (absolutePath) => writeRasterVariants(sourceRelative(absolutePath)));
await writeHubVariant();

const generatedBytes = generated.reduce((total, asset) => total + asset.bytes, 0);
console.log(
  `Optimized ${generated.length} derived assets from ${rasterSources.length} raster sources (${formatBytes(generatedBytes)}).`,
);
