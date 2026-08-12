import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareWorktreeDependencies,
} from "../src/worktree-prep.js";
import {
  projectSetupContentHash,
  projectSetupPlanContentHash,
  PROJECT_SETUP_PATHS,
  projectSetupConfirmationRequest,
} from "@muon/protocol/project-setup";
import {
  projectSetupDataPaths,
  readProjectSetupConfirmation,
  recordProjectSetupConfirmation,
  resolveEffectiveProjectSetup,
  runProjectSetup,
  teardownTaskWorktreeProjectSetup,
  executeProjectRun,
} from "../src/project-setup.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await run("git", args, { cwd });
}

async function write(path: string, contents: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

describe("runProjectSetup", () => {
  let repoRoot: string;
  let worktree: string;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "muon-t5-data-"));
    repoRoot = await mkdtemp(join(tmpdir(), "muon-t5-repo-"));
    await git(repoRoot, "init", "--initial-branch=main");
    await git(repoRoot, "config", "user.email", "test@example.com");
    await git(repoRoot, "config", "user.name", "Muon Test");
    await write(join(repoRoot, "README.md"), "# test\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-m", "init");
    worktree = join(repoRoot, "..", `muon-t5-tree-${Date.now()}`);
    await git(repoRoot, "worktree", "add", "--detach", worktree);
  });

  afterEach(async () => {
    for (const path of [repoRoot, worktree, dataDir]) {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => {}
      );
    }
  });

  it("never auto-runs repo-committed setup without confirmation", async () => {
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        setup: [{ command: "touch", args: ["ran-setup"] }],
      })
    );

    const result = await runProjectSetup({
      repoRoot,
      worktreePath: worktree,
      dataDir,
      execute: true,
    });

    expect(result.confirmationRequired).toBeDefined();
    expect(result.problems.join(" ")).toMatch(/operator confirmation/i);
    expect(existsSync(join(worktree, "ran-setup"))).toBe(false);
  });

  it("runs setup after confirmation is recorded for the current hash", async () => {
    const setup = [{ command: "touch", args: ["ran-setup"] }];
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({ version: 1, setup })
    );
    await recordProjectSetupConfirmation({
      repoRoot,
      dataDir,
      setupHash: projectSetupPlanContentHash({ setup, teardown: [], run: [] }),
    });

    const result = await runProjectSetup({
      repoRoot,
      worktreePath: worktree,
      dataDir,
      execute: true,
    });

    expect(result.problems).toEqual([]);
    expect(result.setup).toHaveLength(1);
    expect(existsSync(join(worktree, "ran-setup"))).toBe(true);
  });

  it("requires re-confirmation when repo setup hash changes", async () => {
    const setup = [{ command: "touch", args: ["first"] }];
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({ version: 1, setup })
    );
    await recordProjectSetupConfirmation({
      repoRoot,
      dataDir,
      setupHash: projectSetupPlanContentHash({ setup, teardown: [], run: [] }),
    });
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        setup: [{ command: "touch", args: ["second"] }],
      })
    );

    const result = await runProjectSetup({
      repoRoot,
      worktreePath: worktree,
      dataDir,
      execute: true,
    });

    expect(result.confirmationRequired).toBeDefined();
    expect(existsSync(join(worktree, "second"))).toBe(false);
  });

  it("runs user override setup without repo confirmation when repo setup is empty", async () => {
    const overridePath = projectSetupDataPaths(dataDir, repoRoot).override;
    await write(
      overridePath,
      JSON.stringify({
        version: 1,
        setup: [{ command: "touch", args: ["user-setup"] }],
      })
    );

    const result = await runProjectSetup({
      repoRoot,
      worktreePath: worktree,
      dataDir,
      execute: true,
    });

    expect(result.problems).toEqual([]);
    expect(existsSync(join(worktree, "user-setup"))).toBe(true);
    expect(result.plan.sources.setup).toBe("user");
  });

  it("never auto-runs a worktree override without confirmation", async () => {
    await write(
      join(worktree, PROJECT_SETUP_PATHS.worktree),
      JSON.stringify({
        version: 1,
        setup: [{ command: "touch", args: ["worktree-bypass"] }],
      })
    );

    const result = await runProjectSetup({
      repoRoot,
      worktreePath: worktree,
      dataDir,
      execute: true,
    });

    expect(result.confirmationRequired?.confirmationBound.setup).toEqual(
      result.plan.setup
    );
    expect(existsSync(join(worktree, "worktree-bypass"))).toBe(false);
  });

  it("never auto-runs the local merge layer without confirmation", async () => {
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.local),
      JSON.stringify({
        version: 1,
        setup: [{ command: "touch", args: ["local-bypass"] }],
      })
    );

    const result = await runProjectSetup({
      repoRoot,
      worktreePath: worktree,
      dataDir,
      execute: true,
    });

    expect(result.confirmationRequired).toBeDefined();
    expect(existsSync(join(worktree, "local-bypass"))).toBe(false);
  });

  it("strips MUON and operator credentials from setup command environments", async () => {
    const overridePath = projectSetupDataPaths(dataDir, repoRoot).override;
    await write(
      overridePath,
      JSON.stringify({
        version: 1,
        setup: [
          {
            command: "sh",
            args: [
              "-c",
              "test -n \"$PATH\" && test -z \"$MUON_OPERATOR_TOKEN\" && test -z \"$MUON_FUTURE_LANE_TOKEN\" && test -z \"$GH_TOKEN\" && touch env-sanitized",
            ],
          },
        ],
      })
    );
    const previous = {
      operator: process.env.MUON_OPERATOR_TOKEN,
      future: process.env.MUON_FUTURE_LANE_TOKEN,
      github: process.env.GH_TOKEN,
    };
    process.env.MUON_OPERATOR_TOKEN = "operator-secret";
    process.env.MUON_FUTURE_LANE_TOKEN = "future-secret";
    process.env.GH_TOKEN = "github-secret";
    try {
      const result = await runProjectSetup({
        repoRoot,
        worktreePath: worktree,
        dataDir,
        execute: true,
      });
      expect(result.problems).toEqual([]);
      expect(existsSync(join(worktree, "env-sanitized"))).toBe(true);
    } finally {
      for (const [key, value] of [
        ["MUON_OPERATOR_TOKEN", previous.operator],
        ["MUON_FUTURE_LANE_TOKEN", previous.future],
        ["GH_TOKEN", previous.github],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("refuses to execute setup in a directory not owned as this repo's linked worktree", async () => {
    const unrelated = await mkdtemp(join(tmpdir(), "muon-t5-unrelated-"));
    try {
      const overridePath = projectSetupDataPaths(dataDir, repoRoot).override;
      await write(
        overridePath,
        JSON.stringify({
          version: 1,
          setup: [{ command: "touch", args: ["must-not-run"] }],
        })
      );
      const result = await runProjectSetup({
        repoRoot,
        worktreePath: unrelated,
        dataDir,
        execute: true,
      });
      expect(result.problems.join(" ")).toMatch(/refused.*linked worktree/i);
      expect(existsSync(join(unrelated, "must-not-run"))).toBe(false);
    } finally {
      await rm(unrelated, { recursive: true, force: true });
    }
  });
});

describe("prepareWorktreeDependencies declarative setup", () => {
  let source: string;
  let worktree: string;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "muon-t5-prep-data-"));
    source = await mkdtemp(join(tmpdir(), "muon-t5-prep-source-"));
    worktree = await mkdtemp(join(tmpdir(), "muon-t5-prep-tree-"));
  });

  afterEach(async () => {
    for (const path of [source, worktree, dataDir]) {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => {}
      );
    }
  });

  it("surfaces confirmation-required problems through preparation", async () => {
    await write(
      join(source, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        setup: [{ command: "touch", args: ["nope"] }],
      })
    );

    const prepared = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
      dataDir,
      executeProjectSetup: true,
    });

    expect(prepared.setupConfirmationRequired).toBeDefined();
    expect(prepared.problems.join(" ")).toMatch(/operator confirmation/i);
  });
});

