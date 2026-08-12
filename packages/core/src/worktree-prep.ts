import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { ProjectSetupConfirmationRequest } from "@muon/protocol/project-setup";
import {
  runProjectSetup,
  summarizeProjectSetup,
  type ProjectSetupRunResult,
} from "./project-setup.js";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * `apps/<name>` and `packages/<name>` sit at depth 2; `backend/` at depth 1;
 * the repo root at 0. Deeper nesting is not a layout npm installs into, and
 * walking further would only cost readdirs on source trees.
 */
const MAX_WORKSPACE_DEPTH = 2;

/** Never worth descending when hunting for installed dependency trees. */
const UNWALKABLE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
]);

/**
 * `node_modules` entries that belong to the tree that RUNS, not the tree that
 * installed: per-run caches and npm's install ledger. Sharing them would let a
 * worktree's tooling write back into the primary checkout, so they are left
 * absent and each worktree regenerates its own.
 */
const WORKTREE_LOCAL_ENTRIES = new Set([
  ".package-lock.json",
  ".vite",
  ".vite-temp",
  ".cache",
  ".modules.yaml",
  ".yarn-integrity",
]);

export type WorktreeDependencyLink = {
  /** Package directory relative to the repo root; `""` is the root itself. */
  packageDir: string;
  /** Entries pointed back at the primary checkout's installed copy. */
  shared: number;
  /** Entries re-pointed at the WORKTREE's own package source. */
  workspace: number;
  /** Declared entry-point dirs (e.g. `dist`) mirrored in, newest-absent only. */
  mirroredOutputs: string[];
};

