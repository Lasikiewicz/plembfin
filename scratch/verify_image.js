import sharp from "sharp";
import path from "node:path";

const files = [
  "90f05716d28b83145a03fbf1c177b544ed0fd697.webp",
  "9ffb6e694fdb74745008bfacbd230c5490c4223d.webp"
];

for (const file of files) {
  const p = path.join("c:\\Github\\plembfin\\data\\media\\posters", file);
  console.log(`\n=== Verifying: ${file} ===`);
  try {
    const meta = await sharp(p).metadata();
    console.log("Image metadata:", meta);
  } catch (error) {
    console.error("Corrupted/Invalid WebP file! Error:", error.message);
  }
}
