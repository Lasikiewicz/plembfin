// Benchmark helper for plan/application-speed-remediation.md (Phase G).
// Not a node script: this file is a single Playwright page function. Paste it
// into the Playwright MCP browser tool's run-code action with a signed-in
// local Plembfin tab open; it returns its measurements as JSON. It never enters
// credentials and does not mutate provider state.

async (page) => {
  const origin = (await page.url()).split("/").slice(0, 3).join("/");
  await page.addInitScript(() => {
    window.__plembfinLayoutShifts = [];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__plembfinLayoutShifts.push({
            value: entry.value,
            startTime: entry.startTime,
            sources: (entry.sources || []).map((source) => {
              const node = source.node;
              return {
                previousRect: source.previousRect ? {
                  x: source.previousRect.x,
                  y: source.previousRect.y,
                  width: source.previousRect.width,
                  height: source.previousRect.height,
                } : null,
                currentRect: source.currentRect ? {
                  x: source.currentRect.x,
                  y: source.currentRect.y,
                  width: source.currentRect.width,
                  height: source.currentRect.height,
                } : null,
                node: node ? {
                  tag: node.tagName,
                  id: node.id,
                  className: typeof node.className === "string" ? node.className.slice(0, 160) : "",
                  text: (node.textContent || "").trim().slice(0, 120),
                } : null,
              };
            }),
          });
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
    } catch {
      window.__plembfinLayoutShiftsUnsupported = true;
    }
  });
  const results = [];
  for (const route of ["/about", "/", "/settings/media-servers"]) {
    await page.goto(`${origin}${route}?check=phase-g-cls-diagnostic-${Date.now()}`, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    results.push(await page.evaluate(() => ({
      route: location.pathname,
      cls: Math.round((window.__plembfinLayoutShifts || []).reduce((sum, entry) => sum + entry.value, 0) * 10000) / 10000,
      entries: window.__plembfinLayoutShifts || [],
      unsupported: Boolean(window.__plembfinLayoutShiftsUnsupported),
    })));
  }
  return results;
}
