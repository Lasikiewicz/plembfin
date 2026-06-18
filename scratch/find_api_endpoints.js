import fs from "node:fs";

const content = fs.readFileSync("c:\\Github\\plembfin\\server\\src\\index.js", "utf8");
const lines = content.split("\n");
lines.forEach((line, index) => {
  if (line.includes("handleConfig") || line.includes("handleTestConnection") || line.includes("test-connection")) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
