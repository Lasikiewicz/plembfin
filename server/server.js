import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { setGlobalDispatcher, Agent } from "undici";
import { loadLocalEnv } from "./src/env.js";

loadLocalEnv();

const { PUBLIC_DIR, MEDIA_DIR, ensureDataDirs } = await import("./src/paths.js");
const { dispatch, runScheduledTick } = await import("./src/index.js");

ensureDataDirs();

// Keep upstream connections (Plex/Emby/Jellyfin/TMDB) warm.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 15000, connections: 64 }));

const PORT = Number(process.env.PORT || 5055);
const app = express();
app.disable("x-powered-by");
app.use(cookieParser());

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
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing Plembfin process or set PORT to another value.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});
