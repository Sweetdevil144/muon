import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitNexusGraphData,
  GitNexusGraphNode,
  GitNexusGraphRelationship,
} from "../shared/ipc.js";
import { resolveGitNexusCli, type ResolvedGitNexusCli } from "./gitnexus-index.js";

// On-demand read of the workspace's LOCAL knowledge graph for the "Open Graph"
// page. Runs two fixed, read-only Cypher queries against `<ws>/.gitnexus/` via
// the bundled CLI (electron-as-node, shell:false, load-only ⇒ no new egress).
// Never a network fetch, never a token. Fail-safe: any failure resolves to
// empty arrays + an `error` string; the caller never sees a rejection.

/** Render caps: keep the payload + sigma layout tractable. muon (~5.6k/12.4k)
 * fits fully; only a very large monorepo trips the cap, and honestly says so. */
export const MAX_NODES = 6000;
export const MAX_EDGES = 15000;

const QUERY_TIMEOUT_MS = 30_000;

// The two queries are FIXED string literals — no interpolation of caller input,
// so there is no Cypher-injection surface. shell:false passes them as one argv
// element regardless of content. We fetch cap+1 rows so truncation is HONEST
// (only flagged when a row genuinely exists beyond the cap). `name` is returned
// LAST because it is the only column that could contain a `|`; the markdown-row
// parser folds any overflow back into the final column, keeping the rest aligned.
const NODES_QUERY = `MATCH (n) RETURN n.id AS id, label(n) AS label, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.name AS name LIMIT ${MAX_NODES + 1}`;
const EDGES_QUERY = `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type LIMIT ${MAX_EDGES + 1}`;

export type GitNexusExec = (
  binary: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  }
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Run the CLI and capture ALL of stdout. Critical detail: the bundled CLI
 * prints its whole result then exits immediately; on a PIPE that races the
 * async stdout flush and truncates at the ~64KB OS buffer (a real, reproduced
 * bug). Redirecting the child's stdout to a temp FILE makes the writes
 * synchronous, so the full output survives the exit; we then read it back.
 * shell:false throughout — no injection surface.
 */
