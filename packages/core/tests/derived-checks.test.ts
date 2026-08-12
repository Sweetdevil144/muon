import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  evaluateCheckCoverage,
  packageOwnerOf,
  qualifyCheckOutcome,
} from "../src/check-coverage.js";
import {
  detectPackageManager,
  deriveChecksForChanges,
  formatCheckCommand,
  hasRunnablePlan,
  packageScriptCheck,
  type DerivedCheckPlan,
} from "../src/derived-checks.js";

/**
 * Derivation fixtures.
 *
 * The first half runs against THIS repository's real manifests — the layout the
 * live failure happened in. The second half builds throwaway repositories on
 * disk, because the feature's whole claim is that it works on the USER's repo:
 * a single-package project, an npm-workspaces monorepo, a repo with no tests at
 * all, and a repo whose manifest does not parse. Those four are the important
 * half; if derivation only works on MUON's own layout it is a hardcode wearing
 * a resolver's clothes.
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

function expectRunnable(plan: DerivedCheckPlan | undefined) {
  if (!plan || !plan.runnable) {
    throw new Error(
      `expected a runnable plan, got: ${plan ? plan.skip.detail : "none"}`
    );
  }
  return plan;
}

function expectSkipped(plan: DerivedCheckPlan | undefined) {
  if (!plan || plan.runnable) {
    throw new Error(
      `expected a skipped plan, got: ${plan ? formatCheckCommand(plan.check) : "none"}`
    );
  }
  return plan;
}

describe("derivation runs the suite that owns the change (this repository)", () => {
  it("derives apps/cli's own test script for a change in apps/cli", async () => {
    const derivation = await deriveChecksForChanges({
      repoRoot: ROOT,
      changedFiles: ["apps/cli/tests/crew.test.ts"],
      baseName: "tests",
    });

    expect(derivation.plans).toHaveLength(1);
    const plan = expectRunnable(derivation.plans[0]);
    expect(plan.name).toBe("tests[apps/cli]");
    expect(plan.packageDir).toBe("apps/cli");
    // The command an operator can copy into their own shell and re-run.
    expect(formatCheckCommand(plan.check)).toBe(
      "npm run --prefix apps/cli test"
    );
    // And it is offered only because it provably collects the changed file.
    expect(plan.coverage.status).toBe("covers");
  });

  it("names one check per touched package, so the operator sees which suites ran", async () => {
    const derivation = await deriveChecksForChanges({
      repoRoot: ROOT,
      changedFiles: [
        "apps/cli/src/commands/crew.ts",
        "apps/cli/tests/crew.test.ts",
        "packages/core/src/loop-runner.ts",
      ],
      baseName: "tests",
    });

    expect(derivation.plans.map((plan) => plan.name)).toEqual([
      "tests[apps/cli]",
      "tests[packages/core]",
    ]);
    expect(
      derivation.plans.map((plan) =>
        plan.runnable ? formatCheckCommand(plan.check) : plan.skip.detail
      )
    ).toEqual([
      "npm run --prefix apps/cli test",
      "npm run --prefix packages/core test",
    ]);
    // Two changed files in apps/cli, one in packages/core — the evidence for
    // why each suite was chosen.
    expect(derivation.plans[0]!.files).toHaveLength(2);
    expect(derivation.plans[1]!.files).toEqual([
      "packages/core/src/loop-runner.ts",
    ]);
  });

  it("says 'no suite' — not pass, not fail — for a package with no test script", async () => {
    // @muon/protocol really has no `test` script in this repo; its suite runs
    // from the ROOT vitest config. Read from the manifest, not asserted here.
    const derivation = await deriveChecksForChanges({
      repoRoot: ROOT,
      changedFiles: ["packages/protocol/src/vendor.ts"],
      baseName: "tests",
    });

    const plan = expectSkipped(derivation.plans[0]);
    expect(plan.skip.kind).toBe("no-suite");
    expect(plan.skip.detail).toContain("[muon:no-test-suite]");
    expect(plan.skip.detail).toContain("packages/protocol");
    expect(plan.skip.detail).toContain("no runnable `test` script");
    expect(plan.skip.detail).toContain("not a failure and not a pass");
    expect(hasRunnablePlan(derivation)).toBe(false);
    expect(derivation.reason).toBe("no_runnable_suite_in_changed_packages");
    // The packet outcome for that result is `skipped` — it fails both the
    // `=== "passed"` and the `=== "failed"` comparison every consumer makes.
    expect(qualifyCheckOutcome(true, undefined, plan.skip)).toBe("skipped");
  });

  it("declines to turn a repo-wide change into eight package test runs", async () => {
    const derivation = await deriveChecksForChanges({
      repoRoot: ROOT,
      changedFiles: [
        "apps/cli/src/a.ts",
        "apps/tui/src/a.ts",
        "apps/desktop/src/a.ts",
        "backend/src/a.ts",
        "packages/core/src/a.ts",
        "packages/graph/src/a.ts",
        "packages/mcp/src/a.ts",
        "packages/client/src/a.ts",
        "packages/adapters/src/a.ts",
      ],
    });

    expect(derivation.plans).toEqual([]);
    expect(derivation.reason).toBe("too_many_packages:9");
  });

  it("reads this repository as an npm repo, from its own lockfile", async () => {
    expect(await detectPackageManager(ROOT)).toBe("npm");
  });
});

/**
 * Ownership is what coverage and derivation both reason in, so a manifest that
 * captures files it cannot verify is a defect in both at once. This repo has a
 * real one: `packages/codegraph/tests/fixtures/python/package.json` is a
 * FIXTURE for codegraph's own indexer (`{ "name": "py-fixture", "private": true }`)
 * — nothing there can run. Treating it as the owning package made every change
 * under it a `no-suite` block, when codegraph's own suite covers it. Fixture
 * manifests are ordinary in tooling repos: you need a package.json to test how
 * package resolution behaves.
 */
