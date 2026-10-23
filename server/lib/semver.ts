export interface SemVer {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

const SEMVER_REGEX = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function hasCanonicalNumericForm(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

function parseIdentifiers(value: string | undefined, rejectLeadingZeroNumbers: boolean): string[] | null {
  if (!value) return [];
  const identifiers = value.split('.');
  if (identifiers.some((identifier) => !/^[0-9A-Za-z-]+$/.test(identifier))) return null;
  if (rejectLeadingZeroNumbers && identifiers.some((identifier) => /^\d+$/.test(identifier) && !hasCanonicalNumericForm(identifier))) {
    return null;
  }
  return identifiers;
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

/**
 * Parses a semantic version string (e.g. "v1.2.3", "1.2.3-beta.1").
 * Returns null if the version is not valid semver.
 */
export function parseSemVer(versionStr: string): SemVer | null {
  if (!versionStr || typeof versionStr !== 'string') return null;
  const trimmed = versionStr.trim();
  const match = trimmed.match(SEMVER_REGEX);
  if (!match) return null;
  if (![match[1], match[2], match[3]].every(hasCanonicalNumericForm)) return null;

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);

  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }

  const prerelease = parseIdentifiers(match[4], true);
  const build = parseIdentifiers(match[5], false);
  if (!prerelease || !build) return null;

  return {
    raw: trimmed,
    major,
    minor,
    patch,
    prerelease,
    build,
  };
}

/**
 * Compares two semantic version strings or SemVer objects.
 * Returns > 0 if a > b, < 0 if a < b, and 0 if a === b.
 */
export function compareSemVer(
  a: string | SemVer,
  b: string | SemVer,
): number {
  const v1 = typeof a === 'string' ? parseSemVer(a) : a;
  const v2 = typeof b === 'string' ? parseSemVer(b) : b;

  if (!v1 && !v2) return 0;
  if (!v1) return -1;
  if (!v2) return 1;

  if (v1.major !== v2.major) return v1.major > v2.major ? 1 : -1;
  if (v1.minor !== v2.minor) return v1.minor > v2.minor ? 1 : -1;
  if (v1.patch !== v2.patch) return v1.patch > v2.patch ? 1 : -1;

  // Normal release has higher precedence than a pre-release: 1.0.0 > 1.0.0-alpha
  const v1HasPre = v1.prerelease.length > 0;
  const v2HasPre = v2.prerelease.length > 0;

  if (!v1HasPre && v2HasPre) return 1;
  if (v1HasPre && !v2HasPre) return -1;
  if (!v1HasPre && !v2HasPre) return 0;

  // Both have pre-releases: compare identifier by identifier
  const length = Math.max(v1.prerelease.length, v2.prerelease.length);
  for (let i = 0; i < length; i++) {
    const id1 = v1.prerelease[i];
    const id2 = v2.prerelease[i];

    if (id1 === undefined) return -1;
    if (id2 === undefined) return 1;
    if (id1 === id2) continue;

    const num1 = /^\d+$/.test(id1);
    const num2 = /^\d+$/.test(id2);

    if (num1 && num2) {
      const comparison = compareNumericIdentifier(id1, id2);
      if (comparison !== 0) return comparison;
    } else if (num1) {
      return -1; // numeric has lower precedence than string
    } else if (num2) {
      return 1;
    } else {
      if (id1 !== id2) return id1 > id2 ? 1 : -1;
    }
  }

  return 0;
}

/**
 * Returns true if candidate is strictly newer than current.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemVer(candidate, current) > 0;
}

/**
 * Normalizes a version string by removing leading 'v' / 'V' and trimming.
 */
export function cleanVersion(versionStr: string): string {
  const parsed = parseSemVer(versionStr);
  if (!parsed) return versionStr.replace(/^[vV]/, '').trim();
  const pre = parsed.prerelease.length > 0 ? `-${parsed.prerelease.join('.')}` : '';
  const build = parsed.build.length > 0 ? `+${parsed.build.join('.')}` : '';
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${pre}${build}`;
}
