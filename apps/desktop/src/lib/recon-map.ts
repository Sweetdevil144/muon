import { realpath } from "node:fs/promises";
import {
  buildRepoMap,
  collectRepoSignals,
  partitionWorkspace,
  recommendCrewSize,
  type CypherRunner,
  type RepoMap,
  type RepoSignals,
  type WorkUnit,
} from "@muon/client/repo-map";
import { resolveGitNexusCli, type ResolvedGitNexusCli } from "./gitnexus-index.js";
import {
  defaultGitNexusExec,
  parseRows,
  type GitNexusExec,
} from "./gitnexus-graph.js";

// The desktop's Reconnaissance card (ROADMAP 4.1b): the same repo_map the
// orchestrator reads to auto-size + partition a crew, rendered so the human sees
// WHY N workers and WHAT each owns — bounded delegation made legible. Reuses the
// graph's CLI plumbing + @muon/client's pure projection. Fail-safe throughout.

const LIST_TIMEOUT_MS = 10_000;
const CYPHER_TIMEOUT_MS = 30_000;
const SAFE_REPO_NAME = /^[A-Za-z0-9._-]{1,128}$/;
// Governance delegation caps — source of truth is @muon/protocol's
// DELEGATION_MAX_CHILDREN / DELEGATION_MAX_DESCENDANTS (not a desktop dep). Kept
// in sync here for the recommendation the card DISPLAYS; the authoritative
// clamp still happens server-side at dispatch.
const DELEGATION_MAX_CHILDREN = 3;
const DELEGATION_MAX_DESCENDANTS = 8;

export type ReconMapResult =
  | {
      status: "ok";
      map: RepoMap;
      recommendation: {
        crewSize: number;
        caps: { maxChildren: number; maxDescendants: number };
        workUnits: WorkUnit[];
      };
    }
  | { status: "degraded"; reason: string };

export type ReconMapDependencies = {
  canonicalize: (path: string) => Promise<string>;
  gnxExec: GitNexusExec;
  resolveCli: (moduleDir?: string) => ResolvedGitNexusCli | null;
};

const defaultDependencies: ReconMapDependencies = {
  canonicalize: realpath,
  gnxExec: defaultGitNexusExec,
  resolveCli: resolveGitNexusCli,
};

const cliEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  GITNEXUS_LBUG_EXTENSION_INSTALL: "load-only",
};

/** Parse `gitnexus list` into {name, path} for every indexed repo. */
function parseRepoList(stdout: string): { name: string; path: string }[] {
  const repos: { name: string; path: string }[] = [];
  let current: { name: string; path?: string } | null = null;
  const flush = () => {
    if (current && current.path) repos.push({ name: current.name, path: current.path });
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

function isUnder(repoPath: string, workspace: string): boolean {
  const strip = (p: string) => p.replace(/[/\\]+$/, "");
  const r = strip(repoPath);
  const w = strip(workspace);
  return r === w || r.startsWith(`${w}/`);
}

/**
 * Reconnoiter every indexed repo under the workspace into a RepoMap + a crew
 * recommendation. Always resolves (fail-safe): an unreadable workspace or a
 * missing CLI degrades to a reason string.
 */
export async function loadReconMap(
  workspacePath: string,
  dependencies: ReconMapDependencies = defaultDependencies
): Promise<ReconMapResult> {
  if (!workspacePath) {
    return { status: "degraded", reason: "No workspace is open." };
  }
  let workspace: string;
  try {
    workspace = await dependencies.canonicalize(workspacePath);
  } catch {
    return { status: "degraded", reason: "Workspace path is unreadable." };
  }
  const cli = (() => {
    try {
      return dependencies.resolveCli();
    } catch {
      return null;
    }
  })();
  if (!cli) {
    return { status: "degraded", reason: "GitNexus CLI not found — cannot reconnoiter." };
  }
  try {
    const listOut = (
      await dependencies.gnxExec(cli.binary, [...cli.commandPrefix, "list"], {
        cwd: workspace,
        timeout: LIST_TIMEOUT_MS,
        windowsHide: true,
        env: cliEnv,
      })
    ).stdout;
    const canonical = await Promise.all(
      parseRepoList(listOut).map(async (repo) => {
        try {
          return { ...repo, path: await dependencies.canonicalize(repo.path) };
        } catch {
          return repo;
        }
      })
    );
    const under = canonical.filter(
      (repo) => isUnder(repo.path, workspace) && SAFE_REPO_NAME.test(repo.name)
    );
    if (under.length === 0) {
      return {
        status: "degraded",
        reason: "No indexed git repository was found under this workspace.",
      };
    }
    const repos: RepoSignals[] = await Promise.all(
      under.map((repo) => {
        const cypher: CypherRunner = async (query, repoName) =>
          parseRows(
            (
              await dependencies.gnxExec(
                cli.binary,
                [...cli.commandPrefix, "cypher", "--repo", repoName, query],
                { cwd: workspace, timeout: CYPHER_TIMEOUT_MS, windowsHide: true, env: cliEnv }
              )
            ).stdout
          );
        return collectRepoSignals(
          { path: repo.path, name: repo.name, indexed: true, stale: null },
          cypher
        );
      })
    );
    const map = buildRepoMap({ workspacePath: workspace, repos });
    const caps = {
      maxChildren: DELEGATION_MAX_CHILDREN,
      maxDescendants: DELEGATION_MAX_DESCENDANTS,
    };
    const crewSize = recommendCrewSize({ map, caps });
    const workUnits = crewSize > 0 ? partitionWorkspace(map, crewSize) : [];
    return { status: "ok", map, recommendation: { crewSize, caps, workUnits } };
  } catch (error) {
    return {
      status: "degraded",
      reason: `Could not reconnoiter the workspace: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    };
  }
}
