// Shared normalization for the optional thematic sub-groups carried by a
// published changelog entry. The flat `sections` arrays remain the canonical
// compatibility shape; `sectionGroups` adds readable themes without dropping
// or hiding any of those individual bullets.

export const CHANGELOG_SECTION_DEFINITIONS = [
  ["newFeatures", "New Features"],
  ["majorBugFixes", "Bug Fixes"],
  ["tweaks", "Tweaks"],
];

// New release entries are grouped automatically at the promotion boundary.
// Keep the vocabulary small and product-facing so the layout stays predictable
// without turning every bullet into a one-off heading. A reviewed entry may
// still provide explicit `sectionGroups`; these defaults are only used when a
// release has not been curated yet.
const CHANGELOG_THEME_ORDER = {
  newFeatures: ["Settings", "Discover & recommendations", "Tautulli imports", "Sync & connection recovery"],
  majorBugFixes: ["Up Next & watch-state", "Tautulli imports", "Manual Watch & watch actions", "Sync & provider recovery"],
  tweaks: ["Up Next & watch-state", "Manual Watch review", "Discover & recommendations", "Sync & connection recovery"],
};

const CHANGELOG_THEME_RULES = {
  newFeatures: [
    ["Settings", /\bsettings\b|administration area|settings section/i],
    ["Discover & recommendations", /recommend|personalized rail|don't recommend/i],
    ["Tautulli imports", /tautulli|imported watch/i],
  ],
  majorBugFixes: [
    ["Tautulli imports", /tautulli|backup and import|\bimporting\b|imported watches|queued imports|multiline backup/i],
    ["Manual Watch & watch actions", /pending actions by show identity|selected TVDB identity|Fix Match|watch date|dismiss & mark unwatched/i],
    ["Up Next & watch-state", /up next|watch state|watch-state|clear progress|resume item|watched or unwatched/i],
  ],
  tweaks: [
    ["Manual Watch review", /manual watch|review counts|review decisions|review actions|dismissing the review|connected app reported a watch|newest review seasons|individual or show-level watch/i],
    ["Discover & recommendations", /watched titles|poster recovery|card metadata|release-date presentation|recommendation exclusions|personal lists/i],
    ["Up Next & watch-state", /up next|watch state|watch-state|completed shows|cross-platform sync and onboarding|watch-date actions|media changes visible while sync/i],
  ],
};

function cleanDetails(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

function defaultThemeFor(sectionKey, detail) {
  const rules = CHANGELOG_THEME_RULES[sectionKey] || [];
  const fallback = sectionKey === "majorBugFixes"
    ? "Sync & provider recovery"
    : "Sync & connection recovery";
  return rules.find(([, pattern]) => pattern.test(detail))?.[0] || fallback;
}

// Build the nested presentation shape from the canonical flat sections. The
// flat arrays remain the source of truth for compatibility and validation; the
// grouped shape is deliberately derived so every future alpha/main promotion
// gets the same readable layout without hand-editing JSON.
export function buildChangelogSectionGroups(sections = {}) {
  return Object.fromEntries(CHANGELOG_SECTION_DEFINITIONS.map(([key]) => {
    const details = cleanDetails(sections[key]);
    const buckets = new Map();
    for (const detail of details) {
      const title = defaultThemeFor(key, detail);
      if (!buckets.has(title)) buckets.set(title, []);
      buckets.get(title).push(detail);
    }

    const order = CHANGELOG_THEME_ORDER[key] || [];
    const titles = [
      ...order,
      ...Array.from(buckets.keys()).filter((title) => !order.includes(title)),
    ];

    return [key, titles
      .filter((title) => buckets.has(title))
      .map((title) => ({ title, details: buckets.get(title) }))];
  }));
}

export function changelogSectionGroups(entry = {}) {
  const sections = entry.sections && typeof entry.sections === "object" ? entry.sections : {};
  const explicitGroups = entry.sectionGroups && typeof entry.sectionGroups === "object"
    ? entry.sectionGroups
    : {};

  return CHANGELOG_SECTION_DEFINITIONS.map(([key, title]) => {
    const configured = Array.isArray(explicitGroups[key])
      ? explicitGroups[key]
        .map((group) => ({
          title: String(group?.title || "").trim(),
          details: cleanDetails(group?.details),
        }))
        .filter((group) => group.details.length > 0)
      : [];
    const details = cleanDetails(sections[key]);
    const groups = configured.length
      ? configured
      : (details.length ? [{ title: "", details }] : []);

    return {
      key,
      title,
      groups,
      details: groups.flatMap((group) => group.details),
    };
  });
}
