import test from "node:test";
import assert from "node:assert/strict";
import { acquireOutboundSlot, configureOutboundGovernor, noteOutboundResponse, outboundGovernorTelemetry, resetOutboundGovernor } from "../server/src/utils/outboundGovernor.js";

test("outbound governor records host-only throttling telemetry", async () => {
  resetOutboundGovernor();
  configureOutboundGovernor("fast");
  const release = await acquireOutboundSlot("media.example.test", { lane: "sync" });
  release();
  noteOutboundResponse("media.example.test", 429, "2");
  const destination = outboundGovernorTelemetry().destinations[0];
  assert.equal(destination.host, "media.example.test");
  assert.equal(destination.throttled, 1);
  assert.equal(destination.cooldowns, 1);
  resetOutboundGovernor();
});
