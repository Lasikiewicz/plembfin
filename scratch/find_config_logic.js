import fs from "node:fs";

const content = fs.readFileSync("c:\\Github\\plembfin\\server\\src\\utils\\configStore.js", "utf8");
const lines = content.split("\n");
lines.forEach((line, index) => {
  if (line.includes("validateConfig") || line.includes("loadMediaConfig") || line.includes("publicMediaConfig")) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
