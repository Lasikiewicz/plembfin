import test from "node:test";
import assert from "node:assert/strict";

import { createUpstreamTimeoutError } from "../server/src/utils/outbound.js";

test("upstream timeouts map to HTTP 504 errors", () => {
  const error = createUpstreamTimeoutError(2500);
  assert.equal(error.status, 504);
  assert.equal(error.code, "UPSTREAM_TIMEOUT");
  assert.match(error.message, /2500ms/);
});
