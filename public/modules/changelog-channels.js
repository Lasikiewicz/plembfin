// Main / Alpha channel toggle for Settings -> Changelog, plus the display
// formatting for five-segment build versions.
//
// New code for the changelog screen lives here rather than in app.js, which is
// a grandfathered file that must not grow (see CLAUDE.md, Frontend Module
// Discipline). app.js keeps ownership of the entry rendering it already has and
// delegates the tab shell to this module.
//
// The toggle is available on every channel: /api/changelog returns the alpha
// branch's live manifest regardless of what is installed, so a stable user can
// read alpha notes. Selecting the Alpha tab never changes the reported installed
// version and never raises an update prompt - the server forces
// alphaBuild.newerBuildAvailable false off the alpha channel for exactly that
// reason.

// Which tab is showing. Held here rather than in state.js because it is purely
// local view state for one panel and is not persisted.
let selectedChannel = "main";

export function selectedChangelogChannel() {
  return selectedChannel;
}

export function setSelectedChangelogChannel(channel) {
  selectedChannel = channel === "alpha" ? "alpha" : "main";
  return selectedChannel;
}

// Build versions are five segments, major.minor.patch.alpha.dev. Trim trailing
// zero segments so a release reads "1.1.0" and an alpha build reads "1.1.0.1",
// but never go below three segments and never touch a zero that is not
// trailing, so a develop build stays "1.1.0.0.2".
//
// docs/decisions.md entry 7 cut an earlier fifth segment precisely because it
// was always zero and rendered as noise ("v0.14.0.3.0"). This trimming is what
// makes a meaningful fifth segment acceptable - do not render the raw string.
export function formatBuildVersion(value) {
  const text = String(value ?? "").trim().replace(/^v/i, "");
  if (!text) return "";
  const parts = text.split(".");
  if (parts.length > 5 || !parts.every((part) => /^\d+$/.test(part))) return text;
  const segments = parts.map(Number);
  while (segments.length < 5) segments.push(0);
  while (segments.length > 3 && segments[segments.length - 1] === 0) segments.pop();
  return segments.join(".");
}

export function renderChangelogChannelTabs({ selected = "main", alphaCount = 0 } = {}) {
  const tab = (channel, label, count) => `
    <button
      class="changelog-channel-tab${selected === channel ? " is-selected" : ""}"
      type="button"
      role="tab"
      aria-selected="${selected === channel ? "true" : "false"}"
      data-changelog-channel="${channel}"
    >${label}${count ? ` <span class="changelog-channel-count">${count}</span>` : ""}</button>`;

  return `
    <div class="changelog-channel-tabs" role="tablist" aria-label="Changelog channel">
      ${tab("main", "Main")}
      ${tab("alpha", "Alpha", alphaCount)}
    </div>`;
}

// Wires the tab buttons inside `root`. `onSelect` is called with the new
// channel only when it actually changed, so a repeat click does not re-render.
export function bindChangelogChannelTabs(root, onSelect) {
  if (!root) return;
  root.querySelectorAll("[data-changelog-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      const channel = button.getAttribute("data-changelog-channel");
      if (!channel || channel === selectedChannel) return;
      setSelectedChangelogChannel(channel);
      onSelect?.(selectedChannel);
    });
  });
}

// The develop build version for a given build number, derived from the local
// build's own version by replacing the dev segment.
//
// A develop changelog entry carries only its build number, not a version, and
// the remote "not pulled yet" entries carry build numbers other than the local
// one - so reusing the local version string verbatim would label build 3 with
// build 1's version.
export function developVersionForBuild(developVersion, build) {
  const base = formatBuildVersion(developVersion);
  const parts = base.split(".");
  if (parts.length < 3 || !parts.every((part) => /^\d+$/.test(part))) return base;
  const segments = parts.map(Number);
  while (segments.length < 5) segments.push(0);
  segments[4] = Number(build) || 0;
  return formatBuildVersion(segments.join("."));
}

// The released base a pre-release build sits on: the first three segments.
export function baseVersionOf(version) {
  const parts = String(version ?? "").trim().replace(/^v/i, "").split(".");
  if (parts.length < 3 || !parts.slice(0, 3).every((part) => /^\d+$/.test(part))) return "";
  return parts.slice(0, 3).join(".");
}

// Splits alpha build entries into the ones built on the installed release and
// the ones left over from earlier cycles.
//
// "Force to main" resets the bundled manifest but never touches the `alpha`
// branch, so origin/alpha legitimately still holds the previous cycle's builds
// after a release. Showing them unlabelled under "Alpha releases" reads as if
// they were current. They are real history and worth keeping, so they are
// separated and labelled with the release they were built on rather than hidden.
export function partitionAlphaEntriesByBase(entries = [], currentBaseVersion = "") {
  const current = baseVersionOf(currentBaseVersion);
  const currentCycle = [];
  const olderByBase = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const base = baseVersionOf(entry.version) || baseVersionOf(entry.baseVersion);
    if (!current || !base || base === current) {
      currentCycle.push(entry);
      continue;
    }
    if (!olderByBase.has(base)) olderByBase.set(base, []);
    olderByBase.get(base).push(entry);
  }

  // Newest base first, so the most recent history sits nearest the current cycle.
  const older = [...olderByBase.entries()].sort((a, b) => {
    const pa = a[0].split(".").map(Number);
    const pb = b[0].split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    }
    return 0;
  });

  return { currentCycle, older };
}
