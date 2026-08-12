import type {
  EditTarget,
  MemoryKind,
  MemoryNote,
  MemoryTrust,
  PreEditActivity,
  PreEditContext,
  PreEditCoverage,
  PreEditCoverageEmptyReason,
  PreEditDuplicateWork,
  PreEditMemory,
  PreEditPendingProposal,
  PreEditWarning,
} from "./types.js";

// Re-export the wire types so a browser-bundled surface (the Electron renderer)
// can pull them AND the view-model from this one pure, node-free module, never
// the package index (which reaches node built-ins via paths/config).
export type {
  EditTarget,
  PreEditActivity,
  PreEditContext,
  PreEditCoverage,
  PreEditCoverageEmptyReason,
  PreEditDuplicateWork,
  PreEditMemory,
  PreEditPendingProposal,
  PreEditWarning,
} from "./types.js";

/**
 * P6a, the shared pre-edit ("Brain") view-model (the hero's human-facing arm).
 *
 * `preEditContext` (P2.5 HERO) fuses a CODE blast-radius with the GOVERNED
 * (human-confirmed) memory anchored to it. That agent-facing side shipped in
 * P2.5; this module is its "surface to the HUMAN" arm: one PURE function of the
 * fused context that the TUI, desktop, and CLI all render, so they can never
 * drift (mirrors the P2b onboarding state machine). No I/O, no node built-ins,
 * the Electron renderer can bundle it.
 *
 * TRUST DISCIPLINE (carry the hero's lesson):
 *   - GOVERNED `memories` are confirmed-only and TRUSTED, their TEXT is shown.
 *   - `warnings` / `pendingProposals` are EXISTENCE-ONLY from the hero (IDs +
 *     anchors + a GENERIC detail, never verbatim untrusted text). This view-model
 *     NEVER carries a proposal's text: `PreEditProposalView.hasText` is a literal
 *     `false`. A human fetches that text ON DEMAND by id via the OPERATOR-tier
 *     note-by-id path (`fetchProposalNote`), then confirms/rejects it through the
 *     operator-tier KG-6 route (`resolveProposal`). Untrusted text is never
 *     surfaced as if it were a confirmed decision.
 */

/** Which guided phase the panel is in. */
export type PreEditPhase =
  /** No context loaded yet (nothing fetched / no target chosen). */
  | "empty"
  /** A context is loaded and rendered (may still have honest sub-notices). */
  | "ready";

export type PreEditProximityLabel = "on-target" | "neighbor";

/** Human labels for each memory kind (decisions first in KIND_ORDER). */
const KIND_LABEL: Record<MemoryKind, string> = {
  decision: "Decision",
  constraint: "Constraint",
  convention: "Convention",
  attempt: "Attempt",
  question: "Question",
};

/**
 * D14: one honest human sentence per empty-gate reason.
 *
 * It lives HERE, with the view-model, and not in `@muon/protocol` beside the
 * enum, for two reasons. Layering: protocol owns the WIRE contract (the closed
 * union, the schema, the derivation), and these are presentation strings. And
 * bundling: this module is the renderer-safe route all three surfaces import
 * (`@muon/client/preedit-view`), so a RUNTIME value import from `@muon/protocol`
 * here would make the browser bundle depend on resolving a package apps/desktop
 * deliberately does not list — the trap `session-workspace.tsx` records. The enum
 * still crosses the wire; only the sentences are local, and `Record<...>` over the
 * closed union means a new reason cannot be added without adding a sentence.
 *
 * These are OUR strings selected by an enum member, so rendering one is never
 * rendering backend or agent text.
 */
const COVERAGE_EMPTY_NOTICE: Record<PreEditCoverageEmptyReason, string> = {
  no_anchors:
    "No anchors resolved for this target, so the gate had nothing to look up.",
  no_notes_on_anchors:
    "The gate looked and found no memory anchored to this radius at all \u2014 nothing is recorded here yet, not even unconfirmed.",
  withheld_no_crew_chat:
    "Memory IS anchored to this radius, but none of it is human-confirmed and this read is not inside a crew chat, so the gate withheld all of it. Confirm a note to surface it here.",
  withheld_by_gate:
    "Memory IS anchored to this radius, but none of it passed the gate for this read.",
  withheld_agent_projection:
    "The gate admitted memory for this radius, but this surface is confirmed-only, so none of it was shown. Confirm the notes to surface them.",
  index_unavailable:
    "The memory index could not be read for part of this radius, so an empty result here means UNKNOWN, not none.",
};

