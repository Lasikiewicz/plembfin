import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

function readOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function requiredOption(name) {
  const value = readOption(name);
  if (!value) {
    throw new Error(`Missing required option --${name}=...`);
  }
  return value;
}

function parseNumbers(value, expected, label) {
  const numbers = value.split(",").map((part) => Number(part.trim()));
  if (numbers.length !== expected || numbers.some((number) => !Number.isFinite(number))) {
    throw new Error(`Expected ${expected} comma-separated numbers for ${label}.`);
  }
  return numbers;
}

const inputPrefix = requiredOption("prefix");
const outputPath = requiredOption("output");
const positions = parseNumbers(requiredOption("positions"), 3, "positions");
const pageHeight = Number(requiredOption("page-height"));
const contentX = Number(readOption("content-x", "0"));
const fixedTop = Number(readOption("fixed-top", "0"));
const redact = readOption("redact");

if (!Number.isInteger(pageHeight) || pageHeight < 1 || !Number.isInteger(contentX) || contentX < 0 || !Number.isInteger(fixedTop) || fixedTop < 0) {
  throw new Error("page-height must be positive; content-x and fixed-top must be non-negative integers.");
}

const inputPaths = [0, 1, 2].map((index) => `${inputPrefix}-${index}.png`);
const inputBuffers = await Promise.all(inputPaths.map((inputPath) => fs.readFile(inputPath)));
const metadata = await sharp(inputBuffers[0]).metadata();
const width = metadata.width;
const viewportHeight = metadata.height;

if (!width || !viewportHeight || pageHeight < viewportHeight || contentX >= width || fixedTop >= viewportHeight) {
  throw new Error("The first capture must have readable dimensions, page-height must include it, and content-x/fixed-top must fit inside it.");
}

const backgroundPixel = await sharp(inputBuffers[0])
  .extract({ left: 0, top: Math.max(0, viewportHeight - 8), width: 1, height: 1 })
  .raw()
  .toBuffer();
const background = {
  r: backgroundPixel[0] ?? 0,
  g: backgroundPixel[1] ?? 0,
  b: backgroundPixel[2] ?? 0,
  alpha: 1,
};

const layers = [{ input: inputBuffers[0], left: 0, top: 0 }];

for (let index = 1; index < inputBuffers.length; index += 1) {
  const top = Math.max(0, Math.round(positions[index]) + fixedTop);
  const height = Math.min(viewportHeight - fixedTop, pageHeight - top);
  if (height <= 0 || contentX >= width) continue;

  layers.push({
    input: await sharp(inputBuffers[index])
      .extract({ left: contentX, top: fixedTop, width: width - contentX, height })
      .toBuffer(),
    left: contentX,
    top,
  });
}

let composed = await sharp({
  create: {
    width,
    height: pageHeight,
    channels: 4,
    background,
  },
}).composite(layers).png().toBuffer();

if (redact) {
  const [left, top, redactWidth, redactHeight] = parseNumbers(redact, 4, "redact");
  if (left < 0 || top < 0 || redactWidth < 1 || redactHeight < 1 || left + redactWidth > width || top + redactHeight > pageHeight) {
    throw new Error("The redact region must fit inside the output image.");
  }

  const blurred = await sharp(composed)
    .extract({ left, top, width: redactWidth, height: redactHeight })
    .blur(18)
    .toBuffer();
  composed = await sharp(composed).composite([{ input: blurred, left, top }]).png().toBuffer();
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await sharp(composed)
  .flatten({ background })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(outputPath);
console.log(`Wrote ${outputPath} (${width}x${pageHeight}).`);
