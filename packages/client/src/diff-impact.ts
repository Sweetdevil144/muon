// Diff-to-Flow review evidence — the pure, FAIL-CLOSED projection.
//
// Maps a change (MUON's own git worktree diff — the source of truth) onto the
// execution flows it disturbs, so the adversarial reviewer gets evidence
// ("this diff moves a symbol at step 3 of RedeemGateAtRoute — verify the gate
// still fail-closes") instead of a bare file list. The load-bearing part is the
// COVERAGE GUARD: GitNexus silently resolves nothing for files it hasn't indexed
// (new code, or a stale index) and would hand the reviewer a false "0 flows
// affected — low risk" all-clear on exactly the novel code that most needs
// scrutiny. For a fail-CLOSED product that is the worst failure mode, so every
// changed file the graph could NOT resolve is surfaced as REVIEW BLIND and the
// verdict refuses to certify. Pure + browser-safe (no git, no CLI, no LLM): the
// tool feeds it git + graph facts; this file only projects + judges them. See
// docs/design/repository-reconnaissance.md's sibling (gitnexus-brain build path).

/** A changed line range in the NEW file (1-based, inclusive), from a git hunk. */
export type HunkRange = { start: number; end: number };

/** One changed file from git: its path + the NEW-file line ranges that changed.
 *  An empty `hunks` means a whole-file/binary/rename change with no line detail. */
export type ChangedFile = { path: string; hunks: HunkRange[] };

/** A symbol the graph knows, with its line span (for hunk intersection). */
export type GraphSymbol = {
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
};

/** A (symbol → process step) membership from STEP_IN_PROCESS, carrying the
 *  symbol's line span so the projector can keep only hunk-touched steps. */
export type ProcessStepRow = {
  file: string;
  symbol: string;
  startLine: number;
  endLine: number;
  process: string;
  processId: string;
  step: number;
  entryPointId?: string;
};

/** Whether the graph's indexed commit is behind the diff's HEAD. */
export type IndexFreshness = {
  graphCommit?: string;
  headCommit?: string;
  stale: boolean;
};

export type DiffImpactInput = {
  scope: string;
  /** Authoritative changed-file set from MUON's git — the coverage denominator. */
  changedFiles: ChangedFile[];
  /** File nodes that exist in the graph (coverage numerator). */
  graphFiles: string[];
  /** Symbols the graph knows in the changed files. */
  symbols: GraphSymbol[];
  /** Step memberships for symbols in the changed files. */
  steps: ProcessStepRow[];
  indexFreshness: IndexFreshness;
};

export type ChangedSymbol = { file: string; name: string; kind: string };

export type AffectedProcess = {
  process: string;
  processId: string;
  entryPointId?: string;
  /** The step ordinals the change touches, ascending. */
  steps: number[];
  /** The changed symbols that put this process in scope. */
  via: string[];
};

/**
 * - `no-op`   — nothing changed.
 * - `review-blind` — at least one changed file is not in the graph (or the index
 *   is stale): the flow evidence is INCOMPLETE and must not be read as an
 *   all-clear. Fail-closed.
 * - `flows-resolved` — every changed file is indexed and fresh; the affected
 *   flows below are the complete evidence.
 */
export type DiffImpactVerdict = "no-op" | "review-blind" | "flows-resolved";

export type DiffImpact = {
  scope: string;
  totals: {
    changedFiles: number;
    resolvedFiles: number;
    blindFiles: number;
    changedSymbols: number;
    affectedProcesses: number;
  };
  /** Changed files the graph could NOT resolve — REVIEW MANUALLY, never omit. */
  blindFiles: string[];
  changedSymbols: ChangedSymbol[];
  affectedProcesses: AffectedProcess[];
  /** resolvedFiles / changedFiles (1 when nothing changed). */
  coverage: number;
  indexFreshness: IndexFreshness;
  verdict: DiffImpactVerdict;
  /** Honesty rail: what is blind, why the verdict, staleness. */
  notes: string[];
};

// Bound what a reviewer reads so a huge diff can't blow the response budget.
const MAX_BLIND_FILES = 100;
const MAX_CHANGED_SYMBOLS = 200;
const MAX_AFFECTED_PROCESSES = 100;
const MAX_STEPS_PER_PROCESS = 40;
const MAX_VIA_PER_PROCESS = 20;

/** POSIX-normalize a path for comparison (forward slashes, no leading "./"). */
function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/** A symbol [s,e] is touched when it intersects ANY changed hunk. A file whose
 *  change carried no hunk detail (empty hunks) counts every symbol as touched. */
