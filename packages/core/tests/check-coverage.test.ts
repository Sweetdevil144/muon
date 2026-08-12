import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  displayDir,
  evaluateCheckCoverage,
  extractVitestInclude,
  qualifyCheckOutcome,
  resolveCheckScope,
  type ResolvedCheckScope,
} from "../src/check-coverage.js";

/**
 * These run against the REAL configs in this repository, not fixtures. The
 * defect being fixed was a disagreement between a check command and a config
 * that both existed on disk; a fixture that re-states the include set would
 * pass while the repo drifted out from under it.
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

function expectResolved(scope: Awaited<ReturnType<typeof resolveCheckScope>>) {
  if (!scope.resolved) {
    throw new Error(`expected a resolved scope, got: ${scope.reason}`);
  }
  return scope satisfies ResolvedCheckScope;
}

describe("resolveCheckScope against this repository", () => {
  it("resolves `npm test` through the root script to the root vitest include", async () => {
    const scope = expectResolved(
      await resolveCheckScope({ command: "npm test" }, ROOT)
    );

    expect(scope.source).toBe("vitest-include");
    expect(scope.include).toEqual([
      "src/**/*.test.{ts,tsx}",
      "packages/protocol/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ]);
    // Both root-level include patterns are owned by the repo-root package;
    // `packages/protocol/tests/**` is owned by @muon/protocol. Nothing else in
    // the monorepo is observed.
    expect(scope.roots.map((root) => displayDir(root.dir)).sort()).toEqual([
      "<repo root>",
      "packages/protocol",
    ]);
  });

  it("resolves a `--prefix apps/cli` command to the apps/cli package", async () => {
    const scope = expectResolved(
      await resolveCheckScope(
        { command: "npm run --prefix apps/cli test" },
        ROOT
      )
    );

    expect(scope.runnerDir).toBe("apps/cli");
    expect(scope.include).toEqual(["tests/**/*.test.ts"]);
    expect(scope.roots).toEqual([{ dir: "apps/cli", recursive: false }]);
  });

  it("resolves a `--prefix packages/core` command to the packages/core package", async () => {
    const scope = expectResolved(
      await resolveCheckScope(
        { command: "npm run --prefix packages/core test" },
        ROOT
      )
    );

    expect(scope.runnerDir).toBe("packages/core");
    expect(scope.roots).toEqual([{ dir: "packages/core", recursive: false }]);
  });

  it("follows the root's own `cli:test` indirection to apps/cli", async () => {
    const scope = expectResolved(
      await resolveCheckScope({ command: "npm run cli:test" }, ROOT)
    );

    expect(scope.runnerDir).toBe("apps/cli");
    expect(scope.roots).toEqual([{ dir: "apps/cli", recursive: false }]);
  });

  it("refuses to guess for a command that is not a resolvable test runner", async () => {
    for (const command of ["tsc --noEmit", "npm run lint", "./scripts/ci.sh"]) {
      const scope = await resolveCheckScope({ command }, ROOT);
      expect(scope.resolved).toBe(false);
    }
  });

  it("refuses to guess when the script needs a shell", async () => {
    // `test:surfaces` chains four commands with `&&`.
    const scope = await resolveCheckScope(
      { command: "npm run test:surfaces" },
      ROOT
    );

    expect(scope).toEqual({ resolved: false, reason: "script_needs_a_shell" });
  });
});

