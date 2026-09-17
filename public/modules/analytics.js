const CONFIG_URL = "/analytics-config.json";
const CONSENT_KEY = "plembfin:demo-analytics-consent";

function privacySignalIsSet() {
  return navigator.doNotTrack === "1"
    || window.doNotTrack === "1"
    || navigator.globalPrivacyControl === true;
}

function readConsent() {
  try {
    return window.localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

function writeConsent(value) {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // A privacy-restricted browser can still use the current-page choice.
  }
}

function parseConfig(config) {
  if (!config?.enabled || typeof config.scriptUrl !== "string" || typeof config.siteKey !== "string") return null;
  if (!/^https:\/\//i.test(config.scriptUrl)) return null;
  return config;
}

function readInlineConfig() {
  const element = document.getElementById("plembfin-traks-config");
  if (!element?.textContent) return null;
  try {
    return parseConfig(JSON.parse(element.textContent));
  } catch {
    return null;
  }
}

async function fetchConfig() {
  try {
    const response = await fetch(CONFIG_URL, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return null;
    return parseConfig(await response.json());
  } catch {
    return null;
  }
}

function loadTraks(config) {
  if (window.__plembfinTraksLoaded || privacySignalIsSet()) return;

  const script = document.createElement("script");
  script.defer = true;
  script.src = config.scriptUrl;
  script.dataset.site = config.siteKey;
  script.onload = () => {
    window.__plembfinTraksLoaded = true;
  };
  document.head.appendChild(script);
}

function scheduleTraksLoad(config) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => loadTraks(config), { timeout: 2000 });
  } else {
    window.setTimeout(() => loadTraks(config), 2000);
  }
}

function showConsentPrompt(config) {
  const banner = document.createElement("aside");
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Analytics preference");
  banner.style.cssText = [
    "position:fixed",
    "left:16px",
    "right:16px",
    "bottom:16px",
    "z-index:10000",
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    "gap:16px",
    "padding:16px 18px",
    "border:1px solid rgba(148,163,184,.3)",
    "border-radius:12px",
    "background:#111827",
    "color:#f8fafc",
    "box-shadow:0 12px 40px rgba(0,0,0,.35)",
    "font:14px/1.45 system-ui,sans-serif",
  ].join(";");
  banner.innerHTML = `
    <p style="margin:0;max-width:720px">Help improve this public demo with privacy-friendly usage statistics. No cookies are used.</p>
    <span style="display:flex;gap:8px;flex:0 0 auto">
      <button type="button" data-analytics-decline style="padding:8px 12px;border:1px solid #64748b;border-radius:8px;background:transparent;color:inherit;cursor:pointer">Decline</button>
      <button type="button" data-analytics-allow style="padding:8px 12px;border:0;border-radius:8px;background:#38bdf8;color:#082f49;cursor:pointer;font-weight:600">Allow analytics</button>
    </span>`;

  const finish = (choice) => {
    writeConsent(choice);
    banner.remove();
    if (choice === "granted") loadTraks(config);
  };

  banner.querySelector("[data-analytics-decline]")?.addEventListener("click", () => finish("denied"));
  banner.querySelector("[data-analytics-allow]")?.addEventListener("click", () => finish("granted"));
  document.body.appendChild(banner);
}

async function boot() {
  if (privacySignalIsSet()) return;

  // Prefer the same-page config so privacy extensions cannot hide the consent
  // prompt by blocking the separately named analytics endpoint.
  const config = readInlineConfig() || await fetchConfig();
  if (!config) return;

  const consent = readConsent();
  if (config.requireConsent !== false) {
    if (consent === "granted") loadTraks(config);
    else if (consent !== "denied") showConsentPrompt(config);
    return;
  }

  scheduleTraksLoad(config);
}

void boot();
