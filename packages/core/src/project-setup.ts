import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { OPERATOR_TOKEN_ENV_VARS } from "@muon/adapters";
import { resolveDataDir } from "@muon/client/paths";
import { resolveCheckArgv } from "@muon/protocol";
import {
  PROJECT_SETUP_PATHS,
  parseProjectSetupConfirmationRecord,
  parseProjectSetupDocument,
  parseProjectSetupLocalDocument,
  parseUserProjectSetupOverride,
  parseWorktreeSetupDocument,
  projectSetupConfirmationMatches,
  projectSetupConfirmationRequest,
  resolveProjectSetupPlan,
  type ProjectSetupConfirmationRecord,
  type ProjectSetupConfirmationRequest,
  type ProjectSetupStep,
  type ResolvedProjectSetupPlan,
} from "@muon/protocol/project-setup";
import { isOwnedLinkedWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);
const SETUP_COMMAND_TIMEOUT_MS = 15 * 60_000;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const PROJECT_SETUP_STRIPPED_ENV = new Set<string>(OPERATOR_TOKEN_ENV_VARS);

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** Repo-declared commands never inherit a MUON control-plane credential. */
function projectSetupEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      PROJECT_SETUP_STRIPPED_ENV.has(key) ||
      (key.startsWith("MUON_") && key.endsWith("_TOKEN"))
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Stable per-checkout identity for data-dir paths (matches worktree storage). */
export function projectSetupRepoIdentity(repoRoot: string): string {
  let canonical = repoRoot;
  try {
    canonical = realpathSync(repoRoot);
  } catch {
    // keep as-is for not-yet-created temp dirs in tests
  }
  const readable =
    basename(canonical).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.+/g, ".") ||
    "repo";
  const identity = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${readable}-${identity}`;
}

export function projectSetupDataPaths(dataDir: string, repoRoot: string): {
  override: string;
  confirmation: string;
} {
  const root = join(dataDir, "projects", projectSetupRepoIdentity(repoRoot));
  return {
    override: join(root, "setup-override.json"),
    confirmation: join(root, "setup-confirmation.json"),
  };
}

export async function loadProjectSetupLayers(input: {
  repoRoot: string;
  worktreePath?: string;
  dataDir?: string;
}): Promise<{
  project?: ReturnType<typeof parseProjectSetupDocument>;
  local?: ReturnType<typeof parseProjectSetupLocalDocument>;
  worktree?: ReturnType<typeof parseWorktreeSetupDocument>;
  user?: ReturnType<typeof parseUserProjectSetupOverride>;
}> {
  const repoRoot = await realpath(input.repoRoot).catch(() => input.repoRoot);
  const worktreePath = input.worktreePath
    ? await realpath(input.worktreePath).catch(() => input.worktreePath)
    : undefined;
  const dataDir = input.dataDir ?? resolveDataDir();
  const paths = projectSetupDataPaths(dataDir, repoRoot);

  const [projectRaw, localRaw, worktreeRaw, userRaw] = await Promise.all([
    readJsonFile(join(repoRoot, PROJECT_SETUP_PATHS.project)),
    readJsonFile(join(repoRoot, PROJECT_SETUP_PATHS.local)),
    worktreePath
      ? readJsonFile(join(worktreePath, PROJECT_SETUP_PATHS.worktree))
      : Promise.resolve(undefined),
    readJsonFile(paths.override),
  ]);

  return {
    project: parseProjectSetupDocument(projectRaw),
    local: parseProjectSetupLocalDocument(localRaw),
    worktree: parseWorktreeSetupDocument(worktreeRaw),
    user: parseUserProjectSetupOverride(userRaw),
  };
}

export async function readProjectSetupConfirmation(input: {
  repoRoot: string;
  dataDir?: string;
}): Promise<ProjectSetupConfirmationRecord | undefined> {
  const dataDir = input.dataDir ?? resolveDataDir();
  const repoRoot = await realpath(input.repoRoot).catch(() => input.repoRoot);
  const { confirmation } = projectSetupDataPaths(dataDir, repoRoot);
  return parseProjectSetupConfirmationRecord(await readJsonFile(confirmation));
}

export async function recordProjectSetupConfirmation(input: {
  repoRoot: string;
  setupHash: string;
  dataDir?: string;
  confirmedAt?: string;
}): Promise<ProjectSetupConfirmationRecord> {
  const dataDir = input.dataDir ?? resolveDataDir();
  const repoRoot = await realpath(input.repoRoot).catch(() => input.repoRoot);
  const { confirmation } = projectSetupDataPaths(dataDir, repoRoot);
  const record: ProjectSetupConfirmationRecord = {
    version: 1,
    setupHash: input.setupHash,
    confirmedAt: input.confirmedAt ?? new Date().toISOString(),
  };
  await mkdir(join(confirmation, ".."), { recursive: true });
  await writeFile(confirmation, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return record;
}

export async function resolveEffectiveProjectSetup(input: {
  repoRoot: string;
  worktreePath?: string;
  dataDir?: string;
}): Promise<ResolvedProjectSetupPlan> {
  const layers = await loadProjectSetupLayers(input);
  return resolveProjectSetupPlan(layers);
}

export type ProjectSetupExecution = {
  command: string;
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ok: boolean;
};

export type ProjectSetupRunResult = {
  plan: ResolvedProjectSetupPlan;
  confirmationRequired?: ProjectSetupConfirmationRequest;
  setup: ProjectSetupExecution[];
  problems: string[];
};

async function runSetupStep(
  cwd: string,
  step: ProjectSetupStep,
  _index: number
): Promise<ProjectSetupExecution> {
  const argv = resolveCheckArgv(step);
  const [command, ...args] = argv;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: SETUP_COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: projectSetupEnvironment(),
    });
    return {
      command: argv.join(" "),
      argv,
      exitCode: 0,
      signal: null,
      stdout: stdout.slice(0, 4_000),
      stderr: stderr.slice(0, 4_000),
      ok: true,
    };
  } catch (error) {
    const execError = error as {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    return {
      command: argv.join(" "),
      argv,
      exitCode: typeof execError.code === "number" ? execError.code : null,
      signal: execError.signal ?? null,
      stdout: (execError.stdout ?? "").slice(0, 4_000),
      stderr: (execError.stderr ?? describe(error)).slice(0, 4_000),
      ok: false,
    };
  }
}

/**
 * Resolve and optionally execute declarative setup for a worktree.
 *
 * Non-user lifecycle commands never run without a matching confirmation record.
 * Pass {@link input.onSetupConfirmationRequired} to persist approval out-of-band.
 */
export async function runProjectSetup(input: {
  repoRoot: string;
  worktreePath: string;
  dataDir?: string;
  /** When false, resolve only — never spawn setup commands. */
  execute?: boolean;
  onSetupConfirmationRequired?: (
    request: ProjectSetupConfirmationRequest
  ) => Promise<boolean>;
}): Promise<ProjectSetupRunResult> {
  const plan = await resolveEffectiveProjectSetup({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    dataDir: input.dataDir,
  });
  const problems: string[] = [];
  const setupRuns: ProjectSetupExecution[] = [];

  const confirmation = projectSetupConfirmationRequest(plan);
  if (confirmation) {
    const record = await readProjectSetupConfirmation({
      repoRoot: input.repoRoot,
      dataDir: input.dataDir,
    });
    if (!projectSetupConfirmationMatches({
      confirmationBound: plan.confirmationBound,
      record,
    })) {
      if (input.onSetupConfirmationRequired) {
        const approved = await input.onSetupConfirmationRequired(confirmation);
        if (approved) {
          await recordProjectSetupConfirmation({
            repoRoot: input.repoRoot,
            setupHash: confirmation.setupHash,
            dataDir: input.dataDir,
          });
        } else {
          return {
            plan,
            confirmationRequired: confirmation,
            setup: setupRuns,
            problems: [
              `project lifecycle commands require operator confirmation (hash ${confirmation.setupHash.slice(0, 12)}…)`,
            ],
          };
        }
      } else {
        return {
          plan,
          confirmationRequired: confirmation,
          setup: setupRuns,
          problems: [
            `project lifecycle commands require operator confirmation (hash ${confirmation.setupHash.slice(0, 12)}…)`,
          ],
        };
      }
    }
  }

  if (input.execute === false || plan.setup.length === 0) {
    return { plan, setup: setupRuns, problems };
  }

  const cwd = await realpath(input.worktreePath).catch(() => input.worktreePath);
  if (!isOwnedLinkedWorktree(input.repoRoot, cwd)) {
    problems.push(
      `refused project setup outside a linked worktree owned by '${input.repoRoot}'`
    );
    return { plan, setup: setupRuns, problems };
  }
  for (let index = 0; index < plan.setup.length; index += 1) {
    const result = await runSetupStep(cwd, plan.setup[index]!, index);
    setupRuns.push(result);
    if (!result.ok) {
      problems.push(
        `setup step ${index + 1} failed (${result.command}): ${result.stderr || "non-zero exit"}`
      );
      break;
    }
  }

  return { plan, setup: setupRuns, problems };
}

export type ProjectSetupTeardownResult = {
  plan: ResolvedProjectSetupPlan;
  confirmationRequired?: ProjectSetupConfirmationRequest;
  teardown: ProjectSetupExecution[];
  teardownProblems: string[];
  removed: boolean;
  removalError?: string;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Run declarative teardown commands, then force-remove the worktree.
 * Teardown command failures are recorded but do not block removal.
 */
export async function teardownTaskWorktreeProjectSetup(input: {
  repoRoot: string;
  worktreePath: string;
  dataDir?: string;
}): Promise<ProjectSetupTeardownResult> {
  const plan = await resolveEffectiveProjectSetup({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    dataDir: input.dataDir,
  });
  const teardownRuns: ProjectSetupExecution[] = [];
  const teardownProblems: string[] = [];

  const cwd = await realpath(input.worktreePath).catch(() => input.worktreePath);
  if (!isOwnedLinkedWorktree(input.repoRoot, cwd)) {
    return {
      plan,
      teardown: teardownRuns,
      teardownProblems,
      removed: false,
      removalError: `refused teardown outside a linked worktree owned by '${input.repoRoot}'`,
    };
  }

  const confirmation = projectSetupConfirmationRequest(plan);
  let mayRunTeardown = true;
  if (plan.confirmationBound.teardown.length > 0 && confirmation) {
    const record = await readProjectSetupConfirmation({
      repoRoot: input.repoRoot,
      dataDir: input.dataDir,
    });
    mayRunTeardown = projectSetupConfirmationMatches({
      confirmationBound: plan.confirmationBound,
      record,
    });
    if (!mayRunTeardown) {
      teardownProblems.push(
        `project lifecycle commands require operator confirmation (hash ${confirmation.setupHash.slice(0, 12)}…); teardown commands were skipped`
      );
    }
  }
  for (
    let index = 0;
    mayRunTeardown && index < plan.teardown.length;
    index += 1
  ) {
    const result = await runSetupStep(cwd, plan.teardown[index]!, index);
    teardownRuns.push(result);
    if (!result.ok) {
      teardownProblems.push(
        `teardown step ${index + 1} failed (${result.command}): ${result.stderr || "non-zero exit"}`
      );
    }
  }

  let removed = false;
  let removalError: string | undefined;
  try {
    await git(input.repoRoot, "worktree", "remove", "--force", cwd);
    removed = true;
  } catch (error) {
    removalError = describe(error);
    if (!isOwnedLinkedWorktree(input.repoRoot, cwd)) {
      return {
        plan,
        teardown: teardownRuns,
        teardownProblems,
        removed: false,
        removalError: `${removalError}; refused direct delete after linked-worktree ownership could no longer be proved`,
      };
    }
    try {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      removed = !existsSync(cwd);
      if (!removed) {
        removalError = `${removalError}; force delete left '${cwd}' on disk`;
      }
    } catch (rmError) {
      removalError = `${removalError}; ${describe(rmError)}`;
    }
  }

  return {
    plan,
    confirmationRequired:
      !mayRunTeardown && confirmation ? confirmation : undefined,
    teardown: teardownRuns,
    teardownProblems,
    removed,
    removalError,
  };
}

/** One line summarizing what declarative setup would run. */
export function summarizeProjectSetup(plan: ResolvedProjectSetupPlan): string {
  const parts: string[] = [];
  if (plan.setup.length > 0) {
    parts.push(`${plan.setup.length} setup (${plan.sources.setup})`);
  }
  if (plan.teardown.length > 0) {
    parts.push(`${plan.teardown.length} teardown (${plan.sources.teardown})`);
  }
  if (plan.run.length > 0) {
    parts.push(`${plan.run.length} run (${plan.sources.run})`);
  }
  if (parts.length === 0) {
    return "no declarative project setup";
  }
  if (plan.repoCommittedSetup.length > 0) {
    parts.push(`${plan.repoCommittedSetup.length} repo-committed`);
  }
  return parts.join(", ");
}

export type ProjectRunOutcome = {
  plan: ResolvedProjectSetupPlan;
  /** Set when execution was refused (no commands / unconfirmed / bad cwd). */
  refused?: string;
  /** Exit code of the last run command (run commands stream to the caller's stdio). */
  exitCode?: number | null;
};

/**
 * T5 — execute the resolved `run` lifecycle in the foreground.
 *
 * Unlike setup/teardown (bounded, captured), run commands are dev-server
 * shaped: they inherit the caller's stdio and run until they exit (no
 * timeout). Same trust rules as every other lifecycle command: MUON
 * control-plane credentials are stripped from the environment, and
 * confirmation-bound commands NEVER run unconfirmed. `cwd` must be the repo
 * root itself (a human running their own checkout) or a linked worktree the
 * repo owns — never an arbitrary directory.
 */
export async function executeProjectRun(input: {
  repoRoot: string;
  cwd: string;
  dataDir?: string;
}): Promise<ProjectRunOutcome> {
  const plan = await resolveEffectiveProjectSetup({
    repoRoot: input.repoRoot,
    worktreePath: input.cwd === input.repoRoot ? undefined : input.cwd,
    dataDir: input.dataDir,
  });
  if (plan.run.length === 0) {
    return { plan, refused: "this project declares no run commands" };
  }
  const cwd = await realpath(input.cwd).catch(() => input.cwd);
  const rootReal = await realpath(input.repoRoot).catch(() => input.repoRoot);
  if (cwd !== rootReal && !isOwnedLinkedWorktree(input.repoRoot, cwd)) {
    return {
      plan,
      refused: `refused: '${input.cwd}' is neither the repository root nor a linked worktree it owns`,
    };
  }
  if (plan.confirmationBound.run.length > 0) {
    const record = await readProjectSetupConfirmation({
      repoRoot: input.repoRoot,
      dataDir: input.dataDir,
    });
    if (
      !projectSetupConfirmationMatches({
        confirmationBound: plan.confirmationBound,
        record,
      })
    ) {
      const confirmation = projectSetupConfirmationRequest(plan);
      return {
        plan,
        refused: `run commands require operator confirmation (hash ${confirmation?.setupHash.slice(0, 12)}…) — approve the pending project-setup gate first`,
      };
    }
  }
  let exitCode: number | null = 0;
  for (const step of plan.run) {
    const argv = resolveCheckArgv(step);
    const [command, ...args] = argv;
    exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(command!, args, {
        cwd,
        stdio: "inherit",
        env: projectSetupEnvironment(),
      });
      child.on("error", () => resolve(null));
      child.on("exit", (code) => resolve(code));
    });
    if (exitCode !== 0) {
      break;
    }
  }
  return { plan, exitCode };
}