describe("teardownTaskWorktreeProjectSetup", () => {
  let repoRoot: string;
  let worktreePath: string;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "muon-t5-teardown-data-"));
    repoRoot = await mkdtemp(join(tmpdir(), "muon-t5-teardown-repo-"));
    await git(repoRoot, "init", "--initial-branch=main");
    await git(repoRoot, "config", "user.email", "test@example.com");
    await git(repoRoot, "config", "user.name", "Muon Test");
    await write(join(repoRoot, "README.md"), "# test\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-m", "init");

    worktreePath = join(repoRoot, "..", `muon-t5-wt-${Date.now()}`);
    await git(repoRoot, "worktree", "add", "--detach", worktreePath);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
      () => {}
    );
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
      () => {}
    );
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("force-deletes the worktree even when teardown commands fail", async () => {
    const teardown = [{ command: "sh", args: ["-c", "exit 1"] }];
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        teardown,
      })
    );
    await recordProjectSetupConfirmation({
      repoRoot,
      dataDir,
      setupHash: projectSetupPlanContentHash({ setup: [], teardown, run: [] }),
    });

    const result = await teardownTaskWorktreeProjectSetup({
      repoRoot,
      worktreePath,
      dataDir,
    });

    expect(result.teardownProblems.length).toBeGreaterThan(0);
    expect(result.removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("runs successful teardown before removal", async () => {
    const teardown = [{ command: "touch", args: [".teardown-ran"] }];
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        teardown,
      })
    );
    await recordProjectSetupConfirmation({
      repoRoot,
      dataDir,
      setupHash: projectSetupPlanContentHash({ setup: [], teardown, run: [] }),
    });

    const result = await teardownTaskWorktreeProjectSetup({
      repoRoot,
      worktreePath,
      dataDir,
    });

    expect(result.teardownProblems).toEqual([]);
    expect(result.teardown[0]?.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("skips unconfirmed teardown commands but still removes the owned worktree", async () => {
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        teardown: [{ command: "touch", args: ["must-not-run"] }],
      })
    );

    const result = await teardownTaskWorktreeProjectSetup({
      repoRoot,
      worktreePath,
      dataDir,
    });

    expect(result.confirmationRequired).toBeDefined();
    expect(result.teardown).toEqual([]);
    expect(result.teardownProblems.join(" ")).toMatch(/confirmation.*skipped/i);
    expect(result.removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("refuses to run teardown or delete the primary repository", async () => {
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        teardown: [{ command: "touch", args: ["must-not-run"] }],
      })
    );

    const result = await teardownTaskWorktreeProjectSetup({
      repoRoot,
      worktreePath: repoRoot,
      dataDir,
    });

    expect(result.removed).toBe(false);
    expect(result.removalError).toMatch(/refused.*linked worktree/i);
    expect(existsSync(join(repoRoot, "README.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "must-not-run"))).toBe(false);
  });
});