const SOURCE_LABEL: Record<PreEditContext["blastRadius"]["source"], string> = {
  provided: "Provided impact map",
  codegraph: "Local code map",
  "target-only": "Selected file only; code map unavailable",
};

/** A governed (confirmed, trusted) memory, annotated for display. Carries TEXT
 *  because it is confirmed-only, this is the trusted half of the gate. */
export type PreEditMemoryView = {
  note: PreEditMemory;
  onTarget: boolean;
  proximity: number;
  proximityLabel: PreEditProximityLabel;
  kindLabel: string;
  isDecision: boolean;
};

/** A contradiction/proposal warning, existence-only (no untrusted text). */
export type PreEditWarningView = {
  kind: PreEditWarning["kind"];
  noteId: string;
  relatedNoteId: string;
  detail: string;
  label: string;
};

/**
 * A pending PROPOSES_SUPERSEDE the human can adjudicate. IDs + anchors + a
 * generic summary ONLY, `hasText` is a literal `false` so the type itself
 * proves the untrusted proposal text is absent until a human explicitly fetches
 * it by id (`fetchProposalNote`).
 */
export type PreEditProposalView = {
  proposalNoteId: string;
  victimNoteId: string;
  modules: string[];
  detail: string;
  /** Structural guarantee: the untrusted proposal TEXT is never in the view. */
  hasText: false;
  summary: string;
};

export type BlastRadiusView = {
  modules: string[];
  symbols: string[];
  depth?: number;
  source: PreEditContext["blastRadius"]["source"];
  sourceLabel: string;
  /** No code-graph radius was available → target-only (an honest degraded state). */
  degraded: boolean;
};

/**
 * KG-7 (ADR-0014), a cross-agent LIVE activity row for the human surface. A
 * COORDINATES-ONLY line ("another lane is live on this symbol/module"): it never
 * carries note/brief/message text. `hasText` is a literal `false` so the type
 * itself proves no content leaks onto the surface (mirrors PreEditProposalView).
 */
export type PreEditActivityView = {
  laneId: string;
  vendor: string;
  taskId: string;
  jobId: string;
  kind: PreEditActivity["kind"];
  anchor: string;
  anchorKind: PreEditActivity["anchorKind"];
  at: string;
  state: PreEditActivity["state"];
  /** KG-9 (ADR-0014 §6) proximity tier, coordinates only. `onSymbol` = the peer is
   *  on your EXACT target symbol; `onTarget` = on your exact target symbol OR module;
   *  else it is a blast-radius neighbour. Lets a surface distinguish "on your EXACT
   *  target" from "in your blast radius" without any content. */
  onSymbol: boolean;
  onTarget: boolean;
  proximity: number;
  /** Structural guarantee: no content-bearing field is ever in the view. */
  hasText: false;
  /** A generic, coordinate-only one-liner (no free-form/agent text). */
  summary: string;
};

/**
 * KG-10 (ADR-0014 §5), a DUPLICATE-WORK row for the human surface: "another lane
 * is doing semantically the same work". COORDINATES ONLY, a similarity scalar +
 * ids; the brief text is NEVER read here (`hasText` is a literal `false`, so the
 * type itself proves no content leaks onto the surface, mirroring
 * PreEditActivityView / PreEditProposalView).
 */
export type PreEditDuplicateWorkView = {
  jobId: string;
  taskId: string;
  vendor: string;
  /** Cosine similarity (0–1), rounded, a coordinate. */
  similarity: number;
  /** Percent form for display, e.g. 88 for 0.88. */
  similarityPct: number;
  state: "live";
  /** Structural guarantee: the brief text is never in the view. */
  hasText: false;
  /** A generic, coordinate-only one-liner (ids + score, no brief text). */
  summary: string;
};

