import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  globalGitNexusResolveBases,
  isGitNexusStorageSkew,
  rankGitNexusManifests,
  resolveNpmGlobalRootSync,
} from "@muon/client/gitnexus-reindex";

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

/**
 * The install's GitNexus CLI, or null when MUON truly has none.
 *
 * Exported (ADR-0054) so `muon graph reindex` spawns the SAME binary `muon
 * version` reads from. A second resolver in the reindex path would be a second
 * answer to "which GitNexus is this install's" — and the two disagreeing is how
 * a command reports a store that another command never touches.
 *
 * Probe order: the entry's own install (a tarball `muon-cli` DEPENDS on
 * gitnexus since 2026-08-19, so `paths: [moduleDir]` finds it), monorepo dev
 * checkouts, then the machine's global copy via the shared base list in
 * `@muon/client/gitnexus-reindex` — the same list the desktop's resolver uses.
 */
export function resolveGitNexus(): { binary: string; commandPrefix: string[] } | null {
  const override = process.env.MUON_GITNEXUS_BIN?.trim();
  if (override) return { binary: override, commandPrefix: [] };

  const tryResolve = (base: string): string | null => {
    try {
      return localRequire.resolve("gitnexus/package.json", { paths: [base] });
    } catch {
      return null;
    }
  };
  const toCli = (manifestPath: string) => ({
    binary: process.execPath,
    commandPrefix: [join(dirname(manifestPath), "dist", "cli", "index.js")],
  });

  // LOCAL FIRST, and only then the machine's global copies. The order is a
  // performance invariant as much as a preference: the global probe runs
  // `npm root -g` (a spawnSync), and a dev checkout or a tarball install must
  // never pay it. Within each tier the NEWEST copy wins — see
  // `rankGitNexusManifests` for why newest is a ranking, not a guarantee.
  const localRanked = rankGitNexusManifests(
    [moduleDir, join(moduleDir, "..", "..", "..", "..", "packages", "mcp")],
    tryResolve
  );
  if (localRanked.length > 0) return toCli(localRanked[0]!.manifestPath);

  const globalRanked = rankGitNexusManifests(
    globalGitNexusResolveBases({
      npmGlobalRoot: resolveNpmGlobalRootSync,
      home: homedir(),
    }),
    tryResolve
  );
  return globalRanked.length > 0 ? toCli(globalRanked[0]!.manifestPath) : null;
}

/**
 * The ESCALATION: every candidate on this machine, newest first, for a caller
 * already refused by a storage-version skew. Pays the global probe on purpose
 * — by this point the cheap answer has demonstrably failed. Called by
 * `loadBrainCommit` below; an injected `resolveGitNexus` opts out, because a
 * test (or an operator override) naming one binary must not be second-guessed.
 */
export function rankedGitNexusClis(): { binary: string; commandPrefix: string[] }[] {
  const override = process.env.MUON_GITNEXUS_BIN?.trim();
  if (override) return [{ binary: override, commandPrefix: [] }];
  const tryResolve = (base: string): string | null => {
    try {
      return localRequire.resolve("gitnexus/package.json", { paths: [base] });
    } catch {
      return null;
    }
  };
  return rankGitNexusManifests(
    [
      moduleDir,
      join(moduleDir, "..", "..", "..", "..", "packages", "mcp"),
      ...globalGitNexusResolveBases({
        npmGlobalRoot: resolveNpmGlobalRootSync,
        home: homedir(),
      }),
    ],
    tryResolve
  ).map((candidate) => ({
    binary: process.execPath,
    commandPrefix: [
      join(dirname(candidate.manifestPath), "dist", "cli", "index.js"),
    ],
  }));
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
  // ESCALATE ON A STORAGE SKEW, and only on that. A store written by a newer
  // GitNexus than the one resolved here is unreadable no matter how often it
  // is retried with the same reader — but another copy on this machine may
  // read it, and that is the one failure a different copy can fix. Any other
  // error is this reader's own and is rethrown untouched.
  let listOut: string;
  try {
    listOut = (
      await command(cli.binary, [...cli.commandPrefix, "list"], workspace)
    ).stdout;
  } catch (first) {
    const reason = first instanceof Error ? first.message : String(first);
    if (!isGitNexusStorageSkew(reason) || dependencies.resolveGitNexus) throw first;
    let recovered: string | undefined;
    for (const candidate of rankedGitNexusClis()) {
      if (candidate.commandPrefix[0] === cli.commandPrefix[0]) continue;
      try {
        recovered = (
          await command(
            candidate.binary,
            [...candidate.commandPrefix, "list"],
            workspace
          )
        ).stdout;
        break;
      } catch {
        // try the next candidate
      }
    }
    if (recovered === undefined) throw first;
    listOut = recovered;
  }
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