export type WorktreePreparation = {
  /** Per-package-directory results, sorted by `packageDir`. */
  links: WorktreeDependencyLink[];
  /**
   * Why this worktree is NOT test-capable. Non-empty means the caller must
   * refuse the run: a half-linked tree is discovered by the worker only after
   * it has spent its whole budget failing to resolve a module.
   */
  problems: string[];
  /** Resolved declarative setup/teardown/run plan (ROADMAP T5). */
  projectSetup?: ProjectSetupRunResult["plan"];
  /** Set when repo-committed setup awaits operator confirmation. */
  setupConfirmationRequired?: ProjectSetupConfirmationRequest;
  /** Per-step setup execution results when setup ran. */
  projectSetupRuns?: ProjectSetupRunResult["setup"];
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** Every directory at or under `sourceRoot` that has an installed tree. */
async function findInstalledPackageDirs(sourceRoot: string): Promise<string[]> {
  const found: string[] = [];

  const visit = async (relativeDir: string, depth: number): Promise<void> => {
    const absolute = relativeDir === "" ? sourceRoot : join(sourceRoot, relativeDir);
    if (existsSync(join(absolute, "node_modules"))) {
      found.push(relativeDir);
    }
    if (depth >= MAX_WORKSPACE_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (UNWALKABLE_DIRS.has(entry.name)) continue;
      await visit(
        relativeDir === "" ? entry.name : join(relativeDir, entry.name),
        depth + 1
      );
    }
  };

  await visit("", 0);
  return found.sort();
}

type LinkPlan = {
  /** Absolute path the worktree's link should point at. */
  target: string;
  /** True when the target is the worktree's OWN source, not the primary tree. */
  workspace: boolean;
};

/**
 * THE rule that keeps a worker honest. Resolve what an installed entry really
 * is, then decide which tree owns it:
 *
 *   - it resolves to repo content OUTSIDE any `node_modules` → it is a
 *     workspace package (`@muon/protocol` -> `<root>/packages/protocol`), so the
 *     worktree must point at ITS OWN copy. Pointing at the primary checkout is
 *     the silent-false-green bug: a worker edits `packages/core` here and tests
 *     the code over there.
 *   - anything else is an installed third-party tree → share the primary
 *     checkout's copy so no network install is needed.
 *
 * Sharing installed trees also shares NATIVE binaries (prisma's query engine,
 * fsevents, the lightningcss/oxide/swc `.node` addons). That is safe and
 * deliberate: a linked worktree lives on the same machine and the same
 * architecture as the checkout that installed them, so a prebuilt
 * `darwin-arm64` addon is exactly the one this process would have loaded.
 */
async function planLink(
  entryPath: string,
  sourceRoot: string,
  worktreePath: string
): Promise<LinkPlan> {
  let resolved = entryPath;
  try {
    resolved = await realpath(entryPath);
  } catch {
    // A dangling link in the source install: share it as-is and let whatever
    // needed it fail the same way it would have in the primary checkout.
    return { target: entryPath, workspace: false };
  }
  const fromRoot = relative(sourceRoot, resolved);
  const insideRepo =
    fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
  const installed = fromRoot.split(sep).includes("node_modules");
  if (insideRepo && !installed) {
    return { target: join(worktreePath, fromRoot), workspace: true };
  }
  return { target: resolved, workspace: false };
}

/** Idempotent: re-points a stale link, never clobbers real worker content. */
async function applyLink(linkPath: string, plan: LinkPlan): Promise<void> {
  const existing = await lstat(linkPath).catch(() => undefined);
  if (existing) {
    if (!existing.isSymbolicLink()) {
      // A real directory or file here is something the worker (or a previous
      // install) put in the worktree. Its own content outranks our mirror.
      return;
    }
    if ((await readlink(linkPath).catch(() => undefined)) === plan.target) {
      return;
    }
    await unlink(linkPath);
  }
  const targetIsDir = (await stat(plan.target).catch(() => undefined))?.isDirectory();
  await symlink(plan.target, linkPath, targetIsDir ? "dir" : "file");
}

/**
 * Mirrors one installed tree. `descend` is true only at the top level, where
 * npm's two structural directories live: `@scope/` (which may hold BOTH
 * workspace links and third-party packages, so it can never be linked whole)
 * and `.bin/` (whose shims must resolve per-entry for the same reason).
 */
async function linkInstalledTree(input: {
  sourceDir: string;
  worktreeDir: string;
  sourceRoot: string;
  worktreePath: string;
  descend: boolean;
  counts: { shared: number; workspace: number };
}): Promise<void> {
  const entries = await readdir(input.sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (WORKTREE_LOCAL_ENTRIES.has(entry.name)) continue;
    const sourceEntry = join(input.sourceDir, entry.name);
    const worktreeEntry = join(input.worktreeDir, entry.name);
    if (input.descend && (entry.name === ".bin" || entry.name.startsWith("@"))) {
      await mkdir(worktreeEntry, { recursive: true });
      await linkInstalledTree({ ...input, sourceDir: sourceEntry, worktreeDir: worktreeEntry, descend: false });
      continue;
    }
    const plan = await planLink(sourceEntry, input.sourceRoot, input.worktreePath);
    await applyLink(worktreeEntry, plan);
    if (plan.workspace) {
      input.counts.workspace += 1;
    } else {
      input.counts.shared += 1;
    }
  }
}

function manifestOutputDirs(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const record = manifest as Record<string, unknown>;
  const declared: unknown[] = [record["main"], record["types"], record["module"]];
  const bin = record["bin"];
  if (typeof bin === "string") {
    declared.push(bin);
  } else if (typeof bin === "object" && bin !== null) {
    declared.push(...Object.values(bin as Record<string, unknown>));
  }
  const dirs = new Set<string>();
  for (const value of declared) {
    if (typeof value !== "string" || value.length === 0) continue;
    const normalized = value.replace(/^\.\//, "");
    const [segment] = normalized.split("/");
    // Only a plain child directory. A manifest that points at a bare file
    // (`index.js`) or escapes the package has nothing for us to mirror.
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.length === normalized.length
    ) {
      continue;
    }
    dirs.add(segment);
  }
  return [...dirs].sort();
}

/**
 * Which of `directories` (relative to the worktree, `/`-separated) git ignores.
 *
 * The trailing slash is load-bearing: a directory-only pattern such as
 * `/packages/*​/dist/` does NOT match the path `packages/protocol/dist` when
 * that directory does not exist yet — exactly the case we are asking about.
 * Asking about `packages/protocol/dist/` tells git it is a directory.
 */
async function ignoredDirectories(
  worktreePath: string,
  directories: string[]
): Promise<Set<string>> {
  if (directories.length === 0) return new Set();
  try {
    const stdout = await git(
      worktreePath,
      "check-ignore",
      "--",
      ...directories.map((directory) => `${directory}/`)
    );
    return new Set(
      stdout
        .split("\n")
        .map((line) => line.trim().replace(/\/$/, ""))
        .filter(Boolean)
    );
  } catch (error) {
    // `check-ignore` exits 1 when NOTHING matched, which is an answer, not a
    // failure. Any other exit means we cannot prove a mirror would stay out of
    // git status, so nothing is mirrored.
    if ((error as { code?: unknown }).code === 1) return new Set();
    throw error;
  }
}

/**
 * A package resolves through its manifest's `main`/`types`/`bin`, which in this
 * repo point into a gitignored `dist/`. A fresh checkout has none, so
 * `@muon/protocol` would resolve to a path that does not exist even with the
 * links in place. Mirror the primary checkout's build output — a COPY, never a
 * link, so that rebuilding inside the worktree writes to the worktree and can
 * never reach back into the operator's tree.
 *
 * Copied only when ABSENT here and IGNORED by git, so this never overwrites a
 * worker's build and never dirties `git status`. A worktree starts at the
 * checkout's HEAD, so the mirrored output matches its source at that moment; a
 * worker that edits a package's `src` must rebuild that package before another
 * package sees the change, exactly as in the primary checkout.
 */
async function mirrorDeclaredOutputs(input: {
  packageDir: string;
  sourceRoot: string;
  worktreePath: string;
}): Promise<string[]> {
  const worktreeManifest = join(input.worktreePath, input.packageDir, "package.json");
  if (!existsSync(worktreeManifest)) return [];
  let dirs: string[];
  try {
    dirs = manifestOutputDirs(JSON.parse(await readFile(worktreeManifest, "utf8")));
  } catch {
    return [];
  }

  const candidates = dirs.filter(
    (dir) =>
      existsSync(join(input.sourceRoot, input.packageDir, dir)) &&
      !existsSync(join(input.worktreePath, input.packageDir, dir))
  );
  // git speaks `/` regardless of platform.
  const gitPath = (dir: string) =>
    [...input.packageDir.split(sep), dir].filter(Boolean).join("/");
  const ignored = await ignoredDirectories(
    input.worktreePath,
    candidates.map(gitPath)
  );

  const mirrored: string[] = [];
  for (const dir of candidates) {
    if (!ignored.has(gitPath(dir))) continue;
    await cp(
      join(input.sourceRoot, input.packageDir, dir),
      join(input.worktreePath, input.packageDir, dir),
      { recursive: true }
    );
    mirrored.push(dir);
  }
  return mirrored;
}

/**
 * A task worktree is a FULL COPY of the repository sitting inside the
 * repository, so nothing about walking into one announces that you are in one —
 * an agent (or a human) reads the same file names, the same package layout, and
 * absolute paths handed back by a code-intelligence tool point at the PRIMARY
 * checkout. That ambiguity is how a governed child ended up editing the
 * operator's real tree while its own worktree stayed pristine.
 *
 * So the tree says what it is, in a file at a path an `ls -a` and a
 * `grep -r muon` both hit. Written on every preparation so it can never drift
 * away from the tree it describes.
 *
 * Written ONLY where git already ignores `.muon/`, which is the same rule the
 * build-output mirror follows and for the same reason: nothing preparation
 * creates may show up in the worktree's `git status`, because that status is
 * the diff a human reviews and the evidence a packet hashes. A repository that
 * does not ignore `.muon/` simply gets no marker — a silent no-op is the only
 * acceptable degradation here, since the alternative is a phantom changed file
 * in every governed diff.
 */
async function writeWorktreeMarker(
  worktreePath: string,
  sourceRoot: string
): Promise<void> {
  const ignored = await ignoredDirectories(worktreePath, [".muon"]);
  if (!ignored.has(".muon")) return;
  const marker = join(worktreePath, ".muon", "WORKTREE.md");
  await mkdir(join(worktreePath, ".muon"), { recursive: true });
  await writeFile(
    marker,
    [
      "# This is a MUON task worktree — not the primary checkout",
      "",
      `- Execution root (edit ONLY here): \`${worktreePath}\``,
      `- Primary checkout (DO NOT edit): \`${sourceRoot}\``,
      "",
      "This directory is a complete, isolated copy of the repository. Every path",
      "you read, write, or run a check against must be inside the execution root.",
      "",
      "MUON's code-intelligence tools report paths in the PRIMARY checkout. Translate",
      "each one into the execution root before acting on it: replace the primary",
      "checkout prefix above with the execution root prefix.",
      "",
      "Your changes reach the operator by review and a governed merge of THIS tree.",
      "Work written into the primary checkout is outside the diff MUON reviews, and",
      "an approval that targets it is refused.",
      "",
    ].join("\n"),
    "utf8"
  );
}

/**
 * Makes a task worktree immediately buildable and testable WITHOUT a network
 * install: every installed dependency tree in the primary checkout is mirrored
 * into the worktree, with workspace packages re-pointed at the worktree's own
 * source (see {@link planLink}).
 *
 * Idempotent and cheap — link-only, no `npm install`, and a second run over an
 * already-prepared worktree just re-stats what is already correct. A repo with
 * nothing installed is a clean no-op: the worktree is then exactly as capable
 * as the checkout it came from, which is the honest outcome.
 */
export async function prepareWorktreeDependencies(input: {
  sourceRoot: string;
  worktreePath: string;
  /** When false, resolve declarative setup but never execute it. */
  executeProjectSetup?: boolean;
  dataDir?: string;
  onSetupConfirmationRequired?: (
    request: ProjectSetupConfirmationRequest
  ) => Promise<boolean>;
}): Promise<WorktreePreparation> {
  const links: WorktreeDependencyLink[] = [];
  const problems: string[] = [];

  let sourceRoot: string;
  let worktreePath: string;
  try {
    sourceRoot = await realpath(input.sourceRoot);
    worktreePath = await realpath(input.worktreePath);
  } catch (error) {
    return {
      links,
      problems: [`the worktree or its checkout could not be read (${describe(error)})`],
    };
  }
  if (sourceRoot === worktreePath) {
    // The primary checkout prepares nothing for itself.
    return { links, problems };
  }

  // Best-effort: the marker tells a reader which tree they are in, but it is an
  // aid, never a capability. It must not be able to fail a dispatch.
  await writeWorktreeMarker(worktreePath, sourceRoot).catch(() => undefined);

  let packageDirs: string[];
  try {
    packageDirs = await findInstalledPackageDirs(sourceRoot);
  } catch (error) {
    return {
      links,
      problems: [`the checkout's installed packages could not be listed (${describe(error)})`],
    };
  }

  for (const packageDir of packageDirs) {
    const worktreeDir = join(worktreePath, packageDir);
    // The worktree may sit on a commit that predates this package.
    if (!existsSync(worktreeDir)) continue;
    const counts = { shared: 0, workspace: 0 };
    let mirroredOutputs: string[] = [];
    try {
      const worktreeModules = join(worktreeDir, "node_modules");
      await mkdir(worktreeModules, { recursive: true });
      await linkInstalledTree({
        sourceDir: join(sourceRoot, packageDir, "node_modules"),
        worktreeDir: worktreeModules,
        sourceRoot,
        worktreePath,
        descend: true,
        counts,
      });
      mirroredOutputs = await mirrorDeclaredOutputs({
        packageDir,
        sourceRoot,
        worktreePath,
      });
    } catch (error) {
      problems.push(
        `'${packageDir === "" ? "." : packageDir}' could not be linked (${describe(error)})`
      );
      continue;
    }
    links.push({ packageDir, ...counts, mirroredOutputs });
  }

  const projectSetupResult = await runProjectSetup({
    repoRoot: sourceRoot,
    worktreePath: worktreePath,
    dataDir: input.dataDir,
    execute: input.executeProjectSetup ?? true,
    onSetupConfirmationRequired: input.onSetupConfirmationRequired,
  }).catch((error) => ({
    plan: {
      setup: [],
      teardown: [],
      run: [],
      repoCommittedSetup: [],
      confirmationBound: {
        setup: [],
        teardown: [],
        run: [],
      },
      sources: {
        setup: "project" as const,
        teardown: "project" as const,
        run: "project" as const,
      },
    },
    setup: [],
    problems: [
      `declarative project setup could not be evaluated (${describe(error)})`,
    ],
    confirmationRequired: undefined,
  }));

  problems.push(...projectSetupResult.problems);

  return {
    links,
    problems,
    projectSetup: projectSetupResult.plan,
    setupConfirmationRequired: projectSetupResult.confirmationRequired,
    projectSetupRuns: projectSetupResult.setup,
  };
}

/** One line an operator can read: what a prepared worktree actually got. */
export function summarizeWorktreePreparation(
  preparation: WorktreePreparation
): string {
  if (preparation.links.length === 0) {
    return "no installed dependencies to mirror";
  }
  const shared = preparation.links.reduce((total, link) => total + link.shared, 0);
  const workspace = preparation.links.reduce(
    (total, link) => total + link.workspace,
    0
  );
  const mirrored = preparation.links.filter(
    (link) => link.mirroredOutputs.length > 0
  ).length;
  const linked = `${preparation.links.length} package dirs linked (${shared} shared, ${workspace} workspace, ${mirrored} build outputs mirrored)`;
  if (!preparation.projectSetup) {
    return linked;
  }
  const declarative = summarizeProjectSetup(preparation.projectSetup);
  if (declarative === "no declarative project setup") {
    return linked;
  }
  return `${linked}; ${declarative}`;
}
