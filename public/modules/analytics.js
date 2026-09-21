const CONFIG_URL = "/analytics-config.json";

function privacySignalIsSet() {
  return navigator.doNotTrack === "1"
    || window.doNotTrack === "1"
    || navigator.globalPrivacyControl === true;
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
    && (() => {
      try {
        const scriptUrl = new URL(traksConfig.scriptUrl, window.location.href);
        return scriptUrl.origin === window.location.origin && scriptUrl.pathname === "/t";
      } catch {
        return false;
      }
    })();
  const googleAnalyticsEnabled = googleAnalyticsConfig?.enabled
    && typeof googleAnalyticsConfig.measurementId === "string"
    && /^G-[A-Z0-9]+$/i.test(googleAnalyticsConfig.measurementId);
  if (!traksEnabled && !googleAnalyticsEnabled) return;

  scheduleAnalyticsLoad(config);
}

void boot();
