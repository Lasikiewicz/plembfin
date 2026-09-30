import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };

const { normalizeNowPlayingSection, validateConfig, DEFAULT_NOW_PLAYING } = await import("../server/src/utils/configStore.js");
const { nowPlayingOptions } = await import("../public/modules/now-playing-options.js");

test("Now Playing options default to Up Next when idle and after sessions, three items", () => {
  assert.deepEqual(normalizeNowPlayingSection({}), { ...DEFAULT_NOW_PLAYING });
  assert.deepEqual(nowPlayingOptions({}), { ...DEFAULT_NOW_PLAYING });
});

test("Now Playing options keep saved flags and clamp the item count", () => {
  assert.deepEqual(
    normalizeNowPlayingSection({ showUpNextWhenIdle: false, showUpNextWhilePlaying: false, itemCount: 99 }),
    { showUpNextWhenIdle: false, showUpNextWhilePlaying: false, itemCount: 3 },
  );
  assert.equal(normalizeNowPlayingSection({ itemCount: 0 }).itemCount, 1);
  assert.equal(nowPlayingOptions({ nowPlaying: { itemCount: "2" } }).itemCount, 2);
});

test("Now Playing config validation rejects bad values", () => {
  assert.deepEqual(validateConfig({ nowPlaying: { itemCount: 3, showUpNextWhenIdle: true } }), []);
  assert.equal(validateConfig({ nowPlaying: { itemCount: 0 } }).length, 1);
  assert.equal(validateConfig({ nowPlaying: { itemCount: 4 } }).length, 1);
  assert.equal(validateConfig({ nowPlaying: { showUpNextWhilePlaying: "yes" } }).length, 1);
});
