// Media-server and metadata-provider settings: Sonarr-style card grids backed
// by /api/config, with edit modals that save per-section payloads and test
// connections. Secrets follow the redacted-config contract — the server never
// echoes credentials, only a `configured` flag per section, and a blank secret
// on save means "keep the stored credential" (except Seerr, whose key is only
// sent when non-empty).
import { state } from "./state.js";
import { buildAuthHeaders } from "./auth.js";
import { openSettingsEditModal, openSettingsPickerModal, renderServiceCardGrid, renderFieldRow, collectFieldValues } from "./settings-ui.js";
import {
  plexCredentialGuide,
  embyCredentialGuide,
  jellyfinCredentialGuide,
  plexWebhookSetup,
  embyWebhookSetup,
  jellyfinWebhookSetup,
  savedCredentialNote,
} from "./help-content.js";

let _cb = {};
export function initSettingsServices(callbacks = {}) {
  _cb = callbacks;
}
const setMessage = (...args) => _cb.setMessage?.(...args);
const clearDerivedUiCaches = (...args) => _cb.clearDerivedUiCaches?.(...args);
const renderDashboard = (...args) => _cb.renderDashboard?.(...args);
const renderActiveSessions = (...args) => _cb.renderActiveSessions?.(...args);

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export async function refreshSeerrCapabilities() {
  if (!state.seerrConfigured) {
    state.seerrSupports4k = { movie: false, tv: false };
    return state.seerrSupports4k;
  }
  const response = await fetch("/api/seerr/status", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Seerr status failed with ${response.status}`);
  state.seerrSupports4k = {
    movie: Boolean(body.capabilities?.movie4k),
    tv: Boolean(body.capabilities?.tv4k),
  };
  return state.seerrSupports4k;
}

const seerrGuide = () => `
  <p class="tool-accordion-desc"><b>Seerr URL:</b> The base URL of your Seerr instance, typically <code>http://localhost:5055</code>.</p>
  <p class="tool-accordion-desc"><b>API Key:</b> Open Seerr → <b>Settings → General</b> and copy the <b>API Key</b> shown at the top of the page.</p>
  <p class="tool-accordion-desc">Once configured, a <b>"Request on Seerr"</b> button appears on every movie and TV show detail page.</p>
`;

const CONNECTION_SERVICES = {
  plex: {
    name: "Plex",
    description: "Sync watch history with a Plex server",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || config.url || "", placeholder: "http://127.0.0.1:32400", help: "Address Plembfin uses to reach Plex." },
      { key: "token", label: "Token", secret: true, configured: config.configured, configuredPlaceholder: "Configured - enter a new token to replace it", placeholder: "Plex token" },
      { key: "username", label: "Username", value: config.username || "", optional: true, help: "Plex account name used to match webhook events." },
    ],
    payload: (v) => ({ baseUrl: v.baseUrl, token: v.token, username: v.username, disabled: !v.enabled }),
    testPayload: (v) => ({ type: "plex", url: v.baseUrl, token: v.token }),
    help: () => plexCredentialGuide() + savedCredentialNote() + plexWebhookSetup(),
  },
  emby: {
    name: "Emby",
    description: "Sync watch history with an Emby server",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || config.url || "", placeholder: "http://127.0.0.1:8096", help: "Address Plembfin uses to reach Emby." },
      { key: "apiKey", label: "API Key", secret: true, configured: config.configured, placeholder: "Emby API key" },
      { key: "userId", label: "User ID", value: config.userId || "", help: "The Emby user whose playstate is synchronized." },
    ],
    payload: (v) => ({ baseUrl: v.baseUrl, apiKey: v.apiKey, userId: v.userId, disabled: !v.enabled }),
    testPayload: (v) => ({ type: "emby", url: v.baseUrl, token: v.apiKey }),
    help: () => embyCredentialGuide() + savedCredentialNote() + embyWebhookSetup(),
  },
  jellyfin: {
    name: "Jellyfin",
    description: "Sync watch history with a Jellyfin server",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || config.url || "", placeholder: "http://127.0.0.1:8096", help: "Address Plembfin uses to reach Jellyfin." },
      { key: "apiKey", label: "API Key", secret: true, configured: config.configured, placeholder: "Jellyfin API key" },
      { key: "userId", label: "User ID", value: config.userId || "", help: "The Jellyfin user whose playstate is synchronized." },
    ],
    payload: (v) => ({ baseUrl: v.baseUrl, apiKey: v.apiKey, userId: v.userId, disabled: !v.enabled }),
    testPayload: (v) => ({ type: "jellyfin", url: v.baseUrl, token: v.apiKey }),
    help: () => jellyfinCredentialGuide() + savedCredentialNote() + jellyfinWebhookSetup(),
  },
  seerr: {
    name: "Seerr",
    description: "Send media requests from detail pages",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || "", placeholder: "http://localhost:5055", help: "Base URL of your Overseerr / Jellyseerr instance." },
      { key: "apiKey", label: "API Key", secret: true, configured: config.configured, placeholder: "Seerr API key" },
    ],
    payload: (v) => {
      const payload = { baseUrl: v.baseUrl, disabled: !v.enabled };
      if (v.apiKey) payload.apiKey = v.apiKey;
      return payload;
    },
    help: () => savedCredentialNote() + seerrGuide(),
  },
};

const keySteps = (lines) => `<ol class="tool-accordion-desc" style="margin: 0; padding-left: 1.25rem; list-style: decimal; font-size: 0.8rem;">${lines.map((line) => `<li>${line}</li>`).join("")}</ol>`;

const METADATA_SERVICES = {
  tmdb: {
    name: "TMDB",
    description: "Artwork, cast, trailers, and metadata (required)",
    keyLabel: "API Key (v3)",
    keyPlaceholder: "TMDB API key",
    keyHelp: "Free v3 developer key — powers posters, cast, and detail pages.",
    help: () => `
      <p class="tool-accordion-desc">Provides poster artwork, cast directories, descriptions, and related recommendations. To obtain a free v3 API key:</p>
      ${keySteps(["Create an account at <b>themoviedb.org</b>", "Go to <b>Settings → API</b> in your profile menu", "Request a Developer key"])}
    `,
  },
  youtube: {
    name: "YouTube",
    description: "Trailer details and durations",
    keyLabel: "Data API Key",
    keyPlaceholder: "YouTube Data API key (optional)",
    optional: true,
    help: () => `
      <p class="tool-accordion-desc">Enables downloading trailer meta descriptions and length info. To create a key:</p>
      ${keySteps(["Go to <b>console.cloud.google.com</b>", "Enable the <b>YouTube Data API v3</b> in your project", "Generate an API Key under Credentials"])}
    `,
  },
  fanart: {
    name: "Fanart.tv",
    description: "Fallback posters, backdrops, and logos",
    keyLabel: "Personal API Key",
    keyPlaceholder: "Personal API key (optional)",
    optional: true,
    keyHelp: "A built-in project key is already configured — a personal key raises rate limits.",
    help: () => `
      <p class="tool-accordion-desc">Plembfin uses fanart.tv as a fallback source for posters, backdrops, and logo art when TMDB has no images for a title. A built-in project key is already configured — no key is required to use this feature.</p>
      <p class="tool-accordion-desc">Entering your own personal API key gives you higher rate limits and access to images uploaded by your fanart.tv account:</p>
      ${keySteps(["Create an account at <b>fanart.tv</b>", "Go to your <b>Profile → API Key</b>", "Copy your personal key and paste it here"])}
    `,
  },
  tvdb: {
    name: "TheTVDB",
    description: "Episode ordering and air dates",
    keyLabel: "Personal API Key",
    keyPlaceholder: "Personal API key (optional)",
    optional: true,
    keyHelp: "A built-in project key is already configured — a personal key gives you your own quota.",
    help: () => `
      <p class="tool-accordion-desc">TV show names, seasons, episode numbering, air dates, and artwork are sourced from TheTVDB for more accurate episode ordering than TMDB alone. A built-in project key is already configured — no key is required to use this feature.</p>
      ${keySteps(["Create an account at <b>thetvdb.com</b>", "Go to <b>Dashboard → API Keys</b> and request a key", "Copy your personal key and paste it here"])}
    `,
  },
  omdb: {
    name: "OMDb",
    description: "IMDb ratings on movie pages",
    keyLabel: "API Key",
    keyPlaceholder: "OMDb API key",
    optional: true,
    help: () => `
      <p class="tool-accordion-desc">When configured, Plembfin fetches IMDb ratings from the OMDb API and shows them next to the TMDB score on movie pages. Ratings are cached for 7 days; the free tier allows 1,000 requests/day.</p>
      ${keySteps(["Go to <b>omdbapi.com/apikey.aspx</b>", "Register for a free API key", "Paste the key here and save"])}
    `,
  },
};

export const SERVICE_DEFS = Object.freeze({ ...CONNECTION_SERVICES, ...METADATA_SERVICES });

// Sync tuning is not part of the add/remove service picker — it's a single,
// always-visible card, so it's kept out of CONNECTION_SERVICES/METADATA_SERVICES
// (which drive the "Add Media Server"/"Add Metadata Provider" pickers).
const TUNING_FIELD_DEFS = [
  { key: "watchedThresholdPercent", label: "Watched Threshold", unit: "%", help: "Playback progress percentage at which a play counts as watched." },
  { key: "minResumePositionSec", label: "Minimum Resume Position", unit: "sec", help: "Minimum playback position before a stopped play is saved as a resume point." },
  { key: "activeSessionTtlMin", label: "Active Session TTL", unit: "min", help: `How long a "now playing" session is kept without an update before it's considered stale.` },
  { key: "outboundTimeoutSec", label: "Outbound Request Timeout", unit: "sec", help: "How long Plembfin waits for a response from Plex, Emby, or Jellyfin before giving up." },
];
const EXTRA_SERVICE_NAMES = { tuning: "Sync Tuning" };

function tuningBadges(tuning = {}) {
  const overriddenCount = TUNING_FIELD_DEFS.filter((field) => tuning[field.key]?.overridden).length;
  if (!overriddenCount) return [{ label: "Defaults", tone: "muted" }];
  return [{ label: `${overriddenCount} customized`, tone: "ready" }];
}

function syncTuningFieldSpecs(tuning = {}) {
  return TUNING_FIELD_DEFS.map((field) => {
    const info = tuning[field.key] || {};
    return {
      key: field.key,
      label: `${field.label}${field.unit ? ` (${field.unit})` : ""}`,
      type: "number",
      value: info.overridden ? info.value : "",
      placeholder: info.default != null ? String(info.default) : "",
      optional: true,
      help: `${field.help} Default: ${info.default}${field.unit || ""}. Valid range: ${info.min}-${info.max}.`,
    };
  });
}

// Blank ⇒ null ⇒ configStore.js interprets null as "not overridden, fall back
// to the environment variable or built-in default" (see server/src/utils/tuning.js).
function syncTuningPayload(values = {}) {
  const payload = {};
  for (const field of TUNING_FIELD_DEFS) {
    const raw = String(values[field.key] ?? "").trim();
    payload[field.key] = raw === "" ? null : Number(raw);
  }
  return payload;
}

// Renders the sync tuning fields directly into the page (no edit modal) and
// wires the form's submit handler to save them in place.
export function renderSyncTuningCard() {
  const fieldsContainer = document.querySelector("#syncTuningFields");
  const form = document.querySelector("#syncTuningForm");
  if (!fieldsContainer || !form) return;
  const tuning = state.savedConfig?.tuning || {};
  fieldsContainer.innerHTML = syncTuningFieldSpecs(tuning).map(renderFieldRow).join("");

  if (form.dataset.bound) return;
  form.dataset.bound = "true";
  const statusEl = document.querySelector("#syncTuningStatus");
  const setStatus = (text, tone = "muted") => {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.className = `message ${tone}`;
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveButton = document.querySelector("#saveSyncTuningButton");
    if (saveButton) saveButton.disabled = true;
    setStatus("Saving...", "muted");
    try {
      await saveServiceConfig("tuning", syncTuningPayload(collectFieldValues(fieldsContainer)));
      setStatus("Saved.", "success");
    } catch (error) {
      setStatus(error?.message || "Save failed.", "error");
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  });
}

function connectionTouched(config) {
  return Boolean(config && (config.configured || config.baseUrl || config.url || config.disabled === true));
}

function connectionBadges(config = {}) {
  if (config.disabled) return [{ label: "Disabled", tone: "muted" }];
  if (config.configured) return [{ label: "Enabled", tone: "ready" }];
  return [{ label: "Not configured", tone: "warning" }];
}

function metadataVisible(id, config) {
  return id === "tmdb" || Boolean(config?.configured);
}

function metadataBadges(id, config = {}) {
  if (config.configured) return [{ label: "Configured", tone: "ready" }];
  return [{ label: id === "tmdb" ? "Required" : "Not configured", tone: "warning" }];
}

// Posts one config section and mirrors the old per-section post-save behavior:
// prefer the server's redacted echo, recompute `configured` locally when the
// echo is missing, refresh Seerr capabilities, and repaint dependent UI.
async function saveServiceConfig(section, sectionPayload) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ [section]: sectionPayload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Save failed with ${response.status}`);

  const savedSectionConfig = body.config?.[section];
  const previousSectionConfig = state.savedConfig?.[section] || {};
  state.savedConfig = {
    ...state.savedConfig,
    [section]: savedSectionConfig || sectionPayload,
  };
  if (!savedSectionConfig) {
    if (METADATA_SERVICES[section]) {
      state.savedConfig[section] = {
        configured: Boolean(sectionPayload.apiKey || previousSectionConfig.configured),
      };
    } else if (section === "seerr") {
      const apiKeySet = Boolean(sectionPayload.apiKey || previousSectionConfig.configured);
      state.savedConfig.seerr = {
        configured: apiKeySet && Boolean(sectionPayload.baseUrl) && !sectionPayload.disabled,
        baseUrl: sectionPayload.baseUrl || "",
        disabled: Boolean(sectionPayload.disabled),
      };
    }
  }
  if (section === "seerr") {
    state.seerrConfigured = Boolean(state.savedConfig.seerr?.configured);
    await refreshSeerrCapabilities().catch(() => {
      state.seerrSupports4k = { movie: false, tv: false };
    });
  }

  state.configLoaded = true;
  clearDerivedUiCaches();
  renderDashboard();
  renderActiveSessions();
  renderMediaServerCards();
  renderMetadataCards();
  renderSyncTuningCard();
  setMessage(`Saved ${SERVICE_DEFS[section]?.name || EXTRA_SERVICE_NAMES[section] || section} settings successfully.`, "success");
  return body;
}

// Tests a media-server connection from modal values. A blank secret is allowed
// when the server is already configured — the backend falls back to the stored
// credential.
async function testServiceConnection(section, values) {
  const def = CONNECTION_SERVICES[section];

  if (section === "seerr") {
    await saveServiceConfig("seerr", def.payload(values));
    if (!state.seerrConfigured) throw new Error("Enter a Seerr server URL and API key first.");
    const response = await fetch("/api/seerr/status", { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "Connection failed");
    state.seerrSupports4k = {
      movie: Boolean(body.capabilities?.movie4k),
      tv: Boolean(body.capabilities?.tv4k),
    };
    return `✔ Connected to "${body.applicationTitle || "Seerr"}"`;
  }

  const payload = def.testPayload(values);
  if (!payload.url || (!payload.token && !state.savedConfig?.[section]?.configured)) {
    throw new Error("Server URL and token are required.");
  }
  const response = await fetch("/api/test-connection", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok && body.ok) {
    return `✔ ${body.detail || "Server identity verified"} in ${body.elapsedMs || 0}ms (HTTP ${body.status || response.status})`;
  }
  const statusText = body.status ? `HTTP ${body.status}` : `HTTP ${response.status}`;
  throw new Error(`${body.error || "Connection failed"} (${statusText})`);
}

export function openServiceEditModal(serviceId) {
  const connection = CONNECTION_SERVICES[serviceId];
  const metadata = METADATA_SERVICES[serviceId];
  const def = connection || metadata;
  if (!def) return;
  const config = state.savedConfig?.[serviceId] || {};

  const fields = connection
    ? def.fields(config)
    : [{
        key: "apiKey",
        label: def.keyLabel,
        secret: true,
        configured: config.configured,
        placeholder: def.keyPlaceholder,
        optional: def.optional,
        help: def.keyHelp,
      }];

  openSettingsEditModal({
    title: `${connectionTouched(config) || config.configured ? "Edit" : "Add"} ${def.name}`,
    fields,
    enabledKey: connection ? "enabled" : "",
    saveDisabledLabel: connection ? "Save & disable" : "",
    onSave: (values) => saveServiceConfig(serviceId, connection ? def.payload(values) : { apiKey: values.apiKey }),
    onTest: connection ? (values) => testServiceConnection(serviceId, values) : undefined,
    helpHtml: def.help?.() || "",
  });
}

function openServicePicker(area) {
  const defs = area === "connection" ? CONNECTION_SERVICES : METADATA_SERVICES;
  const config = state.savedConfig || {};
  const items = Object.entries(defs)
    .filter(([id]) => (area === "connection" ? !connectionTouched(config[id]) : !metadataVisible(id, config[id])))
    .map(([id, def]) => ({ id, name: def.name, description: def.description }));
  openSettingsPickerModal({
    title: area === "connection" ? "Add Media Server" : "Add Metadata Provider",
    intro: area === "connection"
      ? "Plembfin keeps watch history in sync across every connected server."
      : "Metadata providers enrich detail pages with artwork, ratings, and episode data.",
    items,
    onPick: (id) => openServiceEditModal(id),
  });
}

export function renderMediaServerCards() {
  const container = document.querySelector("#mediaServerCards");
  if (!container) return;
  const config = state.savedConfig || {};
  const ids = Object.keys(CONNECTION_SERVICES);
  const visible = ids.filter((id) => connectionTouched(config[id]));
  const remaining = ids.filter((id) => !connectionTouched(config[id]));
  renderServiceCardGrid(container, {
    items: visible.map((id) => ({
      id,
      name: CONNECTION_SERVICES[id].name,
      description: CONNECTION_SERVICES[id].description,
      badges: connectionBadges(config[id]),
    })),
    onSelect: openServiceEditModal,
    onAdd: remaining.length ? () => openServicePicker("connection") : null,
    addLabel: "Add media server",
  });
}

export function renderMetadataCards() {
  const container = document.querySelector("#metadataProviderCards");
  if (!container) return;
  const config = state.savedConfig || {};
  const ids = Object.keys(METADATA_SERVICES);
  const visible = ids.filter((id) => metadataVisible(id, config[id]));
  const remaining = ids.filter((id) => !metadataVisible(id, config[id]));
  renderServiceCardGrid(container, {
    items: visible.map((id) => ({
      id,
      name: METADATA_SERVICES[id].name,
      description: METADATA_SERVICES[id].description,
      badges: metadataBadges(id, config[id]),
    })),
    onSelect: openServiceEditModal,
    onAdd: remaining.length ? () => openServicePicker("metadata") : null,
    addLabel: "Add metadata provider",
  });
}

// Replaces the old populateConfigForm(): applies a freshly loaded redacted
// config to the settings UI (card grids + the global Seerr flag).
export function applyConfigToSettingsUi(config = {}) {
  state.seerrConfigured = Boolean(config.seerr?.configured);
  renderMediaServerCards();
  renderMetadataCards();
  renderSyncTuningCard();
}
