import fs from "node:fs";
import path from "node:path";

const docsRoot = path.resolve("src", "content", "docs");

function collectDocs(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectDocs(filePath));
    else if (entry.name.endsWith(".mdx")) files.push(filePath);
  }
  return files;
}

const duplicates = [];
for (const filePath of collectDocs(docsRoot)) {
  const source = fs.readFileSync(filePath, "utf8");
  const counts = new Map();
  for (const figure of source.matchAll(/<ScreenshotFigure\b[\s\S]*?\/>/g)) {
    const darkSource = figure[0].match(/\bdarkSrc="([^"]+)"/)?.[1];
    if (darkSource) counts.set(darkSource, (counts.get(darkSource) || 0) + 1);
  }
  for (const [asset, count] of counts) {
    if (count > 1) duplicates.push(`${path.relative(process.cwd(), filePath)}: ${count} x ${asset}`);
  }
}

if (duplicates.length > 0) {
  console.error(`Duplicate screenshot references found:\n- ${duplicates.join("\n- ")}`);
  process.exit(1);
}

console.log("Duplicate screenshot check passed.");
