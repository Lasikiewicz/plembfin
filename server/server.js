import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { createStream } from "rotating-file-stream";
import { rateLimit } from "express-rate-limit";
import { setGlobalDispatcher, Agent } from "undici";
import { loadLocalEnv } from "./src/env.js";

loadLocalEnv();

const { createInstanceId, resolveProcessRole, roleHasWeb, roleHasWorker } = await import("./src/utils/processRole.js");
const ROLE = resolveProcessRole();
const INSTANCE_ID = createInstanceId(ROLE);
process.env.PLEMBFIN_INSTANCE_ID = INSTANCE_ID;
process.env.ROLE = ROLE;

const { DATA_DIR, PUBLIC_DIR, MEDIA_DIR, ensureDataDirs } = await import("./src/paths.js");
const { dispatch } = await import("./src/index.js");
const { db } = await import("./src/db.js");
const { enableTmdbMetadataWarmup } = await import("./src/utils/tmdbGateway.js");
const { clearRestoreSyncState, loadMediaConfig, loadRuntimeState, RESTORE_KIND_FULL_SYNC } = await import("./src/utils/configStore.js");
const { createCspImageOriginMemo, createResponseCompression, setPublicAssetCacheHeaders } = await import("./src/utils/httpPerformance.js");
const { recoverInterruptedBackgroundImports } = await import("./src/utils/onboardingStore.js");
const { schedulerLeaseStatus } = await import("./src/utils/schedulerLease.js");
const { createWorkerCoordinator } = await import("./src/workerCoordinator.js");
const { flushPending: flushDiagnosticLogs } = await import("./src/utils/diagnosticLogger.js");

ensureDataDirs();
enableTmdbMetadataWarmup();

if (roleHasWeb(ROLE)) {
  const recoveredImports = recoverInterruptedBackgroundImports();
  if (recoveredImports.recovered.length) {
    console.warn("Cancelled background imports interrupted by server restart", {
      providers: recoveredImports.recovered,
    });
  }
}

// Full Sync Watchstates is driven by browser requests, so it cannot survive a
// process restart. Clear only the tagged full-sync guard here; backup restores
// have their own kind and must remain protected across web-process startup.
if (roleHasWeb(ROLE)) {
  const runtime = await loadRuntimeState().catch(() => ({}));
  const restoreKind = String(runtime.restoreSyncKind || "");
  const legacyFullSync = runtime.restoreSyncActive === true
    && !restoreKind
    && /^[a-zA-Z0-9_-]{8,100}$/.test(String(runtime.restoreSyncRunId || ""));
  const interruptedRestore = (restoreKind === RESTORE_KIND_FULL_SYNC || legacyFullSync)
    ? await clearRestoreSyncState({
      ...(legacyFullSync ? {} : { expectedKind: RESTORE_KIND_FULL_SYNC }),
      reason: "Full Sync Watchstates was interrupted by a server restart.",
    }).catch(() => ({ reset: false }))
    : { reset: false };
  if (interruptedRestore.reset) {
    console.warn("Cleared interrupted Full Sync Watchstates restore after server restart", {
      runId: interruptedRestore.runId,
    });
  }
}

const LOGS_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
// Interval rotation only fires while a process stays alive across the boundary,
// so a restart-heavy install never rotated and access.log grew without limit.
// The size cap makes maxFiles effective regardless of uptime.
const accessLogStream = createStream(ROLE === "all" ? "access.log" : `access-${ROLE}-${process.pid}.log`, {
  interval: "1d",
  size: "10M",
  path: LOGS_DIR,
  maxFiles: 14,
});

// Keep upstream connections (Plex/Emby/Jellyfin/TMDB) warm.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 15000, connections: 64 }));

const PORT = Number(process.env.PORT || 5055);
const app = express();
app.disable("x-powered-by");
const mediaConfigRevisionStmt = db.prepare("SELECT updated_at FROM settings WHERE id = 'mediaConfig'");
const getCspImageOrigins = createCspImageOriginMemo({
  readRevision: () => Number(mediaConfigRevisionStmt.get()?.updated_at || 0),
  loadConfig: () => loadMediaConfig({ resolveConnections: false }),
});

