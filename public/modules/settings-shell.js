// Settings navigation shell: hierarchical section groups and route parsing with
// legacy redirects, the Sonarr-style landing page, the settings sidebar, and the
// panel show/hide engine. Pure route logic lives at the top so it stays
// testable under Node without a DOM.

// Flat section definitions (each maps to a route + panel/subPanel combo)
const SECTIONS = {
  // Parent groups show all their child sections on one page
  general: {
    label: "General",
    description: "Account and sync tuning configuration",
    panel: "general",
    subPanels: ["general-login", "sync-tuning"],
  },
  "media-servers-group": {
    label: "Media servers",
    description: "Media servers and webhook configuration",
    views: [{ panel: "apps", subPanels: ["seerr"] }, { panel: "general", subPanels: ["general-endpoints"] }],
  },
  "sync-group": {
    label: "Sync",
    description: "Sync issues and history",
    panel: "sync",
    subPanels: ["sync-issues", "sync-history", "sync-tools"],
  },
  "backup-restore-group": {
    label: "Backup / restore",
    description: "Backup and restore configuration",
    views: [
      { panel: "backups", backupTab: "settings" },
      { panel: "backups", backupTab: "restore" },
    ],
  },
  "tools-group": {
    label: "Tools",
    description: "Database repairs and library rebuilds",
    panel: "tools",
    subPanels: ["tools-repairs", "tools-sync"],
  },
  "advanced-group": {
    label: "Advanced",
    description: "Advanced settings",
    views: [{ panel: "tools", subPanels: ["tools-diagnostics"] }, { panel: "cache" }],
  },
  // Account and Sync Tuning are sections on the General page
  account: {
    label: "Account",
    description: "Administrator username, password, and sessions",
    panel: "general",
    subPanels: ["general-login"],
    isDisplayOnly: true, // Not a navigable route
  },
  "sync-tuning": {
    label: "Sync tuning",
    description: "Configure watched threshold, resume position, and timeouts",
    panel: "general",
    subPanels: ["sync-tuning"],
    isDisplayOnly: true, // Not a navigable route
  },
  seerr: {
    label: "Seerr",
    description: "Optional movie and TV request integration",
    panel: "apps",
    subPanels: ["seerr"],
    isDisplayOnly: true,
  },
  "media-servers": {
    label: "Media servers",
    description: "Plex, Emby, and Jellyfin connections",
    panel: "apps",
    isDisplayOnly: true,
  },
  webhooks: {
    label: "Webhooks",
    description: "Webhook listener and background scheduler endpoints",
    panel: "general",
    subPanels: ["general-endpoints"],
    isDisplayOnly: true,
  },
  metadata: {
    label: "Metadata providers",
    description: "TMDB, TVDB, Fanart.tv, OMDb, and YouTube providers",
    panel: "api-keys",
    isDisplayOnly: true,
  },
  "sync-issues": {
    label: "Sync issues",
    description: "Unresolved sync issues between your media servers",
    panel: "sync",
    subPanels: ["sync-issues"],
    isDisplayOnly: true,
  },
  "sync-history": {
    label: "Sync history",
    description: "View the history of sync operations",
    panel: "sync",
    subPanels: ["sync-history"],
    isDisplayOnly: true,
  },
  backups: {
    label: "Backup settings",
    description: "Backup schedules and remote destinations",
    panel: "backups",
    backupTab: "settings",
    subSections: [
      { id: "backup-settings-local", label: "Local", description: "Local backup schedules and files" },
      { id: "backup-settings-remote", label: "Remote", description: "Remote backup destinations and mirroring" },
    ],
    isDisplayOnly: true,
  },
  restore: {
    label: "Restore",
    description: "Recover watch history or a full encrypted backup",
    panel: "backups",
    backupTab: "restore",
    subSections: [
      { id: "restore-local", label: "Local", description: "Restore from files on this server or your computer" },
      { id: "restore-remote", label: "Remote", description: "Restore from configured remote storage" },
    ],
    isDisplayOnly: true,
  },
  import: {
    label: "Trakt",
    description: "Bring watch history in from Trakt or CSV exports",
    panel: "tools",
    subPanels: ["tools-migration"],
    isDisplayOnly: true,
  },
  health: {
    label: "System integrity check",
    description: "Connection diagnostics and system integrity checks",
    panel: "tools",
    subPanels: ["tools-diagnostics"],
    isDisplayOnly: true,
  },
  logs: {
    label: "Logs",
    description: "Live server and browser diagnostic output",
    panel: "logs",
    isDisplayOnly: true,
  },
  storage: {
    label: "Storage & cache",
    description: "Artwork and metadata cache usage",
    panel: "cache",
    isDisplayOnly: true,
  },
  "database-repairs": {
    label: "Database repairs",
    description: "Correct damaged or duplicated local history records",
    panel: "tools",
    subPanels: ["tools-repairs"],
    isDisplayOnly: true,
  },
  "library-rebuilds": {
    label: "Library rebuilds and backfills",
    description: "Reprocess local metadata or push the complete archive to connected services",
    panel: "tools",
    subPanels: ["tools-sync"],
    isDisplayOnly: true,
  },
  "force-sync": {
    label: "Force Sync",
    description: "Preview, confirm, and run a safe synchronization plan",
    panel: "sync",
    subPanels: ["sync-tools"],
    isDisplayOnly: false,
  },
  about: {
    label: "About",
    description: "Version and changelog",
    panel: "changelog",
    isDisplayOnly: true,
  },
};

