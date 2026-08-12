export type MemoryKind =
  | "decision"
  | "constraint"
  | "convention"
  | "attempt"
  | "question";

/** Substrate §3.4 — structured result of an attempt note. */
export type AttemptOutcome = "worked" | "abandoned" | "superseded" | "unknown";

/** TODO 4.8 / D7 — how a note entered the ledger. NULL = legacy authored. */
export type NoteDerivation = "authored" | "inferred";

/** Operator review stamp, separate from confirm/reject. */
export type NoteReviewStatus = "pending" | "reviewed" | "deferred";

export type MemoryTrust = "low" | "medium" | "high";

/** A provenance principal, the human or agent that authored/confirmed a note
 *  (KG-5). Projected into the graph as a Principal node; AUTHORED_BY / CONFIRMED_BY
 *  edges connect a note to its principals. Derived from MemoryNote.createdBy. */
export type PrincipalKind = "human" | "agent";

export type PrincipalRecord = {
  id: string;
  kind: PrincipalKind;
  displayName: string;
  /** Agent principals: the vendor (claude-code | codex | ...). Null for humans. */
  vendor: string | null;
  trust: MemoryTrust;
  createdAt: string;
};

export type MemoryNoteInput = {
  kind: MemoryKind;
  text: string;
  taskId?: string;
  laneId?: string;
  modules?: string[];
  topics?: string[];
  /** Symbol anchors (ADR-0012): `<module>#<name>` ids. A symbol-anchored note is
   *  ALWAYS also module-anchored (the module is auto-derived from each id prefix
   *  at the ingest boundary), so a module-precise edit still finds it. */
  symbols?: string[];
  trust?: MemoryTrust;
  createdBy: string;
  /** Per-chat partition key (#126): the mission/chat id this note was written
   *  under. Absent/null → a NULL-chat note (legacy / non-chat / team-synced),
   *  chat-private to nobody. A chat-scoped read admits another partition only
   *  when the note is human-confirmed and `scope:"global"`, so ordinary project
   *  memory never leaks across chats. */
  chatId?: string | null;
  /** Per-WORKSPACE partition key (ADR-0026): the canonical absolute repo root
   *  this note's facts are about. DERIVED at the write boundary from the
   *  authenticated `AgentJobCapability.workspacePath` (never from a caller's
   *  claim and never from `MUON_WORKSPACE`, which the runner remaps to the
   *  governed worktree). Absent/null → the §8 residue: an unassigned note, which
   *  no agent read and no pack export may ever see. Partitions BOTH dedup keys,
   *  so the same sentence written in two repos legitimately stays two rows. */
  workspacePath?: string | null;
  /** Visibility scope (KG-5 / D5): private:<p> | lane:<k> | project | global.
   *  Defaults to "project" in v1; hosted/Team mode flips on hard enforcement. */
  scope?: string;
  /** P1.4 pack-import staging: forces every destructive verdict through the
   *  non-destructive KG-6 branches (a confirmed victim gets `related`, an
   *  unconfirmed victim gets `proposes_supersede` + reconcile) — an import can
   *  retire NOTHING. Absent → bit-for-bit existing ingest behavior. */
  proposalOnly?: boolean;
  /** D1 (§D1, option B): coordinates the caller EXPLICITLY declares do not exist
   *  yet, so the ledger marks their anchors `planned` instead of `unresolved`.
   *  Per-coordinate and explicit precisely so a TYPO can never silently become
   *  "planned"; a value naming a file that IS tracked lands `resolved` anyway,
   *  because reality outranks the declaration. Names a module path
   *  (`src/new.ts`) or a symbol id in it (`src/new.ts#build`) — both reduce to the
   *  same file. It can only ever LABEL an anchor the note already carries: it
   *  never mints one, and it is never persisted as text. Absent → every coordinate
   *  is resolved against the tracked-file set alone. Consumed by the LEDGER
   *  (`backend/src/lib/anchor-resolution.ts`); the in-memory graph ignores it. */
  plannedCoordinates?: string[];
  /** Substrate §3.4: structured attempt result. Ignored unless `kind === "attempt"`. */
  outcome?: AttemptOutcome | null;
  /** TODO 4.8 / D7: reserved for derived notes; defaults to NULL (authored). */
  derivation?: NoteDerivation | null;
};