describe("package ownership refuses a manifest that cannot own a suite", () => {
  it("resolves a file under codegraph's python fixture to packages/codegraph", async () => {
    expect(
      await packageOwnerOf(
        ROOT,
        "packages/codegraph/tests/fixtures/python/app.py"
      )
    ).toBe("packages/codegraph");
  });

  it("derives codegraph's own suite for it, instead of reporting no suite", async () => {
    const derivation = await deriveChecksForChanges({
      repoRoot: ROOT,
      changedFiles: ["packages/codegraph/tests/fixtures/python/app.py"],
      baseName: "tests",
    });

    const plan = expectRunnable(derivation.plans[0]);
    expect(plan.packageDir).toBe("packages/codegraph");
    expect(formatCheckCommand(plan.check)).toBe(
      "npm run --prefix packages/codegraph test"
    );
    expect(plan.coverage.status).toBe("covers");
  });

  it("still resolves a real package to ITSELF, not to its parent", async () => {
    // The rejection must not swallow real packages: every workspace package in
    // this repo owns its own files.
    expect(await packageOwnerOf(ROOT, "packages/codegraph/src/index.ts")).toBe(
      "packages/codegraph"
    );
    expect(await packageOwnerOf(ROOT, "apps/cli/tests/crew.test.ts")).toBe(
      "apps/cli"
    );
  });
});

