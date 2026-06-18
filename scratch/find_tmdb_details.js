import fs from "node:fs";

const js = fs.readFileSync("c:\\Github\\plembfin\\public\\app.js", "utf8");
const lines = js.split("\n");
lines.forEach((line, index) => {
  if (line.includes("movie/tmdb") || line.includes("tvshow/tmdb") || line.includes("renderTmdbDetail") || line.includes("renderDetail")) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
