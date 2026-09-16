import test from "node:test";
import assert from "node:assert/strict";
import { createTautulliClient } from "../server/src/utils/tautulliClient.js";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test("Tautulli client uses the v2 envelope, preserves query controls, and paginates history", async () => {
  const calls = [];
  const client = createTautulliClient({
    baseUrl: "http://127.0.0.1:8181/",
    apiKey: "secret-key",
    fetcher: async (url) => {
      calls.push(new URL(url));
      const request = calls.at(-1);
      if (request.searchParams.get("cmd") === "get_user_names") {
        return response({ response: { result: "success", data: [{ user_id: 7, friendly_name: "Alex" }] } });
      }
      if (request.searchParams.get("start") === "0") {
        return response({ response: { result: "success", data: { data: Array.from({ length: 1000 }, (_, index) => ({ user_id: 7, row_id: index })) } } });
      }
      return response({ response: { result: "success", data: { data: [{ user_id: 7, row_id: 1000 }] } } });
    },
  });

  assert.deepEqual(await client.getUsers(), [{ id: "7", name: "Alex" }]);
  const rows = await client.getHistory({ userId: 7, mediaType: "movie" });
  assert.equal(rows.length, 1001);
  assert.equal(calls[1].searchParams.get("cmd"), "get_history");
  assert.equal(calls[1].searchParams.get("grouping"), "0");
  assert.equal(calls[1].searchParams.get("order_dir"), "asc");
  assert.equal(calls[1].searchParams.get("apikey"), "secret-key");
});

test("Tautulli client treats the post-login /home page as the host root", async () => {
  let requestedUrl;
  const client = createTautulliClient({
    baseUrl: "https://tautulli.example.test/home",
    apiKey: "secret-key",
    fetcher: async (url) => {
      requestedUrl = new URL(url);
      return response({ response: { result: "success", data: [] } });
    },
  });

  await client.getUsers();
  assert.equal(requestedUrl.pathname, "/api/v2");
});

test("Tautulli history reports a total before paging progress", async () => {
  const progress = [];
  const client = createTautulliClient({
    baseUrl: "http://127.0.0.1:8181",
    apiKey: "secret-key",
    fetcher: async (url) => {
      const request = new URL(url);
      if (request.searchParams.get("length") === "1") {
        return response({ response: { result: "success", data: { recordsFiltered: 1500, recordsTotal: 1500, data: [{}] } } });
      }
      const start = Number(request.searchParams.get("start"));
      const count = start === 0 ? 1000 : 500;
      return response({ response: { result: "success", data: { data: Array.from({ length: count }, (_, index) => ({ row_id: start + index })) } } });
    },
  });

  const rows = await client.getHistory({ userId: 7, mediaType: "movie", onProgress: (update) => progress.push(update) });
  assert.equal(rows.length, 1500);
  assert.deepEqual(progress[0], { phase: "counting", mediaType: "movie", total: 1500, completed: 0 });
  assert.deepEqual(progress.at(-1), { phase: "reading", mediaType: "movie", total: 1500, completed: 1500 });
});

test("Tautulli client rejects a failed API envelope without echoing the key", async () => {
  const client = createTautulliClient({
    baseUrl: "http://127.0.0.1:8181",
    apiKey: "do-not-echo",
    fetcher: async () => response({ response: { result: "error", message: "invalid apikey" } }),
  });
  await assert.rejects(() => client.getUsers(), (error) => {
    assert.match(error.message, /invalid apikey/);
    assert.doesNotMatch(error.message, /do-not-echo/);
    return true;
  });
});

// Regression: the importer's "Import from (optional)" field promises "this date
// onward", but Tautulli's `start_date` filters to that single calendar day. The
// local range filter in tautulliImport.js is a `>=` floor, so every row that
// came back passed it - the import silently returned one day of history and
// looked like the account simply had very little. `after` is the real floor.
test("a from-date is sent as Tautulli's range filter, not its single-day filter", async () => {
  const calls = [];
  const client = createTautulliClient({
    baseUrl: "http://127.0.0.1:8181/",
    apiKey: "secret-key",
    fetcher: async (url) => {
      calls.push(new URL(url));
      return response({ response: { result: "success", data: { data: [], recordsFiltered: 0, recordsTotal: 0 } } });
    },
  });

  await client.getHistory({ userId: "7", mediaType: "episode", fromDate: "2024-11-23" });
  const historyCalls = calls.filter((url) => url.searchParams.get("cmd") === "get_history");
  assert.ok(historyCalls.length > 0);
  for (const url of historyCalls) {
    assert.equal(url.searchParams.get("after"), "2024-11-23");
    assert.equal(url.searchParams.get("start_date"), null, "start_date limits to one day and must not be used");
  }

  // No date means no date filter at all, not a defaulted one.
  calls.length = 0;
  await client.getHistory({ userId: "7", mediaType: "episode" });
  for (const url of calls.filter((entry) => entry.searchParams.get("cmd") === "get_history")) {
    assert.equal(url.searchParams.get("after"), null);
    assert.equal(url.searchParams.get("start_date"), null);
  }
});
