// Flow-scope — the pure projection that compiles a GitNexus execution flow's
// membership to concrete file:symbol targets for a dispatch brief.
//
// MUON fences a one-shot worker by a file set today. A flow-shaped fence is
// truer — it matches how the code actually executes — but the raw GitNexus
// Process is NOT a durable contract: labels are auto-generated Entry→Terminal
// concatenations, ids are ordinal (renumbered on reindex), 74% of processes are
// 3-4 steps, and one symbol sits in many overlapping processes. So this does NOT
// emit step-number fences or trust process ids. It RE-RESOLVES a stable anchor
// (a symbol) to the flows it participates in and compiles their membership to
// concrete `file::symbol` in-scope targets + ownedPaths — the brief pastes those
// and re-resolves fresh next time. Pure + browser-safe: the tool feeds it graph
// rows; this only projects them. See [[gitnexus-brain-buildpath]].

/** A flow the anchor participates in (from STEP_IN_PROCESS + the Process node). */
export type FlowRow = {
  processId: string;
  /** The auto-generated Entry→Terminal label (display only, NOT a contract). */
  label: string;
  /** `<Kind>:<file>:<symbol>` — the flow's entry point (a stable symbol UID). */
  entryPointId: string;
  stepCount: number;
};

/** One (process → member symbol) row, carrying the step ordinal for ordering. */
export type FlowMemberRow = {
  processId: string;
  symbol: string;
  file: string;
  step: number;
};

export type FlowScopeInput = {
  anchorSymbol: string;
  anchorFile?: string;
  flows: FlowRow[];
  memberRows: FlowMemberRow[];
};

export type FlowMember = { file: string; symbol: string; step: number };

export type FlowScopeUnit = {
  /** Human label — orientation only; never cite it as a stable contract. */
  process: string;
  entryPoint: { file: string; symbol: string };
  stepCount: number;
  /** Files this flow spans — a candidate ownedPaths fence. */
  ownedPaths: string[];
  /** Member symbols, step-ordered, compiled concrete (capped). */
  members: FlowMember[];
};

export type FlowScope = {
  anchor: { symbol: string; file?: string };
  flows: FlowScopeUnit[];
  /** Total flows the anchor is in (before the cap). */
  flowCount: number;
  /** Union of files across the shown flows — the brief's SCOPE fence. */
  ownedPaths: string[];
  /** `file::symbol` in-scope targets the brief names concretely. */
  inScopeSymbols: string[];
  notes: string[];
};

const MAX_FLOWS = 5;
const MAX_MEMBERS_PER_FLOW = 30;
const MAX_OWNED_PATHS = 12;
const MAX_IN_SCOPE = 60;

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Parse a GitNexus symbol UID `<Kind>:<file>:<symbol>` into {file, symbol}.
 * The file segment is everything between the first and last colon (paths carry
 * no colon); a malformed id degrades to {file:"", symbol:<whole>}.
 */
export function parseSymbolUid(uid: string): { file: string; symbol: string } {
  const parts = uid.split(":");
  if (parts.length < 3) return { file: "", symbol: uid };
  return {
    symbol: parts[parts.length - 1]!,
    file: norm(parts.slice(1, -1).join(":")),
  };
}

/**
 * Compile the flows a stable anchor symbol participates in into concrete
 * file:symbol scope. Deterministic. Ranked by step count (richer flows first).
 * Never emits step-number fences; steps are kept only to ORDER members.
 */
export function buildFlowScope(input: FlowScopeInput): FlowScope {
  const membersByFlow = new Map<string, FlowMember[]>();
  for (const row of input.memberRows) {
    const list = membersByFlow.get(row.processId) ?? [];
    list.push({ file: norm(row.file), symbol: row.symbol, step: row.step });
    membersByFlow.set(row.processId, list);
  }

  const flows: FlowScopeUnit[] = [...input.flows]
    .sort((a, b) => b.stepCount - a.stepCount || a.processId.localeCompare(b.processId))
    .slice(0, MAX_FLOWS)
    .map((flow) => {
      const members = (membersByFlow.get(flow.processId) ?? [])
        .slice()
        .sort((a, b) => a.step - b.step || a.symbol.localeCompare(b.symbol))
        .slice(0, MAX_MEMBERS_PER_FLOW);
      const ownedPaths = dedupeSorted(members.map((m) => m.file).filter(Boolean));
      return {
        process: flow.label,
        entryPoint: parseSymbolUid(flow.entryPointId),
        stepCount: flow.stepCount,
        ownedPaths,
        members,
      };
    });

  const ownedPaths = dedupeSorted(flows.flatMap((f) => f.ownedPaths)).slice(
    0,
    MAX_OWNED_PATHS
  );
  const inScopeSymbols = dedupeSorted(
    flows.flatMap((f) => f.members.map((m) => `${m.file}::${m.symbol}`))
  ).slice(0, MAX_IN_SCOPE);

  const notes: string[] = [];
  if (flows.length === 0) {
    notes.push(
      `'${input.anchorSymbol}' participates in no indexed execution flow — scope by file/symbol directly.`
    );
  } else {
    notes.push(
      `Anchor '${input.anchorSymbol}' seeds ${input.flows.length} flow(s); showing ${flows.length}. Scope the worker to ownedPaths + the in-scope symbols below.`
    );
    notes.push(
      "Flow labels/ids are unstable (auto-named, renumbered on reindex) — re-resolve at each dispatch; never cite a step number as a contract."
    );
  }

  return {
    anchor: {
      symbol: input.anchorSymbol,
      ...(input.anchorFile ? { file: norm(input.anchorFile) } : {}),
    },
    flows,
    flowCount: input.flows.length,
    ownedPaths,
    inScopeSymbols,
    notes,
  };
}

// ── Cypher the tool runs (parameterized by the anchor) ────────────────────────

/** Flows a symbol participates in. `anchorClause` is a pre-built WHERE fragment
 *  (name [+ file]) the caller quotes. */
export function flowsForAnchorQuery(anchorClause: string): string {
  return `MATCH (n)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND ${anchorClause} RETURN DISTINCT p.id AS processId, p.label AS label, p.entryPointId AS entryPointId, p.stepCount AS stepCount`;
}

/** Members of a set of processes. `quotedIds` is a Cypher-quoted comma list. */
export function flowMembersQuery(quotedIds: string): string {
  return `MATCH (n)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND p.id IN [${quotedIds}] RETURN p.id AS processId, n.name AS symbol, n.filePath AS file, r.step AS step`;
}
