import { WebSocket } from "undici";

// Plex Media Server pushes real-time notifications over a WebSocket at
// `/:/websockets/notifications`. Unlike the webhook (which only fires for playback
// events), this stream carries `timeline` notifications whenever a library item's
// state changes — including when an item is marked watched/unwatched in any Plex client.
// We use it to detect unwatch events the webhook can never deliver, then verify the
// actual view state with a targeted metadata lookup before propagating.
//
// This module is pure transport: it connects, reconnects with backoff, filters timeline
// entries down to movies/episodes, debounces per ratingKey, and hands each changed
// ratingKey to `onLibraryItemChange`. All DB/config/propagation logic lives in the caller.
//
// Reverse proxies in front of Plex (Cloudflare, nginx, Traefik, etc.) commonly drop an
// idle WebSocket after a timeout without ever sending a close frame — the socket then
// looks open to us forever but never delivers another message. undici's WebSocket only
// exposes the plain browser surface (no ping/pong control), so there's no way to probe
// liveness directly. Instead an idle watchdog forces a reconnect if no frame has arrived
// within IDLE_WATCHDOG_MS, which self-heals a silently-dead connection.

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const DEBOUNCE_MS = 2500;
const IDLE_WATCHDOG_MS = 5 * 60 * 1000;
const WATCHDOG_CHECK_INTERVAL_MS = 30_000;

// Plex TimelineEntry.type: 1 = movie, 2 = show, 3 = season, 4 = episode.
const WATCHABLE_TIMELINE_TYPES = new Set([1, 4]);
const LIBRARY_IDENTIFIER = "com.plexapp.plugins.library";

function buildNotificationsUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/:/websockets/notifications";
  url.search = "";
  // Unlike the HTTP clients (which send X-Plex-Token as a header), the token must
  // stay in the URL here: the WebSocket handshake API offers no way to set custom
  // headers, and Plex's notification socket only reads the query parameter.
  url.searchParams.set("X-Plex-Token", token);
  return url.toString();
}

// One-shot connectivity probe used by the System Integrity Check. Opens the notification
// socket exactly the way the listener does and resolves as soon as it connects — proving
// the full path works end to end (including any reverse proxy / Cloudflare WebSocket
// upgrade in front of Plex). Never throws; always resolves to a result object.
export async function probePlexNotificationSocket({ baseUrl, token, timeoutMs = 8000 } = {}) {
  if (!baseUrl || !token) {
    return { ok: false, error: "Plex URL or token not provided" };
  }

  let wsUrl;
  try {
    wsUrl = buildNotificationsUrl(baseUrl, token);
  } catch (error) {
    return { ok: false, error: `Invalid Plex URL: ${error?.message || error}` };
  }

  const started = Date.now();
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    return { ok: false, error: `Failed to open socket: ${error?.message || error}` };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.onopen = ws.onerror = ws.onclose = null;
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `Timed out after ${timeoutMs}ms (no WebSocket upgrade — check reverse proxy)` }),
      timeoutMs,
    );

    ws.onopen = () => finish({ ok: true, elapsedMs: Date.now() - started });
    ws.onerror = (event) =>
      finish({ ok: false, error: event?.error?.message || event?.message || "WebSocket connection failed" });
    ws.onclose = (event) =>
      finish({ ok: false, error: `Socket closed before connecting${event?.code ? ` (code ${event.code})` : ""}` });
  });
}

function decodeFrame(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  try {
    return Buffer.from(data).toString("utf8");
  } catch {
    return "";
  }
}

export function createPlexNotificationListener({ getPlexConfig, onLibraryItemChange, logger = console.log }) {
  let socket = null;
  let stopped = true;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let attempt = 0;
  let lastActivityAt = 0;
  const pending = new Map(); // ratingKey -> debounce timeout

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (stopped || !socket) return;
      if (Date.now() - lastActivityAt > IDLE_WATCHDOG_MS) {
        logger(`Plex notifications: no activity for ${Math.round(IDLE_WATCHDOG_MS / 1000)}s, recycling the connection (a reverse proxy may have silently dropped it)`);
        attempt = 0;
        closeSocket();
        connect();
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function closeSocket() {
    if (!socket) return;
    const stale = socket;
    socket = null;
    try {
      stale.onopen = stale.onmessage = stale.onclose = stale.onerror = null;
      stale.close();
    } catch {
      /* ignore */
    }
  }

  function flushPending() {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  }

  function debounce(ratingKey) {
    if (pending.has(ratingKey)) clearTimeout(pending.get(ratingKey));
    pending.set(
      ratingKey,
      setTimeout(() => {
        pending.delete(ratingKey);
        Promise.resolve()
          .then(() => onLibraryItemChange(ratingKey))
          .catch((error) => logger(`Plex notifications: handler failed for ${ratingKey}: ${error?.message || error}`));
      }, DEBOUNCE_MS),
    );
  }

  function handleFrame(raw) {
    lastActivityAt = Date.now();
    let payload;
    try {
      payload = JSON.parse(decodeFrame(raw));
    } catch {
      return;
    }
    const container = payload?.NotificationContainer;
    if (!container || container.type !== "timeline") return;

    const entries = Array.isArray(container.TimelineEntry) ? container.TimelineEntry : [];
    for (const entry of entries) {
      if (entry.identifier && entry.identifier !== LIBRARY_IDENTIFIER) continue;
      if (!WATCHABLE_TIMELINE_TYPES.has(Number(entry.type))) continue;
      const ratingKey = String(entry.itemID ?? entry.ratingKey ?? "").trim();
      if (ratingKey) debounce(ratingKey);
    }
  }

  async function connect() {
    if (stopped) return;
    clearReconnect();

    let config;
    try {
      config = await getPlexConfig();
    } catch (error) {
      logger(`Plex notifications: failed to load config: ${error?.message || error}`);
      scheduleReconnect();
      return;
    }

    if (!config?.baseUrl || !config?.token || config.disabled) {
      // Plex not configured (or disabled) yet — back off and re-check later. A settings
      // save calls restart() which retries immediately.
      scheduleReconnect();
      return;
    }

    let ws;
    try {
      ws = new WebSocket(buildNotificationsUrl(config.baseUrl, config.token));
    } catch (error) {
      logger(`Plex notifications: failed to open socket: ${error?.message || error}`);
      scheduleReconnect();
      return;
    }

    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      attempt = 0;
      lastActivityAt = Date.now();
      logger("Plex notifications: connected");
    };
    ws.onmessage = (event) => {
      if (socket === ws) handleFrame(event.data);
    };
    ws.onerror = (event) => {
      if (socket !== ws) return;
      logger(`Plex notifications: socket error: ${event?.error?.message || event?.message || "unknown"}`);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (!stopped) {
        logger("Plex notifications: socket closed, scheduling reconnect");
        scheduleReconnect();
      }
    };
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      lastActivityAt = Date.now();
      startWatchdog();
      connect();
    },
    stop() {
      stopped = true;
      clearReconnect();
      clearWatchdog();
      flushPending();
      closeSocket();
    },
    // Re-evaluate config and reconnect. Called after a settings save so a newly added
    // or changed Plex server/token is picked up without a process restart.
    restart() {
      if (stopped) {
        this.start();
        return;
      }
      clearReconnect();
      attempt = 0;
      lastActivityAt = Date.now();
      closeSocket();
      connect();
    },
  };
}
