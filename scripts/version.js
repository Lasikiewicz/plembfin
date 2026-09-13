// Five-segment build versions: major.minor.patch.alpha.dev
//
//   major.minor.patch  the released semver, owned by "Force to main"
//   alpha              alpha builds since that release, reset to 0 by "Force to main"
//   dev                develop builds since the last alpha build, reset to 0 by
//                      "Force to alpha"
//
// The ladder is strictly increasing across every command, by arithmetic rather
// than convention:
//
//   1.1.0.0.0  release
//   1.1.0.0.1  1.1.0.0.2  1.1.0.0.3   push to git
//   1.1.0.1.0                          force to alpha
//   1.1.0.1.1  1.1.0.1.2               push to git
//   1.1.0.2.0                          force to alpha
//   1.1.1.0.0                          force to main
//
// docs/decisions.md entry 7 previously removed a five-segment scheme because its
// fifth segment was always zero, was never read by any comparison, and showed up
// as visual noise ("v0.14.0.3.0"). Both halves of that objection are addressed
// here: segments 4 and 5 carry real counters that compareBuildVersions reads, and
// formatBuildVersion trims trailing zeros so a release still renders as "1.1.0".
// Do not reintroduce a meaningless trailing segment.

const SEGMENTS = 5;

// Parses any 1-to-5 segment dotted numeric version into exactly five numbers,
// zero-filling the missing positions. This is what makes the change backward
// compatible: a four-segment "1.0.2.1" written by an older promotion parses to
// [1,0,2,1,0], the same value the new scheme would write, so no already-shipped
// version is reinterpreted.
export function parseBuildVersion(value) {
  const text = String(value ?? "").trim().replace(/^v/i, "");
  if (!text) return null;
  const parts = text.split(".");
  if (parts.length > SEGMENTS) return null;
  const numbers = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const part = parts[i];
    if (part === undefined) {
      numbers.push(0);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    numbers.push(Number(part));
  }
  return numbers;
}

// Returns 1 when a sorts after b, -1 when before, 0 when equal. Returns 0 when
// either side cannot be parsed, matching the existing callers' expectation that
// an unreadable version never wins a comparison.
export function compareBuildVersions(a, b) {
  const pa = parseBuildVersion(a);
  const pb = parseBuildVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < SEGMENTS; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// Display form: trim trailing zero segments, but never below three, so a release
// reads "1.1.0" and an alpha build reads "1.1.0.1" while a develop build keeps
// the zero it needs ("1.1.0.0.2" - only *trailing* zeros go).
export function formatBuildVersion(value) {
  const parsed = parseBuildVersion(value);
  if (!parsed) return String(value ?? "");
  const segments = parsed.slice();
  while (segments.length > 3 && segments[segments.length - 1] === 0) segments.pop();
  return segments.join(".");
}

// The released semver alone, which is what package.json and package-lock.json
// must carry: they are validated as real semver by npm, and a five-segment
// string there is invalid.
export function releaseVersionOf(value) {
  const parsed = parseBuildVersion(value);
  if (!parsed) return String(value ?? "");
  return parsed.slice(0, 3).join(".");
}

export function buildVersion(releaseVersion, alphaBuild = 0, developBuild = 0) {
  const base = parseBuildVersion(releaseVersion);
  if (!base) throw new Error(`Invalid release version: ${releaseVersion}`);
  return [base[0], base[1], base[2], Number(alphaBuild) || 0, Number(developBuild) || 0].join(".");
}

export function bumpPatch(releaseVersion) {
  const parsed = parseBuildVersion(releaseVersion) || [0, 0, 0, 0, 0];
  return [parsed[0], parsed[1], parsed[2] + 1].join(".");
}
