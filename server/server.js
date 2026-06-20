import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { setGlobalDispatcher, Agent } from "undici";
import { loadLocalEnv } from "./src/env.js";

loadLocalEnv();

const { PUBLIC_DIR, MEDIA_DIR, ensureDataDirs } = await import("./src/paths.js");
const { dispatch, runScheduledTick, startPlexNotificationListener } = await import("./src/index.js");

ensureDataDirs();

// Keep upstream connections (Plex/Emby/Jellyfin/TMDB) warm.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 15000, connections: 64 }));

const PORT = Number(process.env.PORT || 5055);
const app = express();
app.disable("x-powered-by");
app.use(cookieParser());

// HTTP security headers.
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https:; " +
    "script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';"
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
app.all("/api/*", express.raw({ type: "*/*", limit: "15mb" }), (req, res) => {
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

// Static SPA assets, then SPA fallback to index.html for client-side routes.
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.get("*", (req, res) => {
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
