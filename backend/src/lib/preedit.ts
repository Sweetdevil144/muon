import {
  type BlastRadius,
  type CodeGraphProvider,
  type EditTarget,
  type MemoryKind,
  type MemoryNoteRecord,
  type MemoryTrust,
  type PreEditActivity,
  type PreEditDuplicateWork,
  MuonGraph,
  NullCodeGraphProvider,
  deriveModulesFromSymbols,
  rerankCalibrated,
} from "@muon/graph";
import type { PreEditCoverage } from "@muon/protocol";
import { tallyGateCoverage } from "./preedit-coverage.js";
import {
  describeCitation,
  orderForInjection,
  type CitingPeer,
} from "./cited-findings.js";

/**
 * P2.5 HERO, `preEditContext`, MUON's dual-graph pre-edit gate (the moat).
 *
 * Before an agent edits a target, MUON fuses a CODE blast-radius with the
 * GOVERNED (human-confirmed) memory anchored to that radius and surfaces prior
 * decisions + contradiction warnings, to the agent (MCP `memory_preedit`) AND the
 * human (route `POST /api/memory/preedit`). It is a READ COMPOSITION over the
 * finished KG foundation; it changes NO write path:
 *   - GOVERNED source: KG-6 `recallForGate` / `governedOnly` (confirmed-only; a
 *     hostile low-trust unconfirmed write can NEVER enter the gate).
 *   - RANKING: module PROXIMITY is a HARD TIER, every note anchored to the EXACT
 *     edit target ranks strictly ABOVE every blast-radius-neighbour note (the
 *     hero's "prior decisions about THIS target first, THEN its radius" promise).
 *     The KG-4 calibrated ranker (`rerankCalibrated`) orders WITHIN each tier:
 *     confirmed decisions surface first; stale/contradicted notes are demoted.
 *     Governance can reorder notes WITHIN a tier but can never lift a neighbour
 *     above an on-target note.
 *   - UNTRUSTED TEXT NEVER FLOWS OUT: only `memories` (confirmed-only, trusted)
 *     carries note TEXT. `warnings` and `pendingProposals` carry existence + IDs +
 *     a GENERIC detail only, never the verbatim text of an unconfirmed note, so
 *     an attacker's note text can never reach the agent through this gate (a
 *     prompt-injection hole is closed by OMISSION, not escaping). A human fetches a
 *     pending proposal's text ON DEMAND by id through the normal note-read path.
 *   - HUMAN GATE: `pendingProposals` (unresolved PROPOSES_SUPERSEDE for the target)
 *     are resolved through the EXISTING KG-6 confirm route (PATCH /api/memory/:id
 *     { confirmed }), a single-use gate we REFERENCE, never rebuild.
 *
 * LOCAL-FIRST: the blast-radius is EITHER supplied by the caller/orchestrator
 * (`opts.blastRadius`, the orchestrator called its hosted GitNexus impact and
 * passed the modules in) OR produced by a pluggable `CodeGraphProvider` whose
 * DEFAULT (`NullCodeGraphProvider`) does no work and makes no network call. When
 * neither yields a radius the gate falls back to the target's OWN module(s).
 */

/** A surfaced GOVERNED memory, annotated with its proximity to the edit. */
export type PreEditMemory = MemoryNoteRecord & {
  /** DISPLAY value: 1 = anchored to the EXACT edit target (its symbol OR module);
   *  <1 = a blast-radius neighbour (depth-weighted, always strictly < 1). Ranking
   *  uses the HARD TIERS (`onSymbol` > `onTarget`-module > neighbour), not this. */
  proximity: number;
  /** True when the note is anchored to the exact edit target, its SYMBOL or its
   *  MODULE (either top tier, strictly above every neighbour, regardless of
   *  governance). Equals `onSymbol || on-target-module`. */
  onTarget: boolean;
  /** True when the note is anchored to the exact edit target SYMBOL (ADR-0012,
   *  the FINEST tier, strictly above an on-target-MODULE-only note). Absent a
   *  target symbol or symbol anchors this is always false → today's ranking. */
  onSymbol: boolean;
  /**
   * Substrate §3.3: true when this note was force-attached by the path-triggered
   * injection arm (standing constraint/convention intersecting the radius) rather
   * than ordinary ranked retrieval. Absent/false = ranked into the set. Labelled
   * so surfaces can show push delivery honestly.
   */
  injected?: boolean;
  /**
   * ADR-0035: a same-chat peer cited this note as a finding on this radius —
   * "cited by reviewer (review_verdict)". COORDINATES ONLY; the citing
   * message's subject and body have no field to ride in, deliberately.
   *
   * A citation does not change the note's tier: a cited-but-unconfirmed note
   * still cannot satisfy the confirmed-only edit gate. It changes WHEN and
   * WHETHER the note surfaces on this radius, never what it is worth.
   *
   * NOTE, drift hazard: this shape is declared twice — here and as
   * `PreEditMemory` in `@muon/client`'s types. They must stay in step; the wire
   * carries the client's.
   */
  citedBy?: string;
};

export type PreEditWarningKind = "contradicts" | "proposes_supersede";

/** A contested/contradicting memory to show before editing. Existence + IDs +
 *  a GENERIC detail ONLY, never any (even confirmed) verbatim note text. */
export type PreEditWarning = {
  kind: PreEditWarningKind;
  /** The surfaced/anchored note the warning is about. */
  noteId: string;
  /** The other note in the relationship (contradicted / would-be-superseded). */
  relatedNoteId: string;
  detail: string;
};

