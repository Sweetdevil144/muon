import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HarnessCheck } from "@muon/protocol";
import {
  displayDir,
  evaluateCheckCoverage,
  packageOwnerOf,
  qualifyCheckOutcome,
  readPackageJson,
  resolveCheckScope,
  readPackageScript,
  runnablePackageScript,
} from "../src/check-coverage.js";
import {
  deriveChecksForChanges,
  hasRunnablePlan,
} from "../src/derived-checks.js";
import { DEFAULT_HARNESSES } from "../src/harness.js";
import { runLoop, toHandoffCheck, type LoopLedger } from "../src/loop-runner.js";

/**
 * The false green, frozen.
 *
 * A real mission's only changed file was `apps/cli/tests/crew.test.ts`. It ran
 * under the SEEDED `implement` harness, whose one check is `npm test`, and this
 * repo's root vitest `include` collects `src/**` and `packages/protocol/tests/**`
 * — neither of which contains that file. `npm test` exited 0 on 68 unrelated
 * tests and MUON recorded `tests:pass`, `loop passed`, `diffVerified: true`.
 *
 * Everything here reads the REAL sources: the harness rows the backend seeds
 * (DEFAULT_HARNESSES, imported — never a hand-copied `npm test` that would keep
 * passing while the seed moved), and the real vitest configs on disk. If either
 * side drifts, these fail instead of a mission.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    if (
      existsSync(resolve(dir, "vitest.config.ts")) &&
      existsSync(resolve(dir, "packages")) &&
      existsSync(resolve(dir, "apps"))
    ) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the repository root from the test file");
}

const ROOT = repoRoot();
const CHANGED = ["apps/cli/tests/crew.test.ts"];

function seededChecks(key: string): HarnessCheck[] {
  const harness = DEFAULT_HARNESSES.find((entry) => entry.key === key);
  if (!harness) {
    throw new Error(`the seeded '${key}' harness no longer exists`);
  }
  return harness.config.checks;
}

/** Whether a package dir declares a suite MUON could actually run. */
async function runnableTestScript(dir: string): Promise<string | undefined> {
  return runnablePackageScript(await readPackageJson(ROOT, dir), "test");
}

function ledgerStub() {
  const events: { kind: string; message: string }[] = [];
  const ledger: LoopLedger = {
    createLoopRun: async () => ({ id: "loop-1" }),
    updateLoopRun: async () => undefined,
    recordEvent: async (event) => {
      events.push({ kind: event.kind, message: event.message });
    },
    requestApproval: async () => ({ id: "approval-1" }),
  };
  return { ledger, events };
}

describe("a check that collects nothing from the changed package is not a pass", () => {
  it("the seeded `implement` harness still declares the check that lied", () => {
    // Not an aesthetic assertion: the rest of this file reasons about a single
    // repo-wide command, and would quietly test nothing if the seed grew a
    // second, package-scoped check without these fixtures being revisited.
    expect(seededChecks("implement")).toEqual([
      { name: "tests", command: "npm test" },
    ]);
    expect(seededChecks("repair")).toEqual(seededChecks("implement"));
  });

  it("reports the seeded check over the real mission's diff as NOT passed", async () => {
    for (const check of seededChecks("implement")) {
      const coverage = await evaluateCheckCoverage({
        check,
        repoRoot: ROOT,
        changedFiles: CHANGED,
      });

      expect(coverage.status).toBe("uncovering");
      if (coverage.status !== "uncovering") return;

      const outcome = qualifyCheckOutcome(true, coverage);
      expect(outcome).not.toBe("passed");
      expect(outcome).toBe("passed-but-uncovering");

      // The operator-facing sentence names BOTH sides of the mismatch: what the
      // command reached, and where the change actually lived.
      expect(coverage.detail).toContain("packages/protocol");
      expect(coverage.detail).toContain(displayDir(""));
      expect(coverage.detail).toContain("apps/cli");
    }
  });

  it("never lets the loop report success on that check alone", async () => {
    const { ledger, events } = ledgerStub();

    const outcome = await runLoop({
      laneKey: "codex",
      laneId: "lane-cx",
      taskId: "task-frozen",
      brief: "Add --json to `muon crew coord`, with a test",
      checks: seededChecks("implement"),
      cwd: ROOT,
      changedFiles: async () => CHANGED,
      // Derivation OFF: this pins what the seeded check is worth BY ITSELF,
      // which is what the live mission actually shipped on.
      deriveChecks: "off",
      maxIterations: 1,
      ledger,
      onEvent: () => undefined,
      execute: async () => ({ exitCode: 0, output: "done" }),
      runCheck: async (check) => ({
        name: check.name,
        command: check.command,
        ok: true,
        exitCode: 0,
        // The exact shape of the lie: a green run naming a file from a package
        // the diff never touched.
        outputTail:
          "✓ packages/protocol/tests/vendor-registry.test.ts (68 tests)",
      }),
    });

    expect(outcome.status).not.toBe("passed");
    expect(events.some((e) => e.message.startsWith("loop passed"))).toBe(false);
    expect(events.find((e) => e.kind === "loop.iteration")!.message).toContain(
      "tests:no-coverage"
    );
    expect(toHandoffCheck(outcome.lastChecks[0]!).outcome).not.toBe("passed");
  });

  it("answers it instead by running apps/cli's own suite", async () => {
    const { ledger, events } = ledgerStub();
    const ran: string[] = [];

    const outcome = await runLoop({
      laneKey: "codex",
      laneId: "lane-cx",
      taskId: "task-frozen-derived",
      brief: "Add --json to `muon crew coord`, with a test",
      checks: seededChecks("implement"),
      cwd: ROOT,
      changedFiles: async () => CHANGED,
      maxIterations: 1,
      ledger,
      onEvent: () => undefined,
      execute: async () => ({ exitCode: 0, output: "done" }),
      runCheck: async (check) => {
        ran.push([check.command, ...(check.args ?? [])].join(" "));
        return {
          name: check.name,
          command: check.command,
          ok: true,
          exitCode: 0,
          outputTail: "all green",
        };
      },
    });

    expect(ran).toEqual(["npm test", "npm run --prefix apps/cli test"]);
    expect(outcome.status).toBe("passed");
    // Even on the happy path the declared check is never reported as a pass.
    expect(toHandoffCheck(outcome.lastChecks[0]!).outcome).toBe("skipped");
    expect(toHandoffCheck(outcome.lastChecks[1]!).outcome).toBe("passed");
    expect(events.find((e) => e.kind === "loop.iteration")!.message).toBe(
      "↻ 1/1 tests:superseded tests[apps/cli]:pass"
    );
  });
});

