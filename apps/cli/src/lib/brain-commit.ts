import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const localRequire = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));

export type ListedRepo = { name: string; path: string };

export type BrainCommit = {
  repoName: string;
  graphCommit?: string;
  headCommit?: string;
  stale?: boolean;
};

type CommandResult = { stdout: string };

export type BrainCommitDependencies = {
  run?: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  resolveGitNexus?: () => { binary: string; commandPrefix: string[] } | null;
  canonicalize?: (path: string) => Promise<string>;
};

/** Parse the repository names and paths from `gitnexus list`. */
export function parseRepoList(stdout: string): ListedRepo[] {
  const repos: ListedRepo[] = [];
  let current: { name: string; path?: string } | null = null;
  const flush = () => {
    if (current?.path) repos.push({ name: current.name, path: current.path });
    current = null;
  };

  for (const raw of stdout.split("\n")) {
    const pathMatch = raw.match(/^\s+Path:\s+(.+?)\s*$/);
    if (pathMatch && current) {
      current.path = pathMatch[1]!;
      continue;
    }
    const headerMatch = raw.match(/^ {2}(\S.*?)\s*$/);
    if (
      headerMatch &&
      !raw.startsWith("   ") &&
      !/:/.test(raw) &&
      !/^ {2}Indexed Repositories/.test(raw)
    ) {
      flush();
      current = { name: headerMatch[1]! };
    }
  }
  flush();
  return repos;
}

/** Extract the indexed commit from one repository block in `gitnexus list`. */
export function repoCommitFromList(stdout: string, repoName: string): string | undefined {
  let inBlock = false;
  for (const raw of stdout.split("\n")) {
    const header = raw.match(/^ {2}(\S.*?)\s*$/);
    if (header && !raw.startsWith("   ") && !/:/.test(raw)) {
      inBlock = header[1] === repoName;
      continue;
    }
    if (inBlock) {
      const commit = raw.match(/^\s+Commit:\s+(\S+)/);
      if (commit) return commit[1];
    }
  }
  return undefined;
}

function resolveGitNexus(): { binary: string; commandPrefix: string[] } | null {
  const override = process.env.MUON_GITNEXUS_BIN?.trim();
  if (override) return { binary: override, commandPrefix: [] };

  for (const base of [moduleDir, join(moduleDir, "..", "..", "..", "..", "packages", "mcp")]) {
    try {
      const packagePath = localRequire.resolve("gitnexus/package.json", { paths: [base] });
      return {
        binary: process.execPath,
        commandPrefix: [join(dirname(packagePath), "dist", "cli", "index.js")],
      };
    } catch {
      // Try the next monorepo-relative resolution point.
    }
  }
  return null;
}

async function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      GITNEXUS_LBUG_EXTENSION_INSTALL: "load-only",
    },
  });
  return { stdout: String(stdout) };
}

function commitsMatch(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/** Resolve the GitNexus repository containing this workspace and report its commit. */
export async function loadBrainCommit(
  workspacePath: string = process.cwd(),
  dependencies: BrainCommitDependencies = {}
): Promise<BrainCommit> {
  const command = dependencies.run ?? run;
  const canonicalize = dependencies.canonicalize ?? realpath;
  const cli = (dependencies.resolveGitNexus ?? resolveGitNexus)();
  if (!cli) throw new Error("GitNexus CLI is unavailable.");

  const workspace = await canonicalize(workspacePath);
  const listOut = (
    await command(cli.binary, [...cli.commandPrefix, "list"], workspace)
  ).stdout;
  const commonRoot = await command(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    workspace
  )
    .then(({ stdout }) => stdout.trim())
    .then((commonDir) => (commonDir ? canonicalize(dirname(commonDir)) : undefined))
    .catch(() => undefined);
  const listed = await Promise.all(
    parseRepoList(listOut).map(async (repo) => ({
      ...repo,
      path: await canonicalize(repo.path).catch(() => repo.path),
    }))
  );
  const repo = listed
    .filter(
      (candidate) =>
        /^[A-Za-z0-9._-]+$/.test(candidate.name) &&
        (candidate.path === workspace ||
          workspace.startsWith(`${candidate.path}${sep}`) ||
          candidate.path === commonRoot)
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!repo) throw new Error("No indexed GitNexus repository contains this workspace.");

  const graphCommit = repoCommitFromList(listOut, repo.name);
  const headCommit = await command("git", ["rev-parse", "HEAD"], workspace)
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
  return {
    repoName: repo.name,
    graphCommit,
    headCommit,
    stale:
      graphCommit && headCommit ? !commitsMatch(graphCommit, headCommit) : undefined,
  };
}