export type MemoryNoteRecord = {
  id: string;
  kind: MemoryKind;
  text: string;
  taskId: string | null;
  laneId: string | null;
  /** Per-chat partition key (#126): the mission/chat id this note was written
   *  under, or null (legacy / non-chat / team-synced). A chat-scoped agent read
   *  sees the matching partition plus confirmed promoted-global notes;
   *  operator-tier reads ignore the partition. */
  chatId?: string | null;
  /** Per-WORKSPACE partition key (ADR-0026): the canonical absolute repo root, or
   *  null for an unassigned (§8 residue) note. Carried on the record so the graph
   *  mirror restores the partition wipe-survivably from the ledger. */
  workspacePath?: string | null;
  modules: string[];
  topics: string[];
  /** Symbol anchors (ADR-0012): `<module>#<name>` ids. Empty for a module-only
   *  note. Restored wipe-survivably from the ledger note column on reproject. */
  symbols: string[];
  trust: MemoryTrust;
  confirmed: boolean;
  stale: boolean;
  /** Operator lifecycle: paused preserves the verdict/provenance but withholds
   * the note from every agent-facing read until it is resumed. */
  status: "active" | "paused" | "rejected";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Temporal validity (Graphiti-inspired): history is never destroyed. */
  validFrom: string;
  /** Bitemporal valid-time end (KG-5). Null = still valid. In v1 (D2) it is set
   *  to the retire timestamp on supersede/reject; valid-time defaults to ingest. */
  validTo?: string | null;
  invalidatedAt: string | null;
  invalidatedBy: string | null;
  /** Visibility scope (KG-5). Defaults to "project"; a first-class, soft-enforced
   *  retrieval dimension in v1 (D5) that hosted mode can hard-gate on later. */
  scope?: string;
  staleSince: string | null;
  supersededBy: string | null;
  /** Usage reinforcement (v3): recalled-and-used notes rise in ranking. */
  accessCount: number;
  lastAccessedAt: string | null;
  /** Set when this note contradicts another on the same anchor (needs human). */
  conflictsWith: string | null;
  /** R3 TTL deadline (ISO-8601), mirrored from the ledger; null/absent = this note
   *  NEVER auto-expires (confirmed / human-authored / high-trust never carry one).
   *  There is deliberately NO `expired` field: hidden-ness is DERIVED from this
   *  deadline plus the never-expire invariants at query time (memory-expiry.ts), so
   *  the graph and the ledger read ONE clock instead of two markers that can drift. */
  expiresAt?: string | null;
  /** Substrate §3.4: null/absent = legacy attempt with no structured outcome. */
  outcome?: AttemptOutcome | null;
  /** TODO 4.8 / D7: null/absent = legacy authored statement. */
  derivation?: NoteDerivation | null;
  /** Operator review stamp; null/absent = no stamp yet. */
  reviewStatus?: NoteReviewStatus | null;
};

/** How a deduped write resolved (mem0-inspired op vocabulary, governed). */
export type MemoryWriteAction =
  | "inserted"
  | "duplicate"
  // TODO 4.9: a strict lexical refinement. Both notes stay active and the
  // durable EXTENDS edge preserves the added detail for human review.
  | "extended"
  | "superseded"
  | "conflict"
  // NON-destructive: a dense-only (lexically-unsupported) high-similarity match.
  // Both notes stay ACTIVE with a "related" edge + a human-reconcile request,
  // dense similarity alone must NEVER silently reject/drop a note (KG-3 F1).
  | "related"
  // GOVERNED, non-destructive (KG-6): a destructive verdict (supersede/duplicate)
  // that the writer is NOT authorized to apply over an UNCONFIRMED higher-trust
  // victim. Both notes stay ACTIVE, a contestable PROPOSES_SUPERSEDE edge is
  // recorded, and a human-reconcile is enqueued, the deferred supersede applies
  // only when a human (or peer-or-higher-trust principal) later confirms it.
  | "proposed";

