import { getDataVersion } from "../db.js";
import { requireAdmin } from "../utils/auth.js";
import { methodNotAllowed } from "../utils/http.js";

const VERSION_CHECK_MS = 250;
const HEARTBEAT_MS = 15_000;

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Streams the shared SQLite history version rather than relying on an
// in-process event emitter. This keeps browser updates working when Plembfin's
// web and scheduler roles run in separate processes.
export async function handleLiveUpdates(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let lastVersion = getDataVersion();
  let lastWriteAt = Date.now();
  writeEvent(res, { type: "ready", version: lastVersion });

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    const version = getDataVersion();
    if (version !== lastVersion) {
      lastVersion = version;
      lastWriteAt = Date.now();
      writeEvent(res, { type: "history-version", version });
      return;
    }
    if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
      lastWriteAt = Date.now();
      res.write(": heartbeat\n\n");
    }
  }, VERSION_CHECK_MS);
  timer.unref?.();

  const close = () => clearInterval(timer);
  req.once("close", close);
  res.once("close", close);
}
