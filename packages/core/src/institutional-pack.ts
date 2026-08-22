/**
 * ADR-0051 — the institutional-context pack, assembled at dispatch.
 *
 * A class of failures this cycle exists to close: a worker that is
 * technically right and operationally wrong because it does not know the
 * system — who owns a module, why a constraint exists, what shape the
 * workspace's code graph is in. The remedy here is NOT an ambient catalog:
 * the pack is assembled server-side from reads the job is already
 * authorized to make — human-confirmed notes in the active workspace
 * partition plus the local code graph's own measured shape — and contains
 * ZERO unconfirmed ids by construction (ADR-0051 §3; wrap proposals are
 * excluded because they are unconfirmed by definition).
 *
 * Pure module, exactly like memory-slice.ts: core owns selection budget and
 * rendering; the server owns the authoritative selection posture; the
 * runner wires the two at its single brief choke point.
 */
import type { StandingMemoryNote } from "./memory-slice.js";

/**
 * ADR-0091 SUPERSEDED the 0051-§4 tag convention with a first-class
 * `ownership` kind. The tags remain readable for the D3 window — selection
 * reads BOTH kind and tag until no active tagged note remains (the
 * ownership-recast migration files the recast proposals; nothing silently
 * disappears) — and then the tag path retires by emptying, visibly.
 */
export const OWNERSHIP_TOPIC_TAGS = [
  "ownership",
  "owner",
  "why",
  "rationale",
] as const;

/** Character budget for the ownership/why slice — deliberately smaller than
 *  the standing canon's: this is the "who owns it and why" digest, not a
 *  second canon. */
export const OWNERSHIP_SLICE_BUDGET_CHARS = 1_600;

/** Hard count ceiling under the char budget (same rationale as standing). */
export const OWNERSHIP_SLICE_MAX_NOTES = 8;

export type OwnershipNote = StandingMemoryNote & {
  topics?: string[] | null;
};

export function hasOwnershipTag(note: {
  topics?: string[] | null;
}): boolean {
  const tags = note.topics;
  if (!tags || tags.length === 0) return false;
  return tags.some((topic) =>
    (OWNERSHIP_TOPIC_TAGS as readonly string[]).includes(topic.toLowerCase())
  );
}

/**
 * The ownership/why selection. DEFENSE IN DEPTH like `selectStandingNotes`:
 * human-confirmed, active, not stale, ownership-tagged, workspace-fenced —
 * re-applied here even though the server already selected on it, because a
 * compromised or stale response must not put an unconfirmed note into every
 * brief in the workspace. Unconfirmed ids CANNOT enter (ADR-0051 test
 * obligation), and the count of omitted notes is returned so the render can
 * say it truncated.
 */
export function selectOwnershipNotes<T extends OwnershipNote>(
  notes: T[],
  budgetChars = OWNERSHIP_SLICE_BUDGET_CHARS,
  expectedWorkspacePath?: string | null
): { selected: T[]; omitted: number } {
  const eligible = notes.filter(
    (note) =>
      note.confirmed &&
      (note.status == null || note.status === "active") &&
      !note.stale &&
      // ADR-0091 D3: the KIND qualifies outright; the tag path stays for
      // the migration window (both-reads, one selector).
      (note.kind === "ownership" ||
        ((note.kind === "decision" ||
          note.kind === "constraint" ||
          note.kind === "convention") &&
          hasOwnershipTag(note))) &&
      !(
        expectedWorkspacePath != null &&
        note.workspacePath != null &&
        note.workspacePath !== expectedWorkspacePath
      )
  );
  const selected: T[] = [];
  let spent = 0;
  for (const note of eligible) {
    if (selected.length >= OWNERSHIP_SLICE_MAX_NOTES) break;
    const cost = note.text.length + 16;
    if (spent + cost > budgetChars) continue;
    selected.push(note);
    spent += cost;
  }
  return { selected, omitted: eligible.length - selected.length };
}

/** The code-graph shape facts the pack states (measured, never claimed). */
export type GraphShapeSummary = {
  status: "fresh" | "stale" | "missing";
  indexedAt?: string;
  files?: number;
  nodes?: number;
  processes?: number;
};