export type MemoryIngestResult = {
  note: MemoryNoteRecord;
  action: MemoryWriteAction;
  /** For duplicate/superseded/conflict: the prior note involved. */
  relatedNoteId?: string;
};

/**
 * Optional embeddings tier. When an embedder is configured, memory notes
 * gain dense semantic recall (fused with lexical/graph via RRF) and
 * similarity-based dedup. Absent = fully lexical, no external service,
 * MUON stays local-first (docs/research/memory-graph-v3.md).
 */
export type Embedder = {
  /**
   * Stable identifier of the embedding SPACE (the model). Part of the cache key
   * (KG-3 F2) so a model switch is a natural cache MISS, a cached vector from a
   * different model is never cosine-compared against a current-model vector
   * (different spaces sharing dims = garbage similarity).
   */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Optional fast availability check (KG-3 F5). Resolves false once detection
   * has concluded the backend is unreachable, so a caller can skip cache lookups
   * and awaited embeds entirely and stay lexical with no per-ingest cost. Absent
   * → assume available (e.g. a deterministic test fake).
   */
  isAvailable?(): Promise<boolean>;
};

/**
 * Optional durable cache for graph-local embeddings. Implementations own the
 * storage and hashing policy; MuonGraph supplies raw text plus the embedder's
 * stable model id and degrades to direct embedding on any cache failure.
 */
export type EmbeddingCacheStore = {
  get(text: string, model: string): Promise<number[] | undefined>;
  put(text: string, model: string, vector: number[]): Promise<void>;
};

export type MemoryNoteUpdate = {
  confirmed?: boolean;
  text?: string;
  trust?: MemoryTrust;
  status?: "active" | "paused" | "rejected";
  /** The confirming/rejecting principal (KG-6). Threaded through the confirm
   *  route so CONFIRMED_BY points at the ACTUAL confirmer (e.g. "human:carol")
   *  rather than a generic "human". Optional → defaults to the human operator
   *  principal ("human"), so prior callers are unchanged. A confirm ALSO resolves
   *  any PROPOSES_SUPERSEDE this note authored (applies the deferred supersede
   *  when the confirmer is authorized; a reject drops the proposal). */
  principal?: string;
  /** Substrate §3.4: set or clear the structured attempt outcome. */
  outcome?: AttemptOutcome | null;
  /** TODO 4.8: operator review stamp, separate from confirm/reject. */
  reviewStatus?: NoteReviewStatus | null;
  /** TODO 4.8: provenance tier (operator correction only until derivation ships). */
  derivation?: NoteDerivation | null;
};

