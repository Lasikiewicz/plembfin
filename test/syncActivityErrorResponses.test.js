import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-sync-activity-errors-");
process.env.API_KEY = "sync-activity-error-test-api-key-1234567890";

const { handleRetrySyncActivityGroup } = await import("../server/src/routes/sync.js");

function request(body) {
  return {
    method: "POST",
    body,
    get(name) {
      return String(name).toLowerCase() === "x-api-key" ? process.env.API_KEY : "";
    },
  };
}

function responseCapture() {
  const capture = { status: null, body: null };
  const response = {
    status(status) {
      capture.status = status;
      return response;
    },
    set() {
      return response;
    },
    send(body) {
      capture.body = JSON.parse(body);
      return response;
    },
  };
  return { capture, response };
}

test("retrying a missing sync activity group returns a safe public error", async () => {
  const { capture, response } = responseCapture();

  await handleRetrySyncActivityGroup(request({ groupKey: "missing-sync-activity-group" }), response);

  assert.equal(capture.status, 404);
  assert.deepEqual(capture.body, { ok: false, error: "Sync activity group not found" });
});
