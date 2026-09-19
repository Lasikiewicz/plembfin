// Benchmark helper for plan/application-speed-remediation.md (Phase G).
// Not a node script: this file is a single Playwright page function. Paste it
// into the Playwright MCP browser tool's run-code action with a signed-in
// local Plembfin tab open; it returns its measurements as JSON. It never enters
// credentials and does not mutate provider state.

async (page) => {
  const routes = [
    "/", "/movies", "/tvshows", "/upcoming", "/discover", "/watchlist", "/ratings", "/custom-lists",
    "/history", "/stats", "/settings", "/about",
    "/tvshow/tvdb/435298-ludwig", "/tvshow/tmdb/108978-reacher",
    "/movie/jackass-presents-bad-grandpa", "/movie/a-quiet-place",
  ];
  const detailRoute = /^\/(tvshow|movie)\//;
  const populations = 2;
  const runs = 6;
  const paceMs = 1200;
  const quietMs = 800;
  const settleLimitMs = 12000;
  const loadLimitMs = 20000;
  const origin = (await page.url()).split("/").slice(0, 3).join("/");
  const startedAt = new Date().toISOString();
  const sleep = (ms) => page.waitForTimeout(ms);

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const onConsole = (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "warning") consoleWarnings.push(message.text());
  };
  const onPageError = (error) => pageErrors.push(String(error?.message || error));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  const kindOf = (entry) => {
    if (entry.initiatorType === "img" || /.(png|jpe?g|webp|svg|ico|gif)(\?|$)/.test(entry.name)
      || /tmdb-poster|tmdb-profile|artwork|image-proxy/.test(entry.name)) return "image";
    if (/\/api\//.test(entry.name)) return "api";
    return "asset";
  };

  const waitForQuiet = async (needsDetailMark) => {
    const started = Date.now();
    let previousCount = -1;
    let lastChange = Date.now();
    while (Date.now() - started < settleLimitMs) {
      const state = await page.evaluate(() => ({
        count: performance.getEntriesByType("resource").length,
        detailReady: performance.getEntriesByName("plembfin:detail-primary-ready").length > 0,
      }));
      if (state.count !== previousCount) {
        previousCount = state.count;
        lastChange = Date.now();
      }
      if ((!needsDetailMark || state.detailReady) && Date.now() - lastChange >= quietMs) return false;
      await sleep(100);
    }
    return true;
  };

  const readMetrics = async () => page.evaluate(() => {
    const resources = performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      responseEnd: entry.responseEnd,
      transferSize: entry.transferSize || 0,
      decodedBodySize: entry.decodedBodySize || 0,
      responseStatus: entry.responseStatus || 0,
    }));
    const navigation = performance.getEntriesByType("navigation")[0] || {};
    const paints = performance.getEntriesByType("paint");
    const primaryMarks = performance.getEntriesByName("plembfin:detail-primary-ready");
    return {
      path: location.pathname,
      navigation: {
        name: navigation.name || "",
        responseStart: navigation.responseStart ?? null,
        domContentLoadedEventEnd: navigation.domContentLoadedEventEnd ?? null,
        loadEventEnd: navigation.loadEventEnd || null,
        transferSize: navigation.transferSize || 0,
        decodedBodySize: navigation.decodedBodySize || 0,
      },
      fcp: paints.find((entry) => entry.name === "first-contentful-paint")?.startTime ?? null,
      primaryReady: primaryMarks.at(-1)?.startTime ?? null,
      resources,
    };
  });

  const readLcp = async () => page.evaluate(async () => new Promise((resolve) => {
    let value = null;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) value = entry.startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(value);
      }, 50);
    } catch {
      resolve(null);
    }
  }));

  const sample = async (route, label) => {
    const url = `${origin}${route}${route.includes("?") ? "&" : "?"}bench=${label}-${Date.now()}`;
    let loaded = true;
    let navigationError = null;
    try {
      await page.goto(url, { waitUntil: "load", timeout: loadLimitMs });
    } catch (error) {
      loaded = false;
      navigationError = String(error?.message || error);
    }
    const timedOut = loaded ? await waitForQuiet(detailRoute.test(route)) : true;
    const metrics = await readMetrics();
    const lcp = loaded ? await readLcp() : null;
    const totals = { requests: 0, transfer: 0, decoded: 0, api: 0, image: 0, asset: 0, status429: 0, failed: 0 };
    const inventory = {};
    for (const entry of metrics.resources) {
      totals.requests += 1;
      totals.transfer += entry.transferSize;
      totals.decoded += entry.decodedBodySize;
      totals[kindOf(entry)] += 1;
      if (entry.responseStatus === 429) totals.status429 += 1;
      if (entry.responseStatus >= 500) totals.failed += 1;
      let key = entry.name;
      key = String(entry.name).replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0] || "/";
      inventory[key] = (inventory[key] || 0) + 1;
    }
    const document = metrics.navigation;
    const shell = { requests: 1, transfer: document.transferSize, decoded: document.decodedBodySize };
    for (const entry of metrics.resources) {
      if (kindOf(entry) !== "asset") continue;
      shell.requests += 1;
      shell.transfer += entry.transferSize;
      shell.decoded += entry.decodedBodySize;
    }
    return {
      route,
      loaded,
      timedOut,
      navigationError,
      path: metrics.path,
      ttfb: document.responseStart,
      dcl: document.domContentLoadedEventEnd,
      load: document.loadEventEnd,
      fcp: metrics.fcp,
      lcp,
      primaryReady: metrics.primaryReady,
      requests: totals.requests + 1,
      transfer: totals.transfer + document.transferSize,
      decoded: totals.decoded + document.decodedBodySize,
      api: totals.api,
      images: totals.image,
      status429: totals.status429,
      failed: totals.failed,
      shell,
      inventory,
    };
  };

  const percentile = (values, percentileValue) => {
    const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
    return Math.round(sorted[Math.max(0, index)] * 10) / 10;
  };

  const summarize = (samples) => {
    const byRoute = {};
    for (const item of samples) (byRoute[item.route] ||= []).push(item);
    const summary = {};
    for (const [route, list] of Object.entries(byRoute)) {
      const measured = list.slice(1);
      const median = (key) => percentile(measured.map((item) => item[key]), 50);
      summary[route] = {
        samples: measured.length,
        incomplete: measured.filter((item) => !item.loaded || item.timedOut).length,
        status429: measured.reduce((sum, item) => sum + item.status429, 0),
        failed: measured.reduce((sum, item) => sum + item.failed, 0),
        medianLoad: median("load"),
        p95Load: percentile(measured.map((item) => item.load), 95),
        maxLoad: percentile(measured.map((item) => item.load), 100),
        medianTtfb: median("ttfb"),
        p95Ttfb: percentile(measured.map((item) => item.ttfb), 95),
        medianFcp: median("fcp"),
        medianLcp: median("lcp"),
        medianPrimaryReady: median("primaryReady"),
        medianRequests: median("requests"),
        medianApi: median("api"),
        medianImages: median("images"),
        medianTransfer: median("transfer"),
        medianDecoded: median("decoded"),
        medianShellRequests: percentile(measured.map((item) => item.shell.requests), 50),
        medianShellTransfer: percentile(measured.map((item) => item.shell.transfer), 50),
        medianShellDecoded: percentile(measured.map((item) => item.shell.decoded), 50),
        inventory: measured.at(-1)?.inventory || {},
      };
    }
    return summary;
  };

  const report = {
    benchmark: "application-speed Phase G warm document matrix",
    cacheMode: "warm authenticated browser profile; immutable versioned assets",
    origin,
    mode: "document",
    populations,
    runs,
    routes,
    startedAt,
    populationsResult: [],
  };
  const storageKey = `plembfin_benchmark_result_${Date.now()}`;
  const persistenceErrors = [];
  const persistReport = async () => {
    try {
      await page.evaluate(({ key, value }) => {
        localStorage.setItem(key, JSON.stringify(value));
        window.__plembfinBenchmarkResultKey = key;
      }, { key: storageKey, value: report });
      return true;
    } catch (error) {
      persistenceErrors.push(String(error?.message || error));
      return false;
    }
  };

  for (let population = 0; population < populations; population += 1) {
    const samples = [];
    for (let run = 0; run < runs; run += 1) {
      for (const route of routes) {
        const item = await sample(route, `warm-${population}-${run}`);
        samples.push(item);
        await sleep(paceMs);
      }
    }
    const ordered = [];
    for (const route of routes) ordered.push(...samples.filter((item) => item.route === route));
    report.populationsResult.push({
      index: population,
      summary: summarize(ordered),
      stalls: samples.filter((item) => (item.load || 0) > 5000).map((item) => ({ route: item.route, time: item.load })),
      raw: samples.map(({ inventory, ...item }) => item),
    });
    await persistReport();
  }

  report.finishedAt = new Date().toISOString();
  const persisted = await persistReport();

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  return {
    storageKey: persisted ? storageKey : null,
    attemptedStorageKey: storageKey,
    persistenceErrors,
    startedAt,
    finishedAt: report.finishedAt,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    populations: report.populationsResult.map((population) => ({
      index: population.index,
      stalls: population.stalls,
      summary: population.summary,
    })),
  };
}