export type MemoryRecallFilter = {
  taskId?: string;
  laneId?: string;
  /** Per-chat partition key (#126). When set, recall sees that chat plus a
   *  deliberately promoted note only when `scope:"global"` AND human-confirmed.
   *  NULL-chat, ordinary cross-chat, and unconfirmed-global notes stay excluded.
   *  Absent = the operator/global view. */
  chatId?: string;
  /** Per-WORKSPACE partition key (ADR-0026 §5): the canonical absolute repo root
   *  this recall belongs to. A HARD gate in the candidate query, ANDed OUTSIDE the
   *  chat clause's `scope:"global"` admission, so promotion widens a note across
   *  MISSIONS and never across REPOS (§6). Excludes the §8 residue by construction.
   *  DERIVED, never stated by an agent: for the agent tier it comes from
   *  `AgentJobCapability.workspacePath`, for the operator tier from an explicit,
   *  `validateWorkspacePath`-checked parameter. Absent = today's unscoped view,
   *  which is what makes the rollout monotonic.
   *
   *  Deliberately NOT part of `MEMORY_FILTER_FIELDS` (the R5 grammar) in v1: the
   *  partition is derived, not stated, and a field is additive to add later while
   *  removing one is breaking (ADR-0026 §9). */
  workspacePath?: string;
  /** ADR-0026 §8 residue view: return ONLY notes with no workspace assignment, so
   *  an operator can adjudicate them in the same queue they already confirm in.
   *  Operator-tier only — refused for an agent at the route, because the residue is
   *  invisible to every agent read and every pack export. Mutually exclusive with
   *  `workspacePath`; a separate field rather than a reserved path value, so one
   *  value never carries two authorities. */
  unscopedWorkspace?: boolean;
  module?: string;
  /** Symbol anchor filter (ADR-0012): recall notes carrying this `<module>#<name>`
   *  id via `list_contains(n.symbols, $symbol)`, byte-for-byte the module recall
   *  shape, so it inherits the KG-6 gate, as-of, scope, and LIMIT-completeness. */
  symbol?: string;
  topic?: string;
  /** Bitemporal as-of instant (ISO-8601). When set, recall returns the notes the
   *  brain believed active AT that time (validFrom<=T<validTo/∞ AND recordedAt<=T
   *  AND retiredAt>T/∞) instead of the current active set (KG-5). Default = now. */
  asOf?: string;
  /** Scope filter (KG-5 / D5). Soft, when set, restricts to that scope; absent =
   *  all scopes. v1 notes default to "project"; hosted mode can hard-gate later. */
  scope?: string;
  /** GATE view (KG-6). When true, recall returns ONLY governed notes, those that
   *  are human-CONFIRMED (or, when `trustFloor` is set, trust >= floor). This is
   *  the hero's gate-read contract: a hostile low-trust unconfirmed write can
   *  NEVER influence a gate. General recall (absent → false) is unchanged. */
  governedOnly?: boolean;
  /** Optional trust floor for the gate (KG-6). With `governedOnly`, ALSO admits
   *  notes whose trust >= this floor even if not explicitly confirmed. Absent →
   *  confirmed-only (the strictest gate). Ignored unless `governedOnly` is set. */
  trustFloor?: MemoryTrust;
  /** #133 CREW-VISIBLE admission (DISTINCT from human confirmation; it NEVER
   *  mutates the human-only `confirmed` flag). With `governedOnly`, ALSO admits an
   *  UNCONFIRMED note whose `chatId` EQUALS this value, so an agent-authored note
   *  reaches the next agent in the SAME chat automatically. Hard-scoped: a legacy
   *  NULL-chat note (chatId '') and every cross-chat/global note stay human-gated,
   *  and trust is untouched (a `trustFloor:'high'` gate still excludes a 'medium'
   *  agent note — the founder's kill switch). Callers set this to the request's OWN
   *  chatId ONLY; it can never widen beyond a single chat. Ignored unless
   *  `governedOnly` is set; absent → the pre-#133 confirmed-only gate. */
  crewChatId?: string;
  /** R3 TTL (mem0's `show_expired`): include notes past their `expiresAt`. Default
   *  false, i.e. an unconfirmed, low/medium-trust, agent-authored note stops being
   *  recalled once its deadline passes. SERVER-OWNED, like `crewVisible`: it is an
   *  operator opt-in and must never be accepted from an agent body. */
  showExpired?: boolean;
  /** R3 evaluation instant (ISO-8601) for the expiry comparison. Absent = the real
   *  clock; deterministic callers/tests pass it explicitly. Deliberately SEPARATE
   *  from `asOf`: a bitemporal read still hides notes expired NOW, so travelling
   *  back in time can never become a way to read expired memory. */
  now?: string;
  /** Substrate §3.4: restrict recall to one memory kind (e.g. `attempt`). */
  kind?: MemoryKind;
  /** Substrate §3.4: restrict recall to one attempt outcome. */
  outcome?: AttemptOutcome;
};

/**
 * D4, THE ONE CONJUNCTIVE RETRIEVAL REQUEST. `q` is optional, the anchors are
 * optional, and they COMPOSE: the anchors are a HARD FILTER on the candidate
 * query and `q` only ORDERS within it.
 *
 * It is a strict SUPERSET of `MemoryRecallFilter`, which is what lets
 * `recallMemory`, `recallForGate` and `searchMemory` stay thin, backward-
 * compatible façades over `retrieveMemory` — `{ module: X }` normalizes to
 * `{ modules: [X] }` and asks the same one-anchor question it always did, and a
 * request with no anchors and no `q` is the pre-D4 unfenced recall byte for byte.
 *
 * The four states are all meaningful, and the fourth is the one the product is
 * about: anchors-only = "everything we know about this file" (today's `/recall`),
 * `q`-only = "search the brain" (today's `/search`), neither = the recent set,
 * BOTH = "what do we know about this file that is relevant to THIS edit".
 */
