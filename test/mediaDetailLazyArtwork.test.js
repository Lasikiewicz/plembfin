import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "../public/modules/media-detail-shared.js"),
  "utf8",
);
const castSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../public/modules/cast-disclosure.js"),
  "utf8",
);

// A first visit to a title issued dozens of per-image proxy requests. Cast
// avatars remain lazy and the first eight are visible immediately; the rest
// sit behind an in-rail "show more" card so a long credits list does not turn
// the page's slow provider calls into an image-request burst.

function imgTags(className, input = source) {
  return input.match(new RegExp(`<img class="${className}"[^>]*>`, "g")) || [];
}

test("every cast avatar is lazy-loaded", () => {
  const tags = imgTags("cast-avatar-img", castSource);
  assert.ok(tags.length > 0, "expected at least one cast avatar tag");
  for (const tag of tags) assert.match(tag, /loading="lazy"/, `eager cast image: ${tag.slice(0, 90)}`);
});

test("long cast lists defer the extra avatars behind an in-rail card", () => {
  assert.match(source, /const visibleCast = cast\.slice\(0, 8\)/);
  assert.match(source, /<button class="cast-more-card" type="button" data-cast-more-trigger/);
  assert.match(source, /<span class="cast-more-card-image"/);
  assert.match(source, /<span class="cast-actor-name">Show more cast<\/span>/);
  assert.match(source, /<span class="cast-character-name">\$\{deferredCast\.length\} more<\/span>/);
  assert.match(castSource, /export function hydrateDeferredCastDisclosure/);
  assert.match(castSource, /trigger\.insertAdjacentHTML\("afterend", cast\.map\(renderCastActor\)\.join\(""\)\)/);
});

test("revealing more cast moves keyboard focus to the first revealed actor", () => {
  const body = castSource.match(/export function hydrateDeferredCastDisclosure[\s\S]*?\n}/)?.[0] || "";
  assert.match(body, /const firstRevealed = trigger\.nextElementSibling;/);
  assert.match(body, /const hadFocus = trigger === document\.activeElement;/);
  assert.match(body, /firstRevealed\.focus\(\)/);
});

test("rail artwork waits for its rail to be reached instead of native lazy loading alone", () => {
  // Native lazy loading fetched every card in a horizontally scrolling rail
  // within ~1,250 px, so a detail page requested dozens of unseen images.
  for (const className of ["season-poster-img", "media-image-thumb"]) {
    for (const tag of source.match(new RegExp(`<img class="${className}"[^>]*>`, "g")) || []) {
      assert.match(tag, /data-rail-src="/, `rail image loads eagerly: ${tag.slice(0, 90)}`);
      assert.doesNotMatch(tag, /\ssrc="/, `rail image has an eager src: ${tag.slice(0, 90)}`);
    }
  }
  const railRows = source.match(/<div class="(?:horizontal-scroll-row|media-images-scroll-row)"[^>]*>/g) || [];
  assert.ok(railRows.length >= 4, "expected the related, recommendation, images, and collection rails");
  for (const row of railRows) assert.match(row, /\$\{deferredRailAttribute\(\)\}/);
  assert.match(source, /new IntersectionObserver\([\s\S]*?rootMargin: RAIL_VIEWPORT_MARGIN/);
});

test("rail image promotion accepts only HTTP(S) URLs", () => {
  assert.match(source, /function safeRailImageUrl\(value\)/);
  assert.match(source, /new URL\(raw, document\.baseURI\)/);
  assert.match(source, /url\.protocol !== "http:" && url\.protocol !== "https:"/);
  assert.match(source, /const safeSrc = safeRailImageUrl\(src\)/);
});

test("every rail poster is lazy-loaded", () => {
  const tags = imgTags("season-poster-img");
  assert.ok(tags.length >= 3, `expected the related/recommendation/images rails, found ${tags.length}`);
  for (const tag of tags) assert.match(tag, /loading="lazy"/, `eager rail poster: ${tag.slice(0, 90)}`);
});

test("lazy images decode off the main thread", () => {
  for (const [className, input] of [["cast-avatar-img", castSource], ["season-poster-img", source]]) {
    for (const tag of imgTags(className, input)) {
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