export type PreEditView = {
  phase: PreEditPhase;
  target: EditTarget;
  targetLabel: string;
  blastRadius: BlastRadiusView;
  /** KG-7 + KG-8 (ADR-0014): OTHER lanes on this edit target, coordinates only.
   *  Live (present tense) sorted before recent (past tense). */
  activity: PreEditActivityView[];
  /** How many OTHER lanes are LIVE (running now) on this edit target's anchor. */
  activeLaneCount: number;
  /** KG-8: how many OTHER tasks RECENTLY touched this anchor (past tense window). */
  recentLaneCount: number;
  /** KG-9: how many OTHER lanes (live or recent) are on your EXACT target (its
   *  symbol OR module), the highest-priority collision, distinct from the radius. */
  onTargetLaneCount: number;
  /** KG-9: how many OTHER lanes are on a blast-radius NEIGHBOUR (not the exact
   *  target), "editing something in your reverse-import closure". */
  neighbourLaneCount: number;
  /** True when a peer lane is currently live on this code (surface a warning). */
  hasLiveActivity: boolean;
  /** True when a peer task recently touched this code (KG-8 past-tense signal). */
  hasRecentActivity: boolean;
  /** KG-9: true when at least one peer (live or recent) is on your EXACT target,
   *  the strongest signal, surfaced above blast-radius-only activity. */
  hasOnTargetActivity: boolean;
  /** KG-10 (ADR-0014): OTHER live lanes doing semantically the SAME work (brief
   *  paraphrase), coordinates only (a similarity scalar + ids, never text). A
   *  DISTINCT channel from `activity` (that is anchor-based; this is brief-based). */
  duplicateWork: PreEditDuplicateWorkView[];
  /** KG-10: how many OTHER live lanes are doing semantically the same work. */
  duplicateWorkCount: number;
  /** KG-10: true when at least one peer lane is doing the same work (surface it). */
  hasDuplicateWork: boolean;
  /** All governed memories, on-target tier first (the hero's hard tier), then
   *  the calibrated within-tier order from the backend is preserved. */
  memories: PreEditMemoryView[];
  onTargetMemories: PreEditMemoryView[];
  neighborMemories: PreEditMemoryView[];
  warnings: PreEditWarningView[];
  pendingProposals: PreEditProposalView[];
  hasGovernedMemory: boolean;
  hasWarnings: boolean;
  pendingCount: number;
  /**
   * D14: how the gate LOOKED (counts + a closed-enum `emptyReason`), carried
   * through for a surface that wants to render the numbers rather than the
   * sentence. `null` when the backend predates D14 and cannot say — which is a
   * different fact from "it looked and found nothing", so it is not defaulted to
   * a zeroed block. DIAGNOSTIC: no view field is computed FROM it except the
   * notice text below.
   */
  coverage: PreEditCoverage | null;
  /** Honest empty/degraded messages to render as-is. */
  notices: string[];
};

/** Describe the edit target as a single line. */
export function describeTarget(target: EditTarget | undefined): string {
  if (!target) {
    return "(no target)";
  }
  if (target.symbol) {
    return target.symbol;
  }
  if (target.module) {
    return target.module;
  }
  if (target.files && target.files.length > 0) {
    return target.files.join(", ");
  }
  return "(no target)";
}

function warningLabel(kind: PreEditWarning["kind"]): string {
  return kind === "contradicts"
    ? "Contradiction"
    : "Pending supersede (needs human confirmation)";
}

function toMemoryView(memory: PreEditMemory): PreEditMemoryView {
  return {
    note: memory,
    onTarget: memory.onTarget,
    proximity: memory.proximity,
    proximityLabel: memory.onTarget ? "on-target" : "neighbor",
    kindLabel: KIND_LABEL[memory.kind] ?? memory.kind,
    isDecision: memory.kind === "decision",
  };
}

/** DISPLAY proximity fallback for a neighbour when a pre-KG-9 backend omits the
 *  tier (matches the hero's `neighbourProximity(undefined)`). */
const NEIGHBOUR_PROXIMITY_FALLBACK = 0.6;

/** Build a coordinate-only activity line. NO content-bearing field is read, the
 *  `summary` is assembled purely from the lane/vendor/anchor coordinates, and the
 *  KG-9 proximity tier (booleans/a number) is carried through verbatim. */
