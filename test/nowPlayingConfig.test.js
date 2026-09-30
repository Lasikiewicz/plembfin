import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };

const { normalizeNowPlayingSection, validateConfig, DEFAULT_NOW_PLAYING } = await import("../server/src/utils/configStore.js");
const { nowPlayingOptions } = await import("../public/modules/now-playing-options.js");

test("Now Playing options default to part watched and Up Next allowed, three items", () => {
  assert.deepEqual(DEFAULT_NOW_PLAYING, { allowPartWatched: true, allowUpNext: true, itemCount: 3 });
  assert.deepEqual(normalizeNowPlayingSection({}), { ...DEFAULT_NOW_PLAYING });
  assert.deepEqual(nowPlayingOptions({}), { ...DEFAULT_NOW_PLAYING });
});

test("Now Playing options keep saved flags and clamp the item count", () => {
  assert.deepEqual(
    normalizeNowPlayingSection({ allowPartWatched: false, allowUpNext: false, itemCount: 99 }),
    { allowPartWatched: false, allowUpNext: false, itemCount: 3 },
  );
  assert.equal(normalizeNowPlayingSection({ itemCount: 0 }).itemCount, 1);
  assert.equal(nowPlayingOptions({ nowPlaying: { itemCount: "2" } }).itemCount, 2);
});

test("Now Playing options ignore the retired idle and while-playing switches", () => {
  const saved = { showUpNextWhenIdle: false, showUpNextWhilePlaying: false, itemCount: 2 };
  assert.deepEqual(normalizeNowPlayingSection(saved), { allowPartWatched: true, allowUpNext: true, itemCount: 2 });
  assert.deepEqual(nowPlayingOptions({ nowPlaying: saved }), { allowPartWatched: true, allowUpNext: true, itemCount: 2 });
});

test("Now Playing config validation rejects bad values", () => {
  assert.deepEqual(validateConfig({ nowPlaying: { itemCount: 3, allowPartWatched: true } }), []);
  assert.equal(validateConfig({ nowPlaying: { itemCount: 0 } }).length, 1);
  assert.equal(validateConfig({ nowPlaying: { itemCount: 4 } }).length, 1);
  assert.equal(validateConfig({ nowPlaying: { allowUpNext: "yes" } }).length, 1);
});
