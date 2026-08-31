let activeController = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let lastVersion = null;
let lastDiscoverVersion = null;
let visibilityHandler = null;
let lockAbortController = null;

const RECONNECT_MS = 1_000;

export function stopLiveUpdates() {
  connectionGeneration += 1;
  activeController?.abort();
  activeController = null;
  lockAbortController?.abort();
  lockAbortController = null;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
  visibilityHandler = null;
  lastVersion = null;
  lastDiscoverVersion = null;
}

export function startLiveUpdates({ authHeaders, onHistoryVersion, onDiscoverVersion, onSyncProgress, onError } = {}) {
  stopLiveUpdates();
  const generation = connectionGeneration;

  // A streaming fetch occupies one HTTP/1.1 connection for the lifetime of
  // the page. Edge/Chromium only permits a small number of connections to one
  // origin, so a handful of background tabs could consume the whole pool and
  // leave their normal API requests queued forever. Keep the stream only in a
  // visible tab; a newly visible tab reconnects and receives the current
  // authoritative version/progress snapshot immediately.
  const isVisible = () => document.visibilityState !== "hidden";

  const scheduleReconnect = () => {
    if (generation !== connectionGeneration || reconnectTimer || !isVisible()) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      requestConnection();
    }, RECONNECT_MS);
  };

  const consumeEvent = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    const event = JSON.parse(data);

    if (event.type === "sync-progress") {
      onSyncProgress?.({ total: Number(event.total) || 0, completed: Number(event.completed) || 0 });
      return;
    }

    // `ready` carries the authoritative progress snapshot. Apply it before
    // comparing versions so a reconnect cannot start a history refresh using
    // the stale sync-busy state left by the previous stream.
    if ("syncTotal" in event) {
      onSyncProgress?.({ total: Number(event.syncTotal) || 0, completed: Number(event.syncCompleted) || 0 });
    }

    const discoverVersion = Number(event.discoverVersion);
    if (Number.isFinite(discoverVersion)) {
      if (lastDiscoverVersion === null) {
        lastDiscoverVersion = discoverVersion;
        onDiscoverVersion?.(discoverVersion, { initial: true });
      } else if (discoverVersion !== lastDiscoverVersion) {
        lastDiscoverVersion = discoverVersion;
        onDiscoverVersion?.(discoverVersion, { initial: false });
      }
    }

    const version = Number(event.version);
    if (!Number.isFinite(version)) return;
    if (lastVersion === null) {
      lastVersion = version;
      return;
    }
    if (version === lastVersion) return;
    lastVersion = version;
    // If the server piggybacked sync-progress onto this version bump, apply it
    // first so the client's sync-busy flag is current before onHistoryVersion
    // decides whether to queue a dashboard refresh.
    onHistoryVersion?.(version);
  };

  const connect = async () => {
    if (generation !== connectionGeneration || !isVisible() || activeController) return;
    const controller = new AbortController();
    activeController = controller;
    try {
      const response = await fetch("/api/live-updates", {
        headers: authHeaders?.() || {},
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Live updates failed with ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (generation === connectionGeneration) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          try { consumeEvent(block); } catch (error) { onError?.(error); }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") onError?.(error);
    } finally {
      if (activeController === controller) activeController = null;
      scheduleReconnect();
    }
  };

  const requestConnection = () => {
    if (generation !== connectionGeneration || !isVisible() || activeController || lockAbortController) return;
    if (!globalThis.navigator?.locks?.request) {
      connect();
      return;
    }

    // Coordinate across every Plembfin tab. Exactly one document owns the
    // long-lived stream; waiting lock requests consume no HTTP connection.
    const controller = new AbortController();
    lockAbortController = controller;
    navigator.locks.request("plembfin-live-updates", { mode: "exclusive", signal: controller.signal }, async () => {
      if (lockAbortController === controller) lockAbortController = null;
      if (generation !== connectionGeneration || !isVisible()) return;
      await connect();
    }).catch((error) => {
      if (error?.name !== "AbortError") onError?.(error);
    }).finally(() => {
      if (lockAbortController === controller) lockAbortController = null;
    });
  };

  visibilityHandler = () => {
    if (generation !== connectionGeneration) return;
    if (!isVisible()) {
      activeController?.abort();
      activeController = null;
      lockAbortController?.abort();
      lockAbortController = null;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      return;
    }
    requestConnection();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
  requestConnection();
}
