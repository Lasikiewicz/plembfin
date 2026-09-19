// Benchmark helper for plan/application-speed-remediation.md (Phase G).
// Not a node script: this file is a single Playwright page function. Paste it
// into the Playwright MCP browser tool's run-code action with a signed-in
// local Plembfin tab open; it returns its measurements as JSON. It never enters
// credentials and does not mutate provider state.

async (page) => {
  const origin = (await page.url()).split("/").slice(0, 3).join("/");
  const originalViewport = page.viewportSize() || { width: 1280, height: 900 };
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

  const goto = async (path, timeout = 30000) => {
    let navigationError = null;
    try {
      await page.goto(`${origin}${path}`, { waitUntil: "load", timeout });
    } catch (error) {
      navigationError = String(error?.message || error);
    }
    await page.waitForTimeout(1200);
    return navigationError;
  };

  const readShell = async () => page.evaluate(() => ({
    path: location.pathname,
    readyState: document.readyState,
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body?.scrollWidth || 0,
    primaryNavigation: Boolean(document.querySelector('nav[aria-label="Primary navigation"]')),
    visibleNavigationItems: [...document.querySelectorAll('nav a, nav button')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }).length,
    serverControls: [...document.querySelectorAll("body *")]
      .filter((element) => /plex|emby|jellyfin/i.test(element.textContent || "") && element.children.length === 0)
      .map((element) => element.textContent.trim()).filter(Boolean).slice(0, 12),
    timing: performance.getEntriesByType("navigation")[0] ? {
      responseStart: performance.getEntriesByType("navigation")[0].responseStart,
      loadEventEnd: performance.getEntriesByType("navigation")[0].loadEventEnd,
    } : null,
  }));

  await page.addInitScript(() => {
    window.__plembfinCls = 0;
    window.__plembfinClsEntries = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__plembfinCls += entry.value;
          window.__plembfinClsEntries += 1;
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
    } catch {
      window.__plembfinClsUnsupported = true;
    }
  });

  await page.setViewportSize({ width: 760, height: 900 });
  const mobileNavigationError = await goto(`/settings?check=phase-g-mobile-${Date.now()}`);
  const mobileNavigation = await readShell();

  let slow4g = { supported: false, navigationError: null };
  let client = null;
  try {
    client = await page.context().newCDPSession(page);
    await client.send("Network.enable");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: 750 * 1024 / 8,
      uploadThroughput: 250 * 1024 / 8,
      latency: 150,
    });
    const navigationError = await goto(`/settings/media-servers?check=phase-g-slow4g-${Date.now()}`, 45000);
    slow4g = {
      supported: true,
      navigationError,
      ...(await readShell()),
    };
  } catch (error) {
    slow4g.error = String(error?.message || error);
  } finally {
    if (client) {
      try {
        await client.send("Network.emulateNetworkConditions", {
          offline: false,
          downloadThroughput: -1,
          uploadThroughput: -1,
          latency: 0,
        });
        await client.send("Network.setCacheDisabled", { cacheDisabled: false });
        await client.detach();
      } catch {
        // The browser context will restore defaults when the session ends.
      }
    }
  }

  await page.setViewportSize(originalViewport);
  const clsRoutes = ["/", "/about", "/settings/media-servers"];
  const cls = [];
  for (const route of clsRoutes) {
    const navigationError = await goto(`${route}?check=phase-g-cls-${Date.now()}`);
    const result = await page.evaluate(() => ({
      path: location.pathname,
      navigationError: null,
      cls: Math.round((window.__plembfinCls || 0) * 10000) / 10000,
      entries: window.__plembfinClsEntries || 0,
      unsupported: Boolean(window.__plembfinClsUnsupported),
      readyState: document.readyState,
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    result.navigationError = navigationError;
    cls.push(result);
  }

  const savedCookies = await page.context().cookies();
  const savedStorage = await page.evaluate(() => {
    const entries = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      entries[key] = localStorage.getItem(key);
    }
    return entries;
  });
  let authExpiry = {};
  try {
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    const navigationError = await goto(`/about?check=phase-g-auth-expiry-${Date.now()}`);
    authExpiry = await page.evaluate(() => ({
      path: location.pathname,
      title: document.title,
      hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
      hasSignInText: /sign in|log in|session expired|authentication/i.test(document.body?.innerText || ""),
      primaryNavigation: Boolean(document.querySelector('nav[aria-label="Primary navigation"]')),
    }));
    authExpiry.navigationError = navigationError;
  } finally {
    await page.context().addCookies(savedCookies);
    await page.goto(`${origin}/about?check=phase-g-auth-restore-${Date.now()}`, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    }, savedStorage);
  }

  const report = {
    benchmark: "application-speed Phase G signed-in smoke checks",
    origin,
    startedAt: new Date().toISOString(),
    originalViewport,
    mobileNavigationError,
    mobileNavigation,
    slow4g,
    cls,
    authExpiry,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    restoredUrl: await page.url(),
    finishedAt: new Date().toISOString(),
  };
  const storageKey = `plembfin_phase_g_smoke_${Date.now()}`;
  await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
    window.__plembfinSmokeResultKey = key;
  }, { key: storageKey, value: report });
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  return { storageKey, report };
}
