const RELEASE_TYPES = new Set(["feat", "fix", "security", "enhance", "perf", "docs"]);

// Release-pipeline bookkeeping commits (rebuilding/promoting the changelog
// itself, and the merge commits the pre-push hook creates when syncing
// against a branch another push already advanced) carry no user-visible
// content of their own - their subject line is noise in a changelog and their
// absence of bullets shouldn't blank out an otherwise-detailed release.
// Shared so every generator drops them the same way. The bump/update patterns
// below match commit messages from before the changelog pipeline moved to
// local computation (see CLAUDE.md's branching model section) - they no
// longer get created, but rebuild-develop-changelog.js's git-history walk can
// still cross them for any reset anchor that predates the move, so they stay
// recognized.
const NOISE_MESSAGE_PATTERNS = [
  /^chore: rebuild develop changelog\b/,
  /^chore: promote develop changelog to alpha\b/,
  /^chore: promote alpha to main\b/,
  /^chore: bump alpha build for /,
  /^chore: bump develop build for /,
  /^chore: update changelog for /,
  /^chore: reset (?:develop|alpha) build counter after promotion to /i,
  /^Merge (branch|commit|pull request|remote-tracking branch)\b/i,
];

export function isNoiseCommitMessage(message) {
  const subject = String(message || "").split(/\r?\n/, 1)[0].trim();
  return NOISE_MESSAGE_PATTERNS.some((pattern) => pattern.test(subject));
}

// Changelog entries are assembled from commit bodies at several branch
// boundaries. A commit can have a valid release type while its bullets still
// describe the bookkeeping around the changelog itself (for example,
// consolidating entries or resetting a build counter). Those notes are useful
// to the maintainer while working, but they are not release content and must
// not reach alpha or main.
const CHANGELOG_ARTIFACT_PATTERN = /\b(?:changelog(?:[-.]|\s|$)|release notes?|release entry|release history)\b/i;
const CHANGELOG_PROCESS_ACTION_PATTERN = /\b(?:consolidat(?:e|ed|ing|ion)|trim(?:med|ming)?|shorten(?:ed|ing)?|drop(?:ped|ping)|fold(?:ed|ing)?|regenerat(?:e|ed|ing)|rewrit(?:e|ten|ing)|correct(?:ed|ion|ing)|clean(?:ed|up|ing)?|deduplicat(?:e|ed|ing)|tighten(?:ed|ing)?|summariz(?:e|ed|ing))\b/i;
const BUILD_COUNTER_PATTERN = /\b(?:reset|bump(?:ed|ing)?)\s+(?:the\s+)?(?:develop|alpha)\s+build(?:\s+counter|\s+metadata)?\b/i;

export function isChangelogProcessText(value) {
  const text = String(value || "").trim();
  if (!text) return false;

  return BUILD_COUNTER_PATTERN.test(text)
    || /\bchangelog[- ]process\b/i.test(text)
    || (CHANGELOG_ARTIFACT_PATTERN.test(text) && CHANGELOG_PROCESS_ACTION_PATTERN.test(text));
}

// A bullet can describe the release pipeline's own machinery - git hooks, CI
// workflows, the promotion scripts themselves - rather than something
// Plembfin the app actually does. That's real, useful information, but it
// belongs in CLAUDE.md/docs for whoever maintains the project, not in a
// changelog an end user reads to find out what changed in the app. This is
// independent of commit type: a legitimate fix/feat commit's bullet list can
// still slip in a line like this if a push session bundled dev-tooling work
// alongside real product changes, so it has to be caught by content, not by
// trusting the commit was typed "chore:".
const RELEASE_TOOLING_PATTERN = /\b(?:pre-push hook|commit-msg hook|git hooks?|githooks|ci pipeline|github actions workflow|release pipeline|build gate|force to (?:alpha|main)|push to git|changelog\.(?:develop|alpha)\.json|rebuild-develop-changelog\.js|promote-develop-to-alpha\.js|promote-alpha-to-main\.js|validate-commit-message\.js|changelog-message\.js)\b/i;

export function isReleaseToolingText(value) {
  return RELEASE_TOOLING_PATTERN.test(String(value || "").trim());
}

export function isChangelogProcessMessage(message) {
  const subject = String(message || "").split(/\r?\n/, 1)[0].trim();
  if (!subject) return false;

  return isChangelogProcessText(subject)
    || isReleaseToolingText(subject)
    || /^(?:chore|docs?)(?:\([^)]*\))?:\s*(?:reset|bump)\s+(?:the\s+)?(?:develop|alpha)\s+build(?:\s+counter|\s+metadata)?\b/i.test(subject)
    || /^(?:chore|docs?)\s+-\s+(?:reset|bump)\s+(?:the\s+)?(?:develop|alpha)\s+build(?:\s+counter|\s+metadata)?\b/i.test(subject);
}

export function filterChangelogDetails(details) {
  const values = Array.isArray(details) ? details : (details == null ? [] : [details]);
  return values
    .map((detail) => String(detail || "").trim())
    .filter((detail) => detail && !isChangelogProcessText(detail) && !isReleaseToolingText(detail));
}

export function filterChangelogEntries(entries = []) {
  if (!Array.isArray(entries)) return [];

  return entries
    .filter((entry) => entry && !isChangelogProcessMessage(entry.message))
    .map((entry) => ({
      ...entry,
      details: filterChangelogDetails(entry.details),
    }))
    .filter((entry) => String(entry.message || "").trim() || entry.details.length > 0);
}