/**
 * The drift lock. Two sources of truth — the seeded check and the repository's
 * own layout — are what produced the false green, and nothing compared them.
 * This compares them on every run.
 */
describe("the seeded check and this repository agree about what it can reach", () => {
  async function workspacePackages(): Promise<string[]> {
    const dirs: string[] = [""];
    for (const parent of ["apps", "packages"]) {
      for (const entry of await readdir(join(ROOT, parent))) {
        const dir = `${parent}/${entry}`;
        if (existsSync(join(ROOT, dir, "package.json"))) {
          dirs.push(dir);
        }
      }
    }
    if (existsSync(join(ROOT, "backend", "package.json"))) {
      dirs.push("backend");
    }
    return dirs;
  }

  it("keeps the seeded check's scope RESOLVABLE, or the whole control degrades", async () => {
    for (const check of seededChecks("implement")) {
      const scope = await resolveCheckScope(check, ROOT);
      // An unresolvable scope is reported as `unknown`, which never downgrades
      // anything — so a seed edit to a command this cannot read would silently
      // switch the coverage gate off for every mission in the repo.
      expect(
        scope.resolved,
        `the seeded check '${check.name}' (${check.command}) is no longer ` +
          `resolvable (${scope.resolved ? "" : scope.reason}); coverage would ` +
          `be 'unknown' for every run and the gate would stop working`
      ).toBe(true);
    }
  });

  it("proves the seeded check reaches only part of this repo — the reason derivation exists", async () => {
    const scope = await resolveCheckScope(seededChecks("implement")[0]!, ROOT);
    if (!scope.resolved) throw new Error("unreachable: asserted above");
    const reached = new Set(scope.roots.map((root) => root.dir));
    const all = await workspacePackages();

    expect(reached.size).toBeLessThan(all.length);
    // Concretely, in this repo today: the root package and @muon/protocol.
    expect([...reached].sort()).toEqual(["", "packages/protocol"]);
  });

  it("leaves NO workspace package unverifiable: covered by the check, or derivable", async () => {
    const unverifiable: string[] = [];
    for (const dir of await workspacePackages()) {
      const changed = [join(dir, "src/__drift_probe__.ts").replace(/^\//, "")];
      const coverage = await evaluateCheckCoverage({
        check: seededChecks("implement")[0]!,
        repoRoot: ROOT,
        changedFiles: changed,
      });
      if (coverage.status === "covers") {
        continue;
      }
      const derivation = await deriveChecksForChanges({
        repoRoot: ROOT,
        changedFiles: changed,
      });
      if (!hasRunnablePlan(derivation)) {
        unverifiable.push(
          `${displayDir(dir)} (declared check: ${coverage.status}, derived: ` +
            `${derivation.reason ?? "none"})`
        );
      }
    }

    expect(
      unverifiable,
      `a change in these packages can be verified by nothing MUON knows how to ` +
        `run — the seeded check does not reach them and they declare no \`test\` ` +
        `script, so every mission touching them escalates to a human gate: ` +
        `${unverifiable.join("; ")}`
    ).toEqual([]);
  });

  /**
   * The surface drift lock. The loop verifying properly while `muon run` and
   * the workflow executors reported `ok ? "pass" : "fail"` is the same
   * two-sources-of-truth defect this file exists for, one layer up: the same
   * check, run from a different surface, was worth something different. So the
   * entry point is asserted structurally, not assumed.
   */
  async function sourceFiles(roots: string[]): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(join(ROOT, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "dist") {
            await walk(path);
          }
        } else if (/\.tsx?$/.test(entry.name)) {
          found.push(path);
        }
      }
    };
    for (const root of roots) {
      await walk(root);
    }
    return found;
  }

  const SURFACES = [
    "apps/cli/src",
    "apps/tui/src",
    "apps/desktop/src",
    "backend/src",
    "packages/runner/src",
    "packages/mcp/src",
    "packages/orchestrator/src",
  ];

  it("lets no surface run a harness check outside the one entry point", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SURFACES)) {
      const source = await readFile(join(ROOT, file), "utf8");
      if (/\brunShellCheck\s*\(/.test(source)) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `these surfaces run harness checks themselves instead of through ` +
        `runChecksWithCoverage, so their checks are NOT coverage-qualified and ` +
        `no suite is derived for a package the declared check cannot see — a ` +
        `green check there means less than the same check inside a loop: ` +
        `${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("makes every surface say so when its checks could not be qualified", async () => {
    const silent: string[] = [];
    for (const file of await sourceFiles(SURFACES)) {
      const source = await readFile(join(ROOT, file), "utf8");
      if (
        /\brunChecksWithCoverage\s*\(/.test(source) &&
        !source.includes("unqualified")
      ) {
        silent.push(file);
      }
    }

    expect(
      silent,
      `these surfaces run checks without reporting the \`unqualified\` case, ` +
        `so a run with no changed-file set to compare against reads exactly ` +
        `like a qualified pass: ${silent.join(", ")}`
    ).toEqual([]);
  });

  /**
   * Ownership drift. `packages/codegraph/tests/fixtures/python/package.json` —
   * a fixture for codegraph's indexer — captured every file beneath it, and
   * since it can run nothing, each of those files became an unverifiable
   * package and a blocked mission. A manifest may only own files it can
   * plausibly verify; this walks every manifest in the repo and asserts it.
   */
  async function manifestDirs(): Promise<string[]> {
    const dirs: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(join(ROOT, dir), { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((entry) => entry.name === "package.json")) {
        dirs.push(dir);
      }
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          entry.name !== "node_modules" &&
          entry.name !== "dist" &&
          !entry.name.startsWith(".")
        ) {
          await walk(dir.length > 0 ? `${dir}/${entry.name}` : entry.name);
        }
      }
    };
    await walk("");
    return dirs;
  }

  it("lets no manifest own files it cannot verify while a real package above it can", async () => {
    const captured: string[] = [];
    for (const dir of await manifestDirs()) {
      const probe = dir.length > 0 ? `${dir}/__probe__.ts` : "__probe__.ts";
      const owner = await packageOwnerOf(ROOT, probe);
      if (await runnableTestScript(owner)) {
        continue;
      }
      // The owner runs nothing. That is fine only if the declared check
      // collects it anyway (…/protocol's suite lives in the root config), or if
      // no ancestor could have done better.
      const coverage = await evaluateCheckCoverage({
        check: seededChecks("implement")[0]!,
        repoRoot: ROOT,
        changedFiles: [probe],
      });
      if (coverage.status === "covers") {
        continue;
      }
      const ancestors: string[] = [];
      let parent = owner;
      while (parent.length > 0) {
        parent = parent.includes("/")
          ? parent.slice(0, parent.lastIndexOf("/"))
          : "";
        if (await runnableTestScript(parent)) {
          ancestors.push(displayDir(parent));
        }
      }
      if (ancestors.length > 0) {
        captured.push(
          `${probe} → ${displayDir(owner)} (runs nothing) instead of ` +
            `${ancestors[0]}`
        );
      }
    }

    expect(
      captured,
      `these paths resolve to a manifest that can verify nothing, while a real ` +
        `package above them could have — every change there escalates to a ` +
        `human gate for no reason: ${captured.join("; ")}`
    ).toEqual([]);
  });

  it("keeps every derivable package's script runnable without a shell", async () => {
    for (const dir of await workspacePackages()) {
      const script = await readPackageScript(ROOT, dir, "test");
      if (script === undefined) {
        continue;
      }
      // A `test` script that chains commands still RUNS (npm gives it a shell),
      // but MUON cannot resolve what it collects, so the derived check would
      // report `unknown` rather than proving coverage. Worth knowing about.
      expect(
        script.includes("&&"),
        `${displayDir(dir)}'s test script chains commands (${script}); a ` +
          `derived check for it can no longer prove what it collects`
      ).toBe(false);
    }
  });
});
