import test from "node:test";
import assert from "node:assert/strict";
import { canReceiveState, canSendState, conflictAuthority, normalizeSyncRoles, syncRolesRevision } from "../server/src/utils/syncRoles.js";

test("sync role presets preserve bidirectional defaults and enforce monitor mode", () => {
  assert.equal(canSendState({}, "plex", "watched"), true);
  assert.equal(canReceiveState({}, "plex", "watched"), true);
  const config = { plex: { sync: { preset: "monitor" } } };
  assert.equal(normalizeSyncRoles(config.plex.sync).preset, "monitor");
  assert.equal(canSendState(config, "plex", "watched"), false);
  assert.equal(canReceiveState(config, "plex", "watched"), false);
});

test("authority policy falls back safely without a selected server", () => {
  assert.deepEqual(conflictAuthority({ authority: { conflictPolicy: "server" } }), { conflictPolicy: "newest_timestamp", server: "" });
  assert.notEqual(syncRolesRevision({}), syncRolesRevision({ plex: { sync: { preset: "source_only" } } }));
});
