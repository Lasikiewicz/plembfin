import fs from "node:fs";
import path from "node:path";

const files = ["package.json", "package-lock.json", "changelog.json"];
files.forEach(f => {
  const p = path.resolve("c:\\Github\\plembfin", f);
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, "utf8");
    const matches = content.match(/"version":\s*"0.0.71"/g);
    console.log(`${f}: found ${matches ? matches.length : 0} match(es)`);
  } else {
    console.log(`${f} does not exist`);
  }
});
