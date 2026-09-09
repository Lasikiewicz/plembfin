import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const astroCli = path.join(websiteRoot, "node_modules", "astro", "astro.js");
const result = spawnSync(process.execPath, [astroCli, ...process.argv.slice(2)], {
  cwd: websiteRoot,
  env: {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: "1",
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