describe("readProjectSetupConfirmation", () => {
  it("round-trips confirmation records in the data dir", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "muon-t5-confirm-repo-"));
    const dataDir = await mkdtemp(join(tmpdir(), "muon-t5-confirm-data-"));
    try {
      const hash = projectSetupContentHash([{ command: "npm", args: ["ci"] }]);
      await recordProjectSetupConfirmation({ repoRoot, dataDir, setupHash: hash });
      const record = await readProjectSetupConfirmation({ repoRoot, dataDir });
      expect(record?.setupHash).toBe(hash);

      const confirmationPath = projectSetupDataPaths(dataDir, repoRoot).confirmation;
      const raw = await readFile(confirmationPath, "utf8");
      expect(JSON.parse(raw)).toMatchObject({ version: 1, setupHash: hash });
    } finally {
      await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("resolveEffectiveProjectSetup", () => {
  it("reads all layers from disk", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "muon-t5-resolve-repo-"));
    const worktree = await mkdtemp(join(tmpdir(), "muon-t5-resolve-tree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "muon-t5-resolve-data-"));
    try {
      await write(
        join(repoRoot, PROJECT_SETUP_PATHS.project),
        JSON.stringify({ version: 1, setup: [{ command: "echo", args: ["project"] }] })
      );
      await write(
        join(repoRoot, PROJECT_SETUP_PATHS.local),
        JSON.stringify({ version: 1, setup: [{ command: "echo", args: ["local"] }] })
      );
      await write(
        join(worktree, PROJECT_SETUP_PATHS.worktree),
        JSON.stringify({ version: 1, setup: [{ command: "echo", args: ["worktree"] }] })
      );
      await write(
        projectSetupDataPaths(dataDir, repoRoot).override,
        JSON.stringify({ version: 1, setup: [{ command: "echo", args: ["user"] }] })
      );

      const plan = await resolveEffectiveProjectSetup({
        repoRoot,
        worktreePath: worktree,
        dataDir,
      });
      expect(plan.setup).toEqual([{ command: "echo", args: ["user"] }]);
      expect(plan.sources.setup).toBe("user");
    } finally {
      await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
      await rm(worktree, { recursive: true, force: true }).catch(() => {});
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── T5 week1: the run-lifecycle executor ────────────────────────────────────

describe("executeProjectRun", () => {
  let repoRoot: string;
  let worktree: string;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "muon-t5run-data-"));
    repoRoot = await mkdtemp(join(tmpdir(), "muon-t5run-repo-"));
    await git(repoRoot, "init", "--initial-branch=main");
    await git(repoRoot, "config", "user.email", "test@example.com");
    await git(repoRoot, "config", "user.name", "Muon Test");
    await write(join(repoRoot, "README.md"), "# test\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-m", "init");
    worktree = join(repoRoot, "..", `muon-t5run-tree-${Date.now()}`);
    await git(repoRoot, "worktree", "add", "--detach", worktree);
  });

  afterEach(async () => {
    for (const path of [repoRoot, worktree, dataDir]) {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => {}
      );
    }
  });

  it("refuses politely when no run commands are declared", async () => {
    const outcome = await executeProjectRun({ repoRoot, cwd: repoRoot, dataDir });
    expect(outcome.refused).toContain("no run commands");
  });

  it("never runs a confirmation-bound run command unconfirmed", async () => {
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        run: [{ command: "touch", args: ["ran-run"] }],
      })
    );
    const outcome = await executeProjectRun({ repoRoot, cwd: repoRoot, dataDir });
    expect(outcome.refused).toContain("operator confirmation");
    expect(existsSync(join(repoRoot, "ran-run"))).toBe(false);
  });

  it("runs a confirmed command in the repo root and reports its exit code", async () => {
    await write(
      join(repoRoot, PROJECT_SETUP_PATHS.project),
      JSON.stringify({
        version: 1,
        run: [{ command: "touch", args: ["ran-run"] }],
      })
    );
    const plan = await resolveEffectiveProjectSetup({ repoRoot, dataDir });
    const confirmation = projectSetupConfirmationRequest(plan)!;
    await recordProjectSetupConfirmation({
      repoRoot,
      setupHash: confirmation.setupHash,
      dataDir,
    });
    const outcome = await executeProjectRun({ repoRoot, cwd: repoRoot, dataDir });
    expect(outcome.refused).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(repoRoot, "ran-run"))).toBe(true);
  });

  it("refuses a cwd that is neither the root nor an owned worktree", async () => {
    const stranger = await mkdtemp(join(tmpdir(), "muon-t5run-stranger-"));
    try {
      await write(
        join(repoRoot, PROJECT_SETUP_PATHS.project),
        JSON.stringify({ version: 1, run: [{ command: "true" }] })
      );
      const outcome = await executeProjectRun({ repoRoot, cwd: stranger, dataDir });
      expect(outcome.refused).toContain("neither the repository root");
    } finally {
      await rm(stranger, { recursive: true, force: true }).catch(() => {});
    }
  });
});
