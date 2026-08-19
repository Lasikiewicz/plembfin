let activeController = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let lastVersion = null;

const RECONNECT_MS = 1_000;

export function stopLiveUpdates() {
  connectionGeneration += 1;
  activeController?.abort();
  activeController = null;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  lastVersion = null;
}

export function startLiveUpdates({ authHeaders, onHistoryVersion, onSyncProgress, onError } = {}) {
  stopLiveUpdates();
  const generation = connectionGeneration;

  const scheduleReconnect = () => {
    if (generation !== connectionGeneration || reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
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

    const version = Number(event.version);
    if (!Number.isFinite(version)) return;
    if (lastVersion === null) {
      lastVersion = version;
      return;
    }
    if (version === lastVersion) return;
    lastVersion = version;
    onHistoryVersion?.(version);
  };

  const connect = async () => {
    if (generation !== connectionGeneration) return;
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

  connect();
}