function toActivityView(activity: PreEditActivity): PreEditActivityView {
  const where = activity.anchorKind === "symbol" ? "symbol" : "module";
  // KG-9 tier, default a pre-KG-9 backend (no tier field) to a neighbour, exactly
  // today's behaviour (nothing is treated as on-target unless the hero said so).
  const onSymbol = activity.onSymbol ?? false;
  const onTarget = activity.onTarget ?? false;
  const proximity =
    activity.proximity ?? (onTarget ? 1 : NEIGHBOUR_PROXIMITY_FALLBACK);
  // Tense follows `state`: live = present ("is editing … (live)"), recent = past
  // ("recently edited … (recent)"). Assembled purely from coordinates, no text.
  const summary =
    activity.state === "live"
      ? `${activity.vendor} lane is ${
          activity.kind === "editing" ? "editing" : "working in"
        } ${where} ${activity.anchor} (live)`
      : `${activity.vendor} lane recently ${
          activity.kind === "editing" ? "edited" : "worked in"
        } ${where} ${activity.anchor} (recent)`;
  return {
    laneId: activity.laneId,
    vendor: activity.vendor,
    taskId: activity.taskId,
    jobId: activity.jobId,
    kind: activity.kind,
    anchor: activity.anchor,
    anchorKind: activity.anchorKind,
    at: activity.at,
    state: activity.state,
    onSymbol,
    onTarget,
    proximity,
    hasText: false,
    summary,
  };
}

/** Build a coordinate-only duplicate-work line. NO brief text is read, the
 *  `summary` is assembled purely from the vendor/ids and the similarity SCALAR. */
function toDuplicateWorkView(
  dup: PreEditDuplicateWork
): PreEditDuplicateWorkView {
  const similarityPct = Math.round(dup.similarity * 100);
  return {
    jobId: dup.jobId,
    taskId: dup.taskId,
    vendor: dup.vendor,
    similarity: dup.similarity,
    similarityPct,
    state: dup.state,
    hasText: false,
    summary: `${dup.vendor} lane (job ${dup.jobId}) is doing semantically the same work (~${similarityPct}% similar)`,
  };
}

function toProposalView(
  proposal: PreEditPendingProposal,
  allowedModules: ReadonlySet<string>
): PreEditProposalView {
  return {
    proposalNoteId: proposal.proposalNoteId,
    victimNoteId: proposal.victimNoteId,
    modules: proposal.modules.filter((module) => allowedModules.has(module)),
    detail: proposal.detail,
    hasText: false,
    summary:
      "A proposal contests trusted memory. View its text, then confirm or reject.",
  };
}

/**
 * Build the pre-edit view-model from a fused context.
 *  - `null` / `undefined` → the `empty` phase (nothing fetched yet).
 *  - a context → the `ready` phase with the blast-radius, governed memories
 *    (on-target tier first, decisions-first order preserved from the backend),
 *    warnings, and pending proposals, plus honest empty/degraded notices.
 *
 * On-target memories are floated above neighbours here too (belt-and-suspenders
 * for the hero's HARD TIER) while the calibrated within-tier order the backend
 * produced, confirmed decisions first, stale/contradicted demoted, is
 * preserved (this view NEVER re-ranks by kind, which would fight KG-4).
 */
