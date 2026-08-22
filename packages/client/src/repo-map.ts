// Repository Reconnaissance (M1) — the pure RepoMap projection.
//
// Turns the raw signals collected from each repo's LOCAL GitNexus graph
// (Community clusters + their member files + File nodes + totals) into the
// structured, token-bounded RepoMap the superagent reads ONCE to decide how many
// subagents and which code part each owns. Pure + browser-safe (like
// dispatch-view.ts / convergence-preflight.ts): no CLI, no fs, no LLM — every
// number is a deterministic projection of the graph. See
// docs/design/repository-reconnaissance.md.

/** One functional cluster (a GitNexus Community). */
export type RepoCluster = {
  /** GitNexus community id (e.g. "comm_45"). */
  id: string;
  /** Human label (the community's heuristicLabel, e.g. "Renderer"). */
  label: string;
  symbolCount: number;
  fileCount: number;
  /** How tightly-linked the cluster is internally (0..1); Partition can weight it. */
  cohesion: number;
  /** Relative path globs this cluster owns — a subagent's disjoint scope. */
  ownedPaths: string[];
  /** File extensions present in the cluster (["ts", "sql"]). */
  languages: string[];
  /** Share of the repo's symbols (0..1) — Size/Partition weight. */
  weight: number;
};

/** One indexed git repo (a member of a possibly multi-repo workspace). */
export type RepoUnit = {
  path: string;
  name: string;
  indexed: boolean;
  /** HEAD moved since the index (null = unknown). */
  stale: boolean | null;
  totals: { symbols: number; files: number; edges: number; processes: number };
  languages: string[];
  /** Top clusters by weight (capped); `clustersTruncated` when more existed. */
  clusters: RepoCluster[];
  clustersTruncated: boolean;
  /** TRUE total community count (even when the cluster LIST above is truncated). */
  clusterCount: number;
  /** Why this repo's map is coarse (unindexed / cli-missing / read error). */
  degraded?: string;
};

export type RepoMapConfidence = "full" | "partial" | "coarse";

export type RepoMap = {
  workspacePath: string;
  repos: RepoUnit[];
  totals: { repos: number; symbols: number; clusters: number };
  confidence: RepoMapConfidence;
};

// ── Collector output (what collectRepoSignals produces per repo) ──────────────

export type ClusterSignal = {
  id: string;
  label: string;
  symbolCount: number;
  cohesion: number;
};

/** A (cluster → member file) link, from the MEMBER_OF edge. */
export type MemberSignal = { communityId: string; filePath: string };

export type RepoSignals = {
  path: string;
  name: string;
  indexed: boolean;
  stale: boolean | null;
  totals: { symbols: number; files: number; edges: number; processes: number };
  clusters: ClusterSignal[];
  members: MemberSignal[];
  /** Every File node's path (for languages + the repo file count fallback). */
  files: string[];
  /** TRUE community count from labelCounts (may exceed `clusters.length`, which
   *  the query caps). Omit → buildRepoMap falls back to the cluster-list length. */
  clusterCount?: number;
  /** Set when this repo could only be read coarsely (unindexed, cli missing…). */
  degraded?: string;
};

export type BuildRepoMapInput = {
  workspacePath: string;
  repos: RepoSignals[];
};

// Keep the map token-bounded: the superagent reads it whole, and the crew caps
// mean it can never fan out to hundreds of scopes anyway.
const MAX_CLUSTERS_PER_REPO = 24;
const MAX_OWNED_PATHS = 8;

/** POSIX dirname without pulling in node:path (browser-safe). "" for a root file. */
function dirOf(filePath: string): string {
  const norm = normRel(filePath);
  const slash = norm.lastIndexOf("/");
  return slash <= 0 ? "" : norm.slice(0, slash);
}

/** Normalize to a forward-slash relative path (strip a leading "./"). */
function normRel(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/**
 * A graph file path is only usable as a scope if it is repo-RELATIVE and stays
 * inside the repo. GitNexus emits relative paths today, but a generated/
 * symlinked/out-of-root File node must never become an escaping glob that a
 * subagent's scope fence would then trust — so the projection validates its own
 * input rather than relying on the graph. Rejects absolute paths, Windows drive
 * letters, and any `..` traversal segment.
 */
function isSafeRelPath(filePath: string): boolean {
  const norm = normRel(filePath);
  if (norm === "") return false;
  if (norm.startsWith("/")) return false; // absolute POSIX
  if (/^[A-Za-z]:/.test(norm)) return false; // Windows drive
  return !norm.split("/").some((segment) => segment === "..");
}

function extOf(filePath: string): string | null {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no ext, or a dotfile
  return base.slice(dot + 1).toLowerCase();
}

/** Distinct languages (extensions) over a set of file paths, most-common first. */
export function languagesOf(filePaths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const fp of filePaths) {
    const ext = extOf(fp);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ext]) => ext);
}

/**
 * Derive a cluster's disjoint owned-path globs from its member files: prefer the
 * directories that hold most of the files (as "dir/"), falling back to naming
 * individual files that live outside those dirs — capped so a scope stays
 * legible. Deterministic (sorted).
 */
export function deriveOwnedPaths(
  filePaths: readonly string[],
  cap: number = MAX_OWNED_PATHS
): string[] {
  const safe = filePaths.filter(isSafeRelPath);
  const dirCounts = new Map<string, number>();
  for (const fp of safe) {
    dirCounts.set(dirOf(fp), (dirCounts.get(dirOf(fp)) ?? 0) + 1);
  }
  // Directories that hold >1 file become a "dir/" glob; ranked by file count
  // then path for stability.
  const dirs = [...dirCounts.entries()]
    .filter(([dir, n]) => dir !== "" && n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir]) => `${dir}/`);
  const covered = new Set(dirs.map((d) => d.slice(0, -1)));
  // Files not under a chosen dir get named individually (root files, singletons).
  const looseFiles = safe
    .filter((fp) => !covered.has(dirOf(fp)))
    .map(normRel)
    .sort();
  const owned = [...dirs, ...dedupe(looseFiles)];
  return owned.slice(0, cap);
}