function redactedUrl(req) {
  try {
    const url = new URL(req.originalUrl || req.url || "", "http://localhost");
    for (const key of [...url.searchParams.keys()]) {
      if (/token|api[_-]?key|secret|password|authorization/i.test(key)) url.searchParams.set(key, "redacted");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(req.originalUrl || req.url || "").replace(/([?&](?:token|api[_-]?key|secret|password|authorization)=)[^&\s"]+/gi, "$1redacted");
  }
}

morgan.token("safe-url", redactedUrl);
// Successful cached-artwork and static-asset hits dominate the access log by an
// order of magnitude and carry no diagnostic value. Failures still get logged.
const ACCESS_LOG_SKIP_PATHS = /^\/(?:media\/|modules\/|favicon|.*\.(?:css|js|png|jpe?g|svg|webp|ico|woff2?)$)/i;
// Front-end pollers that fire on a fixed timer for as long as a tab is open.
// They were the top three entries in the access log and say nothing useful
// about what the app did.
const ACCESS_LOG_SKIP_POLLS = new Set(["/api/ping", "/api/now-playing", "/api/diagnostic-logs"]);
function skipAccessLog(req, res) {
  if (res.statusCode >= 400) return false;
  const requestPath = String(req.path || req.url || "").split("?")[0];
  if (ACCESS_LOG_SKIP_POLLS.has(requestPath)) return true;
  return ACCESS_LOG_SKIP_PATHS.test(requestPath);
}
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"', { stream: accessLogStream, skip: skipAccessLog }));
app.use(cookieParser());

const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
if (!COOKIE_SECURE) {
  console.warn("[security] COOKIE_SECURE is not set - session cookies will not have the Secure flag. Set COOKIE_SECURE=true when running behind HTTPS.");
}

// HTTP security headers.
app.use(async (_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (COOKIE_SECURE) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  let extraImgSrc = "";
  try {
    const origins = await getCspImageOrigins();
    if (origins.length) {
      extraImgSrc = " " + [...new Set(origins)].join(" ");
    }
  } catch {
    // Fail-safe: ignore configuration errors
  }

  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; img-src 'self' data: blob: https://image.tmdb.org https://img.youtube.com https://assets.fanart.tv https://fanart.tv https://artworks.thetvdb.com https://thetvdb.com${extraImgSrc}; ` +
    "script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; " +
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com;"
  );
  next();
});

// Compress ordinary HTTP responses in the app when a self-hosted deployment
// has no compressing proxy. The live update stream opts out explicitly; its
// no-transform cache directive remains a second independent safeguard.
app.use(createResponseCompression());

// Rate limiting - applied before any route handler.
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use("/api/webhook", rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));
app.use("/api/tmdb-poster", rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use("/api/tmdb-profile", rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
// Interactive provider flows poll read-only status endpoints every two seconds.
// Do not charge those reads to the mutation budget: a normal authorization
// lasting two minutes would otherwise consume all 60 requests and block the
// next start/login attempt with 429. The general API limiter still bounds reads.
const providerMutationLimiter = () => rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});
app.use("/api/media-auth", providerMutationLimiter());
app.use("/api/media-connections", providerMutationLimiter());
app.use("/api/tracker-auth", providerMutationLimiter());
app.use("/api/tracker-connections", providerMutationLimiter());
// Destructive/expensive admin actions - several of these paths also serve a
// cheap GET status/poll (e.g. force-sync progress), so only the mutating
// request is throttled; GET/HEAD/OPTIONS pass through untouched.
app.use([
  "/api/delete-media",
  "/api/backup/import",
  "/api/watch-backups",
  "/api/plembfin-backups",
  "/api/force-sync",
  "/api/cron-sync",
  "/api/auth/credentials",
  "/api/full-sync-watchstates",
  "/api/merge-shows",
  "/api/admin-backfill-trakt",
  "/api/admin-fix-history",
  "/api/clear-cache",
], rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
}));
// General API limiter - generous ceiling so the poster-heavy dashboard/explorer is never
// throttled in normal use, while still capping abusive bursts. Applied after the tighter
// per-route limiters above so those still take precedence for their paths.
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 1200, standardHeaders: true, legacyHeaders: false }));
// Static asset / SPA fallback limiter - high ceiling, just bounds runaway requests.
app.use(rateLimit({ windowMs: 60 * 1000, max: 2000, standardHeaders: true, legacyHeaders: false }));