export function buildPreEditView(
  context: PreEditContext | null | undefined
): PreEditView {
  if (!context) {
    return {
      phase: "empty",
      target: {},
      targetLabel: "(no target)",
      blastRadius: {
        modules: [],
        symbols: [],
        source: "target-only",
        sourceLabel: SOURCE_LABEL["target-only"],
        degraded: true,
      },
      activity: [],
      activeLaneCount: 0,
      recentLaneCount: 0,
      onTargetLaneCount: 0,
      neighbourLaneCount: 0,
      hasLiveActivity: false,
      hasRecentActivity: false,
      hasOnTargetActivity: false,
      duplicateWork: [],
      duplicateWorkCount: 0,
      hasDuplicateWork: false,
      memories: [],
      onTargetMemories: [],
      neighborMemories: [],
      warnings: [],
      pendingProposals: [],
      hasGovernedMemory: false,
      hasWarnings: false,
      pendingCount: 0,
      // Nothing was fetched, so no gate read happened and there is no coverage to
      // report. `null` here means "not measured", never "measured as zero".
      coverage: null,
      notices: [
        "Enter a symbol or a file/module path to load its pre-edit context.",
      ],
    };
  }

  const views = context.memories.map(toMemoryView);
  // HARD TIER at the view layer: on-target above neighbour, each partition
  // preserving the backend's calibrated order (a stable partition, never a sort).
  const onTargetMemories = views.filter((memory) => memory.onTarget);
  const neighborMemories = views.filter((memory) => !memory.onTarget);
  const memories = [...onTargetMemories, ...neighborMemories];

  const warnings = context.warnings.map((warning) => ({
    kind: warning.kind,
    noteId: warning.noteId,
    relatedNoteId: warning.relatedNoteId,
    detail: warning.detail,
    label: warningLabel(warning.kind),
  }));

  const allowedProposalModules = new Set([
    ...context.blastRadius.modules,
    ...(context.target.module ? [context.target.module] : []),
    ...(context.target.files ?? []),
  ]);
  const pendingProposals = context.pendingProposals.map((proposal) =>
    toProposalView(proposal, allowedProposalModules)
  );

  // KG-7 + KG-8 (ADR-0014): coordinates-only activity, surface it FIRST (a
  // collision is the most time-sensitive signal). Split live (present tense, a
  // running collision) from recent (past tense, the KG-8 window) so the surface
  // labels each honestly.
  const activity = (context.activity ?? []).map(toActivityView);
  const activeLaneCount = activity.filter((a) => a.state === "live").length;
  const recentLaneCount = activity.filter((a) => a.state === "recent").length;
  // KG-9: split by PROXIMITY tier, "on your EXACT target" vs "in your blast radius"
  //, so a surface can shout the exact-target collision louder than a neighbour.
  const onTargetLaneCount = activity.filter((a) => a.onTarget).length;
  const neighbourLaneCount = activity.length - onTargetLaneCount;
  const hasLiveActivity = activeLaneCount > 0;
  const hasRecentActivity = recentLaneCount > 0;
  const hasOnTargetActivity = onTargetLaneCount > 0;

  // KG-10 (ADR-0014): duplicate-work, a DISTINCT channel from `activity` (that is
  // anchor-based; this is brief-similarity). Coordinates only (a similarity scalar
  // + ids, never brief text). Absent (dense off / pre-KG-10 backend) → [].
  const duplicateWork = (context.duplicateWork ?? []).map(toDuplicateWorkView);
  const duplicateWorkCount = duplicateWork.length;
  const hasDuplicateWork = duplicateWorkCount > 0;

  const degraded = context.blastRadius.source === "target-only";
  const coverage = context.coverage ?? null;
  const notices: string[] = [];
  if (degraded) {
    notices.push(
      "Code-graph impact unavailable, showing memory anchored to the target module only."
    );
  }
  if (memories.length === 0) {
    // D14: an empty gate used to render ONE sentence — "no trusted memory is
    // anchored to this edit radius yet" — which asserted the one thing the gate
    // does not know. On the founder's install it was flatly false: memory WAS
    // anchored, and the human simply could not be shown any of it. So when the
    // backend reports coverage, say what actually happened (a sentence keyed by
    // the closed enum, never assembled from backend prose) and follow it with the
    // counts. Absent coverage → the pre-D14 sentence, unchanged, because a client
    // talking to an old backend genuinely cannot tell the difference.
    const reason = coverage?.emptyReason;
    notices.push(
      reason
        ? COVERAGE_EMPTY_NOTICE[reason]
        : "No trusted memory is anchored to this edit radius yet."
    );
    if (coverage) {
      notices.push(describeCoverage(coverage));
    }
  }

  return {
    phase: "ready",
    target: context.target,
    targetLabel: describeTarget(context.target),
    blastRadius: {
      modules: context.blastRadius.modules,
      symbols: context.blastRadius.symbols ?? [],
      depth: context.blastRadius.depth,
      source: context.blastRadius.source,
      sourceLabel: SOURCE_LABEL[context.blastRadius.source],
      degraded,
    },
    activity,
    activeLaneCount,
    recentLaneCount,
    onTargetLaneCount,
    neighbourLaneCount,
    hasLiveActivity,
    hasRecentActivity,
    hasOnTargetActivity,
    duplicateWork,
    duplicateWorkCount,
    hasDuplicateWork,
    memories,
    onTargetMemories,
    neighborMemories,
    warnings,
    pendingProposals,
    hasGovernedMemory: memories.length > 0,
    hasWarnings: warnings.length > 0,
    pendingCount: pendingProposals.length,
    coverage,
    notices,
  };
}

/**
 * D14: the counts as one line, so "the gate looked and found nothing" and "the
 * gate looked, found 32, and showed you none" are visibly different on a
 * terminal or a panel. Counts ONLY — no note id, no coordinate, no text — and
 * the crew-vouched figure is called what it is, because vouched is not confirmed.
 */