describe("derivation on arbitrary repositories (scratch fixtures)", () => {
  const scratch: string[] = [];

  afterAll(async () => {
    await Promise.all(
      scratch.map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  async function makeRepo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "muon-derive-"));
    scratch.push(dir);
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return dir;
  }

  const vitestConfig = (include?: string[]) =>
    include
      ? `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ${JSON.stringify(include)} } });\n`
      : `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: {} });\n`;

  it("(a) single package.json: the declared command already covers, and derivation agrees", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { test: "vitest run" },
      }),
      "vitest.config.ts": vitestConfig(),
      "src/index.ts": "export const a = 1;\n",
    });

    // Nothing to fix: the repo's own `npm test` collects the change, so the
    // declared command is reported as the pass it really is.
    const coverage = await evaluateCheckCoverage({
      check: { command: "npm test" },
      repoRoot: root,
      changedFiles: ["src/index.ts"],
    });
    expect(coverage.status).toBe("covers");
    expect(qualifyCheckOutcome(true, coverage)).toBe("passed");

    // And were derivation asked anyway, it resolves the single package.
    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: ["src/index.ts"],
      baseName: "tests",
    });
    const plan = expectRunnable(derivation.plans[0]);
    expect(plan.name).toBe("tests[<repo root>]");
    expect(formatCheckCommand(plan.check)).toBe("npm run --prefix . test");
    expect(plan.coverage.status).toBe("covers");
  });

  it("(b) npm-workspaces monorepo: a narrow root check is answered by the changed workspace's suite", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["packages/*"],
        scripts: { test: "vitest run" },
      }),
      "package-lock.json": "{}",
      // The exact shape that caused the live failure: a root runner whose
      // include names ONE workspace.
      "vitest.config.ts": vitestConfig(["packages/alpha/tests/**/*.test.ts"]),
      "packages/alpha/package.json": JSON.stringify({
        name: "alpha",
        scripts: { test: "vitest run" },
      }),
      "packages/alpha/vitest.config.ts": vitestConfig(["tests/**/*.test.ts"]),
      "packages/beta/package.json": JSON.stringify({
        name: "beta",
        scripts: { test: "vitest run" },
      }),
      "packages/beta/vitest.config.ts": vitestConfig(["tests/**/*.test.ts"]),
      "packages/beta/src/pay.ts": "export const pay = () => 1;\n",
    });

    const coverage = await evaluateCheckCoverage({
      check: { command: "npm test" },
      repoRoot: root,
      changedFiles: ["packages/beta/src/pay.ts"],
    });
    expect(coverage.status).toBe("uncovering");
    expect(qualifyCheckOutcome(true, coverage)).toBe("passed-but-uncovering");

    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: ["packages/beta/src/pay.ts"],
      baseName: "tests",
    });
    const plan = expectRunnable(derivation.plans[0]);
    expect(formatCheckCommand(plan.check)).toBe(
      "npm run --prefix packages/beta test"
    );
    expect(plan.coverage.status).toBe("covers");
  });

  it("(c) a repo with no test script anywhere degrades to an honest 'no suite'", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({ name: "untested" }),
      "src/index.ts": "export const a = 1;\n",
    });

    // The declared command cannot even be resolved (there is no script), so it
    // stays `unknown` — an unresolvable scope never downgrades a real pass.
    const coverage = await evaluateCheckCoverage({
      check: { command: "npm test" },
      repoRoot: root,
      changedFiles: ["src/index.ts"],
    });
    expect(coverage).toEqual({
      status: "unknown",
      reason: "script_not_found:test",
    });

    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: ["src/index.ts"],
      baseName: "tests",
    });
    expect(hasRunnablePlan(derivation)).toBe(false);
    expect(expectSkipped(derivation.plans[0]).skip.kind).toBe("no-suite");
  });

  it("(c2) npm's placeholder `test` script is no suite, not a failing suite", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "placeholder",
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
      "src/index.ts": "export const a = 1;\n",
    });

    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: ["src/index.ts"],
    });

    // Running it would exit 1 and read as "this package's tests are broken".
    expect(hasRunnablePlan(derivation)).toBe(false);
    expect(expectSkipped(derivation.plans[0]).skip.detail).toContain(
      "no runnable `test` script"
    );
  });

  it("(d) a malformed package.json degrades, and never throws", async () => {
    const root = await makeRepo({
      "package.json": "{ this is not json",
      "packages/one/package.json": "{ neither is this",
      "packages/one/src/index.ts": "export const a = 1;\n",
    });

    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: ["packages/one/src/index.ts"],
    });
    expect(hasRunnablePlan(derivation)).toBe(false);
    expect(derivation.plans).toHaveLength(1);
    expect(expectSkipped(derivation.plans[0]).skip.kind).toBe("no-suite");

    // The coverage side of the same unreadable repo is equally quiet.
    await expect(
      evaluateCheckCoverage({
        check: { command: "npm test" },
        repoRoot: root,
        changedFiles: ["packages/one/src/index.ts"],
      })
    ).resolves.toMatchObject({ status: "unknown" });
  });

  it("(e) a package whose own suite cannot see its own files is reported, not run", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({ name: "mono" }),
      "packages/alpha/package.json": JSON.stringify({
        name: "alpha",
        scripts: { test: "vitest run" },
      }),
      // alpha's runner only collects from a SIBLING package.
      "packages/alpha/vitest.config.ts": vitestConfig([
        "../beta/tests/**/*.test.ts",
      ]),
      "packages/beta/package.json": JSON.stringify({ name: "beta" }),
      "packages/alpha/src/a.ts": "export const a = 1;\n",
    });

    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: ["packages/alpha/src/a.ts"],
    });

    const plan = expectSkipped(derivation.plans[0]);
    expect(plan.skip.detail).toContain("collects nothing from packages/alpha");
    expect(hasRunnablePlan(derivation)).toBe(false);
  });

  it("(f) a fixture manifest nested in a real package does not capture its files", async () => {
    // No workspace declaration anywhere: the shape of the path is all there is
    // to go on, which is the common case in a plain repo.
    const root = await makeRepo({
      "package.json": JSON.stringify({ name: "mono" }),
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        scripts: { test: "vitest run" },
      }),
      "packages/lib/vitest.config.ts": vitestConfig(["tests/**/*.test.ts"]),
      // The fixture: a manifest that exists so a test can resolve it.
      "packages/lib/tests/fixtures/pkg/package.json": JSON.stringify({
        name: "fixture-pkg",
        private: true,
      }),
      "packages/lib/tests/fixtures/pkg/index.js": "module.exports = 1;\n",
    });

    expect(
      await packageOwnerOf(root, "packages/lib/tests/fixtures/pkg/index.js")
    ).toBe("packages/lib");

    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: ["packages/lib/tests/fixtures/pkg/index.js"],
      baseName: "tests",
    });
    const plan = expectRunnable(derivation.plans[0]);
    expect(formatCheckCommand(plan.check)).toBe(
      "npm run --prefix packages/lib test"
    );
  });

  it("(g) a DECLARED workspace package owns itself, wherever it sits", async () => {
    // The guard against overcorrecting. When the repo states what its packages
    // are, that statement wins — including for a member under a `tests/`
    // segment, which the path heuristic alone would have rejected.
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["packages/*", "packages/lib/tests/harness"],
      }),
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        scripts: { test: "vitest run" },
      }),
      "packages/lib/vitest.config.ts": vitestConfig(["tests/**/*.test.ts"]),
      "packages/lib/tests/harness/package.json": JSON.stringify({
        name: "harness",
        scripts: { test: "vitest run" },
      }),
      "packages/lib/tests/harness/vitest.config.ts": vitestConfig([
        "tests/**/*.test.ts",
      ]),
      "packages/lib/tests/harness/src/a.ts": "export const a = 1;\n",
      // …while an UNDECLARED manifest beside it is still not an owner.
      "packages/lib/tests/fixtures/pkg/package.json": JSON.stringify({
        name: "fixture-pkg",
        private: true,
      }),
      "packages/lib/tests/fixtures/pkg/index.js": "module.exports = 1;\n",
    });

    expect(
      await packageOwnerOf(root, "packages/lib/tests/harness/src/a.ts")
    ).toBe("packages/lib/tests/harness");
    expect(
      await packageOwnerOf(root, "packages/lib/tests/fixtures/pkg/index.js")
    ).toBe("packages/lib");
  });

  it("(h) reads pnpm-workspace.yaml as the same authoritative statement", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({ name: "mono" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        scripts: { test: "vitest run" },
      }),
      "packages/lib/tests/fixtures/pkg/package.json": JSON.stringify({
        name: "fixture-pkg",
        scripts: { test: "vitest run" },
      }),
      "packages/lib/tests/fixtures/pkg/index.js": "module.exports = 1;\n",
    });

    // Declared members own themselves; anything the repo did not declare is not
    // a package here — even one carrying a `test` script, because a fixture
    // that exists to be resolved by a test often carries one.
    expect(await packageOwnerOf(root, "packages/lib/src/a.ts")).toBe(
      "packages/lib"
    );
    expect(
      await packageOwnerOf(root, "packages/lib/tests/fixtures/pkg/index.js")
    ).toBe("packages/lib");
  });

  it("writes each manager's own 'run it over there' flag, never a cd", async () => {
    expect(packageScriptCheck("npm", "apps/cli", "test")).toEqual({
      command: "npm",
      args: ["run", "--prefix", "apps/cli", "test"],
    });
    expect(packageScriptCheck("pnpm", "apps/cli", "test")).toEqual({
      command: "pnpm",
      args: ["--dir", "apps/cli", "run", "test"],
    });
    expect(packageScriptCheck("yarn", "apps/cli", "test")).toEqual({
      command: "yarn",
      args: ["--cwd", "apps/cli", "run", "test"],
    });
    expect(packageScriptCheck("bun", "", "test")).toEqual({
      command: "bun",
      args: ["--cwd", ".", "run", "test"],
    });
  });

  it("detects the manager from the repo, preferring what it declares", async () => {
    const declared = await makeRepo({
      "package.json": JSON.stringify({
        name: "berry",
        packageManager: "yarn@4.1.0",
      }),
      "package-lock.json": "{}",
    });
    expect(await detectPackageManager(declared)).toBe("yarn");

    const pnpm = await makeRepo({
      "package.json": JSON.stringify({ name: "p" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    expect(await detectPackageManager(pnpm)).toBe("pnpm");

    const bare = await makeRepo({
      "package.json": JSON.stringify({ name: "bare" }),
    });
    expect(await detectPackageManager(bare)).toBe("npm");
  });

  it("derives nothing when a derived command would still cover nothing", async () => {
    // Whatever the shape, an empty changed-file set is not a coverage question.
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { test: "vitest run" },
      }),
    });
    const derivation = await deriveChecksForChanges({
      repoRoot: root,
      changedFiles: [],
    });
    expect(derivation).toMatchObject({
      plans: [],
      reason: "no_changed_files",
    });
  });
});
