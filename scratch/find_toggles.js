import fs from "node:fs";

const html = fs.readFileSync("c:\\Github\\plembfin\\public\\index.html", "utf8");
const lines = html.split("\n");
lines.forEach((line, index) => {
  if (line.includes("explorer-view-toggle")) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
