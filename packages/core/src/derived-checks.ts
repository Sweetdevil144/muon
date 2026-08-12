import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessCheck } from "@muon/protocol";
import {
  displayDir,
  evaluateCheckCoverage,
  newOwnerCache,
  packageOwnerOf,
  readPackageJson,
  runnablePackageScript,
  type CheckCoverage,
  type CheckSkip,
} from "./check-coverage.js";

/**
 * Derived checks (the second half of the false-attestation fix).
 *
 * check-coverage.ts can PROVE that a declared check collects nothing from the
 * diff. On its own that turns a false green into a standing red: the seeded
 * `implement` harness declares one check, `npm test`, this repo's root vitest
 * `include` reaches two of its fifteen packages, and every mission touching any
 * of the other thirteen escalates to a human gate — correct, and useless,
 * because no test that COULD have answered the question was ever run.
 *
 * So when a declared check provably misses the diff, derive the check the diff
 * actually needs: map each changed file to its owning package (the same
 * nearest-package.json rule coverage judges by, imported, not re-implemented)
 * and run THAT package's own test script. One result per touched package, named
 * for the package, so an operator sees which suites really ran.
 *
 * Three rules keep this honest:
 *  - Everything is read at RUN TIME out of the repository's own manifests. No
 *    MUON path, no MUON layout, no assumption of a workspace. A repo that
 *    cannot be read this way derives nothing, and the declared command plus its
 *    coverage verdict stands — exactly the behavior that shipped before this.
 *  - A package with no runnable test script is NOT a failure and NOT a pass. It
 *    is `no-suite`: nothing ran there, said in those words.
 *  - A derived command is pre-qualified by the same coverage resolver before it
 *    is offered. A package whose own suite provably cannot see its own changed
 *    files is not worth running, and must not be reported as if it had.
 *
 * Authority note: this executes `scripts.test` from a manifest inside the
 * worktree the agent just edited. That is the SAME exposure the declared check
 * already has (its `npm test` runs the root manifest's script), and the same
 * mitigation applies — no harness preauthorizes Write, so poisoning any
 * manifest requires a human-approved edit first. Derivation adds reach, not
 * authority. (R5, the sandboxed check runner, is what removes the class.)
 */

/** A change spread wider than this is not a package-scoped test run any more. */
const MAX_DERIVED_PACKAGES = 8;

/** The script a derived check runs, unless the caller names another. */
const DEFAULT_SCRIPT = "test";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Rides a derived check's own output, like NO_DIFF_COVERAGE_MARKER does. */
export const DERIVED_CHECK_MARKER = "[muon:derived-check]";

/** Rides a `no-suite` result's output for surfaces that only copy text. */
export const NO_TEST_SUITE_MARKER = "[muon:no-test-suite]";

export type DerivedCheckPlan = {
  /** Operator-facing name, e.g. `tests[apps/cli]`. */
  name: string;
  /** Repo-root-relative package dir; "" is the repo-root package. */
  packageDir: string;
  /** The changed files this package owns — the "why this suite" evidence. */
  files: string[];
} & (
  | { runnable: true; check: HarnessCheck; coverage: CheckCoverage }
  | { runnable: false; skip: CheckSkip }
);

export type CheckDerivation = {
  /** One plan per touched package, in path order. */
  plans: DerivedCheckPlan[];
  /** The manager the commands were written for (evidence, not matching). */
  manager: PackageManager;
  /** Set when nothing at all could be derived, and why. */
  reason?: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lockfile → manager. `package-lock.json` is read FIRST when several exist: a
 * repo that carries more than one lockfile is usually one that migrated and
 * left the old file behind, and npm is the manager that is present wherever
 * node is. An explicit `packageManager` field outranks lockfiles. An installed
 * layout is only a last-resort hint: `node_modules/.pnpm` can be stale residue
 * from one accidental command and must never override the repository's own
 * checked-in lockfile contract.
 */
const LOCKFILES: [file: string, manager: PackageManager][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

const MANAGERS = new Set<PackageManager>(["npm", "pnpm", "yarn", "bun"]);

export async function detectPackageManager(
  repoRoot: string
): Promise<PackageManager> {
  const declared = (await readPackageJson(repoRoot, ""))?.packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@")[0] as PackageManager;
    if (MANAGERS.has(name)) {
      return name;
    }
  }
  for (const [file, manager] of LOCKFILES) {
    if (await exists(join(repoRoot, file))) {
      return manager;
    }
  }
  if (await exists(join(repoRoot, "node_modules", ".pnpm"))) {
    return "pnpm";
  }
  return "npm";
}

/**
 * The argv that runs `script` in `packageDir`. Every form is a bare argv the
 * check runner can spawn without a shell (P3-B), and every form is the
 * manager's own documented "run this script over there" flag — never a `cd`.
 */
export function packageScriptCheck(
  manager: PackageManager,
  packageDir: string,
  script: string
): { command: string; args: string[] } {
  const dir = packageDir.length > 0 ? packageDir : ".";
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["--dir", dir, "run", script] };
    case "yarn":
      return { command: "yarn", args: ["--cwd", dir, "run", script] };
    case "bun":
      return { command: "bun", args: ["--cwd", dir, "run", script] };
    default:
      return { command: "npm", args: ["run", "--prefix", dir, script] };
  }
}

