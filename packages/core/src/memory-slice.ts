/**
 * Memory slices push shared memory INTO briefs (vision brief §6.1): a
 * specialist starts with the top-K current, confirmed notes instead of
 * having to pull via MCP. Recall happens at the surface layer through
 * @muon/client (`recallRelatedToTask` / topic + module recall); this module
 * stays pure so core does not depend on the client package.
 */
export type MemorySliceNote = {
  kind: string;
  text: string;
  confirmed: boolean;
  stale: boolean;
  /** Absent is legacy-active. Paused/rejected notes can remain inspectable on
   * operator surfaces but may never steer a crew brief. */
  status?: "active" | "paused" | "rejected";
  /**
   * WHO vouched. `"human"` is the strictly stronger tier and is exactly what
   * `confirmed` reports. `"orchestrator"` means the crew's own coordinator
   * vouched — settled, durable crew knowledge that the operator owes no review
   * on, but never a claim that a person read it.
   *
   * This is load-bearing for COORDINATION, not bookkeeping. A slice that
   * admits only human-confirmed notes means one worker's learnings never reach
   * its peers, so a crew sharing a workspace does not share context — which is
   * the whole point of having a crew. Optional so a caller that does not carry
   * the field behaves exactly as before.
   */
  confirmedBy?: "human" | "orchestrator" | null;
};

/**
 * The notes that actually make it INTO a slice, vouched and capped at k.
 *
 * D9-ii (substrate §3.6): `stale` is **shown-labelled-demoted**, never silently
 * dropped. Fresh vouched notes fill the k budget first; stale vouched notes
 * follow so a full fresh set still crowds them out. Dropping was option (i) and
 * made the coordinate producer's `markModulesStale` thin the brief of the note
 * most likely to be relevant to the edit under way.
 *
 * Exposed (and used by renderMemorySlice) so a caller can learn EXACTLY which
 * notes were surfaced into an agent's context, the set that counts as "used"
 * for reinforcement (ADR-0009 §2.4 / KG-2). Generic so the caller keeps the
 * concrete note type (with its id); the render path and the used-signal path
 * can never drift because they share this selector.
 */
export function selectMemorySliceNotes<T extends MemorySliceNote>(
  notes: T[],
  k = 5
): T[] {
  const vouched = notes.filter(
    (note) => (note.status == null || note.status === "active") && vouchedForCrew(note)
  );
  const fresh = vouched.filter((note) => !note.stale);
  const stale = vouched.filter((note) => note.stale);
  return [...fresh, ...stale].slice(0, k);
}

/**
 * A note the crew may start from. Human confirmation is the strongest signal
 * and always qualifies; an orchestrator vouch qualifies too, because the
 * coordinator settling a fact is what lets its workers begin from shared
 * context instead of re-deriving it. Anything unvouched stays out of briefs
 * and remains reachable only through MCP recall, flagged as suspect.
 */
function vouchedForCrew(note: MemorySliceNote): boolean {
  return note.confirmed || note.confirmedBy === "orchestrator";
}

/**
 * ADR-0026 §9 — the preamble states its PARTITION, because the agent reads it.
 *
 * The heading is a provenance claim (see the note below about `confirmed`), and
 * after ADR-0026 it is also a SCOPE claim: this memory is one repository's, and the
 * agent's own `memory_search` / `memory_recall` are fenced to the same repository by
 * the server. Saying so is not decoration — an agent that believes the brain is
 * global will conclude, on finding nothing about another repo, that nothing was ever
 * learned there, and may confidently re-derive a decision that already exists.
 *
 * `workspacePath` is optional so a caller that has none renders today's heading
 * byte-for-byte. The runner reads it from `job.workspacePath` and NEVER from
 * `MUON_WORKSPACE`, which the same file remaps to the governed worktree ~250 lines
 * later — deriving it from the env var would label every dispatch with its own
 * throwaway worktree path.
 */
export type MemorySliceScope = {
  workspacePath?: string | null;
};

export function renderMemorySlice(
  notes: MemorySliceNote[],
  k = 5,
  scope?: MemorySliceScope
): string {
  // Vouched notes only: UNVOUCHED never steers a brief. Stale notes DO appear
  // (D9-ii) but are labelled `|STALE` so the agent cannot read them as current
  // fact. "Vouched" is human confirmation OR an orchestrator vouch — see
  // `vouchedForCrew`.
  const usable = selectMemorySliceNotes(notes, k);
  if (usable.length === 0) {
    return "";
  }
  const lines = usable.map((note) =>
    note.stale
      ? `- [${note.kind}|STALE] ${note.text}`
      : `- [${note.kind}] ${note.text}`
  );
  // The heading is READ BY THE AGENT, so it is a claim about provenance and has
  // to match what the filter above actually admits. It said "confirmed" while
  // carrying orchestrator-vouched notes, which told every worker a person had
  // signed off on facts no person had seen — the same lie in the model's context
  // that `confirmed` staying human-only exists to prevent in the ledger.
  const workspace = scope?.workspacePath
    ? ` scoped to ${scope.workspacePath}`
    : "";
  const staleNote =
    usable.some((note) => note.stale)
      ? "; stale notes are labelled |STALE and demoted below current ones"
      : "";
  return `Shared memory (confirmed by a human or vouched by MUON, from the MUON brain${workspace}${staleNote}):\n${lines.join("\n")}\n\n`;
}

export function withMemorySlice(
  brief: string,
  notes: MemorySliceNote[],
  k?: number,
  scope?: MemorySliceScope
): string {
  const slice = renderMemorySlice(notes, k, scope);
  return slice ? `${slice}${brief}` : brief;
}