function symbolTouched(
  startLine: number,
  endLine: number,
  hunks: readonly HunkRange[]
): boolean {
  if (hunks.length === 0) return true; // no line detail → treat whole file as changed
  return hunks.some((h) => startLine <= h.end && endLine >= h.start);
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Project a git diff + graph facts into fail-closed review evidence. Pure and
 * deterministic. NEVER trusts the graph's silence: a changed file with no File
 * node is BLIND, not "clean".
 */
export function buildDiffImpact(input: DiffImpactInput): DiffImpact {
  const changed = input.changedFiles
    .map((f) => ({ path: norm(f.path), hunks: f.hunks }))
    .filter((f) => f.path !== "");
  const hunksByFile = new Map<string, HunkRange[]>();
  for (const file of changed) {
    const existing = hunksByFile.get(file.path) ?? [];
    existing.push(...file.hunks);
    hunksByFile.set(file.path, existing);
  }
  const changedPaths = [...hunksByFile.keys()];
  const graphFiles = new Set(input.graphFiles.map(norm));

  // Coverage guard: which changed files does the graph actually know?
  const resolvedFiles = changedPaths.filter((p) => graphFiles.has(p));
  const blindFiles = changedPaths.filter((p) => !graphFiles.has(p));

  // Precise (hunk-intersected) changed symbols, only from resolved files.
  const changedSymbols: ChangedSymbol[] = [];
  const changedSymbolKeys = new Set<string>();
  for (const sym of input.symbols) {
    const file = norm(sym.file);
    const hunks = hunksByFile.get(file);
    if (!hunks) continue; // symbol not in a changed file
    if (!symbolTouched(sym.startLine, sym.endLine, hunks)) continue;
    const key = `${file}::${sym.name}::${sym.startLine}`;
    if (changedSymbolKeys.has(key)) continue;
    changedSymbolKeys.add(key);
    changedSymbols.push({ file, name: sym.name, kind: sym.kind });
  }

  // Affected processes: keep only steps whose symbol is hunk-touched.
  const byProcess = new Map<
    string,
    { process: string; processId: string; entryPointId?: string; steps: number[]; via: Set<string> }
  >();
  for (const row of input.steps) {
    const file = norm(row.file);
    const hunks = hunksByFile.get(file);
    if (!hunks) continue;
    if (!symbolTouched(row.startLine, row.endLine, hunks)) continue;
    const key = row.processId || row.process;
    const entry = byProcess.get(key) ?? {
      process: row.process,
      processId: row.processId,
      ...(row.entryPointId ? { entryPointId: row.entryPointId } : {}),
      steps: [],
      via: new Set<string>(),
    };
    entry.steps.push(row.step);
    entry.via.add(row.symbol);
    byProcess.set(key, entry);
  }
  const affectedProcesses: AffectedProcess[] = [...byProcess.values()]
    .map((e) => ({
      process: e.process,
      processId: e.processId,
      ...(e.entryPointId ? { entryPointId: e.entryPointId } : {}),
      steps: uniqueSorted(e.steps).slice(0, MAX_STEPS_PER_PROCESS),
      via: [...e.via].sort().slice(0, MAX_VIA_PER_PROCESS),
    }))
    // Most-touched processes first (they're the review priority).
    .sort(
      (a, b) => b.steps.length - a.steps.length || a.process.localeCompare(b.process)
    )
    .slice(0, MAX_AFFECTED_PROCESSES);

  const coverage =
    changedPaths.length === 0
      ? 1
      : Math.round((resolvedFiles.length / changedPaths.length) * 1000) / 1000;

  const stale = input.indexFreshness.stale;
  const notes: string[] = [];
  let verdict: DiffImpactVerdict;
  if (changedPaths.length === 0) {
    verdict = "no-op";
    notes.push("No changed files — nothing to review.");
  } else if (blindFiles.length > 0 || stale) {
    verdict = "review-blind";
    if (blindFiles.length > 0) {
      notes.push(
        `REVIEW BLIND: ${blindFiles.length}/${changedPaths.length} changed file(s) are not in the graph (new or unindexed) — the affected-flow evidence is INCOMPLETE. Review these files manually; do NOT read "0 processes affected" as an all-clear.`
      );
    }
    if (stale) {
      notes.push(
        `Index is STALE (graph at ${input.indexFreshness.graphCommit ?? "unknown"}, diff at ${input.indexFreshness.headCommit ?? "HEAD"}) — re-index before trusting the flow evidence.`
      );
    }
  } else {
    verdict = "flows-resolved";
    notes.push(
      affectedProcesses.length > 0
        ? `All ${changedPaths.length} changed file(s) resolved; ${affectedProcesses.length} execution flow(s) affected — verify each.`
        : `All ${changedPaths.length} changed file(s) resolved; no execution flow is affected (the change touches no process step).`
    );
  }

  return {
    scope: input.scope,
    totals: {
      changedFiles: changedPaths.length,
      resolvedFiles: resolvedFiles.length,
      blindFiles: blindFiles.length,
      changedSymbols: changedSymbols.length,
      affectedProcesses: affectedProcesses.length,
    },
    blindFiles: blindFiles.slice(0, MAX_BLIND_FILES).sort(),
    changedSymbols: changedSymbols.slice(0, MAX_CHANGED_SYMBOLS),
    affectedProcesses,
    coverage,
    indexFreshness: input.indexFreshness,
    verdict,
    notes,
  };
}

// ── Cypher the tool runs (parameterized by the changed-file set) ──────────────
// Kept here so the query contract is one source of truth and testable. The file
// list is inlined as a Cypher string literal array by the caller (values are git
// paths — the caller must quote-escape; see the tool).

/** Build the three recon-style reads for a set of changed files (already
 *  Cypher-quoted). Returns query strings; the tool runs them via cypher --repo. */
export function diffImpactQueries(quotedFileList: string): {
  files: string;
  symbols: string;
  steps: string;
} {
  return {
    files: `MATCH (f:File) WHERE f.filePath IN [${quotedFileList}] RETURN f.filePath AS fp`,
    symbols: `MATCH (n) WHERE n.filePath IN [${quotedFileList}] AND n.startLine IS NOT NULL RETURN n.filePath AS file, n.name AS name, label(n) AS kind, n.startLine AS startLine, n.endLine AS endLine`,
    // NB: Process nodes expose `label` (an auto-generated Entry→Terminal name),
    // NOT `name` — using `p.name` throws a Binder exception and silently yields
    // zero affected flows under a lenient parser.
    steps: `MATCH (n)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND n.filePath IN [${quotedFileList}] AND n.startLine IS NOT NULL RETURN n.filePath AS file, n.name AS symbol, n.startLine AS startLine, n.endLine AS endLine, p.label AS process, p.id AS processId, p.entryPointId AS entryPointId, r.step AS step`,
  };
}

// ── git plumbing (pure) — shared by the MCP tool and the desktop review lane ──

/** The scopes review_diff can request (mirrors GitNexus `detect-changes`). */
export type DiffScope = "unstaged" | "staged" | "all" | "compare";
const SAFE_GIT_REF = /^[A-Za-z0-9._/\-~^@]{1,200}$/;

/** Map a scope (+ compare base) to `git diff` selector args. Pure + validated. */
export function gitScopeArgs(
  scope: DiffScope,
  baseRef?: string
): { args: string[] } | { error: string } {
  switch (scope) {
    case "unstaged":
      return { args: [] };
    case "staged":
      return { args: ["--cached"] };
    case "all":
      return { args: ["HEAD"] };
    case "compare": {
      const ref = (baseRef ?? "").trim();
      if (!ref || !SAFE_GIT_REF.test(ref)) {
        return { error: "compare scope needs a safe baseRef (branch or commit)" };
      }
      // three-dot: what THIS branch introduced since the merge-base.
      return { args: [`${ref}...HEAD`] };
    }
    default:
      return { error: "scope must be unstaged | staged | all | compare" };
  }
}

/**
 * Parse `git diff --unified=0` into per-file NEW-side changed line ranges. The
 * `@@ -a,b +c,d @@` header's new side (c,d) gives the changed lines c..c+d-1
 * (d defaults to 1; a pure deletion d=0 maps to the single line c). Files with
 * no hunks (binary/rename) simply won't appear here — the caller treats them as
 * whole-file changes.
 */
export function parseHunks(diffStdout: string): Map<string, HunkRange[]> {
  const byFile = new Map<string, HunkRange[]>();
  let current: string | null = null;
  for (const line of diffStdout.split("\n")) {
    const plus = line.match(/^\+\+\+ b\/(.+?)\s*$/);
    if (plus) {
      current = plus[1]!;
      if (!byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      current = null; // deleted file — no new-side lines
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const end = start + Math.max(count, 1) - 1;
      byFile.get(current)!.push({ start, end });
    }
  }
  return byFile;
}
