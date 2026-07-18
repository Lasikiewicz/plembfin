// Settings navigation shell: the flat section list, route parsing with legacy
// redirects, the Sonarr-style landing page, the settings sidebar, and the
// panel show/hide engine. Pure route logic lives at the top so it stays
// testable under Node without a DOM.
const SECTIONS = {
  "media-servers": {
    label: "Media Servers",
    description: "Plex, Emby, Jellyfin, and Seerr connections",
    panel: "apps",
  },
  metadata: {
    label: "Metadata",
    description: "TMDB, TVDB, Fanart.tv, OMDb, and YouTube providers",
    panel: "api-keys",
  },
  webhooks: {
    label: "Webhooks",
    description: "Webhook listener and background scheduler endpoints",
    panel: "general",
    subPanels: ["general-endpoints"],
  },
  account: {
    label: "Account & Security",
    description: "Administrator username, password, and sessions",
    panel: "general",
    subPanels: ["general-login"],
  },
  backups: {
    label: "Backups",
    description: "Backup schedules and remote destinations",
    panel: "backups",
    backupTab: "settings",
  },
  restore: {
    label: "Restore",
    description: "Recover watch history or a full encrypted backup",
    panel: "backups",
    backupTab: "restore",
  },
  import: {
    label: "Import",
    description: "Bring watch history in from Trakt or CSV exports",
    panel: "tools",
    subPanels: ["tools-migration"],
  },
  sync: {
    label: "Sync",
    description: "Unresolved sync issues, history, and repair tools",
    panel: "sync",
    subPanels: ["sync-issues", "sync-tuning", "sync-history", "sync-tools"],
  },
  health: {
    label: "Health",
    description: "Connection diagnostics and system checks",
    panel: "tools",
    subPanels: ["tools-diagnostics"],
  },
  logs: {
    label: "Logs",
    description: "Live server and browser diagnostic output",
    panel: "logs",
  },
  storage: {
    label: "Storage & Cache",
    description: "Artwork and metadata cache usage",
    panel: "cache",
  },
  advanced: {
    label: "Advanced",
    description: "Database repairs, rebuilds, and backfills",
    panel: "tools",
    subPanels: ["tools-repairs", "tools-sync"],
  },
  about: {
    label: "About",
    description: "Version and changelog",
    panel: "changelog",
  },
};

const LEGACY_PATHS = {
  "/sync": "/settings/sync",
  "/logs": "/settings/logs",
  "/settings/general": "/settings/account",
  "/settings/apps": "/settings/media-servers",
  "/settings/api-keys": "/settings/metadata",
  "/settings/tools": "/settings/advanced",
  "/settings/cache": "/settings/storage",
  "/settings/changelog": "/settings/about",
  "/settings/account/login": "/settings/account",
  "/settings/connections": "/settings/media-servers",
  "/settings/connections/plex": "/settings/media-servers",
  "/settings/connections/emby": "/settings/media-servers",
  "/settings/connections/jellyfin": "/settings/media-servers",
  "/settings/connections/seerr": "/settings/media-servers",
  "/settings/connections/webhooks": "/settings/webhooks",
  "/settings/metadata/tmdb": "/settings/metadata",
  "/settings/metadata/youtube": "/settings/metadata",
  "/settings/metadata/fanart": "/settings/metadata",
  "/settings/metadata/tvdb": "/settings/metadata",
  "/settings/metadata/omdb": "/settings/metadata",
  "/settings/data": "/settings/backups",
  "/settings/data/backups": "/settings/backups",
  "/settings/data/restore": "/settings/restore",
  "/settings/data/import": "/settings/import",
  "/settings/system": "/settings/health",
  "/settings/system/health": "/settings/health",
  "/settings/system/sync": "/settings/sync",
  "/settings/system/logs": "/settings/logs",
  "/settings/system/storage": "/settings/storage",
  "/settings/system/about": "/settings/about",
  "/settings/system/advanced": "/settings/advanced",
};

const LEGACY_TABS = {
  general: "/settings/account",
  apps: "/settings/media-servers",
  "api-keys": "/settings/metadata",
  backups: "/settings/backups",
  tools: "/settings/advanced",
  sync: "/settings/sync",
  logs: "/settings/logs",
  cache: "/settings/storage",
  changelog: "/settings/about",
};

export const SETTINGS_SECTIONS = Object.freeze(SECTIONS);

