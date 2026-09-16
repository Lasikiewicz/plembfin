import { fetchWithTimeout } from "./outbound.js";
import { normalizeHttpUrl, assertSafeOutboundUrl } from "./outbound.js";

export const TAUTULLI_MAX_HISTORY_ROWS = 50_000;
export const TAUTULLI_PAGE_SIZE = 1_000;

function clean(value) {
  return String(value ?? "").trim();
}

function apiUrl(baseUrl) {
  const normalized = normalizeHttpUrl(baseUrl, { label: "Tautulli baseUrl" });
  if (!normalized) throw new Error("Tautulli baseUrl is required");
  const root = new URL(normalized);
  // Tautulli's web UI commonly leaves the browser at /home after login, but
  // its REST API remains rooted at /api/v2. Accepting that copied page URL
  // avoids turning it into the invalid /home/api/v2 endpoint.
  root.pathname = root.pathname.replace(/\/home\/?$/i, "") || "/";
  root.search = "";
  const url = new URL(`${root.toString().replace(/\/+$/, "")}/api/v2`);
  assertSafeOutboundUrl(url, { label: "Tautulli baseUrl" });
  return url;
}

function apiError(message, status = 502, code = "TAUTULLI_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.expose = true;
  return error;
}

export function createTautulliClient({ baseUrl, apiKey, fetcher = fetchWithTimeout, timeoutMs = 10_000 } = {}) {
  const endpoint = apiUrl(baseUrl);
  const key = clean(apiKey);
  if (!key) throw apiError("Tautulli API key is required", 400, "TAUTULLI_KEY_REQUIRED");

  async function request(cmd, params = {}) {
    const url = new URL(endpoint);
    url.searchParams.set("apikey", key);
    url.searchParams.set("cmd", cmd);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    }
    const response = await fetcher(url, { headers: { Accept: "application/json" } }, timeoutMs);
    const body = await response.json().catch(() => ({}));
    const envelope = body?.response || body;
    if (!response.ok) throw apiError(`Tautulli returned HTTP ${response.status}`, response.status);
    if (String(envelope?.result || "success").toLowerCase() !== "success") {
      throw apiError(clean(envelope?.message || envelope?.error || "Tautulli rejected the request") || "Tautulli rejected the request");
    }
    return envelope?.data ?? body?.data ?? {};
  }

  function historyParams({ userId, mediaType, fromDate = "", start = 0, length = TAUTULLI_PAGE_SIZE } = {}) {
    return {
      grouping: 0,
      user_id: userId,
      media_type: mediaType,
      start,
      length,
      order_column: "date",
      order_dir: "asc",
      out_type: "json",
      // `after`, not `start_date`. Tautulli's `start_date` filters to that one
      // calendar day, so an "import from this date onward" request silently
      // returned only the plays on that single date - and because the local
      // range filter in tautulliImport.js is a `>=` floor, every row that came
      // back passed it and the import looked like it had simply found very
      // little history. `after` is the range floor the UI actually promises.
      ...(fromDate ? { after: fromDate } : {}),
    };
  }

  function historyRows(data) {
    return Array.isArray(data) ? data : (data?.data || data?.rows || data?.records || []);
  }

  function historyTotal(data) {
    const value = data?.recordsFiltered ?? data?.recordsTotal ?? data?.total_count ?? data?.total;
    const total = Number(value);
    return Number.isFinite(total) && total >= 0 ? Math.min(total, TAUTULLI_MAX_HISTORY_ROWS) : null;
  }

  return {
    request,
    async getUsers() {
      const data = await request("get_user_names");
      const rows = Array.isArray(data) ? data : (data?.users || data?.rows || []);
      return rows.map((user) => ({
        id: clean(user.user_id ?? user.id),
        name: clean(user.friendly_name || user.username || user.user_name || user.name || user.user_id),
      })).filter((user) => user.id);
    },
    getServerInfo() {
      return request("get_server_info");
    },
    async getHistory({ userId, mediaType, fromDate = "", maxRows = TAUTULLI_MAX_HISTORY_ROWS, onProgress } = {}) {
      const selectedUserId = clean(userId);
      if (!selectedUserId) throw apiError("A Tautulli user is required", 400, "TAUTULLI_USER_REQUIRED");
      if (!["movie", "episode"].includes(String(mediaType))) throw apiError("mediaType must be movie or episode", 400);
      const boundedMaxRows = Math.min(Math.max(Number(maxRows) || TAUTULLI_MAX_HISTORY_ROWS, 1), TAUTULLI_MAX_HISTORY_ROWS);
      let expectedTotal = null;
      if (onProgress) {
        const countData = await request("get_history", historyParams({ userId: selectedUserId, mediaType, fromDate, start: 0, length: 1 }));
        expectedTotal = historyTotal(countData);
        onProgress({ phase: "counting", mediaType, total: expectedTotal, completed: 0 });
      }
      const rows = [];
      for (let start = 0; start < boundedMaxRows; start += TAUTULLI_PAGE_SIZE) {
        const data = await request("get_history", historyParams({
          userId: selectedUserId,
          mediaType,
          fromDate,
          start,
          length: Math.min(TAUTULLI_PAGE_SIZE, boundedMaxRows - start),
        }));
        const page = historyRows(data);
        if (!page.length) break;
        rows.push(...page);
        if (onProgress) {
          onProgress({
            phase: "reading",
            mediaType,
            total: expectedTotal ?? Math.min(rows.length + (page.length === TAUTULLI_PAGE_SIZE ? TAUTULLI_PAGE_SIZE : 0), boundedMaxRows),
            completed: Math.min(rows.length, boundedMaxRows),
          });
        }
        if (page.length < TAUTULLI_PAGE_SIZE || rows.length >= boundedMaxRows) break;
      }
      if (onProgress && !rows.length) onProgress({ phase: "reading", mediaType, total: expectedTotal || 0, completed: 0 });
      return rows.slice(0, boundedMaxRows);
    },
  };
}

export function sanitizeTautulliError(error) {
  return error?.message || "Tautulli request failed";
}
