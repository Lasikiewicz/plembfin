export function sidebarNavigationPath(target) {
  if (!target) return "";

  if (target.dataset?.settingsPath) return target.dataset.settingsPath;
  if (target.id === "brandLink") return "/";
  if (target.id === "syncProgressIndicator" || target.id === "sidebarSyncAttentionButton") return "/sync-activity";

  const view = target.dataset?.view;
  if (!view) return "";
  if (view === "dashboard") return "/";
  if (view === "explorer") return target.dataset.explorerNav === "shows" ? "/tvshows" : "/movies";
  if (view === "settings") return "/settings";
  return `/${view}`;
}

export function attachSidebarMiddleClickNavigation(sidebar, openWindow = window.open.bind(window)) {
  if (!sidebar) return;

  sidebar.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const target = event.target.closest("#brandLink, #syncProgressIndicator, #sidebarSyncAttentionButton, [data-view], [data-settings-path]");
    if (!target || !sidebar.contains(target)) return;

    const path = sidebarNavigationPath(target);
    if (!path) return;
    event.preventDefault();
    openWindow(new URL(path, window.location.origin).href, "_blank", "noopener");
  });
}