export type MemoryRetrievalRequest = MemoryRecallFilter & {
  /** Free-text query. Absent → the candidate set is ordered by `createdAt DESC`
   *  (recall); present → the hybrid FTS/lexical/entity/dense arms rank WITHIN the
   *  anchored candidate set (search). It is never a filter of its own on the
   *  anchored path: an anchor the text does not mention is still in the answer,
   *  ranked lower. */
  q?: string;
  /** Batched MODULE anchors (D6). Unions with the singular `module`. One query
   *  regardless of how many are supplied — the whole point of the decision. */
  modules?: string[];
  /** Batched SYMBOL anchors (D6, ADR-0012), unioned with the singular `symbol`.
   *  OR'd with `modules` in the candidate query, exactly as the fan-out this
   *  replaces merged its per-module and per-symbol recalls by id. */
  symbols?: string[];
};

/** B1/B2 bounded memory-graph traversal. These are the only relationship
 * tables an agent-facing traversal may expose. Every value is a fixed enum;
 * callers can filter the set but can never inject a relationship name into a
 * graph query. */
export type MemoryGraphRelation =
  | "SUPERSEDES"
  | "EXTENDS"
  | "CONTRADICTS"
  | "AUTHORED_BY"
  | "CONFIRMED_BY"
  | "ANCHORED_TO"
  | "ABOUT_SYMBOL"
  | "ABOUT_TASK"
  | "BY_LANE"
  | "TOUCHED"
  | "WORKED_ON"
  | "GATED_BY"
  | "CLONED_FROM";

export type MemoryGraphNodeType =
  | "note"
  | "principal"
  | "module"
  | "symbol"
  | "task"
  | "lane"
  | "approval";

/**
 * Agent-safe traversal node. The allowlist is intentionally small:
 * task titles, approval reasons, lane names, principal display names, event
 * messages, and every other free-form/content-bearing field are absent.
 *
 * `text` is the ONLY content-bearing field and is optional by construction.
 * It is present only under {@link MEMORY_TRAVERSAL_TEXT_POLICY}. An
 * unconfirmed/cross-chat note can therefore never smuggle prose through a
 * sibling field.
 */
export type MemoryGraphNode = {
  /** Collision-proof traversal id (`note:<id>`, `module:<path>`, ...). */
  id: string;
  /** Original entity id/path, a coordinate only. */
  entityId: string;
  type: MemoryGraphNodeType;
  kind?: string;
  trust?: MemoryTrust;
  confirmed?: boolean;
  status?: string;
  vendor?: string | null;
  module?: string;
  name?: string;
  text?: string;
  textTruncated?: boolean;
};

export type MemoryGraphEdge = {
  from: string;
  to: string;
  relation: MemoryGraphRelation;
};

/**
 * The rule that decided whether a traversal node carries `text`, stated on the
 * wire so a consumer never has to guess why prose was or was not returned.
 *
 * Read it as: **confirmed, OR crew-visible that is also unexpired** — the exact
 * predicate `memoryTraversalNode` evaluates:
 *
 *   text ⇔ note.confirmed
 *          OR (crewVisible AND same-chat AND NOT expired)
 *
 * The `unexpired` qualifier is why the older `confirmed-or-crew-visible` label
 * became false: R3 TTL withholds a lapsed unconfirmed note's text (redeemed by a
 * human confirm). A confirmed note is never expired, so the first branch needs no
 * qualifier. AUTHORSHIP is deliberately absent: the crew branch admits every
 * agent author the chat has, model-mined prose included, because the operator's
 * `autoConfirmAgentMemory` posture is the single thing that decides whether
 * unconfirmed agent memory reaches the crew (it is what sets `crewVisible`).
 * The label carried `unmined` while F9 hard-excluded the LLM extractor; that
 * exclusion is gone, so the label lost the qualifier with it.
 *
 * Kept a CLOSED union deliberately: changing the policy must be a compile error
 * at every consumer (@muon/client mirrors this literal, the desktop and MCP read
 * it through that mirror), never a silently different string on the wire.
 */