/**
 * An unresolved PROPOSES_SUPERSEDE anchored to the edit radius. The proposing note
 * is UNCONFIRMED (so it is NOT in `memories`, which is confirmed-only). Carries
 * existence + IDs + anchors + a GENERIC detail ONLY, deliberately NO proposal
 * TEXT, because that text is untrusted (attacker-controlled) and must never reach
 * the agent. A human adjudicates by fetching the note text ON DEMAND by
 * `proposalNoteId` through the normal note-read path, then resolves it via the
 * EXISTING KG-6 confirm route: PATCH /api/memory/{proposalNoteId} { confirmed: true }
 * APPLIES the deferred supersede, { confirmed: false } drops it.
 */
export type PreEditPendingProposal = {
  proposalNoteId: string;
  /** The note it would supersede (kept active until a human/peer confirms). */
  victimNoteId: string;
  modules: string[];
  detail: string;
};

export type PreEditContextResult = {
  target: EditTarget;
  blastRadius: {
    modules: string[];
    symbols?: string[];
    depth?: number;
    source: "provided" | "codegraph" | "target-only";
  };
  memories: PreEditMemory[];
  warnings: PreEditWarning[];
  pendingProposals: PreEditPendingProposal[];
  /**
   * KG-7 (ADR-0014), cross-agent LIVE activity: which OTHER live lane is currently
   * working on the edit target's symbol/module. A SIBLING channel to `memories`,
   * carrying COORDINATES ONLY (never note/stream/brief text). It is NOT ranked into
   * `memories`, is NOT a `MemoryNote`, and can NEVER enter `recallForGate`. Absent a
   * reader / running job / anchor match it is `[]` → today's hero byte-for-byte.
   */
  activity: PreEditActivity[];
  /**
   * KG-10 (ADR-0014 §5 Embeddings), DUPLICATE-WORK: other currently-LIVE lanes
   * whose declared task brief is a SEMANTIC PARAPHRASE of the caller's brief. A
   * DISTINCT sibling channel to `activity[]` (dup-work is brief-similarity, not
   * anchor-based) carrying COORDINATES ONLY, a similarity SCALAR + ids, NEVER the
   * brief text or the embedding. It is NOT ranked into `memories`, is NOT a
   * `MemoryNote`, and can NEVER enter `recallForGate`. OPTIONAL dense enrichment:
   * absent a reader / no embedder / <2 running jobs / any error → `[]` → today's
   * hero byte-for-byte, no latency, no network.
   */
  duplicateWork: PreEditDuplicateWork[];
  /**
   * D14, COVERAGE: how the gate LOOKED, not just what it found. Counts + a
   * closed-enum `emptyReason`, so `memories: []` stops meaning two different
   * things ("nothing is anchored" vs "things are anchored and you may not see
   * them"). DIAGNOSTIC ONLY — it is derived AFTER every admission decision, no
   * branch above reads it, and D14-C (widen the gate when coverage is zero) is
   * rejected outright: a gate that relaxes when it finds nothing fails open
   * exactly when the index is broken. Counts only, never note ids or text.
   */
  coverage: PreEditCoverage;
};

export type PreEditOptions = {
  /** Pluggable code-graph provider. Default = NullCodeGraphProvider (no egress). */
  provider?: CodeGraphProvider;
  /** Caller/orchestrator-supplied blast-radius, SHORT-CIRCUITS the provider. */
  blastRadius?: BlastRadius;
  /** Bitemporal as-of (KG-5): the governed set the brain believed at time T. */
  asOf?: string;
  /** Scope filter (KG-5 / D5). */
  scope?: string;
  /** #126 + B6 partition: when set, every memory read sees this chat plus
   *  human-confirmed promoted-global memory. Ordinary cross-chat, NULL-chat, and
   *  unconfirmed-global notes can neither surface nor raise a warning. */
  chatId?: string;
  /** ADR-0026 §9 WORKSPACE partition. This gate is the hero read AND the one place
   *  the ADR's collision is dangerous rather than cosmetic: it fans out one
   *  `recallForGate` per anchor MODULE, and the anchors are workspace-RELATIVE
   *  paths, so without this term repo B's decision about `src/index.ts` is served
   *  as governed evidence to an agent editing repo A's. Threaded into BOTH the
   *  governed gate recall and the general pending-proposal recall, because the
   *  second one carries the contradiction warnings. Unlike `chatId` (see the D1
   *  deferral below) the route AUTHENTICATES this for the agent tier. Absent →
   *  unchanged behaviour. */
  workspacePath?: string;
  /** ADR-0026 §8 residue view (operator-only; the route refuses it for an agent). */
  unscopedWorkspace?: boolean;
  /** #133 CREW-VISIBLE admission (the resolved `autoConfirmAgentMemory` operator
   *  setting). When true AND `chatId` is set, the confirmed-only gate ALSO admits
   *  same-chat UNCONFIRMED agent notes into `memories`, so an agent-authored note
   *  reaches the next agent in the SAME chat automatically. DISTINCT from human
   *  confirmation: it never mutates the human-only `confirmed` flag. The blast
   *  radius is HARD-WIRED here — crewChatId is ALWAYS `opts.chatId` (the request's
   *  own chat), so it can never widen across chats or to NULL/''-chat notes, and
   *  trust stays 'medium' so a `trustFloor:'high'` gate still excludes them. Absent
   *  / false → the pre-#133 strict confirmed-only gate. Never touches the general
   *  (pending-proposal) recall, so out-of-gate unconfirmed text stays omitted. */
  crewVisibleMemory?: boolean;
  /** Gate trust floor (KG-6): also admit trust >= floor even if not confirmed. */
  trustFloor?: MemoryTrust;
  /** Per-anchor recall cap. */
  limit?: number;
  /** Deterministic clock threaded into the KG-4 ranker (tests pin it). */
  now?: number;
  /**
   * KG-7 (ADR-0014), the LIVE cross-agent activity reader. Given the resolved
   * anchors (the exact target symbols + all radius modules) and the caller's own
   * ids to exclude, returns coordinate-only `PreEditActivity` for every OTHER live
   * lane touching one of those anchors. OPTIONAL and best-effort: absent (or on
   * throw) the hero degrades to `activity: []`, today's output, no network, no new
   * hard dependency. The reader MUST select only allowlisted coordinate columns
   * (see `lib/activity.ts`), it can never carry note/brief/message text.
   */
  activityReader?: (
    anchors: { symbols: string[]; modules: string[] },
    exclude?: { taskId?: string; jobId?: string }
  ) => Promise<PreEditActivity[]>;
  /**
   * KG-10 (ADR-0014 §5), the OPTIONAL DUPLICATE-WORK reader. Given ONLY the
   * caller's own ids (to resolve the caller's brief AND self-exclude), it returns
   * coordinate-only `PreEditDuplicateWork` for every OTHER live lane whose brief is
   * a semantic paraphrase of the caller's. It reads `DispatchJob.brief` ONLY to
   * embed it (KG-3 loopback embedder), the text NEVER surfaces; only a similarity
   * scalar + ids do. OPTIONAL and best-effort: absent (or on throw) the hero
   * degrades to `duplicateWork: []`, today's output, no embed work, no network,
   * no new hard dependency. Distinct from `activityReader` (anchor-based); this is
   * brief-similarity, so it takes NO anchors, just the caller's ids.
   */
  duplicateWorkReader?: (exclude?: {
    taskId?: string;
    jobId?: string;
  }) => Promise<PreEditDuplicateWork[]>;
  /** Self-exclusion (#5): the calling lane's own task, never report ITSELF live. */
  excludeTaskId?: string;
  /** Self-exclusion (#5): the calling lane's own running job. */
  excludeJobId?: string;
  /**
   * Substrate §3.3 — per-job injection ledger. When present (and a job id is
   * known), path-triggered standing notes are attached at most once per job and
   * each attachment files a coordinate-only `memory.injected` event. Absent →
   * injection still runs (tests / operator probes) but nothing is recorded and
   * nothing is deduped across calls.
   */
  /**
   * ADR-0035: note id → the same-chat peer who cited it as a finding. Supplied
   * by the route from this mission's peer messages. It only REORDERS and LABELS
   * what the governed read already returned — a citation naming a note the
   * reader cannot reach is simply absent from the candidate set and does
   * nothing, which is why this is a map rather than a fetch.
   */
  citedFindings?: ReadonlyMap<string, CitingPeer>;
  injectionLedger?: {
    jobId: string;
    alreadyInjected: (noteId: string) => Promise<boolean>;
    record: (entry: {
      noteId: string;
      anchor: string;
      gateTier: "human_confirmed" | "crew_vouched" | "trust_floor";
    }) => void;
  };
  /** Cap on force-attached standing notes per preflight (operator-feel default). */
  injectionLimit?: number;
};

