import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import {
  buildDiffImpact,
  diffImpactQueries,
  gitScopeArgs,
  parseHunks,
  type ChangedFile,
  type DiffImpact,
  type DiffScope,
  type GraphSymbol,
  type HunkRange,
  type ProcessStepRow,
} from "@muon/client/diff-impact";
import { resolveGitNexusCli, type ResolvedGitNexusCli } from "./gitnexus-index.js";
import {
  defaultGitNexusExec,
  parseRows,
  resolveRepoNameForPath,
  type GitNexusExec,
} from "./gitnexus-graph.js";

// The desktop's review-lane evidence: MUON's OWN git diff (source of truth) →
// the execution flows it disturbs, FAIL-CLOSED. Reuses the graph's CLI plumbing
// (file-redirect exec, repo-name resolution, markdown-row parse) + @muon/client's
// pure buildDiffImpact. This is what replaces the raw 256KB worktreeDiff in the
// Changes tab with "what the change BREAKS" — the wedge made visible. See
// ROADMAP 4.1b.

const execFileAsync = promisify(execFile);
const DIFF_FILE_CAP = 500;
const GIT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 10_000;
const CYPHER_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const SAFE_REPO_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export type ReviewDiffResult =
  | { status: "ok"; impact: DiffImpact }
  | { status: "degraded"; reason: string; action?: string };

export type ReviewDiffQuery = { scope?: DiffScope; baseRef?: string };

export type ReviewDiffDependencies = {
  canonicalize: (path: string) => Promise<string>;
  git: (args: string[], cwd: string) => Promise<string>;
  gnxExec: GitNexusExec;
  resolveCli: (moduleDir?: string) => ResolvedGitNexusCli | null;
};

/**
 * The repository a path belongs to, for INDEX lookup only.
 *
 * For an ordinary checkout this is the path itself. For a linked worktree —
 * every governed task tree since TODO 5.14 moved them out of the source
 * repository — it is the primary repository that owns it, derived from git's
 * own common directory (`--git-common-dir` names `<primary>/.git`, so its
 * parent is the primary root). Never throws: any git failure, or a path that
 * is not in a repository at all, degrades to the original path so the caller
 * behaves exactly as it did before.
 */
async function primaryRepoRootOf(
  workspace: string,
  dependencies: ReviewDiffDependencies
): Promise<string> {
  try {
    const common = (
      await dependencies.git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        workspace
      )
    ).trim();
    if (!common) return workspace;
    // `<primary>/.git` → `<primary>`. A bare or `--separate-git-dir` layout
    // does not end in `/.git`; leaving it alone is correct (it is then not a
    // linked worktree of an indexed checkout either).
    const suffix = "/.git";
    if (!common.endsWith(suffix)) return workspace;
    const root = common.slice(0, -suffix.length);
    if (!root) return workspace;
    return await dependencies.canonicalize(root).catch(() => root);
  } catch {
    return workspace;
  }
}

const defaultGit = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return String(stdout);
};

const defaultDependencies: ReviewDiffDependencies = {
  canonicalize: realpath,
  git: defaultGit,
  gnxExec: defaultGitNexusExec,
  resolveCli: resolveGitNexusCli,
};

const cliEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  GITNEXUS_LBUG_EXTENSION_INSTALL: "load-only",
};

/** The `Commit:` line for a repo block in `gitnexus list` output. */
function repoCommitFromList(stdout: string, name: string): string | undefined {
  let inBlock = false;
  for (const raw of stdout.split("\n")) {
    const header = raw.match(/^ {2}(\S.*?)\s*$/);
    if (header && !raw.startsWith("   ") && !/:/.test(raw)) {
      inBlock = header[1] === name;
      continue;
    }
    if (inBlock) {
      const commit = raw.match(/^\s+Commit:\s+(\S+)/);
      if (commit) return commit[1];
    }
  }
  return undefined;
}