export const MEMORY_TRAVERSAL_TEXT_POLICY =
  "confirmed-or-unexpired-crew-visible" as const;

export type MemoryTraversalTextPolicy = typeof MEMORY_TRAVERSAL_TEXT_POLICY;

export type MemoryTraversalProvenance = {
  root: string;
  hops: number;
  relations: MemoryGraphRelation[];
  truncated: boolean;
  textPolicy: MemoryTraversalTextPolicy;
};

export type MemoryNeighborsOptions = {
  /** Public B1 traversal is capped to 1..3 hops. */
  hops?: number;
  relFilter?: MemoryGraphRelation[];
  /** Maximum returned nodes. Edges are bounded to 4× this value. */
  limit?: number;
  /** Agent reads are hard-partitioned to this chat. */
  chatId?: string;
  /** ADR-0026: and to this WORKSPACE. A provenance walk is a read like any other —
   *  a note whose coordinates a caller may not see must not become visible by being
   *  one hop from a note it may. Applied in `memoryTraversalNode`, the ONE place
   *  traversal nodes acquire fields, so completeness is by construction. */
  workspacePath?: string;
  /** ADR-0026 §8 residue view (operator-only). */
  unscopedWorkspace?: boolean;
  /** Server-owned operator setting; never accepted from an agent body. */
  crewVisible?: boolean;
};

export type MemoryNeighborsResult = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  provenance: MemoryTraversalProvenance;
};

export type MemoryExplainResult = {
  noteId: string;
  path: {
    nodes: MemoryGraphNode[];
    edges: MemoryGraphEdge[];
    goal: "approval" | "principal" | "task" | "anchor" | "note" | "missing";
  };
  contradictions: MemoryGraphNode[];
  provenance: MemoryTraversalProvenance;
};

/**
 * KG-7 (ADR-0014), a CROSS-AGENT ACTIVITY coordinate: which OTHER live lane is
 * currently working on the edit target's symbol/module. The hero surfaces these
 * as a sibling `activity[]` channel so a lane learns, PRE-EDIT, that a peer is
 * already in its code (the "present tense" the confirmed-only memory gate lacks).
 *
 * COORDINATES, NEVER CONTENT (the brain-gate side-channel invariant): every field
 * here is a non-content-bearing coordinate, lane/vendor/task/job IDs, the shared
 * `anchor` (a symbol id or module path), a fixed `kind` enum, a timestamp, and a
 * `state`. It carries NO `Event.message`, NO `DispatchJob.brief`, NO note text and
 * NO free-form string. Activity is agent-authored ⇒ untrusted ⇒ it is a distinct
 * channel that can NEVER become a `MemoryNote`, enter `recallForGate`, or be
 * confirmed, exactly the `pendingProposals` omission discipline applied to the
 * live working-set. A reader that selects ONLY the allowlisted columns is what
 * upholds this at the source.
 */
