import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-diagnostic-logs-");
process.env.ROLE = "web";
const logger = await import("../server/src/utils/diagnosticLogger.js");

test("diagnostic logs redact secrets and clear across the shared store", async () => {
  console.log("diagnostic-test token=super-secret-value");
  const before = logger.getLogs({ limit: 20 });
  assert.ok(before.logs.some((line) => line.includes("diagnostic-test token=[redacted]")));
  assert.ok(before.logs.every((line) => !line.includes("super-secret-value")));
  await new Promise((resolve) => setTimeout(resolve, 2));
  logger.clearLogs();
  assert.equal(logger.getLogs({ limit: 20 }).logs.length, 0);
});