export const defaultGitNexusExec: GitNexusExec = async (binary, args, options) => {
  const dir = await mkdtemp(join(tmpdir(), "muon-gnx-"));
  const outPath = join(dir, "out.json");
  const handle = await open(outPath, "w");
  let closed = false;
  const closeHandle = async () => {
    if (!closed) {
      closed = true;
      await handle.close().catch(() => undefined);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: options.cwd,
        windowsHide: options.windowsHide,
        env: options.env,
        stdio: ["ignore", handle.fd, "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`gitnexus cypher timed out after ${options.timeout}ms`));
      }, options.timeout);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // A non-zero exit still prints `{error}` to stdout (bad query), which
      // parseRows surfaces — so resolve regardless and let the parse decide.
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await closeHandle();
    const stdout = await readFile(outPath, "utf8");
    return { stdout, stderr: "" };
  } finally {
    await closeHandle();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export type LoadGitNexusGraphOptions = {
  exec?: GitNexusExec;
  resolveCli?: (moduleDir?: string) => ResolvedGitNexusCli | null;
  moduleDir?: string;
};

/**
 * Resolve which workspace root an on-demand graph read targets: an explicit
 * `repoPath` (multi-repo graph tabs — Auto Repository Detection picking ONE
 * detected repo's own `.gitnexus/` store) wins; otherwise fall back to the
 * bound workspace root, today's single-repo behavior, unchanged. Pure so the
 * IPC handler's fallback rule is unit-testable without an Electron harness.
 */
export function resolveGraphTarget(
  repoPath: string | undefined,
  boundWorkspace: string | null
): string {
  return repoPath && repoPath.length > 0 ? repoPath : (boundWorkspace ?? "");
}

/**
 * Index-aware graph target (bulletproof against the multi-repo root). An
 * explicit repoPath always wins. Otherwise: if the bound workspace itself has an
 * index, use it (normal single repo); ELSE it is a non-git monorepo root with no
 * `.gitnexus/`, so resolve to the first DETECTED member repo that HAS an index —
 * never returning the empty root that produced "no indexed graph yet". Deps are
 * injected so the rule is unit-testable without fs/Electron.
 */
export function resolveBestGraphTarget(
  repoPath: string | undefined,
  boundWorkspace: string | null,
  deps: {
    hasIndex: (dir: string) => boolean; // `.gitnexus/meta.json` exists + readable
    detectRepos: (root: string) => string[]; // Auto Repository Detection
  }
): string {
  if (repoPath && repoPath.length > 0) return repoPath;
  const root = boundWorkspace ?? "";
  if (!root) return "";
  if (deps.hasIndex(root)) return root;
  const detected = deps.detectRepos(root);
  const indexed = detected.find((dir) => deps.hasIndex(dir));
  return indexed ?? detected[0] ?? root;
}

/**
 * Resolve the registry repo NAME for a target path from `gitnexus list` output.
 * The bundled CLI's local store is a GLOBAL multi-repo registry: `cypher` THROWS
 * "Multiple repositories indexed. Specify which one with the \"repo\" parameter"
 * whenever more than one repo is indexed — the real cause of the "no indexed
 * graph" error once a second repo (e.g. a monorepo member) joins the registry.
 * Mapping the resolved graph-target path back to its registered name lets every
 * read pass `--repo <name>`. Pure so the mapping is unit-testable without a CLI.
 * Returns null when nothing matches (empty/single-repo store, or an unindexed
 * path) so the caller reads without --repo — the legacy single-repo behavior.
 */
export function resolveRepoNameForPath(
  listStdout: string,
  targetPath: string
): string | null {
  const strip = (p: string) => p.replace(/[/\\]+$/, "");
  const target = strip(targetPath);
  if (!target) return null;
  const repos: { name: string; path: string }[] = [];
  let current: { name: string; path?: string } | null = null;
  const flush = () => {
    if (current && current.path) {
      repos.push({ name: current.name, path: strip(current.path) });
    }
    current = null;
  };
  for (const raw of listStdout.split("\n")) {
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
  // 1. Exact path match wins.
  const exact = repos.find((repo) => repo.path === target);
  if (exact) return exact.name;
  // 2. Else the DEEPEST registered repo that is an ancestor of the target
  //    (target nested inside a repo's subtree).
  const ancestors = repos
    .filter((repo) => target.startsWith(`${repo.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  if (ancestors[0]) return ancestors[0].name;
  // 3. Else the SHALLOWEST repo nested under the target (target is a monorepo
  //    root containing exactly one indexed member) — deterministic by path.
  const descendants = repos
    .filter((repo) => repo.path.startsWith(`${target}/`))
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  return descendants[0]?.name ?? null;
}

function empty(
  workspacePath: string,
  error: string
): GitNexusGraphData {
  return {
    nodes: [],
    relationships: [],
    truncated: false,
    error,
    workspacePath,
  };
}

/**
 * Parse the CLI's `cypher` stdout into row objects. The bundled CLI wraps
 * results as `{ markdown: "<pipe table>", row_count: N }` (the output is routed
 * through `formatCypherAsMarkdown`; there is no raw/JSON flag). We also accept a
 * bare JSON array defensively (a future CLI/--json), and surface `{error}` as a
 * throw so the caller fails safe.
 */
export function parseRows(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj) {
      throw new Error(String(obj.error).slice(0, 200));
    }
    if (typeof obj.markdown === "string") {
      return parseMarkdownTable(obj.markdown);
    }
  }
  throw new Error("unexpected Cypher result shape");
}

/** One markdown pipe-table row → its cells (leading/trailing `|` stripped,
 * trimmed). When more cells than columns appear, the overflow is folded back
 * into the LAST cell — safe because only the final `name` column can hold `|`. */
function splitRow(line: string, columnCount?: number): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const parts = s.split("|").map((c) => c.trim());
  if (columnCount !== undefined && parts.length > columnCount && columnCount > 0) {
    const head = parts.slice(0, columnCount - 1);
    const tail = parts.slice(columnCount - 1).join("|").trim();
    return [...head, tail];
  }
  return parts;
}

/** `| a | b |\n| --- | --- |\n| 1 | 2 |` → `[{ a: "1", b: "2" }]`; empty cell ⇒ undefined. */
function parseMarkdownTable(markdown: string): Record<string, unknown>[] {
  const lines = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return []; // header + separator only ⇒ no data rows
  const columns = splitRow(lines[0]!);
  const rows: Record<string, unknown>[] = [];
  // lines[1] is the `| --- | --- |` separator; data begins at index 2.
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]!, columns.length);
    const row: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      const v = cells[idx];
      row[col] = v && v.length > 0 ? v : undefined;
    });
    rows.push(row);
  }
  return rows;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  // Markdown-table cells arrive as strings ("12"); a defensive bare-array path
  // may give real numbers. Coerce both; non-numeric ⇒ undefined.
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Pure transform of the two row sets into the renderable, endpoint-consistent
 * graph. The rows arrive with LIMIT cap+1, so length > cap ⇒ genuinely more
 * exists (honest truncation); we then render only up to the cap.
 */
export function projectGraph(
  nodeRows: Record<string, unknown>[],
  edgeRows: Record<string, unknown>[]
): GitNexusGraphData {
  const nodesTruncated = nodeRows.length > MAX_NODES;
  const edgesTruncated = edgeRows.length > MAX_EDGES;

  const nodes: GitNexusGraphNode[] = [];
  const seen = new Set<string>();
  for (const row of nodeRows.slice(0, MAX_NODES)) {
    const id = str(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      label: str(row.label) ?? "CodeElement",
      name: str(row.name),
      filePath: str(row.filePath),
      startLine: num(row.startLine),
      endLine: num(row.endLine),
    });
  }

  const relationships: GitNexusGraphRelationship[] = [];
  const edgeIds = new Set<string>();
  for (const row of edgeRows.slice(0, MAX_EDGES)) {
    const sourceId = str(row.sourceId);
    const targetId = str(row.targetId);
    const type = str(row.type) ?? "RELATED";
    // Drop dangling edges: sigma.addEdge throws if an endpoint node is absent
    // (which the cap can cause), so an edge only survives if BOTH ends do.
    if (!sourceId || !targetId || !seen.has(sourceId) || !seen.has(targetId)) {
      continue;
    }
    // NUL separator: ids/types can contain `_`, so a `_`-joined key could alias
    // two distinct edges and silently drop one. NUL never appears in either.
    const id = `${sourceId}\u0000${type}\u0000${targetId}`;
    if (edgeIds.has(id)) continue;
    edgeIds.add(id);
    relationships.push({ id, sourceId, targetId, type });
  }

  return {
    nodes,
    relationships,
    truncated: nodesTruncated || edgesTruncated,
  };
}

/**
 * Read the workspace's local knowledge graph. Always resolves (fail-safe).
 * `workspacePath` must be a real bound workspace root; the graph lives under
 * `<workspacePath>/.gitnexus/`.
 */
export async function loadGitNexusGraph(
  workspacePath: string,
  options: LoadGitNexusGraphOptions = {}
): Promise<GitNexusGraphData> {
  if (!workspacePath) {
    return empty("", "No workspace is open. Start a chat in a folder first.");
  }
  const resolve = options.resolveCli ?? resolveGitNexusCli;
  const cli = (() => {
    try {
      return resolve(options.moduleDir);
    } catch {
      return null;
    }
  })();
  if (!cli) {
    return empty(
      workspacePath,
      "GitNexus CLI not found — the local graph cannot be read."
    );
  }
  const exec = options.exec ?? defaultGitNexusExec;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    // Hard rule: no new egress — never install an extension over the network.
    GITNEXUS_LBUG_EXTENSION_INSTALL: "load-only",
  };
  // Disambiguate the multi-repo registry: resolve this target's registered name
  // so every cypher read passes `--repo <name>`. Without it the CLI throws once
  // a second repo is indexed. Best-effort — a store with 0/1 repos (or a `list`
  // failure) resolves to null and reads without --repo, unchanged.
  const repoArgs = await (async (): Promise<string[]> => {
    try {
      const listed = await exec(cli.binary, [...cli.commandPrefix, "list"], {
        cwd: workspacePath,
        timeout: QUERY_TIMEOUT_MS,
        windowsHide: true,
        env,
      });
      const name = resolveRepoNameForPath(listed.stdout, workspacePath);
      // Guard the charset before the name reaches an arg: shell:false already
      // blocks command injection, but a name beginning with `-` (the header
      // regex permits it) could pose as a flag. Fail closed to a legacy read.
      return name && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith("-")
        ? ["--repo", name]
        : [];
    } catch {
      return [];
    }
  })();
  const run = (query: string) =>
    exec(cli.binary, [...cli.commandPrefix, "cypher", ...repoArgs, query], {
      cwd: workspacePath,
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
      env,
    });

  try {
    // Sequential (not parallel): two concurrent readers on the same local
    // graph store can contend on first open; on-demand latency is fine here.
    const nodeOut = await run(NODES_QUERY);
    const nodeRows = parseRows(nodeOut.stdout);
    const edgeOut = await run(EDGES_QUERY);
    const edgeRows = parseRows(edgeOut.stdout);
    const graph = projectGraph(nodeRows, edgeRows);
    graph.workspacePath = workspacePath;
    if (graph.nodes.length === 0) {
      return {
        ...graph,
        error:
          "This workspace has no indexed graph yet. Let GitNexus finish indexing, then reopen.",
      };
    }
    return graph;
  } catch (error) {
    const reason = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 200);
    return empty(workspacePath, `Could not read the local graph: ${reason}`);
  }
}
