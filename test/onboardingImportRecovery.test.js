import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-onboarding-import-recovery-");

const { getOnboardingState, recoverInterruptedBackgroundImports, saveOnboardingState } = await import("../server/src/utils/onboardingStore.js");
const { startServerImport, startTraktImport } = await import("../server/src/utils/onboardingImportCoordinator.js");

const originalState = getOnboardingState();

test("startup recovery cancels persisted background imports without touching completed imports", () => {
  const startedAt = Date.now() - 1_000;
  saveOnboardingState({
    runState: "completed",
    backgroundImports: {
      servers: {
        plex: { enabled: true, status: "importing", startedAt, itemCount: 12 },
        emby: { enabled: true, status: "complete", startedAt, completedAt: startedAt + 100, itemCount: 24 },
      },
      trakt: { enabled: true, status: "importing", startedAt, itemCount: 7042 },
    },
  });

  try {
    const result = recoverInterruptedBackgroundImports();
    assert.deepEqual(result.recovered.sort(), ["plex", "trakt"]);

    const state = getOnboardingState();
    for (const provider of ["plex", "trakt"]) {
      const entry = provider === "trakt" ? state.backgroundImports.trakt : state.backgroundImports.servers[provider];
      assert.equal(entry.enabled, false);
      assert.equal(entry.status, "cancelled");
      assert.equal(entry.itemCount, provider === "trakt" ? 7042 : 12);
      assert.match(entry.error, /server restart/);
    }
    assert.equal(state.backgroundImports.servers.emby.status, "complete");
    assert.deepEqual(recoverInterruptedBackgroundImports().recovered, []);
  } finally {
    saveOnboardingState(originalState);
  }
});

test("completed onboarding cannot start an onboarding background import", async () => {
  saveOnboardingState({ runState: "completed" });

  try {
    assert.deepEqual(await startTraktImport(), { started: false, code: "ONBOARDING_COMPLETE" });
    assert.deepEqual(await startServerImport("plex"), { started: false, code: "ONBOARDING_COMPLETE" });
  } finally {
    saveOnboardingState(originalState);
  }
});
