/**
 * `muon update` — the decision half, kept away from the side effects.
 *
 * Everything here is pure so the rules can be tested without a network or a
 * global npm install: what "newer" means, what the installer would run, and
 * when the answer is "you are already current" rather than a reinstall nobody
 * asked for.
 */

/** Where releases are published. Overridable for staging/self-hosting. */
export const DEFAULT_DOWNLOAD_HOST = "https://download.getmuon.com";

/** The stable alias the installer and this command both read. */
export const LATEST_TARBALL = "muon-cli-latest.tgz";

export type SemverParts = {
  major: number;
  minor: number;
  patch: number;
  /** Everything after `-`, empty when this is a final release. */
  prerelease: string;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(value: string): SemverParts | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

/**
 * Compare two versions. Negative when `a` is older.
 *
 * A PRERELEASE SORTS BEFORE its final release (1.0.0-rc.1 < 1.0.0), which is
 * the semver rule and the one people get wrong by comparing strings — where
 * "1.0.0-rc.1" > "1.0.0" because `-` is not `\0`. Getting this backwards would
 * offer an rc as an "update" to the release it preceded.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    // Unparseable versions are never silently ordered — the caller decides.
    throw new Error(`not a semver version: ${!left ? a : b}`);
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1; // a is final, b is a prerelease → a is newer
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export type UpdateVerdict =
  | { kind: "current"; installed: string }
  | { kind: "available"; installed: string; latest: string }
  | { kind: "ahead"; installed: string; latest: string };

/**
 * What to do given what is installed and what is published.
 *
 * `ahead` is its own answer rather than folded into `current`: a developer
 * running a locally built 0.4.0 against a published 0.3.0 should be told they
 * are ahead, not quietly told they are up to date — the second reading hides a
 * build that never shipped.
 */
export function decideUpdate(
  installed: string,
  latest: string
): UpdateVerdict {
  const order = compareSemver(installed, latest);
  if (order < 0) return { kind: "available", installed, latest };
  if (order > 0) return { kind: "ahead", installed, latest };
  return { kind: "current", installed };
}

/** The tarball URL for a host, with no double slash when the host has one. */
export function latestTarballUrl(host: string = DEFAULT_DOWNLOAD_HOST): string {
  return `${host.replace(/\/+$/, "")}/${LATEST_TARBALL}`;
}

/**
 * The exact argv `muon update` will run.
 *
 * Returned rather than executed so a test can assert the command WITHOUT a
 * global install, and so `--dry-run` can print the real thing instead of a
 * description of it that might drift from what runs.
 */
export function installArgv(host: string = DEFAULT_DOWNLOAD_HOST): string[] {
  return ["install", "-g", latestTarballUrl(host)];
}

/** Human sentence for a verdict — one place, so every surface agrees. */
export function describeVerdict(verdict: UpdateVerdict): string {
  switch (verdict.kind) {
    case "current":
      return `muon ${verdict.installed} is the latest release.`;
    case "available":
      return `muon ${verdict.latest} is available (you have ${verdict.installed}).`;
    case "ahead":
      return `you are running ${verdict.installed}, which is NEWER than the latest release (${verdict.latest}) — a local build, most likely. Nothing to update.`;
  }
}