/** True when `filePath` is the dir `d` itself or nested under `d` (no trailing slash on d). */
function isUnderDir(filePath: string, dir: string): boolean {
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

/**
 * Derive owned paths for a SET of ranked clusters so the results are pairwise
 * DISJOINT — the invariant the partition (and downstream workflow.parallel.paths)
 * relies on. GitNexus communities are symbol-based, so one directory — even one
 * file — can host symbols from several communities; a naive per-cluster
 * projection then emits the same "src/" glob for two clusters, and the "disjoint"
 * promise is false. We fix it at the source: assign each file to exactly ONE
 * cluster (the highest-ranked claimant), and emit a "dir/" glob for a cluster
 * only when NO file assigned elsewhere lives under it — contested dirs fall back
 * to that cluster's own (exclusively-owned) files. Deterministic; `ranked` must
 * be pre-sorted (highest-priority cluster first).
 */
export function deriveDisjointOwnedPaths(
  ranked: readonly { id: string; files: readonly string[] }[],
  cap: number = MAX_OWNED_PATHS
): Map<string, string[]> {
  // 1. Global file → cluster assignment (first ranked claimant wins).
  const owner = new Map<string, string>();
  for (const cluster of ranked) {
    for (const raw of cluster.files) {
      if (!isSafeRelPath(raw)) continue;
      const fp = normRel(raw);
      if (!owner.has(fp)) owner.set(fp, cluster.id);
    }
  }
  // 2. Per-cluster exclusive files.
  const exclusive = new Map<string, string[]>();
  for (const [fp, id] of owner) {
    const list = exclusive.get(id) ?? [];
    list.push(fp);
    exclusive.set(id, list);
  }
  const allFiles = [...owner.keys()];
  // 3. Per-cluster owned paths: exclusive dir-globs, else the cluster's own files.
  const result = new Map<string, string[]>();
  for (const cluster of ranked) {
    const mine = exclusive.get(cluster.id) ?? [];
    const dirCounts = new Map<string, number>();
    for (const fp of mine) {
      dirCounts.set(dirOf(fp), (dirCounts.get(dirOf(fp)) ?? 0) + 1);
    }
    const dirs = [...dirCounts.entries()]
      .filter(([dir, n]) => dir !== "" && n > 1)
      // Exclusivity: no file owned by ANOTHER cluster may live under this dir.
      .filter(
        ([dir]) =>
          !allFiles.some(
            (fp) => owner.get(fp) !== cluster.id && isUnderDir(fp, dir)
          )
      )
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([dir]) => `${dir}/`);
    const coveredDirs = dirs.map((d) => d.slice(0, -1));
    const looseFiles = mine
      .filter((fp) => !coveredDirs.some((d) => isUnderDir(fp, d)))
      .sort();
    result.set(cluster.id, [...dirs, ...dedupe(looseFiles)].slice(0, cap));
  }
  return result;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ── The collector: RepoSignals from a repo's local GitNexus graph ─────────────

/**
 * The fixed, offline Cypher aggregate set Recon runs against a repo's local
 * `.gitnexus/` graph. GitNexus already computes Community clusters (with a human
 * `heuristicLabel`, `symbolCount`, `cohesion`) and links members via a
 * MEMBER_OF `CodeRelation` edge — so Recon READS them, never recomputes. Kept
 * here (browser-safe strings) so the query contract is one source of truth and
 * the row→signals projection is unit-testable without a CLI.
 */
export const RECON_QUERIES = {
  // `label` (free text, may contain a literal `|`) is returned LAST so a pipe in
  // a heuristicLabel folds into the trailing column instead of shifting the
  // numeric columns — see parseCypherRows' overflow handling.
  clusters:
    "MATCH (c:Community) RETURN c.id AS id, c.symbolCount AS symbols, c.cohesion AS cohesion, c.heuristicLabel AS label ORDER BY c.symbolCount DESC LIMIT 200",
  members:
    "MATCH (n)-[r:CodeRelation]->(c:Community) WHERE r.type = 'MEMBER_OF' AND n.filePath IS NOT NULL RETURN c.id AS cid, n.filePath AS fp",
  files: "MATCH (f:File) RETURN f.filePath AS fp",
  labelCounts: "MATCH (n) RETURN label(n) AS label, count(n) AS c",
  edgeCount: "MATCH ()-[r:CodeRelation]->() RETURN count(r) AS edges",
} as const;

/** Runs one Cypher query against a NAMED repo in the local store; returns rows.
 *  Injected so the collector is testable without a CLI (and offline in prod). */
export type CypherRunner = (
  query: string,
  repoName: string
) => Promise<Record<string, unknown>[]>;

export type ReconRepoTarget = {
  path: string;
  name: string;
  indexed: boolean;
  stale: boolean | null;
};

function toStr(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
function toNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Which node labels count as code SYMBOLS (vs File/Folder/Community/Process/…).
const SYMBOL_LABELS = new Set([
  "Function",
  "Method",
  "Class",
  "Interface",
  "Const",
  "Property",
  "Route",
  "Tool",
  "Section",
  "CodeElement",
]);

function coarse(repo: ReconRepoTarget, reason: string): RepoSignals {
  return {
    path: repo.path,
    name: repo.name,
    indexed: repo.indexed,
    stale: repo.stale,
    totals: { symbols: 0, files: 0, edges: 0, processes: 0 },
    clusters: [],
    members: [],
    files: [],
    degraded: reason,
  };
}

/**
 * Collect a repo's Recon signals by running the fixed Cypher set. Fail-safe: an
 * unindexed repo or any query error degrades to a coarse (empty) signal set with
 * a reason — never throws, never blocks. Pure w.r.t. the injected `cypher`.
 */
export async function collectRepoSignals(
  repo: ReconRepoTarget,
  cypher: CypherRunner
): Promise<RepoSignals> {
  if (!repo.indexed) return coarse(repo, "not indexed yet");
  try {
    const [clusterRows, memberRows, fileRows, labelRows, edgeRows] =
      await Promise.all([
        cypher(RECON_QUERIES.clusters, repo.name),
        cypher(RECON_QUERIES.members, repo.name),
        cypher(RECON_QUERIES.files, repo.name),
        cypher(RECON_QUERIES.labelCounts, repo.name),
        cypher(RECON_QUERIES.edgeCount, repo.name),
      ]);

    let symbols = 0;
    let files = 0;
    let processes = 0;
    let clusterCount = 0;
    for (const row of labelRows) {
      const label = toStr(row.label);
      const count = toNum(row.c);
      if (SYMBOL_LABELS.has(label)) symbols += count;
      else if (label === "File") files = count;
      else if (label === "Process") processes = count;
      else if (label === "Community") clusterCount = count;
    }

    return {
      path: repo.path,
      name: repo.name,
      indexed: true,
      stale: repo.stale,
      totals: { symbols, files, edges: toNum(edgeRows[0]?.edges), processes },
      clusterCount,
      clusters: clusterRows.map((r) => ({
        id: toStr(r.id),
        label: toStr(r.label) || toStr(r.id),
        symbolCount: toNum(r.symbols),
        cohesion: toNum(r.cohesion),
      })),
      members: memberRows.map((r) => ({
        communityId: toStr(r.cid),
        filePath: toStr(r.fp),
      })),
      files: fileRows.map((r) => toStr(r.fp)),
    };
  } catch (error) {
    return coarse(
      repo,
      error instanceof Error ? error.message.slice(0, 200) : "graph read failed"
    );
  }
}

/**
 * Why this repo's PAYLOAD cannot scope a crew, read off the projection itself
 * rather than off the flags the collector happened to set.
 *
 * `collectRepoSignals` only reports `degraded` when a query THREW. A stale or
 * half-built index answers every query successfully with zero rows, so a repo
 * came back indexed, un-degraded, and completely empty — and `confidence` (which
 * looked only at those flags) called it "full". A coordinator was handed full
 * confidence with zero clusters and zero ownedPaths and had to go find the
 * entrypoint by hand; a signal that reads high while the payload is empty is
 * worse than no signal, because it is the one thing that says "trust this".
 * Confidence now derives from what is actually in the map, and names the repair.
 */
function emptyPayloadReason(repo: RepoUnit): string | undefined {
  if (repo.totals.symbols === 0 && repo.totals.files === 0) {
    return (
      "its index is empty (0 files, 0 symbols) — the graph has nothing to scope from; " +
      "re-analyze this repo (`gitnexus analyze --force` if it was indexed before this code existed)"
    );
  }
  if (repo.clusterCount === 0 || repo.clusters.length === 0) {
    return (
      `its index carries ${repo.totals.symbols} symbols but no functional clusters, ` +
      "so no owned paths can be derived — re-analyze with `gitnexus analyze --force`"
    );
  }
  if (repo.clusters.every((cluster) => cluster.ownedPaths.length === 0)) {
    return (
      "no cluster in its index resolves to a usable repo-relative path, " +
      "so no scope can be derived — re-analyze with `gitnexus analyze --force`"
    );
  }
  return undefined;
}

export function buildRepoMap(input: BuildRepoMapInput): RepoMap {
  const repos: RepoUnit[] = input.repos.map((signals) => {
    // Group member files by cluster once.
    const filesByCluster = new Map<string, string[]>();
    for (const member of signals.members) {
      const list = filesByCluster.get(member.communityId) ?? [];
      list.push(member.filePath);
      filesByCluster.set(member.communityId, list);
    }
    const totalSymbols = signals.totals.symbols || 0;

    const rankedClusters = [...signals.clusters].sort(
      (a, b) => b.symbolCount - a.symbolCount || a.id.localeCompare(b.id)
    );
    const clustersTruncated = rankedClusters.length > MAX_CLUSTERS_PER_REPO;
    const keptClusters = rankedClusters.slice(0, MAX_CLUSTERS_PER_REPO);
    // Owned paths are derived ACROSS the kept clusters so they come out pairwise
    // disjoint (a directory/file shared by two communities is assigned to one).
    const disjointPaths = deriveDisjointOwnedPaths(
      keptClusters.map((cluster) => ({
        id: cluster.id,
        files: dedupe(filesByCluster.get(cluster.id) ?? []),
      }))
    );
    const clusters: RepoCluster[] = keptClusters.map((cluster) => {
      const files = dedupe(filesByCluster.get(cluster.id) ?? []);
      return {
        id: cluster.id,
        label: cluster.label,
        symbolCount: cluster.symbolCount,
        fileCount: files.length,
        cohesion: cluster.cohesion,
        ownedPaths: disjointPaths.get(cluster.id) ?? [],
        languages: languagesOf(files),
        weight:
          totalSymbols > 0
            ? Math.round((cluster.symbolCount / totalSymbols) * 1000) / 1000
            : 0,
      };
    });

    const unit: RepoUnit = {
      path: signals.path,
      name: signals.name,
      indexed: signals.indexed,
      stale: signals.stale,
      totals: signals.totals,
      languages: languagesOf(signals.files),
      clusters,
      clustersTruncated,
      clusterCount: signals.clusterCount ?? rankedClusters.length,
      ...(signals.degraded ? { degraded: signals.degraded } : {}),
    };
    // A collector-reported reason always wins — it knows WHY the read failed.
    // Otherwise the payload speaks for itself.
    const payloadReason = unit.degraded ? undefined : emptyPayloadReason(unit);
    return payloadReason ? { ...unit, degraded: payloadReason } : unit;
  });

  const anyDegraded = repos.some((r) => r.degraded);
  const anyUnindexed = repos.some((r) => !r.indexed);
  // A repo whose HEAD has moved since the index is real but BEHIND: the map
  // describes code that is no longer exactly what is on disk. That is never
  // "full", and saying so is what turns a silent zero into a stated reason.
  const anyStale = repos.some((r) => r.stale === true);
  const allCoarse = repos.length > 0 && repos.every((r) => r.degraded);
  const confidence: RepoMapConfidence = allCoarse
    ? "coarse"
    : anyDegraded || anyUnindexed || anyStale
      ? "partial"
      : "full";

  return {
    workspacePath: input.workspacePath,
    repos,
    totals: {
      repos: repos.length,
      symbols: repos.reduce((n, r) => n + (r.totals.symbols || 0), 0),
      clusters: repos.reduce((n, r) => n + r.clusters.length, 0),
    },
    confidence,
  };
}

// ── M2: Size — recommend how many subagents (clamped by caps + budget) ────────

/** The governance delegation caps the recommendation can never exceed. */
export type DelegationCaps = { maxChildren: number; maxDescendants: number };

/** Coordinate-only memory signal from B4. Kept structural so the browser-safe
 * RepoMap package does not depend on the native graph package. */
export type RepoMapMemorySignal = {
  hotModules: readonly {
    module: string;
    score: number;
    noteCount: number;
  }[];
  communities: readonly {
    id: string;
    noteCount: number;
    moduleCount: number;
  }[];
};

/**
 * WHAT WAS ACTUALLY ASKED FOR — the input crew sizing was missing entirely.
 *
 * Sizing keyed only on the REPOSITORY (symbols, clusters, repos), so a
 * one-function fix in a 24k-symbol tree recommended the same crew as "audit
 * the whole codebase". That is the measured reason a one-line instruction
 * became a three-agent mission: nothing in the recommendation had ever seen
 * the instruction.
 *
 * Kept as data, not prose parsing with opinions: `solo` is an explicit
 * declaration a caller makes, and the text heuristic below only ever fires on
 * clear POSITIVE evidence of a single-unit ask (ADR-0022 rule 2 — never a
 * subtraction from "everything else must be big").
 */
export type MissionAsk = {
  /** The operator's or agent's own words, when there are any. */
  readonly text?: string;
  /**
   * An explicit "do this yourself" — the caller has already decided. Always
   * wins: a human or an agent saying `solo` is a fact, not a signal to weigh.
   */
  readonly solo?: boolean;
};

/**
 * EVIDENCE, RANKED. Four tiers, checked in this order:
 *
 *   1. an explicit declaration        → single unit, unconditionally
 *   2. an unambiguous sweep           → crew
 *   3. a quantified target ("all the
 *      callers", "every service")     → crew
 *   4. a single target, named         → single unit
 *   else                              → no signal; size off the repository
 *
 * WHY THE ORDER IS THE DESIGN. A human's explicit instruction is a FACT and
 * outranks every guess — a flat "sweep always wins" rule once let the word
 * `refactor` defeat "refactor this one function, DO NOT DISPATCH".
 *
 * WHY THE QUANTIFIER OUTRANKS THE SINGLE TARGET, which is the subtle one:
 * "update all the callers of THIS FUNCTION" names a single symbol and is
 * nonetheless repo-wide work, and dropping this tier let exactly that ask
 * classify as one unit. The reverse mistake — "handle each edge case in this
 * one function" sized as a crew — is real but CHEAP: it falls back to sizing
 * off the repository, which is what happened before any of this existed. The
 * asymmetry decides the tie. A wrong `true` silently shrinks a crew the
 * mission needed; a wrong `false` costs a recon pass. Ambiguity therefore
 * resolves to `false`, always.
 */

/** Tier 1 — the operator said it outright. Nothing overrides these. */
const EXPLICIT_SOLO: readonly RegExp[] = [
  /\bdo\s*n[o']?t\s+(?:dispatch|delegate|fan\s*out|spawn)/i,
  /\bno\s+(?:crew|dispatch|delegation|subagents?|fan\s*out)\b/i,
  /\b(?:solo|single[- ]handed)\b/i,
  /\b(?:by|do\s+it)\s+yourself\b/i,
];

/** Tier 2 — unambiguous breadth: the work IS the whole surface. */
const STRONG_SWEEP: readonly RegExp[] = [
  /\b(?:audit|sweep|survey|inventory|catalog(?:ue)?)\b/i,
  /\b(?:in|across|for|over|throughout)\s+(?:every|all|each)\b/i,
  /\bacross\s+the\s+(?:codebase|repo|monorepo|workspace|stack)\b/i,
  /\b(?:whole|entire)\s+(?:codebase|repo|repository|project|stack)\b/i,
  /\bexamine\s+(?:the\s+)?codebase\b/i,
];

/**
 * Words that sit BETWEEN a quantifier and its population ("all OF THE callers",
 * "every OTHER caller", "all THAT duplicated logic"). They are CONSUMED so the
 * population behind them is still seen, and they are ALSO excluded so the
 * engine cannot backtrack out of the run and let the connective itself pass as
 * the population. Both lists are built from this one array, because the
 * both-lists rule was broken twice — once for `this`, once for `that` — and
 * each time it silently flipped real sweeps to solo.
 */
const QUANTIFIER_CONNECTIVES = [
  "the",
  "of",
  "other",
  "these",
  "those",
  "this",
  "that",
] as const;

/** Never a population, and never in front of one. Excluded only. */
const QUANTIFIER_FILLER = [
  "i",
  "you",
  "we",
  "it",
  "they",
  "is",
  "was",
  "are",
  "been",
  "right",
  "good",
  "set",
  "clear",
  "done",
  "fine",
  "well",
  "ok",
  "okay",
  "along",
  "together",
] as const;

/**
 * Tier 3 — a quantifier over some population. Ranked ABOVE the single-target
 * tier on purpose: "all the callers of this function" contains a single target
 * and is still repo-wide. See the asymmetry argument above.
 */
const QUANTIFIED_SWEEP: readonly RegExp[] = [
  // The word after the quantifier must plausibly BE a population. Matching any
  // word made ordinary filler a sweep — "fix the typo in this one file, that
  // is all I need" over-dispatched, and because this tier outranks the
  // single-target tier it overrode the target it named.
  new RegExp(
    `\\b(?:every|all|each)\\s+(?:(?:${QUANTIFIER_CONNECTIVES.join(
      "|"
    )})\\s+)*(?!(?:${[...QUANTIFIER_CONNECTIVES, ...QUANTIFIER_FILLER].join(
      "|"
    )})\\b)[a-z][a-z-]{1,}`,
    "i"
  ),
];

/** Tier 4 — a single target, named. */
const STRONG_SINGLE: readonly RegExp[] = [
  /\bone[- ](?:file|function|module|symbol|line|test|method|class)\b/i,
  /\bsingle[- ](?:file|function|module|symbol|test|method|class)\b/i,
  /\bthis\s+(?:one\s+)?(?:file|function|typo|line|symbol|method|class)\b/i,
];

/**
 * Does this ask name ONE unit of work?
 *
 * `false` is the safe answer and the default: it falls back to sizing off the
 * repository exactly as before, so an unreadable — or merely ambiguous — ask
 * never silently shrinks a crew. Only positive evidence returns `true`
 * (ADR-0022 rule 2).
 */
export function askIsSingleUnit(ask: MissionAsk | undefined): boolean {
  if (!ask) return false;
  if (ask.solo === true) return true;
  const text = ask.text?.trim();
  if (!text) return false;
  const matches = (patterns: readonly RegExp[]) =>
    patterns.some((pattern) => pattern.test(text));
  if (matches(EXPLICIT_SOLO)) return true;
  if (matches(STRONG_SWEEP)) return false;
  if (matches(QUANTIFIED_SWEEP)) return false;
  return matches(STRONG_SINGLE);
}

export type CrewSizeInput = {
  map: RepoMap;
  caps: DelegationCaps;
  /** What was asked for. Absent = size off the repository, as before. */
  ask?: MissionAsk;
  /** Load-bearing memory can make an otherwise tiny repository worth one
   * bounded specialist rather than a solo pass. */
  memory?: RepoMapMemorySignal;
  /** Remaining mission wall-clock budget (ms); omit = unbounded. */
  budgetMs?: number;
  /** Rough cost of one subagent's turn (ms); default 10 min. */
  perAgentMs?: number;
};

const TRIVIAL_SYMBOLS = 400;
const DEFAULT_PER_AGENT_MS = 10 * 60_000;
const LOAD_BEARING_MEMORY_SCORE = 0.5;

function hasLoadBearingMemory(
  memory: RepoMapMemorySignal | undefined
): boolean {
  return Boolean(
    memory?.hotModules.some(
      (module) =>
        module.noteCount >= 2 && module.score >= LOAD_BEARING_MEMORY_SCORE
    )
  );
}

/**
 * Recommend the TOP-LEVEL fan-out for a mission over this workspace. `0` for a
 * trivial repo the superagent should just examine itself; otherwise the natural
 * number of top units (per-repo for a monorepo, else per functional cluster),
 * clamped by the governance caps and the budget — the min→max on basis of the
 * repository. Each unit can recurse into finer scopes within its own child
 * budget; this is only the first level.
 */
export function recommendCrewSize(input: CrewSizeInput): number {
  const { map, caps } = input;
  const { symbols, clusters, repos } = map.totals;
  // THE ASK OUTRANKS THE REPOSITORY. A single-unit instruction is answered by
  // the superagent itself however large the tree is — which is the whole point
  // of asking: sizing a crew off `symbols` alone is what turned every
  // one-function fix in this 24k-symbol repo into a multi-agent mission.
  // Deliberately ABOVE the trivial-repo check, so an explicit `solo` is not
  // quietly outvoted by load-bearing memory.
  if (askIsSingleUnit(input.ask)) return 0;
  if (
    repos <= 1 &&
    symbols < TRIVIAL_SYMBOLS &&
    clusters <= 1 &&
    !hasLoadBearingMemory(input.memory)
  ) {
    return 0;
  }
  const natural = repos > 1 ? repos : Math.max(1, clusters);
  const perAgentMs = input.perAgentMs ?? DEFAULT_PER_AGENT_MS;
  // Only a finite, positive budget bounds the crew — a NaN/±Infinity/0 budget
  // (or a non-positive perAgentMs) must NOT poison the min() into NaN, since a
  // NaN size would crash the partition (Array.from({length: NaN})).
  const budgetCap =
    typeof input.budgetMs === "number" &&
    Number.isFinite(input.budgetMs) &&
    perAgentMs > 0
      ? Math.max(1, Math.floor(input.budgetMs / perAgentMs))
      : Number.POSITIVE_INFINITY;
  const capped = Math.min(
    natural,
    caps.maxChildren,
    caps.maxDescendants,
    budgetCap
  );
  return Number.isFinite(capped) ? Math.max(1, Math.floor(capped)) : 1;
}

// ── M3: Partition — disjoint scopes → workflow.parallel.paths ─────────────────

export type WorkUnit = {
  /** Human scope label (cluster labels, or the repo name). */
  scope: string;
  repoPath: string;
  clusterIds: string[];
  /** Disjoint relative path globs → a step's workflow.parallel.paths. */
  ownedPaths: string[];
  symbolCount: number;
};

/** Workspace-relative dir of a member repo (for a multi-repo scope). */
function relDir(workspacePath: string, repoPath: string): string {
  const ws = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const rp = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (rp === ws) return ".";
  const rel = rp.startsWith(ws + "/") ? rp.slice(ws.length + 1) : rp;
  return `${rel}/`;
}

/**
 * Partition ONE repo's clusters into `n` disjoint work-units. n >= clusters →
 * one unit per cluster; n < clusters → largest-first packing into the currently
 * -smallest bucket (balanced). Owned paths are the union of a bucket's clusters'
 * paths — disjoint because Communities are non-overlapping. A repo with no
 * clusters yields one whole-repo unit.
 */
export function partitionRepo(repo: RepoUnit, n: number): WorkUnit[] {
  if (!Number.isFinite(n) || n < 1) return [];
  const count = Math.floor(n);
  const clusters = repo.clusters;
  if (clusters.length === 0) {
    return [
      {
        scope: repo.name,
        repoPath: repo.path,
        clusterIds: [],
        ownedPaths: [], // no cluster paths → whole-repo scope, no false glob
        symbolCount: repo.totals.symbols,
      },
    ];
  }
  const bucketCount = Math.min(count, clusters.length);
  const buckets: { clusters: RepoCluster[]; symbols: number }[] = Array.from(
    { length: bucketCount },
    () => ({ clusters: [], symbols: 0 })
  );
  for (const cluster of [...clusters].sort(
    (a, b) => b.symbolCount - a.symbolCount || a.id.localeCompare(b.id)
  )) {
    const target = buckets.reduce(
      (min, b) => (b.symbols < min.symbols ? b : min),
      buckets[0]!
    );
    target.clusters.push(cluster);
    target.symbols += cluster.symbolCount;
  }
  return buckets.map((bucket) => ({
    scope: bucket.clusters.map((c) => c.label).join(" + "),
    repoPath: repo.path,
    clusterIds: bucket.clusters.map((c) => c.id),
    ownedPaths: dedupe(bucket.clusters.flatMap((c) => c.ownedPaths)).slice(
      0,
      MAX_OWNED_PATHS
    ),
    symbolCount: bucket.symbols,
  }));
}

/** True when `ancestor` strictly contains `descendant` in the path tree. */
function isAncestorPath(ancestor: string, descendant: string): boolean {
  const a = ancestor.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = descendant.replace(/\\/g, "/").replace(/\/+$/, "");
  return d.startsWith(`${a}/`);
}

/**
 * Partition a whole workspace into `n` disjoint work-units. Multi-repo → each of
 * the `n` largest repos is a unit scoped to its own directory (a natural disjoint
 * boundary). A repo NESTED under another selected repo (a submodule, or a
 * monorepo root that is itself a registered repo) would give overlapping dir
 * scopes, so it is dropped — its subtree stays covered by the enclosing repo's
 * scope, and the remaining set is provably disjoint. Single repo → delegate to
 * partitionRepo across its clusters.
 */
export function partitionWorkspace(map: RepoMap, n: number): WorkUnit[] {
  if (!Number.isFinite(n) || n < 1) return [];
  const count = Math.floor(n);
  if (map.repos.length > 1) {
    const outermost = map.repos.filter(
      (repo) =>
        !map.repos.some(
          (other) => other !== repo && isAncestorPath(other.path, repo.path)
        )
    );
    return [...outermost]
      .sort(
        (a, b) => b.totals.symbols - a.totals.symbols || a.path.localeCompare(b.path)
      )
      .slice(0, count)
      .map((repo) => ({
        scope: repo.name,
        repoPath: repo.path,
        clusterIds: repo.clusters.map((c) => c.id),
        ownedPaths: [relDir(map.workspacePath, repo.path)],
        symbolCount: repo.totals.symbols,
      }));
  }
  const repo = map.repos[0];
  return repo ? partitionRepo(repo, count) : [];
}

// ── M4 (pure slice): Plan — RepoMap → a ready-to-dispatch crew plan ───────────
//
// The hermetic half of auto-decompose: turn a RepoMap + a mission into the crew
// the superagent should dispatch — one work-unit per disjoint scope, each with a
// scoped prompt and the ownedPaths that become a step's workflow.parallel.paths.
// The VENDOR half (actually running the crew and synthesizing findings) stays
// founder-gated and is not built here. Pure + deterministic + token-bounded.

export type ReconCrewUnit = {
  scope: string;
  repoPath: string;
  /** Disjoint relative path globs → this unit's workflow.parallel.paths. */
  ownedPaths: string[];
  clusterIds: string[];
  symbolCount: number;
  /** Share of the mission's total symbols (0..1) — for budget/attention weighting. */
  weight: number;
  /** A scope-bound examine prompt; the mission, fenced to this unit's paths. */
  prompt: string;
};

export type ReconMissionPlan = {
  mission: string;
  /** "solo" when this mission needs no fan-out — see `soloReason` for WHICH
   *  of the two very different reasons applies. */
  strategy: "solo" | "fan-out";
  /**
   * WHY a solo plan is solo, because the two reasons license opposite claims
   * about coverage and only one of them was ever true:
   *
   *  - `trivial-repo`: the whole repository is small enough to examine
   *    directly, so a solo pass genuinely covers all of it.
   *  - `single-unit-ask`: the ASK names one unit of work. The pass covers that
   *    unit and says NOTHING about the rest of a possibly huge tree.
   *
   * Absent on a fan-out plan.
   */
  soloReason?: "trivial-repo" | "single-unit-ask";
  crewSize: number;
  confidence: RepoMapConfidence;
  units: ReconCrewUnit[];
  /** Honesty rail: why solo, which repos are coarse, what was truncated. */
  notes: string[];
};

export type PlanReconMissionInput = {
  map: RepoMap;
  mission: string;
  caps: DelegationCaps;
  budgetMs?: number;
  perAgentMs?: number;
  memory?: RepoMapMemorySignal;
};

/** The scope-fenced prompt one crew unit receives. Deterministic, no vendor. */
function unitPrompt(mission: string, unit: WorkUnit): string {
  const paths = unit.ownedPaths.length > 0 ? unit.ownedPaths.join(", ") : ".";
  return (
    `${mission.trim()}\n\n` +
    `Scope: ${unit.scope || unit.repoPath}. Examine ONLY these paths: ${paths}. ` +
    `Report findings for this scope only; do not stray outside it. ` +
    `Another agent owns each other scope, so overlap wastes budget.`
  );
}

/**
 * Turn a RepoMap into the crew the superagent should dispatch for `mission`.
 * `crewSize === 0` → a solo plan (the superagent examines the repo itself).
 * Otherwise one unit per disjoint scope from partitionWorkspace, each carrying a
 * scope-fenced prompt + its ownedPaths. Never throws; a coarse/partial map still
 * yields a runnable plan, with the caveat recorded in `notes`.
 */
export function planReconMission(input: PlanReconMissionInput): ReconMissionPlan {
  const { map, mission } = input;
  // The mission text IS the ask — a plan for "rename one function" must not
  // partition the workspace just because the workspace is large.
  const crewSize = recommendCrewSize({
    map,
    caps: input.caps,
    budgetMs: input.budgetMs,
    perAgentMs: input.perAgentMs,
    memory: input.memory,
    ask: { text: mission },
  });
  const notes: string[] = [];
  if (
    map.totals.repos <= 1 &&
    map.totals.symbols < TRIVIAL_SYMBOLS &&
    map.totals.clusters <= 1 &&
    hasLoadBearingMemory(input.memory)
  ) {
    notes.push(
      "Memory centrality marks this small repository as load-bearing; keep one bounded specialist in the plan."
    );
  }
  if (map.confidence !== "full") {
    const coarseRepos = map.repos
      .filter((repo) => repo.degraded)
      .map((repo) => `${repo.name} (${repo.degraded})`);
    notes.push(
      coarseRepos.length > 0
        ? `Map is ${map.confidence}; coarse repos: ${coarseRepos.join(", ")}.`
        : `Map is ${map.confidence}.`
    );
    // Named separately: a stale repo's map is complete but BEHIND HEAD, which is
    // a different caveat from a coarse one and a different repair.
    const staleRepos = map.repos
      .filter((repo) => repo.stale === true)
      .map((repo) => repo.name);
    if (staleRepos.length > 0) {
      notes.push(
        `Indexed before the current HEAD: ${staleRepos.join(", ")} — re-analyze for a scope that matches the working tree.`
      );
    }
  }
  for (const repo of map.repos) {
    if (repo.clustersTruncated) {
      notes.push(
        `${repo.name}: this pass scopes the top ${repo.clusters.length} clusters by size; ` +
          `the long tail is out of scope here and belongs to a follow-up completeness pass (M5).`
      );
    }
  }

  if (crewSize <= 0) {
    // WHICH solo this is. The note used to assert "repository is small enough",
    // which the ask short-circuit made false on arbitrarily large trees — and
    // it could then sit beside the load-bearing-memory note that only ever
    // applies to a small repo, so the plan contradicted itself.
    const soloReason = askIsSingleUnit({ text: mission })
      ? ("single-unit-ask" as const)
      : ("trivial-repo" as const);
    notes.unshift(
      soloReason === "single-unit-ask"
        ? "The mission names a single unit of work, so it is answered directly — this plan makes no claim about the rest of the repository."
        : "Repository is small enough to examine directly — no fan-out needed."
    );
    return {
      mission,
      strategy: "solo",
      soloReason,
      crewSize: 0,
      confidence: map.confidence,
      units: [],
      notes,
    };
  }

  const workUnits = partitionWorkspace(map, crewSize);
  // Weight = share of attention AMONG THE CREW (sums to ~1), the useful budget
  // signal — not share of the whole repo, which cluster truncation distorts.
  const crewSymbols = Math.max(
    1,
    workUnits.reduce((sum, unit) => sum + unit.symbolCount, 0)
  );
  const units: ReconCrewUnit[] = workUnits.map((unit) => ({
    scope: unit.scope,
    repoPath: unit.repoPath,
    ownedPaths: unit.ownedPaths,
    clusterIds: unit.clusterIds,
    symbolCount: unit.symbolCount,
    weight: unit.symbolCount / crewSymbols,
    prompt: unitPrompt(mission, unit),
  }));
  return {
    mission,
    strategy: "fan-out",
    crewSize: units.length,
    confidence: map.confidence,
    units,
    notes,
  };
}

// ── M5 (pure slice): Critique — quantify what a plan does NOT cover ────────────
//
// The completeness critic's ASSESSMENT is pure and testable; only the ACTION it
// motivates (dispatching a follow-up crew with real vendors) is founder-gated. A
// cap-bounded crew on a large repo covers only its top clusters by size — this
// makes that gap explicit and quantified rather than a silent cap, so the
// superagent can sequence more waves (or raise the crew) instead of believing a
// 3-unit pass examined everything.

export type CompletenessCritique = {
  /** Clusters named by the plan's units vs the repo's TRUE community count. */
  coveredClusters: number;
  totalClusters: number;
  clusterCoverage: number; // 0..1
  /** Symbols the plan's units own vs the workspace total. */
  coveredSymbols: number;
  totalSymbols: number;
  symbolCoverage: number; // 0..1
  /** True when coverage is materially incomplete — a follow-up pass is warranted. */
  recommendFollowUp: boolean;
  /** Human, specific reasons a follow-up is (or isn't) recommended. */
  gaps: string[];
};

/** Below this symbol coverage, a single pass is treated as materially incomplete. */
const COMPLETE_ENOUGH = 0.9;

/**
 * Diagnose how much of the workspace a crew plan actually covers. Pure: unions
 * the plan's cluster ids and symbol counts against the map's TRUE totals (which
 * carry the full community count even when the cluster LIST was truncated). A
 * solo plan (examine directly) is complete by construction. Never throws.
 */
export function completenessCritique(
  map: RepoMap,
  plan: ReconMissionPlan
): CompletenessCritique {
  const totalClusters = map.repos.reduce((n, r) => n + r.clusterCount, 0);
  const totalSymbols = Math.max(0, map.totals.symbols);
  const coveredClusterIds = new Set(plan.units.flatMap((u) => u.clusterIds));
  const coveredClusters = coveredClusterIds.size;
  const coveredSymbols = plan.units.reduce((n, u) => n + u.symbolCount, 0);
  const ratio = (part: number, whole: number) =>
    whole > 0 ? Math.min(1, Math.round((part / whole) * 1000) / 1000) : 1;
  const clusterCoverage = ratio(coveredClusters, totalClusters);
  const symbolCoverage = ratio(coveredSymbols, totalSymbols);

  const gaps: string[] = [];
  // A solo plan is complete BY CONSTRUCTION only when it is solo because the
  // whole repository is trivial. Once the ASK could also produce a solo plan
  // (Wave 1C), this branch was claiming `symbolCoverage: 1` over a 24k-symbol
  // tree for "rename one function" — a fabricated evidence claim, which is the
  // one thing a completeness critique must never emit.
  // POSITIVE, not `!== "single-unit-ask"`. `soloReason` is optional on the
  // exported type and this plan crosses an MCP boundary, so a plan that
  // arrives without the discriminator — an older producer, a hand-built
  // fixture — must NOT fall into the full-coverage branch. Claiming coverage
  // is the dangerous direction; withholding it is merely cautious
  // (ADR-0022 rule 2: a set is what it admits, never what it excludes).
  if (plan.strategy === "solo" && plan.soloReason === "trivial-repo") {
    return {
      coveredClusters,
      totalClusters,
      clusterCoverage: 1,
      coveredSymbols: totalSymbols,
      totalSymbols,
      symbolCoverage: 1,
      recommendFollowUp: false,
      gaps: ["Solo pass examines the repository directly — full coverage."],
    };
  }
  if (plan.strategy === "solo") {
    // Scoped, not complete: honest zero coverage of the wider tree, said in
    // words rather than implied by a number.
    //
    // The SENTENCE follows the discriminator, because this branch is reached
    // two ways. `single-unit-ask` is the designed case. An ABSENT
    // `soloReason` also lands here — an older producer, a hand-built fixture,
    // a plan that crossed an MCP boundary — and asserting "answers a
    // single-unit ask" about a plan that never said so would be inventing the
    // very fact this branch exists to stop inventing. `recommendFollowUp` is
    // therefore true for the unknown case: a plan MUON cannot characterise is
    // exactly one a human should look at.
    const scoped = plan.soloReason === "single-unit-ask";
    return {
      coveredClusters: 0,
      totalClusters,
      clusterCoverage: 0,
      coveredSymbols: 0,
      totalSymbols,
      symbolCoverage: 0,
      recommendFollowUp: !scoped,
      gaps: [
        scoped
          ? "This plan answers a single-unit ask directly. It examines only what that ask names — the rest of the repository is UNEXAMINED, and this is not a coverage pass."
          : "This solo plan does not say WHY it is solo, so MUON cannot claim it covered anything. Treat the repository as UNEXAMINED and re-plan if coverage matters.",
      ],
    };
  }
  const truncated = map.repos.filter((r) => r.clustersTruncated);
  if (truncated.length > 0) {
    gaps.push(
      `${truncated.map((r) => r.name).join(", ")}: more communities exist than were mapped, so clusters beyond the top ${MAX_CLUSTERS_PER_REPO}/repo are uncovered.`
    );
  }
  if (symbolCoverage < COMPLETE_ENOUGH) {
    gaps.push(
      `This pass owns ${Math.round(symbolCoverage * 100)}% of symbols (${coveredSymbols}/${totalSymbols}) across ${coveredClusters}/${totalClusters} clusters — sequence more waves or raise the crew to cover the rest.`
    );
  }
  const recommendFollowUp = symbolCoverage < COMPLETE_ENOUGH || truncated.length > 0;
  if (!recommendFollowUp && gaps.length === 0) {
    gaps.push("Coverage is sufficient — no follow-up pass needed.");
  }
  return {
    coveredClusters,
    totalClusters,
    clusterCoverage,
    coveredSymbols,
    totalSymbols,
    symbolCoverage,
    recommendFollowUp,
    gaps,
  };
}
