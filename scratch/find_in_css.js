import fs from "node:fs";

const css = fs.readFileSync("c:\\Github\\plembfin\\public\\styles.css", "utf8");
const lines = css.split("\n");
lines.forEach((line, index) => {
  if (line.includes("explorer-heading")) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