export type PreEditActivity = {
  /** The lane that is live on the anchor (from the touching Event's lane). */
  laneId: string;
  /** The vendor of the live job (claude-code | codex | cursor), a coordinate. */
  vendor: string;
  /** The peer's task id (BY REFERENCE only, never its title/description). */
  taskId: string;
  /** The peer's running DispatchJob id (BY REFERENCE only, never its brief). */
  jobId: string;
  /** Fixed enum, a symbol-anchored declaration is "editing", a module touch is
   *  "running". Never a free-form string. */
  kind: "running" | "editing";
  /** The SHARED anchor the collision is on: a `<module>#<symbol>` id or a module
   *  path string, the same `<module>#<symbol>` namespace the hero fuses on. */
  anchor: string;
  /** Whether `anchor` is a symbol id or a module path. */
  anchorKind: "symbol" | "module";
  /** ISO timestamp of the touching Event (transaction time), a coordinate. */
  at: string;
  /** The tense of the collision, a fixed enum, never free-form. KG-7 `"live"` =
   *  a currently-running peer job (present tense, joined off `DispatchJob(running)`
   *  + the Event log). KG-8 `"recent"` = a peer task that touched this anchor within
   *  the bounded recent window (past tense), read from the rebuildable `ACTED_ON`
   *  projection over the append-only Event log. The hero surfaces both on ONE
   *  channel, `live` always ordered before `recent`. */
  state: "live" | "recent";
  /**
   * KG-9 (ADR-0014 §6), PROXIMITY TIER, mirroring `PreEditMemory`. The activity
   * READER returns pure coordinates and leaves these UNSET; the pre-edit HERO
   * (`preEditContext`) TAGS each returned entry by testing its `anchor` against the
   * exact target sets it already holds, so "a lane is on your EXACT symbol" outranks
   * "a lane is editing something in your reverse-import closure". Coordinates only,
   * these are booleans/a number derived purely from anchor-set membership; no new
   * content, no new external input.
   *
   * `onSymbol`, the entry's `anchor` is the exact target SYMBOL (ADR-0012, finest
   * tier). Absent a target symbol this is always false. */
  onSymbol?: boolean;
  /** `onTarget`, the `anchor` is the exact target symbol OR an exact target MODULE
   *  (`onSymbol || on-target-module`), the top tier, strictly above every neighbour. */
  onTarget?: boolean;
  /** DISPLAY value: 1 when `onTarget`, else the blast-radius neighbour proximity
   *  (< 1, depth-weighted). Ranking uses the hard tiers (`onSymbol` > `onTarget`-
   *  module > neighbour), never this number. */
  proximity?: number;
};

/**
 * KG-10 (ADR-0014 §5 Embeddings / §6), a DUPLICATE-WORK coordinate: another
 * currently-LIVE lane whose declared task brief is a SEMANTIC PARAPHRASE of the
 * caller's brief (cosine of the two briefs' KG-3 embeddings >= a threshold). The
 * hero surfaces these on a DISTINCT sibling channel (`duplicateWork[]`, NOT the
 * anchor-tiered `activity[]`, because duplicate-work is brief-similarity, not
 * anchor-based) so a lane learns, PRE-EDIT, that a peer is already doing the same
 * work, the ADR's OPTIONAL dense enrichment.
 *
 * COORDINATES, NEVER CONTENT (the brain-gate side-channel invariant + the KG-7/8
 * discipline). The brief TEXT is read ONLY to derive the embedding, it is NEVER
 * surfaced. The ONLY thing that flows out is a similarity SCALAR plus ids: no
 * brief text, no embedding vector, no message, ever. Deriving a scalar from
 * content is fine; surfacing the content is not. Like `PreEditActivity`, this is
 * agent-authored ⇒ untrusted ⇒ it can NEVER become a `MemoryNote`, enter
 * `recallForGate`, or be confirmed. A reader that reads `brief` ONLY to embed and
 * returns ONLY these fields is what upholds this at the source, pinned by a
 * side-channel audit test that feeds a poison brief and asserts no substring of
 * any brief appears in the serialized output.
 */
export type PreEditDuplicateWork = {
  /** The peer's running DispatchJob id (BY REFERENCE only, never its brief). */
  jobId: string;
  /** The peer's task id (BY REFERENCE only, never its title/description). */
  taskId: string;
  /** The vendor of the peer's live job (claude-code | codex | cursor). */
  vendor: string;
  /** Cosine similarity of the two briefs' embeddings, ROUNDED, a coordinate,
   *  never the text. The scalar is derived from content but carries none of it. */
  similarity: number;
  /** Duplicate-work is only over currently-running jobs, so always `"live"`. */
  state: "live";
};

export type LaneOutcomeStats = {
  laneId: string;
  laneKey: string;
  laneName: string;
  assignments: number;
  completions: number;
  blocked: number;
  averageDurationMs: number | null;
  lastActivityAt: string | null;
  /** Distinct modules this lane's tasks have touched. */
  modulesTouched?: number;
  /** Overlap with the target task's modules (when ranking for a task). */
  familiarModules?: number;
  /** Note topics of this lane matching the request text (pre-task routing). */
  topicMatches?: number;
};

export type LaneSuggestion = {
  laneId: string;
  laneKey: string;
  laneName: string;
  score: number;
  reason: string;
};
