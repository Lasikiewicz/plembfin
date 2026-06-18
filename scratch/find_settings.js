import fs from "node:fs";

const html = fs.readFileSync("c:\\Github\\plembfin\\public\\index.html", "utf8");
const lines = html.split("\n");
lines.forEach((line, index) => {
  if (line.includes("settings-pane") || line.includes("data-settings-panel")) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
