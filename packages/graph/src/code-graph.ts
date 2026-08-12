/**
 * P2.5 HERO, the pluggable CODE blast-radius provider.
 *
 * MUON anchors memory at the MODULE (file/dir path) level. Before an agent edits a
 * target, the pre-edit gate (`preEditContext`) fuses the CODE blast-radius, the
 * modules a change ripples into, with the GOVERNED (human-confirmed) memory
 * anchored to that radius. Computing a code blast-radius is a CODE-GRAPH concern,
 * and MUON is LOCAL-FIRST with NO egress by default, so the DEFAULT provider does
 * NOTHING and returns null (the gate then fuses over the target's own module(s)
 * only, zero network). There are exactly two opt-in ways a real radius arrives:
 *
 *   1. THE ORCHESTRATOR SUPPLIES IT. The orchestrator is the process that holds a
 *      HOSTED code-graph client (e.g. GitNexus). It calls impact THERE and passes
 *      the affected modules straight into `preEditContext` via `opts.blastRadius`
 *      (MCP: `memory_preedit({ blastRadiusModules })`). MUON's backend never makes
 *      the call. → `source: "provided"`.
 *   2. A LOCAL IN-PROCESS PROVIDER (CG-1, future). A module-graph indexer running
 *      inside MUON with NO network could implement this interface. → `source:
 *      "codegraph"`.
 *
 * MUON's backend deliberately has NO GitNexus client: GitNexus is exposed to the
 * orchestrator, not to MUON's local-first core. A GitNexus-backed provider is
 * therefore opt-in and lives ORCHESTRATOR-side, never here.
 */

export type EditTarget = {
  /**
   * The symbol the agent is about to edit (function/class/method). MUON has no
   * symbol graph yet (CG-1), so it is carried for provenance/echo and consumed by
   * a future code-graph provider, it is NOT resolved locally.
   */
  symbol?: string;
  /** The primary module (file/dir path) the edit lands in. */
  module?: string;
  /** Additional files the edit touches. */
  files?: string[];
};

export type BlastRadius = {
  /** Modules the change ripples into, the neighbourhood to fuse memory over. */
  modules: string[];
  /**
   * Symbols in the radius, when a symbol-level provider supplied them (ADR-0015).
   * SEMANTICS: the target symbol PLUS the symbols that TRANSITIVELY REFERENCE it
   * (via CG-1's name-based, import-resolved reverse-reference graph), NOT merely an
   * echo of the target. A referencer is always a strict REFINEMENT inside `modules`
   * (`deriveModulesFromSymbols(symbols) ⊆ modules ∪ {target module}`, never widens
   * the radius); on ANY ambiguity the provider degrades to the echo-only target, so
   * a symbol edge here is never wrong. Absent a symbol-level provider it is the
   * target echo (or undefined for a module-only target), today's behaviour.
   *
   * ADR-0016 (multi-language via the `LanguageAdapter` seam): a NON-TS target (e.g.
   * Python) returns a MODULE-level radius with `symbols` = echo-only, with no
   * special-casing, the language adapter has no `extractReferences`, so no file
   * populates `symbolReverse` and `refineSymbols` finds no referencers.
   */
  symbols?: string[];
  /** Traversal depth the radius was computed to (a proximity-weighting hint). */
  depth?: number;
  /** Where the radius came from ("provided" | "codegraph" | a provider tag). */
  source: string;
};

export interface CodeGraphProvider {
  /**
   * Resolve the blast-radius for an edit target, or null when this provider does
   * no work (the local-first default), the gate then falls back to module-only.
   */
  impact(target: EditTarget): Promise<BlastRadius | null>;
}

/**
 * The DEFAULT provider: does NOTHING and makes NO network call. It returns null so
 * the pre-edit gate fuses governed memory over the target's OWN module(s) only.
 * This is what keeps MUON local-first with ZERO egress out of the box. CG-1 will
 * add a real in-process module-graph provider; a GitNexus-backed provider stays
 * opt-in and orchestrator-side.
 */
export class NullCodeGraphProvider implements CodeGraphProvider {
  async impact(_target: EditTarget): Promise<BlastRadius | null> {
    return null;
  }
}
