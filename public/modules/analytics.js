const CONFIG_URL = "/analytics-config.json";
const CONSENT_KEY = "plembfin:demo-analytics-consent-v2";

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

function loadTraks(config) {
  if (!config?.enabled || window.__plembfinTraksLoaded || window.__plembfinTraksLoading || privacySignalIsSet()) return;

  window.__plembfinTraksLoading = true;
  const script = document.createElement("script");
  script.defer = true;
  script.src = config.scriptUrl;
  script.dataset.site = config.siteKey;
  script.onload = () => {
    window.__plembfinTraksLoaded = true;
    window.__plembfinTraksLoading = false;
  };
  script.onerror = () => {
    window.__plembfinTraksLoading = false;
  };
  document.head.appendChild(script);
}

function loadGoogleAnalytics(config) {
  const googleAnalytics = config?.googleAnalytics;
  if (
    !googleAnalytics?.enabled
    || !/^G-[A-Z0-9]+$/i.test(googleAnalytics.measurementId || "")
    || window.__plembfinGoogleAnalyticsLoaded
    || window.__plembfinGoogleAnalyticsLoading
    || privacySignalIsSet()
  ) return;

  window.__plembfinGoogleAnalyticsLoading = true;
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", googleAnalytics.measurementId, { anonymize_ip: true });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleAnalytics.measurementId)}`;
  script.onload = () => {
    window.__plembfinGoogleAnalyticsLoaded = true;
    window.__plembfinGoogleAnalyticsLoading = false;
  };
  script.onerror = () => {
    window.__plembfinGoogleAnalyticsLoading = false;
  };
  document.head.appendChild(script);
}

function loadAnalytics(config) {
  loadTraks(config.traks);
  loadGoogleAnalytics(config);
}

function scheduleAnalyticsLoad(config) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => loadAnalytics(config), { timeout: 2000 });
  } else {
    window.setTimeout(() => loadAnalytics(config), 2000);
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
    <p style="margin:0;max-width:720px">Allow Plembfin to share page views, time-on-page, browser/device details, referrer, and a coarse region with Traks and Google Analytics. Traks is cookieless; Google Analytics may use cookies or similar measurement technologies.</p>
    <span style="display:flex;gap:8px;flex:0 0 auto">
      <button type="button" data-analytics-decline style="padding:8px 12px;border:1px solid #64748b;border-radius:8px;background:transparent;color:inherit;cursor:pointer">Decline</button>
      <button type="button" data-analytics-allow style="padding:8px 12px;border:0;border-radius:8px;background:#38bdf8;color:#082f49;cursor:pointer;font-weight:600">Allow analytics</button>
    </span>`;

  const finish = (choice) => {
    writeConsent(choice);
    banner.remove();
    if (choice === "granted") loadAnalytics(config);
  };

  banner.querySelector("[data-analytics-decline]")?.addEventListener("click", () => finish("denied"));
  banner.querySelector("[data-analytics-allow]")?.addEventListener("click", () => finish("granted"));
  document.body.appendChild(banner);
}

async function boot() {
  if (privacySignalIsSet()) return;

  let response;
  try {
    response = await fetch(CONFIG_URL, { credentials: "same-origin", cache: "no-store" });
  } catch {
    return;
  }
  if (!response.ok) return;

  let config;
  try {
    config = await response.json();
  } catch {
    return;
  }
  if (!config?.enabled) return;

  const traksConfig = config.traks;
  const googleAnalyticsConfig = config.googleAnalytics;
  const traksEnabled = traksConfig?.enabled
    && typeof traksConfig.scriptUrl === "string"
    && typeof traksConfig.siteKey === "string"
    && /^https:\/\//i.test(traksConfig.scriptUrl);
  const googleAnalyticsEnabled = googleAnalyticsConfig?.enabled
    && typeof googleAnalyticsConfig.measurementId === "string"
    && /^G-[A-Z0-9]+$/i.test(googleAnalyticsConfig.measurementId);
  if (!traksEnabled && !googleAnalyticsEnabled) return;

  const consent = readConsent();
  if (config.requireConsent !== false) {
    if (consent === "granted") loadAnalytics(config);
    else if (consent !== "denied") showConsentPrompt(config);
    return;
  }

  scheduleAnalyticsLoad(config);
}

void boot();
