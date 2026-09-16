import { loadLocalEnv } from "../server/src/env.js";

// Local checkouts are normally used to test the develop branch. Load .env first
// so an explicitly configured BUILD_CHANNEL still wins, then default the local
// launcher to the develop metadata instead of the bundled release metadata.
loadLocalEnv();
if (!String(process.env.BUILD_CHANNEL || "").trim()) {
  process.env.BUILD_CHANNEL = "develop";
}
if (!String(process.env.PLEMBFIN_DEV_NO_CACHE_ASSETS || "").trim()) {
  process.env.PLEMBFIN_DEV_NO_CACHE_ASSETS = "1";
}

await import("../server/server.js");
