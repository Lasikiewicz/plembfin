const GROUPS = {
  account: {
    label: "Account & Security",
    shortLabel: "Account",
    defaultTask: "login",
    tasks: {
      login: { label: "Admin login", panel: "general", subPanels: ["general-login"] },
    },
  },
  connections: {
    label: "Connections",
    defaultTask: "plex",
    tasks: {
      plex: { label: "Plex", panel: "apps", subPanels: ["apps-plex"] },
      emby: { label: "Emby", panel: "apps", subPanels: ["apps-emby"] },
      jellyfin: { label: "Jellyfin", panel: "apps", subPanels: ["apps-jellyfin"] },
      seerr: { label: "Seerr", panel: "apps", subPanels: ["apps-seerr"] },
      webhooks: { label: "Webhooks", panel: "general", subPanels: ["general-endpoints"] },
    },
  },
  metadata: {
    label: "Metadata",
    defaultTask: "tmdb",
    tasks: {
      tmdb: { label: "TMDB", panel: "api-keys", subPanels: ["api-tmdb"] },
      youtube: { label: "YouTube", panel: "api-keys", subPanels: ["api-youtube"] },
      fanart: { label: "Fanart.tv", panel: "api-keys", subPanels: ["api-fanart"] },
      tvdb: { label: "TheTVDB", panel: "api-keys", subPanels: ["api-tvdb"] },
      omdb: { label: "OMDb", panel: "api-keys", subPanels: ["api-omdb"] },
    },
  },
  data: {
    label: "Data & Backup",
    defaultTask: "backups",
    tasks: {
      backups: { label: "Backups", panel: "backups", backupTab: "settings" },
      restore: { label: "Restore", panel: "backups", backupTab: "restore" },
      import: { label: "Trakt import", panel: "tools", subPanels: ["tools-migration"] },
    },
  },
  system: {
    label: "System",
    defaultTask: "health",
    tasks: {
      health: { label: "Health", panel: "tools", subPanels: ["tools-diagnostics"] },
      sync: { label: "Sync", panel: "sync", subPanels: ["sync-issues", "sync-history", "sync-tools"] },
      logs: { label: "Logs", panel: "logs" },
      storage: { label: "Storage", panel: "cache" },
      about: { label: "About", panel: "changelog" },
      advanced: { label: "Advanced", panel: "tools", subPanels: ["tools-repairs", "tools-sync"] },
    },
  },
};

const LEGACY_PATHS = {
  "/sync": "/settings/system/sync",
  "/logs": "/settings/system/logs",
  "/settings/general": "/settings/account/login",
  "/settings/apps": "/settings/connections/plex",
  "/settings/api-keys": "/settings/metadata/tmdb",
  "/settings/backups": "/settings/data/backups",
  "/settings/tools": "/settings/system/advanced",
  "/settings/sync": "/settings/system/sync",
  "/settings/logs": "/settings/system/logs",
  "/settings/cache": "/settings/system/storage",
  "/settings/changelog": "/settings/system/about",
};

const LEGACY_TABS = {
  general: "/settings/account/login",
  apps: "/settings/connections/plex",
  "api-keys": "/settings/metadata/tmdb",
  backups: "/settings/data/backups",
  tools: "/settings/system/advanced",
  sync: "/settings/system/sync",
  logs: "/settings/system/logs",
  cache: "/settings/system/storage",
  changelog: "/settings/system/about",
};

export const SETTINGS_GROUPS = Object.freeze(GROUPS);

