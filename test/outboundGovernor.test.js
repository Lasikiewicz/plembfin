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

test("interactive lane can admit a request while sync slots are occupied", async () => {
  resetOutboundGovernor();
  configureOutboundGovernor("standard");
  const syncReleases = await Promise.all(
    Array.from({ length: 4 }, () => acquireOutboundSlot("media.example.test", { lane: "sync" })),
  );

  const interactiveRelease = await acquireOutboundSlot("media.example.test", { lane: "interactive" });
  interactiveRelease();
  syncReleases.forEach((release) => release());
  resetOutboundGovernor();
});

test("queued interactive requests overtake queued sync work", async () => {
  resetOutboundGovernor();
  configureOutboundGovernor("fast");

  const heldReleases = await Promise.all(
    Array.from({ length: 10 }, () => acquireOutboundSlot("media.example.test", { lane: "interactive" })),
  );
  const syncRequest = acquireOutboundSlot("media.example.test", { lane: "sync" })
    .then((release) => ({ lane: "sync", release }));
  const interactiveRequest = acquireOutboundSlot("media.example.test", { lane: "interactive" })
    .then((release) => ({ lane: "interactive", release }));

  heldReleases[0]();
  const first = await Promise.race([syncRequest, interactiveRequest]);
  assert.equal(first.lane, "interactive");
  first.release();
  heldReleases.slice(1).forEach((release) => release());
  (await syncRequest).release();
  resetOutboundGovernor();
});
