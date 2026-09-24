// Stops whatever is listening on the local server port, starts `scripts/start-local.js` detached
// with its output in a log file, waits for /api/ping, and prints one status line.
//   node scripts/restart-server.js            restart (stop, then start)
//   node scripts/restart-server.js --if-down  reuse a server that already answers /api/ping
// Replaces ad-hoc stop/start/probe loops, which cost many agent tool calls.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5055;
const pingUrl = `http://localhost:${port}/api/ping`;
const logPath = path.join(os.tmpdir(), "plembfin-local-server.log");
const ifDown = process.argv.includes("--if-down");
const START_TIMEOUT_MS = 90_000;

async function ping() {
  try {
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function listeningPids() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === "TCP" && cols[1]?.endsWith(`:${port}`) && cols[3] === "LISTENING") pids.add(cols[4]);
      }
      return [...pids].filter((pid) => pid && pid !== "0");
    }
    const out = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function stop(pids) {
  for (const pid of pids) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
      else process.kill(Number(pid), "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logTail(lines = 15) {
  try {
    return fs.readFileSync(logPath, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "(no log output)";
  }
}

if (ifDown && (await ping())) {
  console.log(`Server already up on :${port} (reused). Log: ${logPath}`);
  process.exit(0);
}

const running = listeningPids();
if (running.length) {
  stop(running);
  for (let i = 0; i < 20 && listeningPids().length; i++) await sleep(250);
}

const logFd = fs.openSync(logPath, "w");
const child = spawn(process.execPath, [path.join(root, "scripts", "start-local.js")], {
  cwd: root,
  detached: true,
  stdio: ["ignore", logFd, logFd],
  windowsHide: true,
});
child.unref();

const started = Date.now();
while (Date.now() - started < START_TIMEOUT_MS) {
  if (child.exitCode !== null) break;
  if (await ping()) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const stopped = running.length ? `, stopped pid ${running.join(",")}` : "";
    console.log(`Server up on :${port} (pid ${child.pid}) in ${secs}s${stopped}. Log: ${logPath}`);
    process.exit(0);
  }
  await sleep(500);
}

console.error(`Server did not answer ${pingUrl} within ${START_TIMEOUT_MS / 1000}s. Last log lines (${logPath}):`);
console.error(logTail());
process.exit(1);