function cypherQuotePaths(paths: readonly string[], cap: number): string {
  return paths
    .slice(0, cap)
    .map((p) => `'${p.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)
    .join(", ");
}

/**
 * Compute review-diff evidence for a workspace. Always resolves (fail-safe): any
 * failure degrades to a reason string so the caller can fall back to the raw
 * diff, and — critically — a workspace whose repo is unindexed or stale never
 * silently reads as "clean": buildDiffImpact returns a review-blind verdict and
 * the coverage/freshness fields tell the UI whether it is stale, absent, or
 * genuinely new files.
 */
export async function loadReviewDiff(
  workspacePath: string,
  query: ReviewDiffQuery = {},
  dependencies: ReviewDiffDependencies = defaultDependencies
): Promise<ReviewDiffResult> {
  const scope: DiffScope = query.scope ?? "all";
  const scoped = gitScopeArgs(scope, query.baseRef);
  if ("error" in scoped) return { status: "degraded", reason: scoped.error };

  let workspace: string;
  try {
    workspace = await dependencies.canonicalize(workspacePath);
  } catch {
    return { status: "degraded", reason: "Workspace path is unreadable." };
  }

  try {
    const changedPaths = (
      await dependencies.git(["diff", "--name-only", ...scoped.args], workspace)
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    let headCommit = "";
    try {
      headCommit = (await dependencies.git(["rev-parse", "HEAD"], workspace)).trim();
    } catch {
      /* detached / no commits — freshness stays unknown */
    }

    const cli = (() => {
      try {
        return dependencies.resolveCli();
      } catch {
        return null;
      }
    })();

    let graphFiles: string[] = [];
    let symbols: GraphSymbol[] = [];
    let steps: ProcessStepRow[] = [];
    let graphCommit: string | undefined;

    if (cli && changedPaths.length > 0) {
      const listOut = (
        await dependencies.gnxExec(cli.binary, [...cli.commandPrefix, "list"], {
          cwd: workspace,
          timeout: LIST_TIMEOUT_MS,
          windowsHide: true,
          env: cliEnv,
        })
      ).stdout;
      // A governed task worktree is a LINKED worktree whose directory lives
      // outside the source repository (TODO 5.14), so it is neither the
      // indexed repo's path nor a descendant of it — and
      // `resolveRepoNameForPath` matches on exactly those two shapes. Looking
      // the worktree up directly therefore returns null and the whole review
      // degrades to REVIEW BLIND / "workspace not indexed", on a change whose
      // repository IS indexed. Resolve the linked worktree back to its primary
      // repository first, the same git-common-dir identity ADR-0026 uses for
      // the memory partition. The DIFF still runs in the worktree — that is
      // where the change is; only the INDEX lookup is repository-scoped.
      const indexLookupPath = await primaryRepoRootOf(workspace, dependencies);
      const repoName = resolveRepoNameForPath(listOut, indexLookupPath);
      if (repoName && SAFE_REPO_NAME.test(repoName)) {
        graphCommit = repoCommitFromList(listOut, repoName);
        const quoted = cypherQuotePaths(changedPaths, DIFF_FILE_CAP);
        const queries = diffImpactQueries(quoted);
        const cypher = async (q: string) =>
          parseRows(
            (
              await dependencies.gnxExec(
                cli.binary,
                [...cli.commandPrefix, "cypher", "--repo", repoName, q],
                { cwd: workspace, timeout: CYPHER_TIMEOUT_MS, windowsHide: true, env: cliEnv }
              )
            ).stdout
          );
        const [fileRows, symRows, stepRows] = await Promise.all([
          cypher(queries.files),
          cypher(queries.symbols),
          cypher(queries.steps),
        ]);
        graphFiles = fileRows.map((r) => String(r.fp));
        symbols = symRows.map((r) => ({
          file: String(r.file),
          name: String(r.name),
          kind: String(r.kind),
          startLine: Number(r.startLine) || 0,
          endLine: Number(r.endLine) || Number(r.startLine) || 0,
        }));
        steps = stepRows.map((r) => ({
          file: String(r.file),
          symbol: String(r.symbol),
          startLine: Number(r.startLine) || 0,
          endLine: Number(r.endLine) || Number(r.startLine) || 0,
          process: String(r.process),
          processId: String(r.processId),
          step: Number(r.step) || 0,
          ...(r.entryPointId ? { entryPointId: String(r.entryPointId) } : {}),
        }));
      }
    }

    const hunks: Map<string, HunkRange[]> =
      changedPaths.length > 0
        ? parseHunks(await dependencies.git(["diff", "--unified=0", ...scoped.args], workspace))
        : new Map();
    const changedFiles: ChangedFile[] = changedPaths.map((path) => ({
      path,
      hunks: hunks.get(path) ?? [],
    }));

    // Staleness applies to EVERY scope, including the default `unstaged` — see
    // the same fix and reasoning in packages/mcp/src/gitnexus-tools.ts. The
    // excluded scopes made the DEFAULT path unable to report a stale index, so
    // a stale-but-complete file set rendered as an all-clear on the surface
    // that gates a merge. Whether the working tree differs from HEAD is the
    // diff's business; this asks only whether the GRAPH was built at HEAD.
    const stale =
      !!graphCommit && !!headCommit
        ? !headCommit.startsWith(graphCommit)
        : false;

    const impact = buildDiffImpact({
      scope,
      changedFiles,
      graphFiles,
      symbols,
      steps,
      indexFreshness: { graphCommit, headCommit, stale },
    });
    return { status: "ok", impact };
  } catch (error) {
    return {
      status: "degraded",
      reason: `Could not compute review evidence: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    };
  }
}
