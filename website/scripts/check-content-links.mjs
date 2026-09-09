import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(websiteRoot, "src", "content", "docs");
function collectDocFiles(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) return collectDocFiles(path.join(directory, entry.name), relativePath);
    return entry.name.endsWith(".mdx") ? [relativePath] : [];
  });
}

const docFiles = collectDocFiles(docsRoot);
const docSlugs = docFiles.map((file) => file.slice(0, -4).split(path.sep).join("/"));
const knownRoutes = new Set([
  "/",
  "/docs/",
  "/changelog/",
  ...docSlugs.map((slug) => `/docs/${slug}/`),
]);
const failures = [];

for (const file of docFiles) {
  const content = fs.readFileSync(path.join(docsRoot, file), "utf8");
  for (const match of content.matchAll(/\]\((\/[^)#?\s]+)(?:[#?][^)]*)?\)/g)) {
    const route = match[1].endsWith("/") || match[1].includes(".") ? match[1] : `${match[1]}/`;
    if (route.startsWith("/docs/") || route === "/changelog/" || route === "/") {
      if (!knownRoutes.has(route)) failures.push(`${file}: unknown internal route ${match[1]}`);
    }
  }
}

if (failures.length) {
  console.error(`Website link check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Website internal link check passed.");
}