export function describeCoverage(coverage: PreEditCoverage): string {
  const { anchors, notes, admittedBy } = coverage;
  const parts = [
    `Gate coverage: ${anchors.modules.resolved}/${anchors.modules.requested} module anchors resolved`,
  ];
  if (anchors.symbols.requested > 0) {
    parts.push(
      `${anchors.symbols.resolved}/${anchors.symbols.requested} symbol anchors resolved`
    );
  }
  if (anchors.unreadable > 0) {
    parts.push(`${anchors.unreadable} anchor(s) unreadable`);
  }
  parts.push(`${notes.considered} note(s) considered`);
  parts.push(
    `${notes.admitted} admitted (${admittedBy.humanConfirmed} human-confirmed, ${admittedBy.crewVouched} crew-vouched${
      admittedBy.trustFloor > 0
        ? `, ${admittedBy.trustFloor} by trust floor`
        : ""
    })`
  );
  if (notes.surfaced !== notes.admitted) {
    parts.push(`${notes.surfaced} shown here`);
  }
  parts.push(coverage.crewChat ? "crew tier engaged" : "crew tier not engaged");
  return `${parts.join(" · ")}.`;
}

// ── The shared loader + adjudication helpers ─────────────────────────────────
//
// A minimal structural client so this module stays node-free and trivially
// mockable. All three surfaces call THESE (never the raw client) so the fetch,
// the on-demand text pull, and the confirm/reject go through the exact same
// path, the OPERATOR token (P3-A: the human surfaces carry it, and the
// confirm/reject is operator-tier).

/** The target + optional orchestrator-supplied blast-radius, echoing the client. */
export type PreEditTargetInput = {
  symbol?: string;
  module?: string;
  files?: string[];
  blastRadiusModules?: string[];
  blastRadiusSymbols?: string[];
  blastRadiusDepth?: number;
  asOf?: string;
  scope?: string;
  chatId?: string;
  trustFloor?: MemoryTrust;
};

/** The minimal client surface the pre-edit panel needs. */
export type PreEditClient = {
  preEditContext(input: PreEditTargetInput): Promise<PreEditContext>;
  getMemoryNote(noteId: string): Promise<MemoryNote>;
  updateMemoryNote(input: {
    noteId: string;
    confirmed?: boolean;
    status?: "active" | "paused" | "rejected";
    trust?: MemoryTrust;
    principal?: string;
  }): Promise<MemoryNote>;
};

/**
 * Turn a symbol-or-path string the human typed into an EditTarget. A value with
 * a "/" or a "." is treated as a file/module PATH (module-level anchoring, how
 * MUON anchors memory); anything else is a bare SYMBOL name (echoed for
 * provenance; MUON has no symbol graph yet, so it yields the honest target-only
 * state unless the caller also supplies a blast-radius).
 */
export function parseEditTarget(raw: string): EditTarget {
  const value = raw.trim();
  if (!value) {
    return {};
  }
  return /[/.]/.test(value) ? { module: value } : { symbol: value };
}

/** Fetch a fused pre-edit context and build its view, the single shared truth
 *  the TUI/desktop/CLI all render (and re-run to REFRESH after an adjudication). */
export async function loadPreEditView(
  client: PreEditClient,
  input: PreEditTargetInput
): Promise<PreEditView> {
  const context = await client.preEditContext(input);
  return buildPreEditView(context);
}

/**
 * Fetch a pending proposal's note (incl. TEXT) ON DEMAND by id via the
 * operator-tier note-by-id path. The panel calls this only when the human clicks
 * "View", the text is never auto-injected into the initial render.
 */
export function fetchProposalNote(
  client: PreEditClient,
  proposalNoteId: string
): Promise<MemoryNote> {
  return client.getMemoryNote(proposalNoteId);
}

// ── Hero auto-context from the active task (P6) ──────────────────────────────
//
// The moat should surface AUTOMATICALLY during a real dispatch, not only when a
// human types a target into the Brain panel. This pure helper derives a pre-edit
// target from what the CURRENT task actually touched, the modules recorded on
// its events (`metadata.modules`, written as files change) and the modules +
// SYMBOLS (Slice 7 / ADR-0012) anchored to its memory notes, so the panel
// pre-fills itself. Surfaces fall back to manual entry when this returns null.