// Capture the raw request body for /api so webhook/JSON handlers can parse it
// themselves (multipart via busboy, JSON via readJson). express.raw sets
// req.body to a Buffer, which the requestBody helpers already understand.
app.all("/api/*path", express.raw({ type: "*/*", limit: "15mb" }), (req, res) => {
  Promise.resolve(dispatch(req, res)).catch((error) => {
    console.error("Unhandled API error", error);
    if (res.headersSent) return;
    // Deliberate client errors (e.g. readJson's 400 for a malformed body) keep
    // their status and message; anything unexpected returns a generic 500 so
    // internal details never reach the client. Handlers return promises that
    // dispatch() does not await, so their rejections surface here, not in
    // dispatch()'s own catch.
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(status).json({ error: error.message || "Request failed" });
      return;
    }
    res.status(500).json({ error: "Internal error" });
  });
});

// Locally cached posters/backdrops.
app.use("/media", express.static(MEDIA_DIR, { maxAge: "365d", immutable: true }));
// Bundled app and source icons.
app.use("/icons", express.static(path.join(PUBLIC_DIR, "icons"), { maxAge: "7d" }));

app.get("/changelog.json", (_req, res) => {
  res.sendFile(path.resolve(PUBLIC_DIR, "..", "changelog.json"));
});

app.get("/auth/plex/return", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plex connected</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    background: #05080c;
    color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Outfit, Arial, sans-serif;
  }
  main {
    display: grid;
    justify-items: center;
    gap: 14px;
    max-width: 26rem;
    padding: 2.5rem 2rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    background: rgba(18, 22, 28, 0.55);
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 50%;
    background: color-mix(in srgb, #10b981, transparent 85%);
    color: #10b981;
  }
  .icon svg { width: 1.75rem; height: 1.75rem; }
  h1 { margin: 0; font-size: 1.25rem; }
  p { margin: 0; color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
  .closing { font-size: 0.85rem; color: #64748b; }
</style>
</head>
<body>
<main>
  <div class="icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
  </div>
  <h1>Plex connected</h1>
  <p>Plembfin is verifying the connection in the original tab.</p>
  <p class="closing">You may close this tab.</p>
</main>
</body>
</html>`);
});

// Health check - must be above the SPA fallback.
app.all(["/health", "/health/"], (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).set("Allow", "GET, HEAD").json({ error: "Method not allowed" });
  }
  const now = Date.now();
  const lease = schedulerLeaseStatus(now);
  res.json({
    ok: true,
    ts: now,
    role: ROLE,
    database: { ok: true },
    worker: {
      available: lease.available,
      leader: lease.available && lease.holderId === INSTANCE_ID,
      heartbeatAgeMs: lease.heartbeatAt ? Math.max(0, now - lease.heartbeatAt) : null,
      lastTickAgeMs: lease.lastTickAt ? Math.max(0, now - lease.lastTickAt) : null,
    },
  });
});

// Static SPA assets, then SPA fallback to index.html for client-side routes.
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], setHeaders: setPublicAssetCacheHeaders }));
app.get("/*name", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ROLE=web omits this coordinator; ROLE=all preserves the default combined process.
const coordinator = roleHasWorker(ROLE) ? createWorkerCoordinator({ holderId: INSTANCE_ID, role: ROLE }) : null;
const server = roleHasWeb(ROLE) ? app.listen(PORT) : null;

server?.on("listening", async () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`plembfin listening on http://localhost:${listeningPort}`);
  if (process.env.PLEMBFIN_BUILD_CHECK === "1") {
    server.close((error) => {
      if (error) {
        console.error("Build-check shutdown failed", error);
        process.exitCode = 1;
      }
    });
    return;
  }
  await coordinator?.start().catch((error) => console.error("Failed to start worker coordinator", error));
});

server?.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing Plembfin process or set PORT to another value.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received - shutting down gracefully`);
  const timer = setTimeout(() => {
    console.error("Graceful shutdown timed out - forcing exit");
    process.exit(1);
  }, 5000);
  timer.unref();
  await coordinator?.stop().catch((error) => console.error("Worker shutdown failed", error));
  const finish = () => {
    // Persist buffered diagnostics while the database is still open.
    try { flushDiagnosticLogs(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  if (server) server.close(finish);
  else finish();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (!server) {
  console.log(`plembfin worker started (role=${ROLE})`);
  await coordinator.start();
}
