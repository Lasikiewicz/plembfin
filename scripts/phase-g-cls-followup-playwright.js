// Benchmark helper for plan/application-speed-remediation.md (Phase G).
// Not a node script: this file is a single Playwright page function. Paste it
// into the Playwright MCP browser tool's run-code action with a signed-in
// local Plembfin tab open; it returns its measurements as JSON. It never enters
// credentials and does not mutate provider state.

async (page) => {
  const origin = (await page.url()).split("/").slice(0, 3).join("/");
  const originalViewport = page.viewportSize() || { width: 1280, height: 900 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  await page.addInitScript(() => {
    window.__phaseGClsFollowup = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__phaseGClsFollowup.push({
            value: entry.value,
            hadRecentInput: entry.hadRecentInput,
            startTime: entry.startTime,
            sources: (entry.sources || []).map((source) => ({
              node: source.node ? `${source.node.tagName}.${source.node.id || ""}.${source.node.className || ""}` : "",
              previousRect: source.previousRect,
              currentRect: source.currentRect,
            })),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch (error) {
      window.__phaseGClsFollowupUnsupported = String(error?.message || error);
    }
  });

  const readResult = async (path) => {
    await page.goto(`${origin}${path}?check=phase-g-cls-followup-${Date.now()}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1800);
    return page.evaluate(() => {
      const shell = document.querySelector(".page-shell");
      const rect = shell?.getBoundingClientRect();
      const entries = window.__phaseGClsFollowup || [];
      return {
        path: location.pathname,
        cls: Math.round(entries.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + entry.value, 0) * 1000000) / 1000000,
        entries,
        unsupported: window.__phaseGClsFollowupUnsupported || null,
        readyState: document.readyState,
        innerWidth,
        pageShell: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      };
    });
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktop = [];
  for (const path of ["/", "/about", "/settings/media-servers"]) {
    desktop.push(await readResult(path));
  }

  await page.setViewportSize({ width: 760, height: 900 });
  const mobile = await readResult("/settings/media-servers");
  const report = {
    benchmark: "application-speed Phase G signed-in CLS follow-up after auth-shell reservation",
    origin,
    startedAt: new Date().toISOString(),
    desktop,
    mobile,
    target: "CLS < 0.1 per route",
    pass: desktop.every((result) => result.cls < 0.1) && mobile.cls < 0.1,
    finishedAt: new Date().toISOString(),
  };

  await page.setViewportSize(originalViewport);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  await cdp.detach();
  return report;
}
