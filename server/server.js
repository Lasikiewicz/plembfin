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

const { DATA_DIR, PUBLIC_DIR, MEDIA_DIR, ensureDataDirs } = await import("./src/paths.js");
const { dispatch, runScheduledTick, startPlexNotificationListener, stopPlexNotificationListener, backfillUnknownShowTitles } = await import("./src/index.js");
const { db } = await import("./src/db.js");

ensureDataDirs();
const LOGS_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const accessLogStream = createStream("access.log", {
  interval: "1d",
  path: LOGS_DIR,
  maxFiles: 14,
});

// Keep upstream connections (Plex/Emby/Jellyfin/TMDB) warm.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 15000, connections: 64 }));

const PORT = Number(process.env.PORT || 5055);
const app = express();
app.disable("x-powered-by");

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
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"', { stream: accessLogStream }));
app.use(cookieParser());

const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
if (!COOKIE_SECURE) {
  console.warn("[security] COOKIE_SECURE is not set — session cookies will not have the Secure flag. Set COOKIE_SECURE=true when running behind HTTPS.");
}

// HTTP security headers.
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (COOKIE_SECURE) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https://image.tmdb.org https://img.youtube.com https://assets.fanart.tv https://fanart.tv; " +
    "script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; " +
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com;"
  );
  next();
});

// Rate limiting — applied before any route handler.
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use("/api/webhook", rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));
app.use("/api/tmdb-poster", rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use("/api/tmdb-profile", rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Capture the raw request body for /api so webhook/JSON handlers can parse it
// themselves (multipart via busboy, JSON via readJson). express.raw sets
// req.body to a Buffer, which the requestBody helpers already understand.
app.all("/api/*path", express.raw({ type: "*/*", limit: "15mb" }), (req, res) => {
  Promise.resolve(dispatch(req, res)).catch((error) => {
    console.error("Unhandled API error", error);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  });
});

// Locally cached posters/backdrops.
app.use("/media", express.static(MEDIA_DIR, { maxAge: "365d", immutable: true }));

app.get("/changelog.json", (_req, res) => {
  res.sendFile(path.resolve(PUBLIC_DIR, "..", "changelog.json"));
});

// Health check — must be above the SPA fallback.
app.all(["/health", "/health/"], (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).set("Allow", "GET, HEAD").json({ error: "Method not allowed" });
  }
  res.json({ ok: true, ts: Date.now() });
});

// Static SPA assets, then SPA fallback to index.html for client-side routes.
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.get("/*name", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// In-process scheduler — replaces the per-minute scheduledSync Cloud Function.
let tickRunning = false;
async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await runScheduledTick();
  } catch (error) {
    console.error("Scheduled tick failed", error);
  } finally {
    tickRunning = false;
  }
}

const server = app.listen(PORT);

server.on("listening", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`plembfinfire listening on http://localhost:${listeningPort}`);
  if (process.env.PLEMBFIN_BUILD_CHECK === "1") {
    server.close((error) => {
      if (error) {
        console.error("Build-check shutdown failed", error);
        process.exitCode = 1;
      }
    });
    return;
  }
  // Fix any episodes stored with "Unknown Show" title when a better title is now known.
  backfillUnknownShowTitles().catch((err) => console.error("backfillUnknownShowTitles failed", err));
  // Kick once shortly after boot, then every minute.
  setTimeout(tick, 10_000);
  setInterval(tick, 60_000);
  // Connect the Plex real-time notification listener for event-driven unwatch detection.
  startPlexNotificationListener();
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing Plembfin process or set PORT to another value.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  const timer = setTimeout(() => {
    console.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 5000);
  timer.unref();
  stopPlexNotificationListener();
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
