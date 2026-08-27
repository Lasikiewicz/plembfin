import { db } from "../db.js";

const SETTINGS_ID = "onboarding";

export const CURRENT_ONBOARDING_VERSION = 1;

const DEFAULT_STATE = {
  version: 0,
  accountClaimed: false,
  runState: "not_started",
  startedAt: null,
  completedAt: null,
  currentStep: "overview",
  acknowledgements: {
    webhooks: {},
    traktSkipped: false,
  },
  backgroundImports: {
    servers: {},
    trakt: {
      enabled: null,
      status: "not_started",
      startedAt: null,
      completedAt: null,
      itemCount: null,
      error: null,
    },
  },
  pushSync: {
    status: "not_started",
    startedAt: null,
    completedAt: null,
  },
  checklistDismissedAt: null,
  ctaDismissedAt: null,
};

const selectStmt = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertStmt = db.prepare(
  `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

function readRaw() {
  const row = selectStmt.get(SETTINGS_ID);
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function writeRaw(state) {
  upsertStmt.run(SETTINGS_ID, JSON.stringify(state), Date.now());
}

function mergeState(stored) {
  return {
    ...DEFAULT_STATE,
    ...stored,
    acknowledgements: { ...DEFAULT_STATE.acknowledgements, ...(stored?.acknowledgements || {}) },
    backgroundImports: {
      servers: { ...(stored?.backgroundImports?.servers || {}) },
      trakt: { ...DEFAULT_STATE.backgroundImports.trakt, ...(stored?.backgroundImports?.trakt || {}) },
    },
    pushSync: { ...DEFAULT_STATE.pushSync, ...(stored?.pushSync || {}) },
  };
}

export function getOnboardingState() {
  return mergeState(readRaw());
}

export function saveOnboardingState(patch = {}) {
  const next = mergeState({ ...readRaw(), ...patch });
  writeRaw(next);
  return next;
}

export function isAccountClaimed() {
  return getOnboardingState().accountClaimed === true;
}

// Atomically claims the account inside an IMMEDIATE transaction so concurrent
// claim requests can't both win: the loser observes accountClaimed already
// true within the same transaction and returns false without writing.
export function claimAccount() {
  const txn = db.transaction(() => {
    const state = mergeState(readRaw());
    if (state.accountClaimed) return false;
    const next = {
      ...state,
      accountClaimed: true,
      runState: "in_progress",
      startedAt: state.startedAt || Date.now(),
      currentStep: "overview",
    };
    writeRaw(next);
    return true;
  });
  return txn.immediate();
}

// Marks onboarding as already-complete for an upgraded/pre-existing install
// so it never sees the guided setup flow uninvited. Idempotent.
export function markPristineDetectionComplete() {
  const state = getOnboardingState();
  if (state.accountClaimed && state.runState === "completed") return state;
  return saveOnboardingState({
    accountClaimed: true,
    runState: "completed",
    version: CURRENT_ONBOARDING_VERSION,
    completedAt: state.completedAt || Date.now(),
  });
}

// Distinguishes a genuinely pristine install from an existing/upgraded one so
// upgraded installs never see the account-claim or guided-setup screens.
// Marks onboarding complete (and the account claimed) the first time any of
// these durable signals is found: in-app managed credentials, a media-server
// connection, watch history, or a configured metadata key beyond env
// defaults. Idempotent - safe to call on every boot.
export function detectAndMarkPristineInstall({ authManagedInApp = false } = {}) {
  const state = getOnboardingState();
  if (state.accountClaimed) return state;
  if (authManagedInApp) return markPristineDetectionComplete();

  const hasMediaConnection = Boolean(db.prepare("SELECT 1 FROM media_connections LIMIT 1").get());
  const hasWatchHistory = Boolean(db.prepare("SELECT 1 FROM watch_history LIMIT 1").get());

  let hasCustomMetadataKeys = false;
  const mediaConfigRow = db.prepare("SELECT data FROM settings WHERE id = 'mediaConfig'").get();
  if (mediaConfigRow?.data) {
    try {
      const stored = JSON.parse(mediaConfigRow.data);
      hasCustomMetadataKeys = Boolean(
        stored?.tmdb?.apiKey || stored?.fanart?.apiKey || stored?.tvdb?.apiKey || stored?.omdb?.apiKey,
      );
    } catch {
      // Malformed row - ignore rather than misclassify an install as pristine.
    }
  }

  if (hasMediaConnection || hasWatchHistory || hasCustomMetadataKeys) {
    return markPristineDetectionComplete();
  }
  return state;
}

export function completeOnboarding(patch = {}) {
  return saveOnboardingState({
    runState: "completed",
    completedAt: Date.now(),
    version: CURRENT_ONBOARDING_VERSION,
    ...patch,
  });
}

export function restartOnboarding() {
  return saveOnboardingState({
    runState: "in_progress",
    currentStep: "overview",
    acknowledgements: { webhooks: {}, traktSkipped: false },
    checklistDismissedAt: null,
    ctaDismissedAt: null,
  });
}
