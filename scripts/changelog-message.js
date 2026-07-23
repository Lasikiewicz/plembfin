const RELEASE_TYPES = new Set(["feat", "fix", "security", "enhance", "perf", "docs"]);

export function formatChangelogMessage(message) {
  const m = String(message || "").match(/^([a-zA-Z]+)(?:\([^)]*\))?:\s*(.*)$/);
  if (!m) return message;
  const labels = {
    feat: "Feature",
    fix: "Fix",
    security: "Security",
    chore: "Chore",
    docs: "Docs",
    ci: "CI",
    enhance: "Enhancement",
    perf: "Performance",
  };
  const label = labels[m[1].toLowerCase()];
  if (!label) return message;
  const rest = m[2].trim();
  if (!rest) return label;
  return `${label} - ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

export function bulletPointsFrom(message) {
  return String(message || "")
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
