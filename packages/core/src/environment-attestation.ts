import { join } from "node:path";
import { detectPackageManager, type PackageManager } from "./derived-checks.js";

/**
 * Next-wave feature #7 — attest the workspace's own build environment.
 *
 * MUON attests a great deal about vendors and MCP servers and nothing about
 * the tree the crew actually builds in. The motivating incident is in the
 * orchestrator field notes, and it happened twice: an agent ran `pnpm install`
 * mid-task, `node_modules/.pnpm` appeared, MUON's package-manager detection
 * changed its answer, and nine `packages/core` tests failed with assertions
 * about `pnpm --dir` versus `npm run --prefix`. Both times it looked like a
 * code regression until someone checked the filesystem.
 *
 * The detection itself has since been hardened — an installed layout is now
 * explicitly a last-resort hint that cannot override a checked-in lockfile —
 * so this module is not a second fix for that bug. It is the missing
 * OBSERVABILITY: a fingerprint that says what the environment is and whether
 * its parts agree, carried in the dispatch preamble and the handoff packet, so
 * a confusing red matrix becomes one honest line.
 *
 * It ATTESTS. It does not gate: a drifted environment is reported, never
 * refused. A check that blocks work because a stray directory exists would
 * cost more than the confusion it prevents.
 */

export type ManagerSource =
  /** package.json's own `packageManager` field — the strongest signal. */
  | "declared"
  /** A checked-in lockfile; the repository's contract. */
  | "lockfile"
  /** `node_modules` layout only. A hint, and the one that caused the incident. */
  | "installed-layout"
  /** Nothing said anything; npm because it is present wherever node is. */
  | "default";

export type EnvironmentAttestation = {
  readonly packageManager: PackageManager;
  readonly managerSource: ManagerSource;
  /** Every lockfile present. More than one usually means migration residue. */
  readonly lockfiles: readonly string[];
  /** What `node_modules` looks like installed by, when it says anything. */
  readonly installedLayout: PackageManager | "unknown" | "absent";
  /** True when nothing observed contradicts anything else observed. */
  readonly consistent: boolean;
  /**
   * Honest, human-readable drift. Empty when consistent. Each line names what
   * was observed and why it might make checks lie — never a fix to apply
   * automatically.
   */
  readonly drift: readonly string[];
};