// Hierarchical grouping: parent menu item with child sections
// ALL children are display-only (navigate to parent, not separate pages)
const SECTION_GROUPS = [
  {
    id: "general",
    label: "General",
    sections: ["account", "sync-tuning"],
    displayOnly: ["account", "sync-tuning"],
  },
  {
    id: "media-servers-group",
    label: "Media servers",
    sections: ["media-servers", "seerr", "webhooks"],
    displayOnly: ["media-servers", "seerr", "webhooks"],
  },
  {
    id: "metadata",
    label: "Metadata",
    sections: ["metadata"],
    displayOnly: ["metadata"],
  },
  {
    id: "sync-group",
    label: "Sync",
    sections: ["sync-issues", "sync-history", "force-sync"],
    displayOnly: ["sync-issues", "sync-history"],
  },
  {
    id: "backup-restore-group",
    label: "Backup / restore",
    sections: ["backups", "restore"],
    displayOnly: ["backups", "restore"],
  },
  {
    id: "import",
    label: "Import",
    sections: ["import"],
    displayOnly: ["import"],
  },
  {
    id: "tools-group",
    label: "Tools",
    sections: ["database-repairs", "library-rebuilds"],
    displayOnly: ["database-repairs", "library-rebuilds"],
  },
  {
    id: "advanced-group",
    label: "Advanced",
    sections: ["health", "storage"],
    displayOnly: ["health", "storage"],
  },
  {
    id: "logs",
    label: "Logs",
    sections: ["logs"],
    displayOnly: ["logs"],
  },
  {
    id: "about",
    label: "About",
    sections: ["about"],
    displayOnly: ["about"],
  },
];

const LEGACY_PATHS = {
  "/sync": "/settings/sync-issues",
  "/logs": "/settings/logs",
  "/settings/apps": "/settings/media-servers",
  "/settings/api-keys": "/settings/metadata",
  "/settings/tools": "/settings/database-repairs",
  "/settings/cache": "/settings/storage",
  "/settings/changelog": "/settings/about",
  "/settings/account/login": "/settings/account",
  "/settings/connections": "/settings/media-servers",
  "/settings/connections/plex": "/settings/media-servers",
  "/settings/connections/emby": "/settings/media-servers",
  "/settings/connections/jellyfin": "/settings/media-servers",
  "/settings/connections/seerr": "/settings/seerr",
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
  "/settings/system/sync": "/settings/sync-issues",
  "/settings/system/logs": "/settings/logs",
  "/settings/system/storage": "/settings/storage",
  "/settings/system/about": "/settings/about",
  "/settings/system/advanced": "/settings/database-repairs",
  "/settings/sync": "/settings/sync-issues",
  "/settings/sync/issues": "/settings/sync-issues",
  "/settings/sync/history": "/settings/sync-history",
  "/settings/sync/tuning": "/settings/sync-tuning",
  "/settings/advanced": "/settings/database-repairs",
};