/** Standing kinds eligible for §3.3 path-triggered injection. */
const PATH_INJECT_KINDS = ["constraint", "convention"] as const;
/** Default per-preflight injection budget (substrate founder decision 2). */
export const DEFAULT_INJECTION_LIMIT = 8;

/** Hard upper bound on how many anchor modules the gate will read over,
 *  regardless of what the caller supplies (DoS guard, the route ALSO caps the
 *  input array, this is defence-in-depth so a direct lib caller can't amplify).
 *  Since D6 this bounds the LIST PARAMETER of one query rather than the number of
 *  queries, so it is no longer also a latency bound — but it stays, because an
 *  unbounded anchor list is still an unbounded predicate. */
export const MAX_ANCHOR_MODULES = 128;

/** Prior DECISIONS should surface first within a tier, then constraints/
 *  conventions. A tiny relevance nudge fed to the KG-4 ranker so that, at EQUAL
 *  governance, a governed decision edges out a governed convention. Ranking
 *  across tiers is decided by `onTarget`, never by this. */
const KIND_PRIORITY: Record<MemoryKind, number> = {
  decision: 5,
  constraint: 4,
  convention: 3,
  attempt: 2,
  question: 1,
};
const KIND_BUMP_WEIGHT = 0.02;

/** DISPLAY proximity for a blast-radius NEIGHBOUR, falls off with radius depth,
 *  clamped strictly BELOW 1 so it can never tie the exact-target proximity (the
 *  hard tier owns ranking; this is for the human surface). */
