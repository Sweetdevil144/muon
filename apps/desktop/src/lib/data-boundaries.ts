import { realpath } from "node:fs/promises";
import {
  buildDataBoundary,
  tablesForFileQuery,
  writersForTablesQuery,
  type DataBoundary,
  type WriterRow,
} from "@muon/client/data-boundaries";
import { resolveGitNexusCli, type ResolvedGitNexusCli } from "./gitnexus-index.js";
import {
  defaultGitNexusExec,
  parseRows,
  resolveRepoNameForPath,
  type GitNexusExec,
} from "./gitnexus-graph.js";

// The desktop's migration-risk lookup (ROADMAP 4.1b): which datastore tables a
// file writes + who else writes them, so the pre-edit Brain surfaces the
// highest-consequence class of edit (a schema/shape change to a shared table is
// a migration) at the decision point. Reuses the graph's CLI plumbing.

const LIST_TIMEOUT_MS = 10_000;
const CYPHER_TIMEOUT_MS = 30_000;
const SAFE_REPO_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export type DataBoundaryResult =
  | { status: "ok"; boundary: DataBoundary }
  | { status: "degraded"; reason: string };

export type DataBoundaryDependencies = {
  canonicalize: (path: string) => Promise<string>;
  gnxExec: GitNexusExec;
  resolveCli: (moduleDir?: string) => ResolvedGitNexusCli | null;
};

const defaultDependencies: DataBoundaryDependencies = {
  canonicalize: realpath,
  gnxExec: defaultGitNexusExec,
  resolveCli: resolveGitNexusCli,
};

const cliEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  GITNEXUS_LBUG_EXTENSION_INSTALL: "load-only",
};

const cypherQuote = (value: string) =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * Resolve a file's datastore footprint for the bound workspace. `file` is a
 * repo-relative path (as the pre-edit target names it). Always resolves.
 */
export async function loadDataBoundaries(
  workspacePath: string,
  file: string,
  dependencies: DataBoundaryDependencies = defaultDependencies
): Promise<DataBoundaryResult> {
  const relFile = file.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!workspacePath || !relFile) {
    return { status: "degraded", reason: "No workspace or file target." };
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
  if (!cli) return { status: "degraded", reason: "GitNexus CLI not found." };
  try {
    const listOut = (
      await dependencies.gnxExec(cli.binary, [...cli.commandPrefix, "list"], {
        cwd: workspace,
        timeout: LIST_TIMEOUT_MS,
        windowsHide: true,
        env: cliEnv,
      })
    ).stdout;
    const repoName = resolveRepoNameForPath(listOut, workspace);
    if (!repoName || !SAFE_REPO_NAME.test(repoName)) {
      return { status: "degraded", reason: "Workspace is not indexed." };
    }
    const cypher = async (query: string) =>
      parseRows(
        (
          await dependencies.gnxExec(
            cli.binary,
            [...cli.commandPrefix, "cypher", "--repo", repoName, query],
            { cwd: workspace, timeout: CYPHER_TIMEOUT_MS, windowsHide: true, env: cliEnv }
          )
        ).stdout
      );
    const tableRows = await cypher(tablesForFileQuery(cypherQuote(relFile)));
    const queriedTables = tableRows.map((r) => String(r.tbl)).filter(Boolean);
    let writerRows: WriterRow[] = [];
    if (queriedTables.length > 0) {
      const quoted = queriedTables.slice(0, 40).map(cypherQuote).join(", ");
      const rows = await cypher(writersForTablesQuery(quoted));
      writerRows = rows.map((r) => ({ table: String(r.tbl), file: String(r.file) }));
    }
    return {
      status: "ok",
      boundary: buildDataBoundary({ file: relFile, queriedTables, writerRows }),
    };
  } catch (error) {
    return {
      status: "degraded",
      reason: `Could not read data boundaries: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    };
  }
}