function cleanPath(value = "") {
  const path = String(value || "/settings").split(/[?#]/, 1)[0] || "/settings";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function settingsPathForLegacy(value = "") {
  const key = String(value || "").trim();
  if (key.startsWith("/")) return LEGACY_PATHS[cleanPath(key)] || cleanPath(key);
  return LEGACY_TABS[key] || (GROUPS[key] ? `/settings/${key}` : "/settings");
}

export function parseSettingsRoute(value = "/settings", { mustChangePassword = false } = {}) {
  const requestedPath = cleanPath(value);
  if (mustChangePassword) {
    const task = GROUPS.account.tasks.login;
    return { kind: "task", group: "account", task: "login", path: "/settings/account/login", requestedPath, title: "Account & Security", ...task };
  }

  const canonicalLegacy = LEGACY_PATHS[requestedPath];
  const canonicalPath = canonicalLegacy || requestedPath;
  if (canonicalPath === "/settings") {
    return { kind: "overview", group: "overview", task: "", path: "/settings", requestedPath, title: "Settings overview" };
  }

  const parts = canonicalPath.split("/").filter(Boolean);
  if (parts[0] !== "settings" || !GROUPS[parts[1]]) {
    return { kind: "overview", group: "overview", task: "", path: "/settings", requestedPath, title: "Settings overview" };
  }

  const group = parts[1];
  const groupDefinition = GROUPS[group];
  const taskName = groupDefinition.tasks[parts[2]] ? parts[2] : groupDefinition.defaultTask;
  const task = groupDefinition.tasks[taskName];
  return {
    kind: "task",
    group,
    task: taskName,
    path: `/settings/${group}/${taskName}`,
    requestedPath,
    title: taskName === groupDefinition.defaultTask ? groupDefinition.label : `${groupDefinition.label} - ${task.label}`,
    ...task,
  };
}

export function settingsDashboardSummary({ config = {}, configLoaded = false, watchBackups = null, plembfinBackups = null, backupsLoading = false, syncJobs = [], syncJobsLoaded = false, syncJobsLoading = false, syncActive = false } = {}) {
  const connectionKeys = ["plex", "emby", "jellyfin", "seerr"];
  const enabledConnections = connectionKeys.filter((key) => !config[key]?.disabled);
  const connected = enabledConnections.filter((key) => config[key]?.configured);
  const connectionAttention = enabledConnections.filter((key) => !config[key]?.configured);
  const connections = !configLoaded
    ? { tone: "unknown", label: "Unknown", detail: "Configuration has not loaded yet." }
    : connectionAttention.length
      ? { tone: "warning", label: `${connectionAttention.length} need attention`, detail: `${connected.length} of ${enabledConnections.length} enabled services are configured.` }
      : enabledConnections.length
        ? { tone: "ready", label: `${connected.length} connected`, detail: "Enabled media services have saved credentials." }
        : { tone: "muted", label: "None enabled", detail: "Connect a media service to begin syncing." };

  const metadataKeys = ["tmdb", "youtube", "fanart", "tvdb", "omdb"];
  const metadataCount = metadataKeys.filter((key) => config[key]?.configured).length;
  const metadata = !configLoaded
    ? { tone: "unknown", label: "Unknown", detail: "Metadata configuration has not loaded yet." }
    : !config.tmdb?.configured
      ? { tone: "warning", label: "TMDB required", detail: `${metadataCount} of ${metadataKeys.length} providers have personal keys.` }
      : { tone: "ready", label: `${metadataCount} configured`, detail: "TMDB is ready; other providers are optional." };

  const backupSources = [watchBackups, plembfinBackups].filter(Boolean);
  const backupConfigs = backupSources.map((item) => item?.config || {});
  const scheduled = backupConfigs.some((item) => item.enabled || item.remoteEnabled);
  const backupErrors = backupSources.map((item) => item?.runtime?.lastError || item?.runtime?.lastRemoteError).filter(Boolean);
  const successfulDates = backupSources.map((item) => Date.parse(item?.runtime?.lastSuccessAt || "")).filter(Number.isFinite);
  const lastSuccess = successfulDates.length ? Math.max(...successfulDates) : 0;
  const stale = scheduled && lastSuccess && Date.now() - lastSuccess > 48 * 60 * 60 * 1000;
  const backups = backupsLoading && !backupSources.length
    ? { tone: "loading", label: "Loading", detail: "Reading backup schedules and recent runs." }
    : !backupSources.length
      ? { tone: "unknown", label: "Unknown", detail: "Backup status has not loaded yet." }
      : backupErrors.length
        ? { tone: "warning", label: "Action required", detail: "A recent backup operation reported an error." }
        : !scheduled
          ? { tone: "muted", label: "Not scheduled", detail: "Manual backups remain available." }
          : stale
            ? { tone: "warning", label: "Backup may be stale", detail: "No successful scheduled backup was recorded in the last 48 hours." }
            : { tone: "ready", label: "Scheduled", detail: lastSuccess ? "A recent scheduled backup completed successfully." : "The schedule is enabled; no successful run is recorded yet." };

  const sync = syncActive
    ? { tone: "loading", label: "Sync running", detail: "A manual synchronization is currently active." }
    : syncJobsLoading && !syncJobsLoaded
      ? { tone: "loading", label: "Loading", detail: "Checking unresolved synchronization work." }
      : !syncJobsLoaded
        ? { tone: "unknown", label: "Unknown", detail: "Sync status has not loaded yet." }
        : syncJobs.length
          ? { tone: "warning", label: `${syncJobs.length} unresolved`, detail: "Review failed or outstanding propagation attempts." }
          : { tone: "ready", label: "No open issues", detail: "No unresolved synchronization work is currently listed." };

  return { connections, metadata, backups, sync };
}

function setStatusRow(key, status) {
  const row = document.querySelector(`[data-settings-status="${key}"]`);
  if (!row) return;
  row.dataset.tone = status.tone;
  const label = row.querySelector("[data-status-label]");
  const detail = row.querySelector("[data-status-detail]");
  if (label) label.textContent = status.label;
  if (detail) detail.textContent = status.detail;
}

export function renderSettingsDashboard(source = {}) {
  const summary = settingsDashboardSummary(source);
  for (const [key, status] of Object.entries(summary)) setStatusRow(key, status);
  return summary;
}

function moveHelpIntoDisclosure(row) {
  const help = row.querySelector(":scope > .settings-row-help");
  const main = row.querySelector(":scope > .settings-row-main");
  if (!help || !main) return;
  const details = document.createElement("details");
  details.className = "settings-help-disclosure";
  const summary = document.createElement("summary");
  summary.textContent = "Setup help";
  const body = document.createElement("div");
  body.className = "settings-help-body";
  while (help.firstChild) body.append(help.firstChild);
  details.append(summary, body);
  main.append(details);
  help.remove();
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
  document.querySelectorAll(".settings-row").forEach(moveHelpIntoDisclosure);
  prepareAdvancedDisclosures();
}

function renderTaskNavigation(route) {
  const nav = document.querySelector("#settingsTaskNav");
  if (!nav) return;
  if (route.kind === "overview") {
    nav.replaceChildren();
    nav.classList.add("hidden");
    return;
  }
  const group = GROUPS[route.group];
  nav.classList.toggle("hidden", Object.keys(group.tasks).length <= 1);
  nav.innerHTML = Object.entries(group.tasks).map(([key, task]) => {
    const active = key === route.task;
    return `<button class="settings-task-link${active ? " active" : ""}" type="button" data-settings-path="/settings/${route.group}/${key}"${active ? ' aria-current="page"' : ""}>${task.label}</button>`;
  }).join("");
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
  if (select) select.value = route.kind === "overview" ? "/settings" : `/settings/${route.group}`;
  renderTaskNavigation(route);
  return route;
}

export function focusSettingsRoute(route) {
  const target = route?.kind === "overview"
    ? document.querySelector("#settingsOverviewTitle")
    : document.querySelector("#settingsTaskNav [aria-current=\"page\"]") || document.querySelector(`[data-settings-panel="${route?.panel}"]:not(.hidden) .section-heading p`);
  if (!target) return;
  if (!target.matches("button, a, input, select, textarea")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}