function cleanPath(value = "") {
  const path = String(value || "/settings").split(/[?#]/, 1)[0] || "/settings";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function settingsPathForLegacy(value = "") {
  const key = String(value || "").trim();
  if (key.startsWith("/")) return LEGACY_PATHS[cleanPath(key)] || cleanPath(key);
  return LEGACY_TABS[key] || (SECTIONS[key] ? `/settings/${key}` : "/settings");
}

function sectionRoute(section, requestedPath) {
  const definition = SECTIONS[section];
  return {
    kind: "task",
    group: section,
    task: "",
    path: `/settings/${section}`,
    requestedPath,
    title: definition.label,
    panel: definition.panel,
    subPanels: definition.subPanels,
    backupTab: definition.backupTab,
  };
}

export function parseSettingsRoute(value = "/settings", { mustChangePassword = false } = {}) {
  const requestedPath = cleanPath(value);
  if (mustChangePassword) return sectionRoute("account", requestedPath);

  const canonicalPath = LEGACY_PATHS[requestedPath] || requestedPath;
  if (canonicalPath === "/settings") {
    return { kind: "overview", group: "overview", task: "", path: "/settings", requestedPath, title: "Settings overview" };
  }

  const parts = canonicalPath.split("/").filter(Boolean);
  if (parts[0] !== "settings" || !SECTIONS[parts[1]]) {
    return { kind: "overview", group: "overview", task: "", path: "/settings", requestedPath, title: "Settings overview" };
  }
  return sectionRoute(parts[1], requestedPath);
}

function renderSettingsSidebar() {
  const menu = document.querySelector("#sidebarSettingsMenu");
  if (!menu) return;
  menu.querySelectorAll("[data-settings-group]").forEach((el) => el.remove());
  const lockButton = menu.querySelector("#lockButton");
  const fragment = document.createDocumentFragment();
  for (const [id, definition] of Object.entries(SECTIONS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-tab";
    button.dataset.settingsGroup = id;
    button.dataset.settingsPath = `/settings/${id}`;
    button.textContent = definition.label;
    fragment.append(button);
  }
  menu.insertBefore(fragment, lockButton || null);
}

function renderSettingsSectionSelect() {
  const select = document.querySelector("#settingsSectionSelect");
  if (!select) return;
  select.replaceChildren();
  const overview = document.createElement("option");
  overview.value = "/settings";
  overview.textContent = "Overview";
  select.append(overview);
  for (const [id, definition] of Object.entries(SECTIONS)) {
    const option = document.createElement("option");
    option.value = `/settings/${id}`;
    option.textContent = definition.label;
    select.append(option);
  }
}

function renderSettingsOverview() {
  const list = document.querySelector("#settingsOverviewList");
  if (!list) return;
  list.replaceChildren();
  for (const [id, definition] of Object.entries(SECTIONS)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "settings-link-row";
    row.dataset.settingsPath = `/settings/${id}`;
    const title = document.createElement("strong");
    title.textContent = definition.label;
    const description = document.createElement("span");
    description.textContent = definition.description;
    row.append(title, description);
    list.append(row);
  }
}

function prepareAdvancedDisclosures() {
  const labels = {
    "tools-repairs": ["Database repairs", "Correct damaged or duplicated local history records."],
    "tools-sync": ["Library rebuilds and backfills", "Reprocess local metadata or push the complete archive to connected services."],
  };
  for (const [name, copy] of Object.entries(labels)) {
    const row = document.querySelector(`[data-sub-panel="${name}"]`);
    if (!row || row.closest(".settings-advanced-disclosure")) continue;
    const details = document.createElement("details");
    details.className = "settings-advanced-disclosure";
    details.dataset.settingsAdvanced = name;
    const summary = document.createElement("summary");
    summary.innerHTML = `<span><strong>${copy[0]}</strong><small>${copy[1]}</small></span><span aria-hidden="true">+</span>`;
    row.before(details);
    details.append(summary, row);
  }
}

export function prepareSettingsShell() {
  renderSettingsSidebar();
  renderSettingsSectionSelect();
  renderSettingsOverview();
  prepareAdvancedDisclosures();
}

export function applySettingsRoute(route) {
  document.querySelector("#settingsOverview")?.classList.toggle("hidden", route.kind !== "overview");
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => panel.classList.add("hidden"));
  document.querySelectorAll("[data-sub-panel]").forEach((panel) => panel.classList.add("hidden"));
  document.querySelectorAll("[data-settings-advanced]").forEach((panel) => panel.classList.add("hidden"));

  if (route.kind === "task") {
    const panels = [...document.querySelectorAll(`[data-settings-panel="${route.panel}"]`)];
    for (const panel of panels) panel.classList.remove("hidden");
    if (route.subPanels?.length) {
      for (const name of route.subPanels) {
        document.querySelector(`[data-sub-panel="${name}"]`)?.classList.remove("hidden");
        document.querySelector(`[data-settings-advanced="${name}"]`)?.classList.remove("hidden");
      }
    }
    if (route.panel === "backups") {
      for (const panel of panels) panel.classList.toggle("hidden", panel.dataset.backupsPanel !== route.backupTab);
    }
  }

  document.querySelectorAll("[data-settings-group]").forEach((button) => {
    const active = route.group === button.dataset.settingsGroup;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const select = document.querySelector("#settingsSectionSelect");
  if (select) select.value = route.kind === "overview" ? "/settings" : route.path;
  return route;
}

export function focusSettingsRoute(route) {
  const target = route?.kind === "overview"
    ? document.querySelector("#settingsOverviewTitle")
    : document.querySelector(`[data-settings-panel="${route?.panel}"]:not(.hidden) .section-heading p`)
      || document.querySelector(`[data-settings-panel="${route?.panel}"]:not(.hidden)`);
  if (!target) return;
  if (!target.matches("button, a, input, select, textarea")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}