/**
 * Render the institutional-context section. Two rules the wording enforces:
 *
 * 1. An EMPTY ownership slice is explicit ("no confirmed ownership/why
 *    notes"), never invented and never silently omitted — an agent that
 *    sees nothing must know nobody recorded ownership, not guess that the
 *    pack forgot it (A3).
 * 2. The graph-shape line reports what the store MEASURED about itself and
 *    its freshness status; a stale or missing index is named here and gets
 *    its own loud TOOL GAP block from the preamble (A10) — this line never
 *    softens that.
 */
export function renderInstitutionalPack(input: {
  ownership: OwnershipNote[];
  /** Server scan honesty (ADR-0051): false means the ownership scan hit its
   *  bound before seeing the whole candidate set, so an empty slice must
   *  NOT be asserted as ledger-wide absence. Absent → complete. */
  ownershipScanComplete?: boolean;
  graphShape?: GraphShapeSummary;
  scope?: { workspacePath?: string | null };
  budgetChars?: number;
}): string {
  const { selected, omitted } = selectOwnershipNotes(
    input.ownership,
    input.budgetChars ?? OWNERSHIP_SLICE_BUDGET_CHARS,
    input.scope?.workspacePath
  );
  const lines: string[] = [];
  const workspace = input.scope?.workspacePath
    ? ` for ${input.scope.workspacePath}`
    : "";
  lines.push(
    `Institutional context${workspace} (server-assembled: human-confirmed notes + the code graph's own measurements — nothing here is agent-claimed):`
  );
  const scanComplete = input.ownershipScanComplete ?? true;
  if (selected.length === 0) {
    // An absolute absence claim is only lawful when the scan actually saw
    // the whole candidate set — an absence derived from a truncated scan is
    // the exact "refusal that lies" class this product refuses to ship.
    lines.push(
      scanComplete
        ? "- OWNERSHIP / WHY: no confirmed ownership or rationale notes exist for this workspace. Absence recorded, not guessed — if you learn who owns a module or why a constraint exists, propose it via memory_add with topic \"ownership\" or \"why\"."
        : "- OWNERSHIP / WHY: the ownership scan hit its bound before completing, so absence is NOT established. Recall via memory_search with topic \"ownership\" or \"why\" before concluding nobody recorded ownership."
    );
  } else {
    lines.push("- OWNERSHIP / WHY (human-confirmed):");
    for (const note of selected) {
      lines.push(`  - [${note.kind}] ${note.text}`);
    }
    if (omitted > 0) {
      lines.push(
        `  - ${omitted} more confirmed ownership/why note(s) exist but did not fit this brief's budget; recall them via memory_search.`
      );
    }
  }
  const shape = input.graphShape;
  if (shape) {
    if (shape.status === "fresh" && shape.nodes != null) {
      const processes =
        shape.processes != null ? `, ${shape.processes} execution flows` : "";
      lines.push(
        `- CODE GRAPH: fresh index${shape.indexedAt ? ` (${shape.indexedAt})` : ""} — ${shape.nodes} symbols across ${shape.files ?? "?"} files${processes}. Use repo_map for clusters and disjoint work-units; do not re-derive the shape by walking directories.`
      );
    } else if (shape.status === "stale") {
      lines.push(
        "- CODE GRAPH: index is STALE — see the TOOL GAP block above; graph-backed claims are unknown risk until re-indexed."
      );
    } else {
      lines.push(
        "- CODE GRAPH: no readable local index — see the TOOL GAP block above; graph tools will degrade and say so."
      );
    }
  }
  return `${lines.join("\n")}\n\n`;
}

/** Prepend the institutional pack to a brief (empty pack → brief unchanged,
 *  byte-identical, same contract as the other composers). */
export function withInstitutionalPack(
  brief: string,
  input: {
    ownership: OwnershipNote[];
    ownershipScanComplete?: boolean;
    graphShape?: GraphShapeSummary;
    scope?: { workspacePath?: string | null };
    budgetChars?: number;
  } | null
): string {
  if (!input) return brief;
  const section = renderInstitutionalPack(input);
  return section ? `${section}${brief}` : brief;
}