function neighbourProximity(depth: number | undefined): number {
  if (depth == null) {
    return 0.6;
  }
  return Math.min(0.9, Math.max(0.2, 1 - 0.15 * depth));
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * D6: the AGGREGATE row budget for one batched anchor read.
 *
 * The fan-out this replaces asked for `limit` rows PER ANCHOR and merged the
 * results by id, so the union it could return was `limit × anchors`. One query
 * with a `limit`-sized cap would therefore be a silent narrowing — the batching
 * itself would drop notes. Stating the aggregate keeps the answer the same set;
 * the graph clamps it to its own `MAX_ANCHORED_ROWS` ceiling.
 */
function anchorRowBudget(limit: number, anchorCount: number): number {
  return limit * Math.max(1, anchorCount);
}

/** Which of `anchors` at least one returned note actually carries — the per-anchor
 *  RESOLUTION count D14's coverage reports, derived from the notes' own AUTHORITY
 *  arrays now that one batched query has replaced the per-anchor fan-out whose
 *  array index used to answer this. Equivalent by construction: a note came back
 *  because it carries one of the requested anchors, and `pick` reads exactly the
 *  array the candidate query's anchor term is the mirror of. */
function resolvedAnchors(
  anchors: string[],
  noteSets: MemoryNoteRecord[][],
  pick: (note: MemoryNoteRecord) => string[]
): number {
  if (anchors.length === 0) {
    return 0;
  }
  const seen = new Set<string>();
  for (const notes of noteSets) {
    for (const note of notes) {
      for (const value of pick(note) ?? []) {
        seen.add(value);
      }
    }
  }
  return anchors.filter((anchor) => seen.has(anchor)).length;
}

export async function preEditContext(
  graph: MuonGraph,
  target: EditTarget,
  opts: PreEditOptions = {}
): Promise<PreEditContextResult> {
  const provider = opts.provider ?? new NullCodeGraphProvider();
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 50;

  // --- 1. resolve the blast-radius (modules + symbols) -----------------------
  let neighbourModules: string[] = [];
  let radiusSymbols: string[] | undefined;
  let depth: number | undefined;
  let source: "provided" | "codegraph" | "target-only";

  if (opts.blastRadius) {
    // The orchestrator (holding GitNexus) already computed impact and passed the
    // affected modules in, MUON makes NO code-graph call.
    neighbourModules = opts.blastRadius.modules;
    radiusSymbols = opts.blastRadius.symbols;
    depth = opts.blastRadius.depth;
    source = "provided";
  } else {
    // CG-1 (always-on) resolves a symbol→module reverse-import radius, or null on
    // any doubt → module-only, no network. NullCodeGraphProvider (a supplied
    // default) likewise returns null.
    const radius = await provider.impact(target);
    if (radius) {
      neighbourModules = radius.modules;
      radiusSymbols = radius.symbols;
      depth = radius.depth;
      source = "codegraph";
    } else {
      source = "target-only";
    }
  }

  // --- 1a. the on-SYMBOL exact set (ADR-0012 Tier 0) -------------------------
  // The exact target symbol + any radius symbol that EQUALS it (the CG-1/GitNexus
  // on-target echo). A symbol-anchored note is ALWAYS also module-anchored, so the
  // symbol's module joins the exact MODULE set (Tier 1) too → clean degrade. Absent
  // a target symbol this set is EMPTY → Tier 0 empty → byte-for-byte today's rank.
  const exactSymbolSet = new Set<string>([
    ...(target.symbol ? [target.symbol] : []),
    ...(radiusSymbols ?? []).filter((sym) => sym === target.symbol),
  ]);
  const symbolModules = deriveModulesFromSymbols([...exactSymbolSet]);

  // ADR-0015 R3 (companion step 1), the REFERENCER symbols: radius symbols that are
  // NOT the exact target (CG-1's transitive referencers of the edit target). They
  // sharpen the KG-7…11 activity channel, "a lane is editing a symbol that
  // REFERENCES your target", while the existing tiering auto-classifies them as
  // NEIGHBOURS (onSymbol=false, since they are not in `exactSymbolSet`). They are
  // deliberately NOT folded into the memory fan-out (`exactSymbolSet` / `allModules`
  // are unchanged), so Tier 0 stays the exact target and `memories[]` is byte-for-byte
  // today's ranking (invariant #3). Empty when the symbol layer is off / echo-only.
  const referencerSymbols = (radiusSymbols ?? []).filter(
    (sym) => !exactSymbolSet.has(sym)
  );

  const targetModules = uniq([
    ...(target.module ? [target.module] : []),
    ...(target.files ?? []),
    ...symbolModules,
  ]);
  const exactModuleSet = new Set(targetModules);
  // DoS guard: never fan out over more than MAX_ANCHOR_MODULES anchors, even if a
  // caller hands us a giant array (the route caps too, this is defence-in-depth).
  const allModules = uniq([...targetModules, ...neighbourModules]).slice(
    0,
    MAX_ANCHOR_MODULES
  );

  // --- 2. GOVERNED (confirmed-only) memory over modules AND symbols ----------
  // Reuse KG-6's gate VERBATIM (recallForGate → governedOnly) over the anchor
  // MODULES and the exact SYMBOLS (the SAME confirmed-only gate, KG-6 unchanged,
  // so an unconfirmed symbol-anchored note is still excluded).
  //
  // D6: ONE query, not one per anchor. This used to fan out `MAX_ANCHOR_MODULES`
  // governed recalls + one per exact symbol + the same again ungated below — ≥257
  // store round trips for a 128-module radius. It is now a batched, list-valued
  // anchor term (`memoryAnchorClause`), so the gate costs a CONSTANT number of
  // round trips whether the radius is 1 module or 128, and the row set is the same
  // union the fan-out merged by id. Measured 531 ms → 56 ms at 10 000 notes.
  //
  // The two namespaces are OR'd in one query exactly as the two fan-outs were
  // merged by id, so the gate's admitted set is unchanged.
  // #133 CREW-VISIBLE admission: crewChatId is HARD-WIRED to the request's OWN
  // chat (never a caller-supplied value), so the gate can only ever widen WITHIN
  // this chat — never across chats, never to NULL/''-chat notes (the outer chatId
  // HARD-partition still bounds every candidate row to this chat). Only the GATED
  // recall (recallForGate below) receives it; the general pending-proposal recall
  // stays untouched, so out-of-gate unconfirmed text is still surfaced generic-only.
  // Absent chat (operator/global gate) or setting OFF → undefined → strict gate.
  //
  // D1 (documented deferral, S1): `opts.chatId` originates as `body.chatId` on
  // POST /preedit — an UNAUTHENTICATED coordinate, not bound to the caller's own
  // dispatched job. So a compromised agent could POST a FOREIGN chatId and read
  // that chat's UNCONFIRMED agent notes (the #133 crew-visible delta over the
  // pre-existing confirmed-note read). This is knowingly bounded for v1 by:
  // single-user local-first (no cross-tenant boundary to cross), an opaque
  // chatId (unguessable, not enumerable), and the operator kill switch
  // (autoConfirmAgentMemory OFF → crewVisibleMemory false → strict confirmed-only
  // gate, so nothing unconfirmed surfaces regardless of chatId). The real fix is
  // per-chat AGENT credentials that bind the supplied chatId to the caller's own
  // dispatched job (as dispatch.ts already does) — the documented S1 deferral;
  // do NOT change the default here to paper over it. See docs/adr/0009.
  const crewChatId =
    opts.crewVisibleMemory && opts.chatId ? opts.chatId : undefined;
  const exactSymbols = [...exactSymbolSet];
  const governedById = new Map<string, MemoryNoteRecord>();
  // D6 STARVATION GUARD — the EXACT-TARGET modules get their own arm.
  //
  // The batched query orders `createdAt DESC` ACROSS all anchors and then slices,
  // where the per-anchor fan-out it replaced gave every anchor its own `limit`.
  // Those differ the moment the cap binds: enough newer notes on a hot
  // blast-radius neighbour consume the whole budget and a note anchored to the
  // EDIT TARGET ITSELF never enters the ranking. An adversarial review reproduced
  // exactly that — the gate's Tier-0 evidence, the "prior decisions about THIS
  // symbol first" promise this module's header makes, dropped in favour of newer
  // neighbour notes. `memories[]` cannot rank a note the candidate query excluded.
  //
  // So the exact set is asked for SEPARATELY, with its own budget, and merged
  // first. This is +1 bounded query and stays FLAT in anchor count, so D6's
  // round-trip property holds; what it buys is that a neighbour can no longer
  // starve the target. Skipped when the exact set IS the whole set, which is the
  // common single-file gate.
  const exactModules = targetModules.slice(0, MAX_ANCHOR_MODULES);
  const needsExactArm =
    exactModules.length > 0 && exactModules.length < allModules.length;
  const exactGated = needsExactArm
    ? await graph.recallForGate(
        {
          modules: exactModules,
          asOf: opts.asOf,
          scope: opts.scope,
          chatId: opts.chatId,
          workspacePath: opts.workspacePath,
          unscopedWorkspace: opts.unscopedWorkspace,
          crewChatId,
        },
        {
          trustFloor: opts.trustFloor,
          limit: anchorRowBudget(limit, exactModules.length),
        }
      )
    : [];
  const gatedNotes = await graph.recallForGate(
    {
      modules: allModules,
      symbols: exactSymbols,
      asOf: opts.asOf,
      scope: opts.scope,
      chatId: opts.chatId,
      // ADR-0026: the workspace fence rides the anchor read, and a batched query is
      // a NEW candidate query — it reaches the same single `workspaceCondition`
      // evaluator through `visibilityClauses` rather than restating the rule.
      workspacePath: opts.workspacePath,
      unscopedWorkspace: opts.unscopedWorkspace,
      crewChatId,
    },
    {
      trustFloor: opts.trustFloor,
      limit: anchorRowBudget(limit, allModules.length + exactSymbols.length),
    }
  );
  for (const note of [...exactGated, ...gatedNotes]) {
    if (!governedById.has(note.id)) {
      governedById.set(note.id, note);
    }
  }

  // --- 3. 3-tier HARD order: on-symbol > on-target-module > neighbour ---------
  // KG-4 orders WITHIN each tier (decisions first, stale/contradicted demoted);
  // governance can reorder within a tier but NEVER lift a lower tier above a
  // higher one. Relevance fed to KG-4 is the small decisions-first nudge,
  // proximity is expressed structurally as the tier, not folded into the score.
  const proxById = new Map<
    string,
    { proximity: number; onTarget: boolean; onSymbol: boolean }
  >();
  const neighbourProx = neighbourProximity(depth);
  const onSymbolInputs: { note: MemoryNoteRecord; relevance: number }[] = [];
  const onModuleInputs: { note: MemoryNoteRecord; relevance: number }[] = [];
  const neighbourInputs: { note: MemoryNoteRecord; relevance: number }[] = [];
  for (const note of governedById.values()) {
    const onSymbol = note.symbols.some((sym) => exactSymbolSet.has(sym));
    const onModule = note.modules.some((mod) => exactModuleSet.has(mod));
    const onTarget = onSymbol || onModule;
    proxById.set(note.id, {
      proximity: onTarget ? 1 : neighbourProx,
      onTarget,
      onSymbol,
    });
    const input = {
      note,
      relevance: KIND_BUMP_WEIGHT * (KIND_PRIORITY[note.kind] ?? 0),
    };
    if (onSymbol) {
      onSymbolInputs.push(input);
    } else if (onModule) {
      onModuleInputs.push(input);
    } else {
      neighbourInputs.push(input);
    }
  }
  const ranked = [
    ...rerankCalibrated(onSymbolInputs, undefined, now),
    ...rerankCalibrated(onModuleInputs, undefined, now),
    ...rerankCalibrated(neighbourInputs, undefined, now),
  ];
  const memories: PreEditMemory[] = ranked.map((note) => {
    const meta = proxById.get(note.id)!;
    return {
      ...note,
      proximity: meta.proximity,
      onTarget: meta.onTarget,
      onSymbol: meta.onSymbol,
    };
  });

  // --- 3b. Substrate §3.3: path-triggered standing injection ------------------
  // Own selection + own budget: human-confirmed (same gate tier) constraint /
  // convention notes anchored to the radius, even when the ordinary recall LIMIT
  // starved them. Dedup is per-job via the optional ledger (coordinate event
  // `memory.injected`); without a ledger every call may inject (tests).
  const surfacedIds = new Set(memories.map((m) => m.id));
  const injectionCap = Math.max(
    0,
    Math.min(opts.injectionLimit ?? DEFAULT_INJECTION_LIMIT, 32)
  );
  if (injectionCap > 0 && allModules.length + exactSymbols.length > 0) {
    let injectCandidates: MemoryNoteRecord[] = [];
    try {
      injectCandidates = await graph.pathTriggeredStanding(
        {
          modules: allModules,
          symbols: exactSymbols,
          asOf: opts.asOf,
          scope: opts.scope,
          chatId: opts.chatId,
          workspacePath: opts.workspacePath,
          unscopedWorkspace: opts.unscopedWorkspace,
          crewChatId,
          trustFloor: opts.trustFloor,
        },
        { kinds: PATH_INJECT_KINDS, limit: injectionCap * 2 }
      );
    } catch {
      injectCandidates = [];
    }
    const injected: PreEditMemory[] = [];
    // ADR-0035 D4: cited findings lead within the SAME budget. A finding about
    // this radius from this mission is fresher evidence than a standing
    // convention the agent has probably already seen; sharing the cap is what
    // makes a chatty crew degrade to "some findings wait for the next
    // preflight" rather than "the gate is full of peer chatter".
    const ordered = orderForInjection(
      injectCandidates,
      opts.citedFindings ?? new Map()
    );
    for (const { note, citedBy } of ordered) {
      if (injected.length >= injectionCap) {
        break;
      }
      if (surfacedIds.has(note.id)) {
        continue;
      }
      if (opts.injectionLedger) {
        let skip = false;
        try {
          skip = await opts.injectionLedger.alreadyInjected(note.id);
        } catch {
          skip = false;
        }
        if (skip) {
          continue;
        }
      }
      const onSymbol = note.symbols.some((sym) => exactSymbolSet.has(sym));
      const onModule = note.modules.some((mod) => exactModuleSet.has(mod));
      const onTarget = onSymbol || onModule;
      const anchor =
        (onSymbol
          ? note.symbols.find((sym) => exactSymbolSet.has(sym))
          : undefined) ??
        note.modules.find((mod) => allModules.includes(mod)) ??
        note.modules[0] ??
        note.symbols[0] ??
        "";
      const gateTier: "human_confirmed" | "crew_vouched" | "trust_floor" =
        note.confirmed
          ? "human_confirmed"
          : crewChatId && note.chatId === crewChatId
            ? "crew_vouched"
            : "trust_floor";
      injected.push({
        ...note,
        proximity: onTarget ? 1 : neighbourProx,
        onTarget,
        onSymbol,
        injected: true,
        // Coordinates only (D2). The citing message's subject and body never
        // enter this payload; an agent that wants the reviewer's wording calls
        // peer_inbox, which is a boundary it opens itself.
        ...(citedBy ? { citedBy: describeCitation(citedBy) } : {}),
      });
      surfacedIds.add(note.id);
      governedById.set(note.id, note);
      if (opts.injectionLedger && anchor) {
        opts.injectionLedger.record({
          noteId: note.id,
          anchor,
          gateTier,
        });
      }
    }
    // Injected notes lead: they are the push answer to "what would I never ask?".
    // Within the injected set, keep on-symbol > on-module > neighbour.
    injected.sort((a, b) => {
      // A cited finding outranks proximity: a peer telling you about THIS
      // radius right now beats a standing note that merely sits on it.
      const cited = (m: PreEditMemory) => (m.citedBy ? 0 : 1);
      if (cited(a) !== cited(b)) return cited(a) - cited(b);
      const tier = (m: PreEditMemory) => (m.onSymbol ? 0 : m.onTarget ? 1 : 2);
      return tier(a) - tier(b);
    });
    memories.unshift(...injected);
  }

  // --- 4. warnings + pending proposals (existence + IDs ONLY, no note text) ---
  const warnings: PreEditWarning[] = [];
  const seenWarn = new Set<string>();
  const addWarn = (warning: PreEditWarning) => {
    const key = `${warning.kind}:${warning.noteId}:${warning.relatedNoteId}`;
    if (!seenWarn.has(key)) {
      seenWarn.add(key);
      warnings.push(warning);
    }
  };

  // 4a. CONTRADICTS / PROPOSES_SUPERSEDE that touch a SURFACED governed note.
  for (const memory of memories) {
    for (const other of await graph.contradictionsOf(memory.id)) {
      addWarn({
        kind: "contradicts",
        noteId: memory.id,
        relatedNoteId: other,
        detail:
          "A surfaced memory contradicts another memory on the same anchor.",
      });
    }
    if (memory.conflictsWith) {
      addWarn({
        kind: "contradicts",
        noteId: memory.id,
        relatedNoteId: memory.conflictsWith,
        detail: "A surfaced memory is flagged as contradicting another memory.",
      });
    }
    for (const victim of await graph.proposedSupersedesOf(memory.id)) {
      addWarn({
        kind: "proposes_supersede",
        noteId: memory.id,
        relatedNoteId: victim,
        detail:
          "A surfaced memory proposes to supersede another memory, pending human confirmation.",
      });
    }
  }

  // 4b. Unresolved PROPOSES_SUPERSEDE anchored to the radius → pendingProposals so
  // the human can act via the EXISTING KG-6 confirm route. The proposing note is
  // UNCONFIRMED (invisible to the gate), so a GENERAL (non-gated) recall reaches it
  //, but ONLY its id/anchors are surfaced, NEVER its (attacker-controlled) text.
  //
  // D6: one batched query here too, for the same reason and with the same row set
  // — this arm was the OTHER half of the ≥257 round trips.
  const pendingProposals: PreEditPendingProposal[] = [];
  const seenProposal = new Set<string>();
  const generalById = new Map<string, MemoryNoteRecord>();
  const generalNotes = await graph.recallMemory(
    {
      modules: allModules,
      asOf: opts.asOf,
      scope: opts.scope,
      chatId: opts.chatId,
      workspacePath: opts.workspacePath,
      unscopedWorkspace: opts.unscopedWorkspace,
    },
    anchorRowBudget(limit, allModules.length)
  );

  // D14: the same UNGATED recall for the exact-target SYMBOL anchors, run ONLY
  // to count coverage. It answers the question §0 is about — "we asked about
  // symbol X and the index carries nothing under it at all" — which the GATED
  // symbol result cannot answer, because there a symbol that resolves to an
  // unconfirmed note is indistinguishable from a symbol nothing is anchored to.
  //
  // Deliberately NOT merged into `generalById`: that set drives
  // `pendingProposals`, and widening it here would change OUTPUT, not just
  // reporting. It stays a SEPARATE query from the batched module recall above for
  // the same reason plus one more: a throw here marks the symbol anchors UNREADABLE
  // (→ `index_unavailable`) rather than failing the gate, and folding it into the
  // module arm would extend that best-effort posture over a read that today
  // propagates. `exactSymbolSet` holds at most the one target symbol (every member
  // equals `target.symbol` by construction above), so this is +1 query when a
  // symbol was supplied and ZERO when it was not — batched over the whole set, so
  // it stays +1 if that ever grows.
  let unreadableAnchors = 0;
  const symbolCandidates: MemoryNoteRecord[] | null =
    exactSymbols.length === 0
      ? []
      : await graph
          .recallMemory(
            {
              symbols: exactSymbols,
              asOf: opts.asOf,
              scope: opts.scope,
              chatId: opts.chatId,
              workspacePath: opts.workspacePath,
              unscopedWorkspace: opts.unscopedWorkspace,
            },
            anchorRowBudget(limit, exactSymbols.length)
          )
          .catch(() => {
            // Every symbol anchor is unreadable, not just one: they were asked for
            // in ONE query, so the store either answered for all of them or none.
            unreadableAnchors += exactSymbols.length;
            return null;
          });

  for (const note of generalNotes) {
    if (!generalById.has(note.id)) {
      generalById.set(note.id, note);
    }
  }
  for (const note of generalById.values()) {
    for (const victimId of await graph.proposedSupersedesOf(note.id)) {
      const key = `${note.id}:${victimId}`;
      if (seenProposal.has(key)) {
        continue;
      }
      seenProposal.add(key);
      pendingProposals.push({
        proposalNoteId: note.id,
        victimNoteId: victimId,
        modules: note.modules.filter((mod) => allModules.includes(mod)),
        detail:
          "An unconfirmed proposal contests a memory on the edit radius, a human must confirm or drop it.",
      });
      addWarn({
        kind: "proposes_supersede",
        noteId: note.id,
        relatedNoteId: victimId,
        detail:
          "An unconfirmed proposal contests a memory on the edit radius, needs human confirmation.",
      });
    }
    for (const other of await graph.contradictionsOf(note.id)) {
      if (governedById.has(other)) {
        addWarn({
          kind: "contradicts",
          noteId: note.id,
          relatedNoteId: other,
          detail:
            "A memory on the edit radius contradicts a surfaced governed memory.",
        });
      }
    }
  }

  // --- 5. KG-7 + KG-8 (ADR-0014): cross-agent activity (live + recent) ---------
  // A SIBLING channel, computed AFTER memories and entirely independent of them,
  // so `memories[]` is byte-for-byte identical whether or not a reader is present
  // (invariant #3 no-regression). Join the SAME resolved anchors (exact target
  // symbols + all radius modules) the memory fan-out used, excluding the caller's
  // own task/job so a lane never reports ITSELF (#5). The reader fuses LIVE
  // (present tense) and RECENT (KG-8, past tense, the bounded `ACTED_ON` window)
  // onto this one channel. Coordinates only: the reader selects allowlisted columns
  // and returns no note/brief/message text. Best-effort and degrade-to-empty: no
  // reader, no running job, no anchor match, or ANY reader error → `[]` → today's
  // hero exactly (no new hard dependency, no network).
  let activity: PreEditActivity[] = [];
  if (opts.activityReader) {
    // try/catch (not just `.catch`) so a SYNCHRONOUS throw in a future non-async
    // reader also degrades to [] rather than 500ing the gate. Pass a COPY of
    // `allModules`, it is also the returned `blastRadius.modules`, so a reader
    // must never be able to mutate the response through its argument.
    let raw: PreEditActivity[] = [];
    try {
      raw = await opts.activityReader(
        {
          // ADR-0015 R3: the exact target symbol(s) AND the CG-1 referencer symbols,
          // so a lane editing a symbol that references the target surfaces. The
          // tiering below classifies referencers as neighbours automatically.
          symbols: uniq([...exactSymbolSet, ...referencerSymbols]),
          modules: [...allModules],
        },
        { taskId: opts.excludeTaskId, jobId: opts.excludeJobId }
      );
    } catch {
      raw = [];
    }

    // KG-9 (ADR-0014 §6), TIER each entry by PROXIMITY, exactly mirroring the
    // `memories[]` tiering (on-symbol > on-target-module > neighbour). The reader
    // returns coordinates (`anchor` + `anchorKind`); the HERO owns the tier because
    // it holds the exact target sets. Test the entry's `anchor` against those SAME
    // sets the memory fan-out used, no new closure, no new anchors, no new content:
    //   - onSymbol  = the anchor IS the exact target symbol (ADR-0012 finest tier);
    //   - onTarget  = onSymbol OR the anchor is an exact target module (top tier);
    //   - proximity = 1 on-target, else the blast-radius neighbour value (DISPLAY).
    // `neighbourProx` is the SAME depth-weighted value the memory tier uses, so the
    // activity and memory surfaces agree on what "neighbour" means.
    const tagged: PreEditActivity[] = raw.map((entry) => {
      const onSymbol = exactSymbolSet.has(entry.anchor);
      const onTarget = onSymbol || exactModuleSet.has(entry.anchor);
      return {
        ...entry,
        onSymbol,
        onTarget,
        proximity: onTarget ? 1 : neighbourProx,
      };
    });

    // Order: HARD TIER first (on-symbol > on-target-module > neighbour, "a lane is
    // on your EXACT symbol" outranks "a lane is somewhere in your blast radius"),
    // THEN `state` (live before recent, a present-tense collision is the most
    // time-sensitive signal), THEN `at` DESC (most-recent touch first). The tier is
    // the PRIMARY key, mirroring how `memories[]` puts proximity above governance.
    // Never ranked into / merged with `memories`.
    const tierRank = (a: PreEditActivity): number =>
      a.onSymbol ? 0 : a.onTarget ? 1 : 2;
    const stateRank: Record<PreEditActivity["state"], number> = {
      live: 0,
      recent: 1,
    };
    activity = tagged.slice().sort((a, b) => {
      const tierDelta = tierRank(a) - tierRank(b);
      if (tierDelta !== 0) {
        return tierDelta;
      }
      if (a.state !== b.state) {
        return stateRank[a.state] - stateRank[b.state];
      }
      return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
    });
  }

  // --- 6. KG-10 (ADR-0014 §5): DUPLICATE-WORK (optional dense enrichment) -------
  // A DISTINCT sibling channel, computed independently of `memories[]` AND
  // `activity[]`, so both are byte-for-byte identical whether or not a dup-work
  // reader is present (no-regression). Unlike activity, dup-work is NOT anchor-
  // based: it compares the caller's declared brief against every OTHER live lane's
  // brief by embedding similarity, so the reader takes only the caller's own ids
  // (to resolve + self-exclude the caller). COORDINATES ONLY: the reader reads a
  // brief solely to embed it and returns a similarity SCALAR + ids, never the
  // text or the vector. Best-effort and degrade-to-empty: no reader, no embedder,
  // <2 running jobs, or ANY reader error/timeout → `[]` → today's hero exactly (no
  // embed work, no network). try/catch (not just `.catch`) so a synchronous throw
  // in a future non-async reader also degrades rather than 500ing the gate.
  let duplicateWork: PreEditDuplicateWork[] = [];
  if (opts.duplicateWorkReader) {
    try {
      duplicateWork = await opts.duplicateWorkReader({
        taskId: opts.excludeTaskId,
        jobId: opts.excludeJobId,
      });
    } catch {
      duplicateWork = [];
    }
  }

  // Surface the on-target symbol in the radius echo (so the human/agent surface
  // shows what the on-symbol tier fused on). Absent a target symbol, this is the
  // raw radius symbols, unchanged from today (may be undefined).
  const symbols =
    exactSymbolSet.size > 0
      ? uniq([...(radiusSymbols ?? []), ...exactSymbolSet])
      : radiusSymbols;

  // --- 7. D14 COVERAGE: report how the gate LOOKED ----------------------------
  // Computed LAST, from what the steps above already fetched, and read by
  // NOTHING above it. `memories` / `warnings` / `pendingProposals` / `activity` /
  // `duplicateWork` are all finished; this block cannot move a note into or out
  // of any of them. That ordering IS the D14-C rejection in code: there is no
  // point in this function where a zero coverage could relax an admission.
  //
  // An anchor "RESOLVED" when it matched at least one note in scope — gated OR
  // ungated. Both legs matter: ungated alone would call an anchor unresolved
  // when the gate's in-query LIMIT let an old confirmed note through that the
  // newer ungated rows crowded out, and gated alone would call an anchor
  // unresolved whenever everything under it is merely unconfirmed, which is the
  // exact lie D14 exists to kill.
  //
  // D6 changed HOW an anchor's resolution is counted, not WHAT counts. The
  // per-anchor fan-out answered "did anchor i resolve?" with the emptiness of
  // result array i; one batched query has no per-anchor array, so resolution is
  // read back off each returned note's own `modules`/`symbols` — the AUTHORITY
  // arrays the batched anchor term is the edge-side mirror of. Equivalent by
  // construction: a note is in the answer because it carries one of the requested
  // anchors, and the only anchors it can contribute are the ones in those arrays.
  const consideredIds = new Set<string>(governedById.keys());
  for (const note of generalNotes) {
    consideredIds.add(note.id);
  }
  for (const note of symbolCandidates ?? []) {
    consideredIds.add(note.id);
  }
  const modulesResolved = resolvedAnchors(
    allModules,
    [generalNotes, gatedNotes],
    (note) => note.modules
  );
  const symbolsResolved = resolvedAnchors(
    exactSymbols,
    [symbolCandidates ?? [], gatedNotes],
    (note) => note.symbols
  );
  const coverage = tallyGateCoverage(
    {
      anchors: {
        // Post-cap: what the gate actually fanned out over, which is exactly
        // `blastRadius.modules` below, so a caller can see the MAX_ANCHOR_MODULES
        // slice by comparing it with what it sent.
        modules: { requested: allModules.length, resolved: modulesResolved },
        symbols: { requested: exactSymbols.length, resolved: symbolsResolved },
        unreadable: unreadableAnchors,
      },
      notes: { considered: consideredIds.size, admitted: 0, surfaced: 0 },
      admittedBy: { humanConfirmed: 0, crewVouched: 0, trustFloor: 0 },
      // The #133 crew tier is engaged iff the gate was actually given a
      // crewChatId — the one fact that makes "0 for the human, N for an agent in
      // the same chat" readable instead of looking like an empty brain.
      crewChat: crewChatId !== undefined,
    },
    memories,
    { trustFloor: opts.trustFloor, crewChatId }
  );

  return {
    target,
    blastRadius: { modules: allModules, symbols, depth, source },
    memories,
    warnings,
    pendingProposals,
    activity,
    duplicateWork,
    coverage,
  };
}
