import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "../public/modules/media-detail-shared.js"),
  "utf8",
);

// A first visit to a title issued 78 API requests, 49 of them per-image
// proxies: 30 cast headshots and 19 rail posters, every one of them below the
// fold and fetched eagerly. That burst is what the page's genuinely slow
// provider calls queued behind - a 9ms endpoint took 2,089ms during it.

function imgTags(className) {
  return source.match(new RegExp(`<img class="${className}"[^>]*>`, "g")) || [];
}

test("every cast avatar is lazy-loaded", () => {
  const tags = imgTags("cast-avatar-img");
  assert.ok(tags.length > 0, "expected at least one cast avatar tag");
  for (const tag of tags) assert.match(tag, /loading="lazy"/, `eager cast image: ${tag.slice(0, 90)}`);
});

test("every rail poster is lazy-loaded", () => {
  const tags = imgTags("season-poster-img");
  assert.ok(tags.length >= 3, `expected the related/recommendation/images rails, found ${tags.length}`);
  for (const tag of tags) assert.match(tag, /loading="lazy"/, `eager rail poster: ${tag.slice(0, 90)}`);
});

test("lazy images decode off the main thread", () => {
  for (const className of ["cast-avatar-img", "season-poster-img"]) {
    for (const tag of imgTags(className)) {
      assert.match(tag, /decoding="async"/, `blocking decode: ${tag.slice(0, 90)}`);
    }
  }
});

test("the app-link pills stay eager", () => {
  // These are tiny, always above the fold, and part of the first paint of the
  // Watch Now row - deferring them would make the page look unfinished.
  const tags = source.match(/<img class="[^"]*media-app-link-logo"[^>]*>/g) || [];
  assert.ok(tags.length > 0, "expected app-link logo tags");
  for (const tag of tags) assert.match(tag, /loading="eager"/, `app-link logo should stay eager: ${tag.slice(0, 90)}`);
});

test("no media-detail image is left without an explicit loading strategy", () => {
  const allImgs = source.match(/<img [^>]*>/g) || [];
  const missing = allImgs.filter((tag) => !/loading="(lazy|eager)"/.test(tag));
  assert.deepEqual(missing, [], `images with no loading attribute:\n${missing.join("\n")}`);
});
