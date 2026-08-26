import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { writeAuditLog } from "../db.js";
import {
  getOnboardingState,
  saveOnboardingState,
  completeOnboarding,
  restartOnboarding,
  CURRENT_ONBOARDING_VERSION,
} from "../utils/onboardingStore.js";
import { countTrackerItemStates, getTrackerConnection } from "../utils/trackerConnectionRepo.js";
import { countWatchHistoryRows, countWatchHistoryRowsBySource } from "../utils/dataRepo.js";
import { loadMediaConfig, publicMediaConfig, activeSyncOperation, loadRuntimeState } from "../utils/configStore.js";
import { tvdbBuiltInAvailable } from "../utils/tvdbGateway.js";
import { fanartBuiltInAvailable } from "../utils/fanartGateway.js";
import { startServerImport, cancelServerImport, startTraktImport, cancelTraktImport } from "../utils/onboardingImportCoordinator.js";

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];

function serverSummary(provider, config) {
  const section = config[provider] || {};
  const connection = section.connection || null;
  return {
    provider,
    connected: Boolean(connection),
    status: connection?.status || (section.configured ? "saved" : "not_configured"),
    serverName: connection?.serverName || "",
    baseUrl: section.baseUrl || "",
    remoteUsername: connection?.remoteUsername || "",
    tested: Boolean(connection?.lastValidatedAt),
  };
}

function checklistItems(state, { servers, trakt, tmdbConfigured, seerrConfigured, hasBackup, webhookAckCount }) {
  const items = [];
  if (!tmdbConfigured) items.push({ id: "connect_tmdb", label: "Connect TMDB", href: "/settings/metadata" });
  for (const server of servers) {
    if (server.connected && server.provider !== "plex" && !state.acknowledgements.webhooks?.[server.provider]) {
      items.push({ id: `webhooks_${server.provider}`, label: `Set up webhooks for ${server.serverName || server.provider}`, href: "/settings/webhooks" });
    }
    if (server.connected && state.backgroundImports.servers?.[server.provider]?.enabled === false) {
      items.push({ id: `import_${server.provider}`, label: `Import watched status from ${server.serverName || server.provider}`, href: "/settings/sync-tools" });
    }
  }
  if (!trakt.connected && (state.acknowledgements.traktSkipped || state.currentStep === "overview")) {
    items.push({ id: "connect_trakt", label: "Connect Trakt", href: "/settings/import" });
  }
  if (!seerrConfigured) items.push({ id: "configure_seerr", label: "Configure Seerr", href: "/settings/seerr" });
  if (!hasBackup) items.push({ id: "create_backup", label: "Create an encrypted backup", href: "/settings/backups" });
  items.push({ id: "store_credential_key", label: "Store your credential-vault key somewhere safe", href: "/settings/backups", dismissible: true });
  void webhookAckCount;
  return items;
}

export async function handleSetupStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const state = getOnboardingState();
  const config = publicMediaConfig(await loadMediaConfig({ resolveConnections: false }));
  const servers = MEDIA_SERVERS.map((provider) => serverSummary(provider, config));
  const traktConnection = getTrackerConnection("trakt");
  const trakt = {
    connected: Boolean(traktConnection && traktConnection.status === "connected"),
    username: traktConnection?.username || "",
    baselineComplete: Boolean(traktConnection?.baselineComplete),
  };
  const watchHistoryCount = await countWatchHistoryRows();
  const runtime = await loadRuntimeState();

  const items = checklistItems(state, {
    servers,
    trakt,
    tmdbConfigured: Boolean(config.tmdb?.configured),
    seerrConfigured: Boolean(config.seerr?.configured),
    hasBackup: false,
  });

  // A background import's itemCount is otherwise only as fresh as its last
  // in-process update - which for Trakt's reconcile pass can be long between
  // writes (see onboardingImportCoordinator.js), and even the per-item media-
  // server counter is an in-memory value a process restart would lose.
  // Report what's actually on file for anything still "importing" instead,
  // so the UI shows real, moving progress rather than a stale number.
  const traktImportState = state.backgroundImports.trakt;
  const serverImportStates = state.backgroundImports.servers || {};
  const liveServers = Object.fromEntries(
    Object.entries(serverImportStates).map(([provider, importState]) => [
      provider,
      importState?.status === "importing"
        ? { ...importState, itemCount: countWatchHistoryRowsBySource(provider) }
        : importState,
    ]),
  );
  const backgroundImports = {
    ...state.backgroundImports,
    servers: liveServers,
    trakt: traktImportState?.status === "importing"
      ? { ...traktImportState, itemCount: countTrackerItemStates("trakt") }
      : traktImportState,
  };

  return sendJson(res, {
    onboarding: {
      version: state.version,
      currentOnboardingVersion: CURRENT_ONBOARDING_VERSION,
      runState: state.runState,
      currentStep: state.currentStep,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      acknowledgements: state.acknowledgements,
      backgroundImports,
      pushSync: state.pushSync,
      checklistDismissedAt: state.checklistDismissedAt,
    },
    servers,
    trakt,
    metadata: {
      tmdbConfigured: Boolean(config.tmdb?.configured),
      builtInAvailable: { tvdb: tvdbBuiltInAvailable(), fanart: fanartBuiltInAvailable() },
    },
    watchHistoryCount,
    pushSyncAvailable: watchHistoryCount > 0 && servers.some((s) => s.tested),
    syncLocked: Boolean(activeSyncOperation(runtime)),
    checklist: state.checklistDismissedAt ? [] : items,
  });
}