export function changelogEntryProcessViolations(entry = {}) {
  const violations = [];
  // Belt-and-suspenders alongside the generators' own noise guard: a bare
  // merge/bump commit message (no real bullets) is never informative to a
  // user reading Settings -> Changelog, so the target-branch gate refuses it
  // too, in case a future code path in either generator ever reaches this
  // check without having applied that guard itself.
  if (isNoiseCommitMessage(entry.message) || isChangelogProcessMessage(entry.message)) {
    violations.push(`message: ${String(entry.message).split(/\r?\n/, 1)[0].trim()}`);
  }

  for (const [field, values] of [
    ["details", entry.details],
    ["sections.newFeatures", entry.sections?.newFeatures],
    ["sections.majorBugFixes", entry.sections?.majorBugFixes],
    ["sections.tweaks", entry.sections?.tweaks],
  ]) {
    for (const value of Array.isArray(values) ? values : []) {
      if (isChangelogProcessText(value) || isReleaseToolingText(value)) violations.push(`${field}: ${String(value).trim()}`);
    }
  }

  return Array.from(new Set(violations));
}

// A multi-commit push (routine on alpha, and especially a "Merge alpha with
// main" promotion that bundles a whole branch at once) backfills bullets from
// every commit in range, not just the one that triggered the build. Without
// this check that included commits whose type isn't user-facing - chore:,
// test:, refactor:, ci:, style: - dumping their bullets into the same
// changelog entry as real feat/fix/security work: an internal debug-only
// endpoint, or a note about fixing a test's expectations, read like product
// changes to anyone browsing Settings -> Changelog even though neither one
// is. Only commits typed as one of the RELEASE_TYPES belong in the backfill.
export function isReleaseTypeCommitMessage(message) {
  const subject = String(message || "").split(/\r?\n/, 1)[0].trim();
  const match = subject.match(/^([a-zA-Z]+)(?:\([^)]*\))?:\s*/);
  return Boolean(match && RELEASE_TYPES.has(match[1].toLowerCase()));
}

export function formatChangelogMessage(message) {
  let text = String(message || "").trim();
  text = text.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "").trim();

  const m = text.match(/^([a-zA-Z]+)(?:\([^)]*\))?:\s*(.*)$/);
  if (!m) return text;
  const labels = {
    feat: "Feature",
    feature: "Feature",
    fix: "Fix",
    security: "Security",
    chore: "Chore",
    docs: "Docs",
    ci: "CI",
    enhance: "Enhancement",
    perf: "Performance",
  };
  const label = labels[m[1].toLowerCase()];
  if (!label) return text;
  let rest = m[2].trim();
  rest = rest.replace(/^(feature|feat|fix|security|chore|docs|ci|enhancement|enhance|perf)\s*[:-]\s*/i, "").trim();
  if (!rest) return label;
  return `${label} - ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

// A release entry can bundle more than one unrelated push into its one
// headline - several "Push to git" runs land in the same develop entry
// before a "Force to alpha", and likewise several "Force to alpha" runs can
// land in the same alpha entry before a "Force to main". Picking only the
// most recent one (the old behavior) silently drops every earlier push from
// the one line most people actually read in Settings -> Changelog, even
// though their bullets are still listed below it. This instead folds every
// formatted "Label - description" headline passed in into one sentence
// naming all of them, unwrapping a headline that's already one of these
// composite sentences (from an earlier "Force to alpha" this same cycle)
// rather than nesting "This update includes This update includes ...".
export function synthesizeHeadline(messages = []) {
  const cleaned = messages.map((message) => String(message || "").trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];

  const fragments = cleaned.map((message) => {
    let rest = message.replace(/^[A-Za-z]+\s+-\s+/, "").trim();
    rest = rest.replace(/^this update includes\s+/i, "").replace(/\.$/, "").trim();
    if (!rest) return message;
    return rest.charAt(0).toLowerCase() + rest.slice(1);
  });

  const last = fragments[fragments.length - 1];
  const joined = fragments.length === 2
    ? `${fragments[0]} and ${last}`
    : `${fragments.slice(0, -1).join(", ")}, and ${last}`;
  return `This update includes ${joined}.`;
}

export function bulletPointsFrom(message) {
  return String(message || "")
    // Commit bodies entered through some shell paths contain a literal
    // "\\n" instead of an actual line break. Treat both forms identically.
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function comparable(value) {
  return String(value || "")
    .replace(/^[a-zA-Z]+(?:\([^)]*\))?:\s*/, "")
    .replace(/^[a-zA-Z]+\s+-\s+/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

export function validateReleaseMessage(message) {
  const raw = String(message || "").trim();
  const subject = raw.split(/\r?\n/, 1)[0].trim();
  const match = subject.match(/^([a-zA-Z]+)(?:\([^)]*\))?:\s*(.*)$/);
  if (!match || !RELEASE_TYPES.has(match[1].toLowerCase())) return [];

  const bullets = bulletPointsFrom(raw);
  const subjectKey = comparable(subject);
  const meaningfulBullets = bullets.filter((bullet) => comparable(bullet) !== subjectKey);
  if (meaningfulBullets.length > 0) return [];

  return [
    `${match[1].toLowerCase()} commits must include at least one user-visible bullet that adds detail beyond the subject.`,
    `Use: git commit -m "${subject}" -m "- What changed for users"`,
  ];
}
