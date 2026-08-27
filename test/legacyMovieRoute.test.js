import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { movieSearchFromRouteValue } = await import("../public/modules/media-detail.js");

test("legacy movie slugs remain usable as metadata search titles after unwatching", () => {
  assert.equal(movieSearchFromRouteValue("the-flash"), "the flash");
  assert.equal(movieSearchFromRouteValue("godzilla-x-kong-the-new-empire"), "godzilla x kong the new empire");
  assert.equal(movieSearchFromRouteValue("the-hunger-games-mockingjay-part-2"), "the hunger games mockingjay part 2");
});