export async function handleSetupStep(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const patch = {};
  if (body.currentStep) patch.currentStep = String(body.currentStep).slice(0, 64);
  if (body.webhookAck && typeof body.webhookAck === "object") {
    const state = getOnboardingState();
    const provider = String(body.webhookAck.provider || "").trim();
    if (provider) {
      patch.acknowledgements = {
        ...state.acknowledgements,
        webhooks: { ...state.acknowledgements.webhooks, [provider]: { acknowledgedAt: Date.now() } },
      };
    }
  }
  if (body.traktSkipped !== undefined) {
    const state = getOnboardingState();
    patch.acknowledgements = { ...(patch.acknowledgements || state.acknowledgements), traktSkipped: Boolean(body.traktSkipped) };
  }
  const next = saveOnboardingState(patch);
  return sendJson(res, { ok: true, onboarding: next });
}

export async function handleSetupImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  const principal = await requireAdmin(req, res);
  if (!principal) return;

  const body = await readJson(req).catch(() => ({}));
  const target = String(body.target || "").trim();
  const action = String(body.action || "").trim();
  if (!["start", "cancel"].includes(action)) return sendJson(res, { error: "action must be start or cancel", code: "VALIDATION_FAILED" }, 400);

  if (target === "trakt") {
    const result = action === "start" ? await startTraktImport() : cancelTraktImport();
    writeAuditLog(`onboarding.import.trakt.${action}`, { ip: req.ip || req.socket?.remoteAddress });
    if (result?.code === "SYNC_LOCKED") return sendJson(res, { error: "A sync operation is already running.", code: "SYNC_LOCKED", retryable: true }, 409);
    return sendJson(res, { ok: true, ...result });
  }
  if (MEDIA_SERVERS.includes(target)) {
    const result = action === "start" ? await startServerImport(target) : cancelServerImport(target);
    writeAuditLog(`onboarding.import.${target}.${action}`, { ip: req.ip || req.socket?.remoteAddress });
    if (result?.code === "SYNC_LOCKED") return sendJson(res, { error: "A sync operation is already running.", code: "SYNC_LOCKED", retryable: true }, 409);
    return sendJson(res, { ok: true, ...result });
  }
  return sendJson(res, { error: "target must be plex, emby, jellyfin, or trakt", code: "VALIDATION_FAILED" }, 400);
}

export async function handleSetupComplete(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const config = publicMediaConfig(await loadMediaConfig({ resolveConnections: false }));
  const hasTestedServer = MEDIA_SERVERS.some((provider) => serverSummary(provider, config).tested);
  if (!hasTestedServer) {
    return sendJson(res, { error: "Connect and test at least one media server before finishing setup.", code: "STEP_GATED", retryable: false }, 409);
  }

  const next = completeOnboarding();
  writeAuditLog("onboarding.completed", { ip: req.ip || req.socket?.remoteAddress });
  return sendJson(res, { ok: true, onboarding: next });
}

export async function handleSetupRestart(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const next = restartOnboarding();
  writeAuditLog("onboarding.restarted", { ip: req.ip || req.socket?.remoteAddress });
  return sendJson(res, { ok: true, onboarding: next });
}

export async function handleSetupChecklistDismiss(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const next = saveOnboardingState({ checklistDismissedAt: Date.now() });
  return sendJson(res, { ok: true, onboarding: next });
}
