import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(websiteRoot, "src");
const failures = [];

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath));
    else files.push(absolutePath);
  }
  return files;
}

const figureSource = fs.readFileSync(path.join(sourceRoot, "components", "ScreenshotFigure.astro"), "utf8");
for (const requiredFragment of [
  "alt={alt}",
  "width={resolvedWidth}",
  "height={resolvedHeight}",
  "sizes={sizes}",
  "data-lightbox-trigger=\"true\"",
  "aria-label={`Open image preview: ${alt}`}",
]) {
  if (!figureSource.includes(requiredFragment)) failures.push(`ScreenshotFigure.astro is missing ${requiredFragment}`);
}

const layoutSource = fs.readFileSync(path.join(sourceRoot, "layouts", "SiteLayout.astro"), "utf8");
for (const requiredFragment of [
  'aria-labelledby="image-lightbox-title"',
  'aria-describedby="image-lightbox-caption"',
  "closeButton?.focus()",
  "lastTrigger.focus()",
  "Reflect.get(window, \"__plembfinSyncTheme\")",
]) {
  if (!layoutSource.includes(requiredFragment)) failures.push(`SiteLayout.astro is missing ${requiredFragment}`);
}

const headerSource = fs.readFileSync(path.join(sourceRoot, "components", "SiteHeader.astro"), "utf8");
for (const requiredFragment of ['type="button" data-theme-toggle', 'aria-pressed="false"', 'aria-controls="site-nav"']) {
  if (!headerSource.includes(requiredFragment)) failures.push(`SiteHeader.astro is missing ${requiredFragment}`);
}

for (const filePath of walkFiles(sourceRoot).filter((file) => file.endsWith(".astro") || file.endsWith(".mdx"))) {
  const source = fs.readFileSync(filePath, "utf8");
  for (const match of source.matchAll(/^\s*<ScreenshotFigure\b[\s\S]*?\/>/gm)) {
    if (!/\balt\s*=/.test(match[0])) failures.push(`${path.relative(websiteRoot, filePath)} has a screenshot without alt text`);
  }
}

const indexSource = fs.readFileSync(path.join(sourceRoot, "pages", "index.astro"), "utf8");
const featuresSource = fs.readFileSync(path.join(sourceRoot, "pages", "features.astro"), "utf8");
for (const [label, source] of [["index.astro", indexSource], ["features.astro", featuresSource]]) {
  if (!source.includes('alt="" aria-hidden="true"')) failures.push(`${label} provider icons are not explicitly decorative`);
  if (!source.includes("{integration.name}") && !source.includes("{service.name}")) failures.push(`${label} provider names are not visibly rendered beside their icons`);
}

if (!layoutSource.includes("navigator.doNotTrack === \"1\"")) failures.push("analytics loading does not honor Do Not Track");
if (/<script async src=\{`https:\/\/www\.googletagmanager\.com/.test(layoutSource)) failures.push("analytics is still injected synchronously in the document head");

const distRoot = path.join(websiteRoot, "dist");
if (fs.existsSync(distRoot)) {
  for (const filePath of walkFiles(distRoot).filter((file) => file.endsWith(".html"))) {
    const html = fs.readFileSync(filePath, "utf8");
    for (const imageMatch of html.matchAll(/<img\b[^>]*>/gi)) {
      const image = imageMatch[0];
      if (!/\bwidth="\d+"/.test(image) || !/\bheight="\d+"/.test(image)) {
        failures.push(`${path.relative(websiteRoot, filePath)} contains an image without intrinsic dimensions`);
      }
    }
    for (const figure of html.matchAll(/<figure class="screenshot-figure">[\s\S]*?<\/figure>/g)) {
      const image = figure[0].match(/<img\b[^>]*>/)?.[0] || "";
      if (!/\bwidth="\d+"/.test(image) || !/\bheight="\d+"/.test(image)) {
        failures.push(`${path.relative(websiteRoot, filePath)} contains a screenshot without intrinsic dimensions`);
      }
      if (!/\balt="[^"]+"/.test(image)) failures.push(`${path.relative(websiteRoot, filePath)} contains a screenshot without a text alternative`);
    }
  }
}

if (failures.length) {
  console.error(`Website accessibility check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Website accessibility check passed (source semantics and rendered screenshot contracts).");
}