// ── TODO 4.1 + 4.3: the STANDING-MEMORY arm, budgeted in characters ─────────
//
// Standing memory is the workspace's canon — human-confirmed `constraint` and
// `convention` notes plus explicitly pinned, human-confirmed `decision` notes
// that ride into EVERY brief regardless of the task, because
// no query would ever retrieve "facts that should be known regardless of what
// is being asked". The server fixes the selection posture (human-confirmed
// only, active, not stale, workspace-fenced); this module owns the BUDGET and
// the rendering, and stays pure like the slice above.
//
// The budget is CHARACTERS, not a count (TODO 4.3): the measured payload on
// day one is 38 notes and the longest live note is 3,172 characters — a
// count-capped arm either starves (k too small) or floods (one long note eats
// the context a count never sees). Chars are the honest unit MUON can measure
// without a tokenizer; the gate-read telemetry records the same unit.

/** Default standing budget: roughly a thousand tokens' worth of canon. Enough
 *  for ~25 median-length live notes; a brief never silently loses more than
 *  this to memory it did not ask for. Operator-tunable at the call site. */
export const STANDING_MEMORY_BUDGET_CHARS = 4_000;

/** Hard count ceiling under the char budget, so a corpus of one-liners cannot
 *  turn the standing section into a wall of 60 bullets. */
export const STANDING_MEMORY_MAX_NOTES = 16;

export type StandingMemoryNote = MemorySliceNote & {
  /** TODO 4.22: explicit human curation for a decision-log entry. */
  pinned?: boolean;
  /**
   * The note's own workspace, when the response carries it. Used ONLY for the
   * defense-in-depth fence below (a mismatch is dropped); absent/null is left
   * to the server's authoritative fence, never guessed.
   */
  workspacePath?: string | null;
};

/**
 * The notes that actually make it into the standing section, and what was left
 * out. DEFENSE IN DEPTH: the kind/confirmed/stale predicate is re-applied here
 * even though the server already selected on it — a compromised or stale server
 * response must not put an unconfirmed note into every brief in the workspace.
 * Human-confirmed ONLY (never an orchestrator vouch — TODO 4.1's boundary), so
 * this is deliberately NOT `vouchedForCrew`.
 *
 * `expectedWorkspacePath`, when supplied, is the SECOND fence: the heading this
 * feeds names one workspace, so a note whose own `workspacePath` disagrees must
 * never ride under it (the one field whose mismatch the heading actively
 * misreports). A note that carries no workspace is left to the server's
 * authoritative fence — the client never guesses a partition it was not told.
 *
 * Selection walks the caller's order (the server sends newest-first) and takes
 * whole notes while they fit; a note that would burst the budget is skipped
 * rather than truncated, because half a constraint is not a constraint. The
 * count of omitted notes is returned so the rendering can SAY it truncated —
 * a silently-shortened canon reads as the whole canon.
 */
export function selectStandingNotes<T extends StandingMemoryNote>(
  notes: T[],
  budgetChars = STANDING_MEMORY_BUDGET_CHARS,
  expectedWorkspacePath?: string | null
): { selected: T[]; omitted: number } {
  const eligible = notes.filter(
    (note) =>
      note.confirmed &&
      (note.status == null || note.status === "active") &&
      !note.stale &&
      (note.kind === "constraint" ||
        note.kind === "convention" ||
        (note.kind === "decision" && note.pinned === true)) &&
      // Defense-in-depth workspace fence: drop a note whose own workspace
      // disagrees with the one this section will name. Skipped when either
      // side is unknown — the server fence is authoritative there.
      !(
        expectedWorkspacePath != null &&
        note.workspacePath != null &&
        note.workspacePath !== expectedWorkspacePath
      )
  );
  const selected: T[] = [];
  let spent = 0;
  for (const note of eligible) {
    if (selected.length >= STANDING_MEMORY_MAX_NOTES) break;
    const cost = note.text.length + 16; // the bullet + kind label overhead
    if (spent + cost > budgetChars) continue;
    selected.push(note);
    spent += cost;
  }
  return { selected, omitted: eligible.length - selected.length };
}

/**
 * Render the standing section. The heading is READ BY THE AGENT, so like the
 * slice heading it is a provenance claim — and additionally a COMPLETENESS
 * claim: when the budget left notes out, the heading says how many, because an
 * agent that believes it holds the whole canon will treat an absent constraint
 * as a nonexistent one.
 */
export function renderStandingMemory(
  notes: StandingMemoryNote[],
  options?: { budgetChars?: number; scope?: MemorySliceScope }
): string {
  const { selected, omitted } = selectStandingNotes(
    notes,
    options?.budgetChars ?? STANDING_MEMORY_BUDGET_CHARS,
    // The heading names this workspace, so fence the notes to it too.
    options?.scope?.workspacePath
  );
  if (selected.length === 0) {
    return "";
  }
  const lines = selected.map((note) => `- [${note.kind}] ${note.text}`);
  const workspace = options?.scope?.workspacePath
    ? ` for ${options.scope.workspacePath}`
    : "";
  const truncation =
    omitted > 0
      ? ` ${omitted} more standing note(s) exist but did not fit this brief's budget; recall them via memory_search.`
      : "";
  return `Standing workspace memory (human-confirmed constraints, conventions, and pinned decisions${workspace} — these hold regardless of the task${truncation}):\n${lines.join("\n")}\n\n`;
}

export function withStandingMemory(
  brief: string,
  notes: StandingMemoryNote[],
  options?: { budgetChars?: number; scope?: MemorySliceScope }
): string {
  const section = renderStandingMemory(notes, options);
  return section ? `${section}${brief}` : brief;
}