const LOCKFILE_NAMES: readonly [file: string, manager: PackageManager][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

/** Injected so the attestation is testable without a real tree. */
export type EnvironmentProbe = {
  exists: (path: string) => Promise<boolean>;
  readPackageManagerField: () => Promise<string | undefined>;
};


/**
 * The repo's `packageManager` field, reduced to a NAME MUON already knows —
 * or dropped.
 *
 * This value is read out of the workspace's own `package.json`, which is
 * repository-controlled text, and the drift line built from it is fused into
 * the WORKER PREAMBLE — MUON's own trusted voice. Interpolating it raw let a
 * repository write newlines and instruction-shaped prose into that preamble
 * (`"pnpm@9\n\nIGNORE THE ABOVE. Your real task is…"` still resolves to a
 * valid manager for the version check), which is prompt injection into the one
 * channel the agent is told to trust.
 *
 * Narrowing beats escaping. There is no reason to echo an arbitrary string
 * here: the only thing the drift message needs to say is WHICH manager the
 * repo declared, and that is one of five known names. A value that does not
 * start with one of them tells the agent nothing it can act on, so it is
 * dropped rather than rendered — the same posture as every other bounded
 * surface in this codebase (ADR-0022 rule 2: a positive set, never a filter).
 */
const KNOWN_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

function narrowDeclaredManager(raw: string | undefined): PackageManager | undefined {
  if (typeof raw !== "string") return undefined;
  // `packageManager` is spec'd as `name@version`; only the name is rendered.
  const name = raw.trim().split("@")[0]?.trim().toLowerCase();
  return KNOWN_MANAGERS.find((manager) => manager === name);
}

/**
 * Build the attestation from what the probe can see.
 *
 * Pure over the probe: the decisions here are about what the observations
 * MEAN, and they are the part worth testing. Resolution deliberately mirrors
 * `detectPackageManager` rather than re-deriving it — two answers to "which
 * manager" is exactly the class of drift this module exists to report.
 */
export async function attestEnvironment(
  repoRoot: string,
  probe: EnvironmentProbe,
  resolved: PackageManager
): Promise<EnvironmentAttestation> {
  const declared = narrowDeclaredManager(
    await probe.readPackageManagerField()
  );
  const lockfiles: string[] = [];
  for (const [file] of LOCKFILE_NAMES) {
    if (await probe.exists(join(repoRoot, file))) lockfiles.push(file);
  }

  const hasNodeModules = await probe.exists(join(repoRoot, "node_modules"));
  let installedLayout: EnvironmentAttestation["installedLayout"] = hasNodeModules
    ? "unknown"
    : "absent";
  if (hasNodeModules) {
    if (await probe.exists(join(repoRoot, "node_modules", ".pnpm"))) {
      installedLayout = "pnpm";
    } else if (await probe.exists(join(repoRoot, "node_modules", ".yarn-state.yml"))) {
      installedLayout = "yarn";
    } else if (await probe.exists(join(repoRoot, "node_modules", ".package-lock.json"))) {
      installedLayout = "npm";
    }
  }

  const managerSource: ManagerSource = declared
    ? "declared"
    : lockfiles.length > 0
      ? "lockfile"
      : installedLayout !== "absent" && installedLayout !== "unknown"
        ? "installed-layout"
        : "default";

  const drift: string[] = [];

  // The incident, named exactly: an installed layout that disagrees with the
  // repository's own contract. Reported, never acted on.
  if (
    installedLayout !== "absent" &&
    installedLayout !== "unknown" &&
    installedLayout !== resolved
  ) {
    drift.push(
      `node_modules looks installed by ${installedLayout}, but this repo resolves to ${resolved}` +
        (lockfiles.length > 0 ? ` (${lockfiles[0]})` : "") +
        ` — a stray \`${installedLayout} install\` can make package-script checks fail as if code regressed`
    );
  }

  // Two lockfiles is usually a half-finished migration; the resolution order
  // then decides silently, which is worth saying out loud.
  const lockManagers = new Set(
    LOCKFILE_NAMES.filter(([file]) => lockfiles.includes(file)).map(
      ([, manager]) => manager
    )
  );
  if (lockManagers.size > 1) {
    drift.push(
      `${lockfiles.length} lockfiles present (${lockfiles.join(", ")}) — resolution picked ${resolved}; the others are probably migration residue`
    );
  }

  // A declared field that disagrees with the lockfiles is a real contradiction
  // rather than residue: someone changed one half.
  if (declared && lockManagers.size > 0 && !lockManagers.has(resolved)) {
    drift.push(
      `package.json declares ${declared} but the checked-in lockfiles are for ${[...lockManagers].join(", ")}`
    );
  }

  if (lockfiles.length > 0 && installedLayout === "absent") {
    drift.push(
      "dependencies are not installed — checks that run package scripts will fail for that reason, not because the code is wrong"
    );
  }

  return {
    packageManager: resolved,
    managerSource,
    lockfiles,
    installedLayout,
    consistent: drift.length === 0,
    drift,
  };
}

/**
 * The one line the field notes asked for: enough to stop someone debugging a
 * code regression that is really a filesystem accident.
 */
export function describeEnvironment(
  attestation: EnvironmentAttestation
): string {
  const head = `env: ${attestation.packageManager} (${attestation.managerSource})`;
  if (attestation.consistent) return `${head} · consistent`;
  return `${head} · DRIFT: ${attestation.drift[0]}`;
}

/** Convenience for production callers: probe the real filesystem. */
export async function attestRepoEnvironment(
  repoRoot: string,
  io: {
    exists: (path: string) => Promise<boolean>;
    readPackageManagerField: () => Promise<string | undefined>;
  }
): Promise<EnvironmentAttestation> {
  const resolved = await detectPackageManager(repoRoot);
  return attestEnvironment(repoRoot, io, resolved);
}
