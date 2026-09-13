import { loadLocalEnv } from "../server/src/env.js";

// Local checkouts are normally used to test the develop branch. Load .env first
// so an explicitly configured BUILD_CHANNEL still wins, then default the local
// launcher to the develop metadata instead of the bundled release metadata.
loadLocalEnv();
if (!String(process.env.BUILD_CHANNEL || "").trim()) {
  process.env.BUILD_CHANNEL = "develop";
}

await import("../server/server.js");