/** How a derived check reads in an event line or a packet summary. */
export function formatCheckCommand(check: {
  command: string;
  args?: string[];
}): string {
  return [check.command, ...(check.args ?? [])].join(" ");
}

function noSuite(detail: string): CheckSkip {
  return { kind: "no-suite", detail: `${NO_TEST_SUITE_MARKER} ${detail}` };
}

function unverified(files: string[]): string {
  return (
    `${files.length} changed file(s) there are unverified: ` +
    `${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}. ` +
    `This is not a failure and not a pass — no suite ran.`
  );
}

/**
 * Derives one check per package the change actually touched.
 *
 * `changedFiles` are repo-root-relative, exactly as git reports them. The
 * result is a PLAN, not an execution: the caller runs the runnable entries
 * through the same check runner every other check goes through, so derived
 * checks inherit the no-shell argv spawn and the abort handling unchanged.
 */
export async function deriveChecksForChanges(input: {
  repoRoot: string;
  changedFiles: string[];
  /** Names become `${baseName}[<package>]`; defaults to the script name. */
  baseName?: string;
  /** The package.json script to derive from. */
  script?: string;
}): Promise<CheckDerivation> {
  const script = input.script ?? DEFAULT_SCRIPT;
  const baseName = input.baseName ?? script;
  const manager = await detectPackageManager(input.repoRoot);
  const cache = newOwnerCache();

  const owned = new Map<string, string[]>();
  for (const file of input.changedFiles) {
    const dir = await packageOwnerOf(input.repoRoot, file, cache);
    owned.set(dir, [...(owned.get(dir) ?? []), file]);
  }
  if (owned.size === 0) {
    return { plans: [], manager, reason: "no_changed_files" };
  }
  if (owned.size > MAX_DERIVED_PACKAGES) {
    // A change this wide is a repo-wide event; running eight-plus suites under
    // a loop budget is not a check, it is a CI run. Fall back to the declared
    // command and let the coverage verdict speak.
    return {
      plans: [],
      manager,
      reason: `too_many_packages:${owned.size}`,
    };
  }

  const plans: DerivedCheckPlan[] = [];
  for (const [packageDir, files] of [...owned.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const label = displayDir(packageDir);
    const name = `${baseName}[${label}]`;
    const manifest = await readPackageJson(input.repoRoot, packageDir);
    const declared = runnablePackageScript(manifest, script);

    if (declared === undefined) {
      plans.push({
        name,
        packageDir,
        files,
        runnable: false,
        skip: noSuite(
          `${label} declares no runnable \`${script}\` script, so no suite ` +
            `exists there. ${unverified(files)}`
        ),
      });
      continue;
    }

    const check = {
      name,
      ...packageScriptCheck(manager, packageDir, script),
    } satisfies HarnessCheck;
    // Pre-qualified by the SAME resolver that judged the declared command: a
    // package whose own suite provably collects nothing from its own changed
    // files answers nothing, so it is reported rather than run. (`unknown` — a
    // runner we cannot read — still runs: it is the package's own suite for the
    // package that changed, which is the strongest evidence available.)
    const coverage = await evaluateCheckCoverage({
      check,
      repoRoot: input.repoRoot,
      changedFiles: files,
    });
    if (coverage.status === "uncovering") {
      plans.push({
        name,
        packageDir,
        files,
        runnable: false,
        skip: noSuite(
          `${label}'s own \`${script}\` script (${formatCheckCommand(check)}) ` +
            `collects nothing from ${label}: ${coverage.detail}. ` +
            `${unverified(files)}`
        ),
      });
      continue;
    }
    plans.push({ name, packageDir, files, runnable: true, check, coverage });
  }

  return {
    plans,
    manager,
    ...(plans.some((plan) => plan.runnable)
      ? {}
      : { reason: "no_runnable_suite_in_changed_packages" }),
  };
}

/** Whether a derivation can actually answer the question the declared check could not. */
export function hasRunnablePlan(derivation: CheckDerivation): boolean {
  return derivation.plans.some((plan) => plan.runnable);
}

/** The sentence a derived check's own output opens with. */
export function describeDerivedCheck(
  plan: Extract<DerivedCheckPlan, { runnable: true }>,
  declared: { name: string; command: string }
): string {
  return (
    `${DERIVED_CHECK_MARKER} MUON ran ${displayDir(plan.packageDir)}'s own ` +
    `test script (${formatCheckCommand(plan.check)}) because the declared ` +
    `check '${declared.name}' (${declared.command}) collects nothing from ` +
    `${displayDir(plan.packageDir)}, where ${plan.files.length} changed ` +
    `file(s) live.`
  );
}

/** The sentence a superseded declared check's output gains. */
export function describeSupersededCheck(
  declared: { name: string; command: string },
  ran: string[]
): string {
  return (
    `${DERIVED_CHECK_MARKER} check '${declared.name}' (${declared.command}) ` +
    `is not evidence for this change; MUON ran the changed packages' own ` +
    `suites instead: ${ran.join(", ")}.`
  );
}