/** The task-derived signals the auto-context is built from (all optional). */
export type AutoContextSource = {
  /** Task events; entries whose `metadata.modules` is a string[] contribute. */
  events?: { metadata?: Record<string, unknown> | null }[];
  /** Memory notes anchored to the task; contribute their modules + symbols. */
  memories?: { modules?: string[]; symbols?: string[] }[];
  /** Human-readable task name, used only to build the panel label. */
  taskTitle?: string;
};

/** A derived pre-edit target ready to hand to `preEditContext`, plus display bits. */
export type AutoContext = {
  /** The target input: on-target module (+ symbol) and the touched blast-radius. */
  input: PreEditTargetInput;
  modules: string[];
  symbols: string[];
  /** One-line label for the surface, e.g. "auto from active task: a.ts, b.ts". */
  label: string;
};

/** Hard cap on how many touched modules/symbols the auto-context fans out over,
 *  mirroring the route's own anchor cap (defence-in-depth against a huge task). */
const MAX_AUTO_MODULES = 32;
const MAX_AUTO_SYMBOLS = 32;

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

/**
 * Derive the pre-edit target for the CURRENT task from its touched modules +
 * symbols. Returns `null` when nothing is derivable (no active task / no touched
 * modules yet) so the caller can fall back to manual entry.
 *
 * The primary MODULE (and SYMBOL, when present) becomes the on-target anchor and
 * the full touched set is passed as the `blastRadiusModules`/`blastRadiusSymbols`
 *, so `preEditContext` treats it as an orchestrator-provided radius (source
 * "provided") and ranks on-target memory first, exactly as during a real edit.
 */
export function deriveAutoContext(
  source: AutoContextSource
): AutoContext | null {
  const moduleSet = new Set<string>();
  const symbolSet = new Set<string>();

  for (const event of source.events ?? []) {
    for (const mod of stringArray(event.metadata?.modules)) {
      moduleSet.add(mod);
    }
  }
  for (const note of source.memories ?? []) {
    for (const mod of stringArray(note.modules)) {
      moduleSet.add(mod);
    }
    for (const sym of stringArray(note.symbols)) {
      symbolSet.add(sym);
    }
  }

  const modules = [...moduleSet].slice(0, MAX_AUTO_MODULES);
  const symbols = [...symbolSet].slice(0, MAX_AUTO_SYMBOLS);
  if (modules.length === 0 && symbols.length === 0) {
    return null;
  }

  // Prefer a symbol's own module as the on-target module so the on-symbol tier
  // and the on-module tier agree; otherwise the first touched module.
  const primarySymbol = symbols[0];
  const symbolModule = primarySymbol?.includes("#")
    ? primarySymbol.slice(0, primarySymbol.indexOf("#"))
    : undefined;
  const primaryModule = symbolModule ?? modules[0];

  const input: PreEditTargetInput = {
    ...(primaryModule ? { module: primaryModule } : {}),
    ...(primarySymbol ? { symbol: primarySymbol } : {}),
    ...(modules.length > 0 ? { blastRadiusModules: modules } : {}),
    ...(symbols.length > 0 ? { blastRadiusSymbols: symbols } : {}),
  };

  const shown = (modules.length > 0 ? modules : symbols).slice(0, 3);
  const more = (modules.length > 0 ? modules.length : symbols.length) - shown.length;
  const where = source.taskTitle ? `active task “${source.taskTitle}”` : "active task";
  const label = `auto from ${where}: ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`;

  return { input, modules, symbols, label };
}

export type ProposalDecision = "confirm" | "reject";

/**
 * Adjudicate a pending PROPOSES_SUPERSEDE via the EXISTING KG-6 operator-tier
 * confirm route (PATCH /api/memory/:id). Confirming the PROPOSING note APPLIES
 * the deferred supersede (retires the victim); rejecting DROPS the proposal and
 * keeps the victim. A human principal is threaded so KG-6 actually resolves the
 * proposal (an omitted principal would leave it pending). The caller REFRESHES
 * by re-running `loadPreEditView` afterwards.
 */
export function resolveProposal(
  client: PreEditClient,
  input: {
    proposalNoteId: string;
    decision: ProposalDecision;
    /** Confirming principal (human:*). Defaults to the operator ("human"). */
    principal?: string;
  }
): Promise<MemoryNote> {
  return client.updateMemoryNote({
    noteId: input.proposalNoteId,
    confirmed: input.decision === "confirm",
    principal: input.principal ?? "human",
  });
}