describe("evaluateCheckCoverage: the exact failing case from the run", () => {
  const npmTest = { command: "npm test" };

  it("reports NO coverage for `npm test` over apps/cli/tests/crew.test.ts", async () => {
    const coverage = await evaluateCheckCoverage({
      check: npmTest,
      repoRoot: ROOT,
      changedFiles: ["apps/cli/tests/crew.test.ts"],
    });

    expect(coverage.status).toBe("uncovering");
    if (coverage.status !== "uncovering") return;
    expect(coverage.detail).toContain("apps/cli");
    expect(coverage.detail).toContain("packages/protocol");
    // The outcome an operator sees is NOT a pass.
    expect(qualifyCheckOutcome(true, coverage)).toBe("passed-but-uncovering");
  });

  it("still reports no coverage when the whole diff is one non-root package", async () => {
    const coverage = await evaluateCheckCoverage({
      check: npmTest,
      repoRoot: ROOT,
      changedFiles: [
        "apps/cli/src/commands/crew.ts",
        "apps/cli/tests/crew.test.ts",
      ],
    });

    expect(coverage.status).toBe("uncovering");
  });

  it("reports coverage when a changed file lives in an observed package", async () => {
    const coverage = await evaluateCheckCoverage({
      check: npmTest,
      repoRoot: ROOT,
      changedFiles: ["packages/protocol/src/handoff.ts"],
    });

    expect(coverage.status).toBe("covers");
    if (coverage.status !== "covers") return;
    expect(coverage.coveredFiles).toEqual(["packages/protocol/src/handoff.ts"]);
    expect(qualifyCheckOutcome(true, coverage)).toBe("passed");
  });

  it("covers a repo-root-package file through the `src/**` include", async () => {
    const coverage = await evaluateCheckCoverage({
      check: npmTest,
      repoRoot: ROOT,
      changedFiles: ["src/components/marketing/product-detail-page.tsx"],
    });

    expect(coverage.status).toBe("covers");
  });

  it("counts a partial intersection as covered, never as uncovering", async () => {
    const coverage = await evaluateCheckCoverage({
      check: npmTest,
      repoRoot: ROOT,
      changedFiles: [
        "apps/cli/tests/crew.test.ts",
        "packages/protocol/src/handoff.ts",
      ],
    });

    expect(coverage.status).toBe("covers");
    if (coverage.status !== "covers") return;
    expect(coverage.coveredFiles).toEqual(["packages/protocol/src/handoff.ts"]);
  });

  it("covers the same changed file once the command is scoped to its package", async () => {
    const coverage = await evaluateCheckCoverage({
      check: { command: "npm run --prefix apps/cli test" },
      repoRoot: ROOT,
      changedFiles: ["apps/cli/tests/crew.test.ts"],
    });

    expect(coverage.status).toBe("covers");
  });

  it("stays `unknown` for a command whose scope cannot be resolved", async () => {
    const coverage = await evaluateCheckCoverage({
      check: { command: "tsc --noEmit" },
      repoRoot: ROOT,
      changedFiles: ["apps/cli/tests/crew.test.ts"],
    });

    expect(coverage.status).toBe("unknown");
    // An unresolvable scope must never downgrade a real pass.
    expect(qualifyCheckOutcome(true, coverage)).toBe("passed");
  });

  it("stays `unknown` when there are no changed files to intersect", async () => {
    const coverage = await evaluateCheckCoverage({
      check: npmTest,
      repoRoot: ROOT,
      changedFiles: [],
    });

    expect(coverage).toEqual({ status: "unknown", reason: "no_changed_files" });
  });

  it("keeps a failed check failed regardless of coverage", async () => {
    const coverage = await evaluateCheckCoverage({
      check: npmTest,
      repoRoot: ROOT,
      changedFiles: ["packages/protocol/src/handoff.ts"],
    });

    expect(qualifyCheckOutcome(false, coverage)).toBe("failed");
  });
});

describe("extractVitestInclude", () => {
  it("reads the include array out of a config's test block", () => {
    expect(
      extractVitestInclude(
        `export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });`
      )
    ).toEqual({ include: ["tests/**/*.test.ts"] });
  });

  it("treats a missing include as vitest's own defaults", () => {
    expect(
      extractVitestInclude(`export default defineConfig({ test: {} });`)
    ).toEqual({ include: [] });
  });

  it("refuses a computed include instead of guessing at it", () => {
    expect(
      extractVitestInclude(
        `export default defineConfig({ test: { include: [...shared, "a"] } });`
      )
    ).toEqual({ unreadable: "include_is_computed" });
    expect(
      extractVitestInclude(
        "export default defineConfig({ test: { include: [`${base}/*.test.ts`] } });"
      )
    ).toEqual({ unreadable: "include_is_computed" });
  });
});
