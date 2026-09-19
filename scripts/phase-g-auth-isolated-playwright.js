// Benchmark helper for plan/application-speed-remediation.md (Phase G).
// Not a node script: this file is a single Playwright page function. Paste it
// into the Playwright MCP browser tool's run-code action with a signed-in
// local Plembfin tab open; it returns its measurements as JSON. It never enters
// credentials and does not mutate provider state.

async (page) => {
  const origin = (await page.url()).split("/").slice(0, 3).join("/");
  const browser = page.context().browser();
  if (!browser) {
    return {
      supported: false,
      reason: "The current Playwright context does not expose a browser for isolation.",
    };
  }

  const storageState = await page.context().storageState();
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1280, height: 900 },
  });
  const probe = await context.newPage();

  const readAuthShell = async () => probe.evaluate(() => {
    const authView = document.querySelector("#authView");
    const password = document.querySelector('input[type="password"]');
    const navigation = document.querySelector('nav[aria-label="Primary navigation"]');
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    return {
      path: location.pathname,
      bodyClass: document.body.className,
      authViewVisible: visible(authView),
      passwordVisible: visible(password),
      navigationVisible: visible(navigation),
      title: document.title,
    };
  });

  const route = `/about?check=phase-g-auth-isolated-${Date.now()}`;
  const report = {
    benchmark: "application-speed Phase G isolated auth expiry and restoration",
    origin,
    startedAt: new Date().toISOString(),
    contextIsolation: true,
    credentialsEntered: false,
  };

  try {
    await probe.goto(`${origin}${route}`, { waitUntil: "load", timeout: 30000 });
    await probe.waitForTimeout(1000);
    report.beforeExpiry = await readAuthShell();

    await context.clearCookies();
    await probe.reload({ waitUntil: "load", timeout: 30000 });
    await probe.waitForTimeout(1000);
    report.afterExpiry = await readAuthShell();

    await context.addCookies(storageState.cookies);
    await probe.reload({ waitUntil: "load", timeout: 30000 });
    await probe.waitForTimeout(1200);
    report.afterRestore = await readAuthShell();
    report.pass = Boolean(
      report.beforeExpiry?.navigationVisible
      && !report.beforeExpiry?.authViewVisible
      && report.afterExpiry?.authViewVisible
      && report.afterExpiry?.passwordVisible
      && !report.afterExpiry?.navigationVisible
      && report.afterRestore?.navigationVisible
      && !report.afterRestore?.authViewVisible
      && !report.afterRestore?.passwordVisible
    );
  } catch (error) {
    report.error = String(error?.message || error);
    report.pass = false;
  } finally {
    await context.close();
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