const LEGACY_TABS = {
  apps: "/settings/media-servers",
  "api-keys": "/settings/metadata",
  backups: "/settings/backups",
  tools: "/settings/database-repairs",
  sync: "/settings/sync-issues",
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
  const group = SECTION_GROUPS.find((g) => g.sections.includes(section))?.id || section;
  // A route can aggregate several underlying panels (a parent group's page
  // shows all of its children's content). Single-panel sections synthesize a
  // one-item views array from their flat panel/subPanels/backupTab fields.
  const views = definition.views || [{ panel: definition.panel, subPanels: definition.subPanels, backupTab: definition.backupTab }];
  const primary = views[0] || {};
  return {
    kind: "task",
    group,
    section,
    task: "",
    path: `/settings/${section}`,
    requestedPath,
    title: definition.label,
    panel: primary.panel,
    subPanels: primary.subPanels,
    backupTab: primary.backupTab,
    views,
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
  const route = sectionRoute(parts[1], requestedPath);
  const hash = String(value || "").split("#")[1]?.split(/[?&]/, 1)[0] || "";
  if (hash && SECTIONS[hash] && SECTION_GROUPS.find((group) => group.id === route.group)?.sections.includes(hash)) {
    route.section = hash;
    route.title = SECTIONS[hash].label;
  }
  return route;
}

function renderSettingsSidebar() {
  const menu = document.querySelector("#sidebarSettingsMenu");
  if (!menu) return;
  menu.querySelectorAll("[data-settings-group], [data-settings-group-parent], [data-settings-subsection]").forEach((el) => el.remove());
  const lockButton = menu.querySelector("#lockButton");
  const fragment = document.createDocumentFragment();

  for (const group of SECTION_GROUPS) {
    // Parent button for the group (navigates to parent group section if it exists, otherwise first child)
    const parentPath = SECTIONS[group.id] ? `/settings/${group.id}` : `/settings/${group.sections[0]}`;
    const parentButton = document.createElement("button");
    parentButton.type = "button";
    parentButton.className = "settings-tab settings-group-parent";
    parentButton.dataset.settingsGroupParent = group.id;
    parentButton.dataset.settingsPath = parentPath;
    parentButton.textContent = group.label;
    fragment.append(parentButton);

    // Child buttons for each section in the group
    for (const sectionId of group.sections) {
      const definition = SECTIONS[sectionId];
      const childButton = document.createElement("button");
      childButton.type = "button";
      childButton.className = "settings-tab settings-group-child";
      childButton.dataset.settingsGroup = sectionId;

      // If this is a display-only child or marked as such, it navigates to the
      // parent's aggregated page but scrolls straight to its own section there.
      const isDisplayOnly = definition.isDisplayOnly || (group.displayOnly && group.displayOnly.includes(sectionId));
      if (isDisplayOnly) {
        childButton.dataset.settingsPath = `${parentPath}#${sectionId}`;
      } else {
        childButton.dataset.settingsPath = `/settings/${sectionId}`;
      }

      childButton.dataset.settingsGroupParent = group.id;
      childButton.textContent = definition.label;
      fragment.append(childButton);

      for (const subSection of definition.subSections || []) {
        const subButton = document.createElement("button");
        subButton.type = "button";
        subButton.className = "settings-tab settings-group-grandchild hidden";
        subButton.dataset.settingsSubsection = subSection.id;
        subButton.dataset.settingsParentSection = sectionId;
        subButton.dataset.settingsPath = `/settings/${sectionId}#${subSection.id}`;
        subButton.textContent = subSection.label;
        fragment.append(subButton);
      }
    }
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

  for (const group of SECTION_GROUPS) {
    const groupOptgroup = document.createElement("optgroup");
    groupOptgroup.label = group.label;
    for (const sectionId of group.sections) {
      const definition = SECTIONS[sectionId];
      const option = document.createElement("option");
      option.value = `/settings/${sectionId}`;
      option.textContent = definition.label;
      groupOptgroup.append(option);
      for (const subSection of definition.subSections || []) {
        const subOption = document.createElement("option");
        subOption.value = `/settings/${sectionId}#${subSection.id}`;
        subOption.textContent = `— ${definition.label}: ${subSection.label}`;
        groupOptgroup.append(subOption);
      }
    }
    select.append(groupOptgroup);
  }
}

function renderSettingsOverview() {
  const list = document.querySelector("#settingsOverviewList");
  if (!list) return;
  list.replaceChildren();

  for (const group of SECTION_GROUPS) {
    const groupContainer = document.createElement("div");
    groupContainer.className = "settings-group-section";
    const groupHeading = document.createElement("h3");
    groupHeading.className = "settings-group-heading";
    groupHeading.textContent = group.label;
    groupContainer.append(groupHeading);

    const itemsContainer = document.createElement("div");
    itemsContainer.className = "settings-group-items";
    for (const sectionId of group.sections) {
      const definition = SECTIONS[sectionId];
      const row = document.createElement("button");
      row.type = "button";
      row.className = "settings-link-row";
      row.dataset.settingsPath = `/settings/${sectionId}`;
      const title = document.createElement("strong");
      title.textContent = definition.label;
      const description = document.createElement("span");
      description.textContent = definition.description;
      row.append(title, description);
      itemsContainer.append(row);
      for (const subSection of definition.subSections || []) {
        const subRow = document.createElement("button");
        subRow.type = "button";
        subRow.className = "settings-link-row settings-link-row--nested";
        subRow.dataset.settingsPath = `/settings/${sectionId}#${subSection.id}`;
        const subTitle = document.createElement("strong");
        subTitle.textContent = subSection.label;
        const subDescription = document.createElement("span");
        subDescription.textContent = subSection.description;
        subRow.append(subTitle, subDescription);
        itemsContainer.append(subRow);
      }
    }
    groupContainer.append(itemsContainer);
    list.append(groupContainer);
  }
}

function prepareToolsDisclosures() {
  const labels = {
    "tools-repairs": ["Database Repairs", "Correct damaged or duplicated local history records."],
    "tools-sync": ["Library Rebuilds and Backfills", "Reprocess local metadata or push the complete archive to connected services."],
  };
  for (const [name, copy] of Object.entries(labels)) {
    const row = document.querySelector(`[data-sub-panel="${name}"]`);
    if (!row || row.closest(".settings-disclosure")) continue;
    const details = document.createElement("details");
    details.className = "settings-disclosure";
    details.dataset.settingsDisclosure = name;
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
  prepareToolsDisclosures();
}

export function applySettingsRoute(route) {
  document.querySelector("#settingsOverview")?.classList.toggle("hidden", route.kind !== "overview");
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => panel.classList.add("hidden"));
  document.querySelectorAll("[data-sub-panel]").forEach((panel) => panel.classList.add("hidden"));
  document.querySelectorAll("[data-settings-disclosure]").forEach((panel) => {
    panel.classList.add("hidden");
    panel.open = false;
  });

  if (route.kind === "task") {
    // A route may aggregate multiple views (a parent group's page shows every
    // child section's panel together), so reveal each one in turn.
    const views = route.views?.length ? route.views : [{ panel: route.panel, subPanels: route.subPanels, backupTab: route.backupTab }];
    const requestedBackupTabs = new Set();
    for (const view of views) {
      if (!view.panel) continue;
      const panels = [...document.querySelectorAll(`[data-settings-panel="${view.panel}"]`)];
      for (const panel of panels) panel.classList.remove("hidden");
      for (const name of view.subPanels || []) {
        document.querySelector(`[data-sub-panel="${name}"]`)?.classList.remove("hidden");
        const disclosure = document.querySelector(`[data-settings-disclosure="${name}"]`);
        if (disclosure) {
          disclosure.classList.remove("hidden");
          disclosure.open = true;
        }
      }
      if (view.panel === "backups" && view.backupTab) requestedBackupTabs.add(view.backupTab);
    }
    if (requestedBackupTabs.size) {
      document.querySelectorAll('[data-settings-panel="backups"]').forEach((panel) => {
        panel.classList.toggle("hidden", !requestedBackupTabs.has(panel.dataset.backupsPanel));
      });
    }
  }

  document.querySelectorAll("[data-settings-subsection]").forEach((button) => {
    button.classList.toggle("hidden", route.kind !== "task" || route.section !== button.dataset.settingsParentSection);
  });

  // Handle parent/child active states
  document.querySelectorAll("[data-settings-group-parent]").forEach((button) => {
    const active = route.group === button.dataset.settingsGroupParent;
    button.classList.toggle("active", active);
  });

  document.querySelectorAll("[data-settings-group]").forEach((button) => {
    const active = route.section === button.dataset.settingsGroup;
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

// Resolves a section id to the DOM element that represents it on an
// aggregated parent page, so the sidebar can scroll a specific child section
// into view instead of only landing at the top of the group's page.
function settingsSectionElement(sectionId) {
  const definition = SECTIONS[sectionId];
  if (!definition) return document.getElementById(sectionId);
  const view = definition.views?.[0] || { panel: definition.panel, subPanels: definition.subPanels, backupTab: definition.backupTab };
  if (!view.panel) return null;
  if (view.subPanels?.length) {
    const name = view.subPanels[0];
    // Prefer the <details> disclosure wrapper (it includes the section's own
    // heading) over the bare row it wraps, so scrolling doesn't crop the title.
    return document.querySelector(`[data-settings-disclosure="${name}"]`) || document.querySelector(`[data-sub-panel="${name}"]`);
  }
  if (view.backupTab) return document.querySelector(`[data-settings-panel="${view.panel}"][data-backups-panel="${view.backupTab}"]`);
  return document.querySelector(`[data-settings-panel="${view.panel}"]`);
}

export function scrollToSettingsSection(sectionId) {
  const target = settingsSectionElement(sectionId);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}
