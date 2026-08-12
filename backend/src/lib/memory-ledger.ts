import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type MemoryNote as MemoryNoteRow,
  type Principal as PrincipalRow,
} from "@prisma/client";
import {
  authorizesDestructiveWrite,
  classifyIncomingNote,
  deriveModulesFromSymbols,
  trustRank,
  type MemoryIngestResult,
  type MemoryNoteInput,
  type MemoryNoteRecord,
  type MemoryNoteUpdate,
  type MemoryTrust,
  type MuonGraph,
  type NoteDerivation,
  type NoteReviewStatus,
  type PrincipalRecord,
} from "@muon/graph";
import {
  evaluateMemoryIngestPolicy,
  isAttemptOutcome,
  isNoteDerivation,
  isNoteReviewStatus,
  lifecycleDaysForKind,
  matchesMemoryFilter,
  normalizeNoteDerivation,
  parseMemoryLifecyclePolicy,
  type MemoryFilter,
  type MemoryFilterRecord,
  type MemoryIngestPolicy,
  type MemoryLifecycleKind,
  type MemoryLifecyclePolicy,
  type MemoryLibraryOrderBy,
} from "@muon/protocol";
import {
  promoteResolvedPathEntities,
  successorModules,
} from "./anchor-promotion.js";
import { GATE_READ_EVENT_KIND } from "./gate-telemetry.js";
import { MEMORY_INJECTED_EVENT_KIND } from "./injection-telemetry.js";
import {
  coordinateResolverFor,
  resolutionOf,
  type CoordinateResolver,
  type MemoryAnchorResolution,
} from "./anchor-resolution.js";
import { prisma } from "./db.js";
import {
  awaitGraphMirrors,
  getEmbedder,
  getGraph,
  mirrorToGraph,
  mirrorToGraphNow,
  reportMirrorFailure,
  GRAPH_MIRROR_FAILED_EVENT_KIND,
} from "./graph.js";
import {
  getAutoConfirmAgentMemory,
  getMemoryLifecyclePolicy,
  getMemoryIngestPolicy,
  MEMORY_LIFECYCLE_POLICY_KEY,
} from "./operator-settings.js";
import { repoRootOf } from "./workspace-identity.js";

// ── The write-actor (ADR-0009 §2.3 / KG-2) ──────────────────────────────────
//
// A SINGLE in-process async mutex serializes the ingest read-modify-write
// critical section (anchorScopedCandidates → classifyIncomingNote → insert /
// supersede / conflict). The backend is single-process (ADR-0008), so an
// in-process queue is sufficient and closes the TOCTOU where two concurrent
// ingests both read "no duplicate" and both insert, or two supersedes race and
// one supersede link is lost. Every mutating ledger path (ingest AND the
// text-edit supersede in updateMemoryNote) runs through `runExclusive`, so no
// two read-modify-write sections can ever interleave.
let writeActorQueue: Promise<unknown> = Promise.resolve();
const MEMORY_TOMBSTONE_TEXT = "";
const MAX_MEMORY_COMPACTION_BATCH = 500;
/** Bounded work per sweeper run: one pass never scans or writes more than this,
 *  so the sweep is a short, predictable transaction even on a huge brain. */
const MAX_MEMORY_EXPIRY_SWEEP_BATCH = 500;
/**
 * Rows the operator library reads per round trip while resolving DERIVED state.
 * Deliberately BELOW the SQLite connector's 999-parameter `IN` chunking
 * threshold: a chunked query applies `take` to EACH chunk, so any query that
 * combines a caller-sized `IN` list with a `take` silently returns a MULTIPLE of
 * the requested page (measured: IN(2500) + take:200 → 600 rows, missing the
 * newest). Nothing in this file may pair the two again.
 */
const MEMORY_LIBRARY_SCAN_PAGE = 500;

/** Hard ceiling on rows ONE library read will inspect while resolving derived
 *  state, so even the operator tier cannot turn this into an unbounded scan.
 *  The RETURNED PAGE is unaffected by it (the scan runs newest-first, so the
 *  page is filled long before the ceiling); it bounds only how far `total` can
 *  count, and a read that hits it says so via `totalExact: false` rather than
 *  reporting a silently wrong number. */
const MAX_MEMORY_LIBRARY_SCAN = 20_000;

/** The library's ONE total order. `updatedAt` alone is not a total order, so the
 *  `id` tiebreak is what makes the keyset cursor below skip exactly the rows
 *  already seen — no duplicates across pages, no rows stepped over. */
const MEMORY_LIBRARY_ORDER: Prisma.MemoryNoteOrderByWithRelationInput[] = [
  { updatedAt: "desc" },
  { id: "asc" },
];
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * How long a write may WAIT on its own graph projection before giving up on
 * waiting (not on the projection).
 *
 * The text-edit path awaits its mirror so an edit never leaves the gate seeing
 * NEITHER the predecessor nor the successor (ADR-0049; measured ~20ms in
 * practice). But that await sits inside `runExclusive`, the single write-actor
 * queue every memory write passes through — ingest, edit, sweep, compaction.
 * Unbounded, one slow or hung graph would stall every memory write on the
 * machine instead of degrading one best-effort projection.
 *
 * So the wait is bounded and the projection is NOT cancelled: past the
 * deadline this returns and the chain keeps running exactly as the old
 * fire-and-forget mirror did. The worst case is therefore no worse than the
 * behaviour this replaced, and the normal case still closes the window.
 */
const MIRROR_AWAIT_BUDGET_MS = 2_000;

function awaitMirrorBounded(mirror: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, MIRROR_AWAIT_BUDGET_MS);
    timer.unref?.();
    void mirror.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runExclusive<T>(critical: () => Promise<T>): Promise<T> {
  // Chain onto the tail regardless of whether the prior task resolved or
  // rejected, so one failed write never deadlocks or poisons the queue.
  const result = writeActorQueue.then(critical, critical);
  writeActorQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isLedgerTombstone(
  row: Pick<MemoryNoteRow, "text" | "status" | "retiredAt">,
): boolean {
  return (
    row.text === MEMORY_TOMBSTONE_TEXT &&
    row.status === "rejected" &&
    row.retiredAt !== null
  );
}

// ── The durable memory ledger (ADR-0009 Slice 1 / KG-1) ─────────────────────
//
// The relational tables (MemoryNote/MemoryEdge/Episode/Confirmation) are the
// SOURCE OF TRUTH for memory. The embedded LadybugDB graph is a REBUILDABLE
// projection. Every write here is ledger-first (durable) then mirrored to the
// graph (best-effort). `projectLedgerToGraph()` replays the ledger into a fresh
// graph on boot, so a `STORE_VERSION` bump / corrupt-store recovery can never
// destroy a human-confirmed memory. Reads (search/recall) still come from the
// graph projection (routes/memory.ts), the note shape stays a superset of
// MemoryNoteRecord so surfaces don't break.

/** Normalize before hashing so trivial whitespace/case differences collapse. */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function textHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}

/**
 * P1.4 memory packs: the ledger's EXACT normalize+sha256 text identity, exported
 * additively so pack content-addressing (the confirmation⇔content binding in
 * lib/memory-pack.ts) and ledger dedup identity can never drift apart. A pure
 * re-export of the private {@link textHash}; nothing else changes.
 */
export function computeMemoryTextHash(text: string): string {
  return textHash(text);
}

function asStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

/**
 * ADR-0012 module auto-derivation (the degrade guarantee): a symbol-anchored note
 * is ALWAYS also module-anchored, union each symbol id's module prefix (via the
 * `moduleOfSymbol` split, whose namespace correctness rides `toWorkspaceRelativePosix`)
 * into the note's module set (idempotent). So a module-precise edit still finds a
 * symbol-anchored note; a symbol-precise edit finds it AND ranks it higher.
 */
function effectiveModules(input: {
  modules?: string[];
  symbols?: string[];
}): string[] {
  return [
    ...new Set([
      ...(input.modules ?? []),
      ...deriveModulesFromSymbols(input.symbols ?? []),
    ]),
  ];
}

// ── Provenance principals (KG-5) ─────────────────────────────────────────────
//
// Every note carries a `createdBy` string; a Principal (the human/agent behind
// it) is UPSERTED from it on ingest and the note is linked (AUTHORED_BY in the
// graph). The Principal ledger row is the source of truth; the graph node/edges
// are a rebuildable projection. A note's trust DERIVES from its author's trust
// unless explicitly overridden, the hook KG-6's governed writes gate on.

type ParsedPrincipal = {
  id: string;
  kind: "human" | "agent";
  displayName: string;
  vendor: string | null;
  trust: MemoryTrust;
};

/** Deterministic slug so the SAME author always maps to the SAME Principal id
 *  (one row per author; a wipe+reproject re-derives the identical id). */
function slugifyPrincipal(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

/**
 * Parse `MemoryNote.createdBy` / `Confirmation.principal` into a provenance
 * Principal (KG-5). Accepts the explicit `human:<id>` / `agent:<vendor>`
 * convention AND the bare legacy form already in the ledger: "human" → the human
 * principal; any other bare string ("codex", "muon-capture", …) → an AGENT whose
 * vendor IS that string. Default trust DERIVES from kind, a human outranks an
 * agent, which becomes the note's trust unless the note overrides it.
 */
function parsePrincipal(raw: string): ParsedPrincipal {
  const s = (raw ?? "").trim();
  const colon = s.indexOf(":");
  let kind: "human" | "agent";
  let identity: string;
  let vendor: string | null;
  if (colon > 0) {
    const prefix = s.slice(0, colon).toLowerCase();
    const rest = s.slice(colon + 1).trim();
    if (prefix === "human") {
      kind = "human";
      identity = rest || "human";
      vendor = null;
    } else if (prefix === "agent") {
      kind = "agent";
      identity = rest || "agent";
      vendor = identity;
    } else {
      // Unknown prefix, treat the whole string as an agent vendor.
      kind = "agent";
      identity = s;
      vendor = s;
    }
  } else if (s === "" || s.toLowerCase() === "human") {
    kind = "human";
    identity = "human";
    vendor = null;
  } else {
    kind = "agent";
    identity = s;
    vendor = s;
  }
  return {
    id: `principal-${kind}-${slugifyPrincipal(identity)}`,
    kind,
    displayName: identity,
    vendor,
    trust: kind === "human" ? "high" : "medium",
  };
}

/** Upsert op for a Principal (composed into the ledger-first $transaction so the
 *  author lands atomically with the note). Create seeds the kind-default trust;
 *  update refreshes the label but NEVER overwrites trust (a human may have
 *  adjusted it, and KG-6 will gate on that authoritative value). */
function principalUpsertOp(
  parsed: ParsedPrincipal,
): Prisma.PrismaPromise<unknown> {
  return prisma.principal.upsert({
    where: { id: parsed.id },
    create: {
      id: parsed.id,
      kind: parsed.kind,
      displayName: parsed.displayName,
      vendor: parsed.vendor,
      trust: parsed.trust,
    },
    update: { displayName: parsed.displayName, vendor: parsed.vendor },
  });
}

/** Map a Principal ledger row → the PrincipalRecord the graph projects. */
function toPrincipalRecord(row: PrincipalRow): PrincipalRecord {
  return {
    id: row.id,
    kind: row.kind as PrincipalRecord["kind"],
    displayName: row.displayName,
    vendor: row.vendor,
    trust: row.trust as MemoryTrust,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A PrincipalRecord derived purely from a parse (no ledger row), used when
 *  projecting a legacy note whose author predates the Principal table. */
function derivedPrincipalRecord(parsed: ParsedPrincipal): PrincipalRecord {
  return {
    id: parsed.id,
    kind: parsed.kind,
    displayName: parsed.displayName,
    vendor: parsed.vendor,
    trust: parsed.trust,
    createdAt: new Date().toISOString(),
  };
}

// ── Dense embeddings tier (ADR-0009 Slice 3 / KG-3) ──────────────────────────
//
// Lexical-first stays the DEFAULT: with no embedder configured/reachable every
// path below is a no-op and dedup + recall are pure jaccard, unchanged. When a
// (local, opt-in, auto-detected) embedder IS available, a note's vector is
// computed ONCE, persisted to the durable EmbeddingCache keyed by textHash (so
// identical text is never re-embedded, and vectors SURVIVE a .lbug store wipe),
// and passed into the graph projection so `MemoryNote.embedding` is a REAL
// vector instead of []. All best-effort, the dense tier never fails an ingest.

/** Parse a JSON-encoded number[] from EmbeddingCache; undefined if malformed. */
function parseVector(json: string): number[] | undefined {
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) {
      return undefined;
    }
    const vec = arr.map(Number);
    return vec.every((n) => Number.isFinite(n)) ? vec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Vector for a note's text, cache-FIRST (an identical text by textHash reuses
 * the stored vector and NEVER re-embeds), else compute via the embedder and
 * upsert the durable cache. Best-effort end to end: no embedder / any failure →
 * undefined and the caller stays lexical. Meant to run OFF the write-actor mutex
 * (a cold embed is a local model call that must not stall other ingests); the
 * cache read/write are fast textHash-keyed ops. LOCAL-ONLY (lib/embedder.ts).
 */
async function embedNoteText(text: string): Promise<number[] | undefined> {
  const embedder = getEmbedder();
  if (!embedder) {
    return undefined;
  }
  // KG-3 F5: once detection has concluded the local backend is unreachable, the
  // embed path is INERT, skip the cache lookup AND the awaited embed entirely,
  // so the realistic no-Ollama default costs nothing per ingest after the first
  // probe. (isAvailable absent → assume available, e.g. a deterministic fake.)
  if (embedder.isAvailable && !(await embedder.isAvailable())) {
    return undefined;
  }
  const hash = textHash(text);
  const model = embedder.id;
  // Cache key is (textHash, model) (KG-3 F2): a vector from a DIFFERENT model is
  // simply not found here, so a model switch is a clean miss (never a cross-
  // embedding-space cosine). Validate dims before trusting a hit.
  const cached = await prisma.embeddingCache
    .findUnique({ where: { textHash_model: { textHash: hash, model } } })
    .catch(() => null);
  if (cached) {
    const vec = parseVector(cached.vector);
    if (vec && vec.length === cached.dims) {
      return vec; // valid cache HIT → no recompute
    }
    // Corrupt / dims-mismatched row → fall through and recompute under `model`.
  }
  let vector: number[] | undefined;
  try {
    const [vec] = await embedder.embed([text]);
    vector = vec && vec.length > 0 ? vec : undefined;
  } catch {
    return undefined; // embed failed → silently lexical
  }
  if (!vector) {
    return undefined;
  }
  // Persist to the durable, model-keyed cache. Best-effort: a cache-write
  // failure must never fail the ingest; `update` heals a corrupt/mismatched row.
  await prisma.embeddingCache
    .upsert({
      where: { textHash_model: { textHash: hash, model } },
      create: {
        textHash: hash,
        model,
        vector: JSON.stringify(vector),
        dims: vector.length,
      },
      update: { vector: JSON.stringify(vector), dims: vector.length },
    })
    .catch(() => undefined);
  return vector;
}

/**
 * Batch-load cached vectors for a set of notes, keyed by note id. Recomputes
 * each note's textHash (the same normalize+sha256 used at write time) and looks
 * the vector up in EmbeddingCache, so dense dedup and reprojection RESTORE
 * vectors from the durable ledger and never re-embed. Notes with no cached
 * vector are simply absent from the map (→ lexical for that pair).
 */
async function loadNoteVectors(
  notes: readonly { id: string; text: string }[],
  model: string | undefined,
): Promise<Map<string, number[]>> {
  const byId = new Map<string, number[]>();
  // No current model (dense off) → restore NOTHING (KG-3 F2): vectors from some
  // prior model must not be revived into a comparison against the current one.
  if (notes.length === 0 || !model) {
    return byId;
  }
  const idsByHash = new Map<string, string[]>();
  for (const note of notes) {
    const hash = textHash(note.text);
    const ids = idsByHash.get(hash) ?? [];
    ids.push(note.id);
    idsByHash.set(hash, ids);
  }
  const rows = await prisma.embeddingCache
    .findMany({ where: { textHash: { in: [...idsByHash.keys()] }, model } })
    .catch(() => [] as { textHash: string; vector: string; dims: number }[]);
  for (const row of rows) {
    const vec = parseVector(row.vector);
    if (!vec || vec.length !== row.dims) {
      continue;
    }
    for (const id of idsByHash.get(row.textHash) ?? []) {
      byId.set(id, vec);
    }
  }
  return byId;
}

// ── R3 TTL for low-trust agent notes (mem0 §6 `expiration_date`) ─────────────
//
// The problem: every note an agent writes lived forever, so an unconfirmed guess
// from three months ago competed with a human-confirmed fact for recall.
//
// The policy, and its hard edges:
//  • A TTL is stamped at INGEST, and ONLY on a note that is unconfirmed AND
//    AGENT-authored AND at-or-below the operator's trust ceiling. Stamping at
//    write time (rather than deriving `recordedAt + days` at read time) means a
//    later settings change never retroactively evicts a mass of existing notes;
//    each note carries the policy that was in force when it was written.
//  • CONFIRMED, HUMAN-AUTHORED, and HIGH-TRUST notes NEVER auto-expire. That is
//    an invariant, not a dial: expiry is eviction and eviction is a governance
//    act, the same rule that governs `memory_delete`. An agent must never be able
//    to make a confirmed memory disappear by waiting.
//  • Confirming CLEARS the expiry. A note earns permanence by being confirmed;
//    that is the intended redemption path, and it is why hiding (not deleting)
//    is the only correct model here.
//  • Expiry HIDES. Nothing is destroyed: text, provenance, Confirmation history
//    and supersede lineage all stay, and `showExpired` reveals them on demand.
//
// Reads DERIVE hidden-ness from `expiresAt <= now`, so recall is correct even if
// the sweeper has never run; the sweeper only materializes the soft tombstone.

/**
 * The ledger's note shape: `MemoryNoteRecord` plus the R3 expiry state. A strict
 * SUPERSET, so every existing surface consumer keeps working untouched (the same
 * additive contract the module header describes).
 */
export type MemoryLedgerNote = MemoryNoteRecord & {
  /** The policy deadline, or null when this note never auto-expires. */
  expiresAt: string | null;
  /** Derived: `expiresAt` is set and already past. Hidden from recall by default. */
  expired: boolean;
  /**
   * Operator-owned protection. Derived from the append-only pin/unpin verdict
   * stream so it survives a graph wipe without adding mutable authority state.
   */
  pinned: boolean;
  /** The source episode that created this exact note revision. */
  provenance: {
    sourceType: string;
    rawRef: string | null;
    createdAt: string;
  } | null;
  /**
   * P0-2 — WHO vouched for this note, or null if nobody has. `"human"` is the
   * strictly stronger tier and is exactly what `confirmed` reports;
   * `"orchestrator"` means the crew's coordinator vouched so the operator owes
   * no review, which makes the note durable and usable but is never a claim
   * that a person looked at it.
   */
  confirmedBy: "human" | "orchestrator" | null;
  /** TODO 4.8 / D7: provenance tier; NULL on the row reads as `authored`. */
  derivation: NoteDerivation;
  /** TODO 4.8: operator review stamp; null = no stamp yet. */
  reviewStatus: NoteReviewStatus | null;
  /**
   * TODO 4.8: count of active notes sharing this row's `textHash` in the same
   * workspace fence (D12 corroboration signal). Computed at read time only.
   */
  supportCount: number;
};

/**
 * Has this note EARNED PERMANENCE? These are the three never-expire invariants —
 * human-authored, human-confirmed, high-trust — and they are checked at write
 * time, at read time, and again by the sweeper. Deliberately independent of the
 * operator's TTL policy: an invariant is not a dial, so no setting can widen it,
 * and an operator narrowing the trust ceiling can never retroactively un-expire
 * a note that a previous, wider policy already stamped.
 */
function ttlRedeemed(args: {
  authorIsHuman: boolean;
  confirmed: boolean;
  trust: MemoryTrust;
  pinned?: boolean;
}): boolean {
  return (
    args.authorIsHuman ||
    args.confirmed ||
    args.pinned === true ||
    trustRank(args.trust) >= trustRank("high")
  );
}

/**
 * The `expiresAt` a new note should carry, or null. A null/unreadable policy, a
 * days value of 0 (the documented off switch), an already-permanent note, or a
 * note above the operator's trust ceiling all yield null — every uncertain path
 * resolves to "never expires", because that is the non-destructive direction.
 *
 * The trust ceiling is a WRITE-time dial only: it decides which new notes get
 * stamped, never which stamped notes are honoured.
 */
function ttlExpiresAt(args: {
  policy: MemoryLifecyclePolicy | null;
  kind: MemoryLifecycleKind;
  legacyFallbackDays?: number | null;
  authorIsHuman: boolean;
  /** Omitted for new notes, which are unconfirmed by construction. */
  confirmed?: boolean;
  trust: MemoryTrust;
  pinned?: boolean;
  now: Date;
}): Date | null {
  const policy = args.policy;
  const configuredDays = policy
    ? lifecycleDaysForKind(policy, args.kind)
    : undefined;
  const days = Number.isInteger(configuredDays)
    ? configuredDays
    : args.legacyFallbackDays;
  // Route/protocol schemas close the kind union, but direct legacy callers and
  // pre-table rows can still carry an older value. Unknown is never permission
  // to manufacture an Invalid Date or evict it on a guessed row.
  if (
    !policy ||
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days <= 0
  ) {
    return null;
  }
  // A brand-new note is unconfirmed by construction (no Confirmation row yet).
  if (
    ttlRedeemed({
      authorIsHuman: args.authorIsHuman,
      confirmed:
        (args.confirmed ?? false) &&
        policy.permanentWhenConfirmedByKind[args.kind],
      trust: args.trust,
      pinned: args.pinned,
    })
  ) {
    return null;
  }
  if (trustRank(args.trust) > trustRank(policy.trustCeiling)) {
    return null;
  }
  return new Date(args.now.getTime() + days * MS_PER_DAY);
}

/** Map a ledger row → the MemoryNoteRecord shape surfaces already consume. */
function toRecord(
  row: MemoryNoteRow,
  confirmed: boolean,
  conflictsWith: string | null,
  now: Date = new Date(),
  // P0-2: defaults to the human answer so every existing call site keeps its
  // exact meaning; read paths that resolve confirmations thread the real value.
  confirmedBy: "human" | "orchestrator" | null = confirmed ? "human" : null,
  supportCount = 1,
  pinned = false,
  provenance: MemoryLedgerNote["provenance"] = null,
): MemoryLedgerNote {
  const iso = (value: Date | null | undefined): string | null =>
    value ? value.toISOString() : null;
  return {
    id: row.id,
    kind: row.kind as MemoryNoteRecord["kind"],
    text: row.text,
    taskId: row.taskId,
    laneId: row.laneId,
    // #126: the per-chat partition key travels on every record so the graph
    // projection (projectMemoryNote) restores it wipe-survivably from the ledger.
    chatId: row.chatId,
    // ADR-0026: the per-workspace partition key travels the same way and for the
    // same reason — a `.lbug` wipe → reproject must restore the partition, not
    // silently blank it and hand every workspace's notes back to all of them.
    workspacePath: row.workspacePath,
    modules: asStringArray(row.modules),
    topics: asStringArray(row.topics),
    symbols: asStringArray(row.symbols),
    trust: row.trust as MemoryNoteRecord["trust"],
    confirmed,
    stale: row.staleSince != null,
    status: row.status as MemoryNoteRecord["status"],
    scope: row.scope,
    createdBy: row.createdBy,
    createdAt: row.recordedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    validFrom: row.validFrom.toISOString(),
    validTo: iso(row.validTo),
    invalidatedAt: iso(row.retiredAt),
    invalidatedBy:
      row.status === "rejected"
        ? row.supersededBy
          ? "superseded"
          : "human"
        : null,
    staleSince: iso(row.staleSince),
    supersededBy: row.supersededBy,
    accessCount: row.accessCount,
    lastAccessedAt: iso(row.lastUsedAt),
    conflictsWith,
    // R3: the policy deadline travels on every record, and `expired` is DERIVED
    // from it (never from the sweeper's marker), so a brain whose sweeper has not
    // run yet still hides an expired note from recall.
    expiresAt: iso(row.expiresAt),
    expired: isExpiredRow(row, confirmed, now, pinned),
    pinned,
    // Every governed ledger read has usable creation provenance. Intact rows
    // use their Episode above; a legacy/residue row whose nullable episodeId was
    // never backfilled falls back to facts already durable on the note itself.
    provenance: provenance ?? {
      sourceType: parsePrincipal(row.createdBy).kind,
      rawRef: null,
      createdAt: row.recordedAt.toISOString(),
    },
    outcome: row.outcome && isAttemptOutcome(row.outcome) ? row.outcome : null,
    derivation: normalizeNoteDerivation(row.derivation),
    reviewStatus:
      row.reviewStatus && isNoteReviewStatus(row.reviewStatus)
        ? row.reviewStatus
        : null,
    confirmedBy,
    supportCount,
  };
}

/**
 * The ONE place hidden-ness is decided. It re-applies the never-expire
 * invariants (confirmed / human-authored / high-trust) at READ time rather than
 * trusting that every write path cleared the column, so a stamped deadline on a
 * note that has since earned permanence can never hide it — no matter which code
 * path set the deadline or which one forgot to clear it.
 */
function isExpiredRow(
  row: Pick<MemoryNoteRow, "expiresAt" | "trust" | "createdBy">,
  confirmed: boolean,
  now: Date,
  pinned = false,
): boolean {
  if (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()) {
    return false;
  }
  // Past the deadline, but hidden ONLY if the note has not earned permanence in
  // the meantime: a note confirmed or raised to high trust since it was stamped
  // stays visible regardless of the stale column.
  return !ttlRedeemed({
    authorIsHuman: parsePrincipal(row.createdBy).kind === "human",
    confirmed,
    trust: row.trust as MemoryTrust,
    pinned,
  });
}

async function isConfirmed(noteId: string): Promise<boolean> {
  // A note is "confirmed" ONLY when a HUMAN principal blessed it (KG-6 F1). The
  // confirming principal is stored on each Confirmation row (KG-6), so we take the
  // latest HUMAN decision and ignore agent/system rows entirely, an `agent:*`
  // (or omitted → system) confirm can NEVER flip this flag. This is the single
  // source of truth that the gate, KG-5 confirmed-victim protection, and KG-4
  // confirmed-ranking all key on, so "confirmed" means human-confirmed everywhere.
  const confirmations = await prisma.confirmation.findMany({
    where: { noteId },
    orderBy: { at: "desc" },
  });
  const latestHuman = confirmations.find(
    (row) =>
      parsePrincipal(row.principal).kind === "human" &&
      (row.decision === "confirm" || row.decision === "reject"),
  );
  return latestHuman?.decision === "confirm";
}

async function latestConflict(noteId: string): Promise<string | null> {
  const edge = await prisma.memoryEdge.findFirst({
    where: { fromId: noteId, kind: "contradicts" },
    orderBy: { at: "desc" },
  });
  return edge?.toId ?? null;
}

/** Hydrate a single note into a full record (derives confirmed + conflict). */
async function noteRecordById(
  id: string,
  conflictsWithOverride?: string | null,
): Promise<MemoryLedgerNote | null> {
  const row = await prisma.memoryNote.findUnique({ where: { id } });
  if (!row) {
    return null;
  }
  // P0-2: one read of the note's confirmation ledger answers BOTH questions.
  // `toRecord`'s default (confirmedBy = "human" iff confirmed) is right only for
  // a caller that never resolved the ledger — here it would report every
  // orchestrator-vouched note as unvouched on the ONE record every write path
  // hands back: the POST/PATCH/clone responses and `GET /memory/:id`.
  const confirmations = await prisma.confirmation.findMany({
    where: { noteId: id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const confirmed = deriveConfirmedSet(confirmations).has(id);
  const [conflictsWith, episode] = await Promise.all([
    conflictsWithOverride !== undefined
      ? Promise.resolve(conflictsWithOverride)
      : latestConflict(id),
    row.episodeId
      ? prisma.episode.findUnique({ where: { id: row.episodeId } })
      : Promise.resolve(null),
  ]);
  const pinned = derivePinnedSet(confirmations).has(id);
  return toRecord(
    row,
    confirmed,
    conflictsWith,
    new Date(),
    deriveConfirmedByMap(confirmations).get(id) ?? null,
    1,
    pinned,
    episode
      ? {
          sourceType: episode.sourceType,
          rawRef: episode.rawRef,
          createdAt: episode.createdAt.toISOString(),
        }
      : null,
  );
}

/**
 * P6a, read a single note by id from the durable ledger (source of truth),
 * hydrated with its confirmed + conflict state. This is the OPERATOR-ONLY
 * note-by-id path the human pre-edit ("Brain") panel calls to fetch a pending
 * PROPOSES_SUPERSEDE proposal's TEXT ON DEMAND to adjudicate it. The hero gate
 * (preEditContext) deliberately withholds that (attacker-controlled) text from
 * the agent; a human, trusted to read and decide, pulls it here through the
 * operator-tier route (routes/memory.ts `GET /:noteId` → requireOperator), so an
 * agent can never use this to exfiltrate an unconfirmed note's contents.
 */
export async function getMemoryNote(
  noteId: string,
): Promise<MemoryLedgerNote | null> {
  return noteRecordById(noteId);
}

/**
 * READ-ONLY note resolution that also accepts a SHORT-ID PREFIX, git-style.
 *
 * Agents (and their reports) constantly abbreviate `mem-<uuid>` to
 * `mem-dd6bfe9a` — and the exact-match recall then answered "no such note"
 * for a note that existed, which a live coordinator escalated into a false
 * "memory_add silently loses notes" finding (2026-08-06 mission). A prefix
 * of ≥8 hex chars resolves iff it names EXACTLY ONE note; zero or several
 * matches read as missing — the same no-existence-oracle shape the recall
 * fence already returns for hidden ids.
 *
 * READ paths only. Governance verbs (confirm/reject/delete) must keep exact
 * ids: acting on an ambiguous abbreviation is how the wrong note dies.
 */
export async function resolveMemoryNoteByIdOrPrefix(
  noteId: string,
): Promise<MemoryLedgerNote | null> {
  const exact = await noteRecordById(noteId);
  if (exact) return exact;
  if (!/^mem-[0-9a-f]{8,}(-[0-9a-f-]*)?$/i.test(noteId)) return null;
  const matches = await prisma.memoryNote.findMany({
    where: { id: { startsWith: noteId } },
    take: 2,
    select: { id: true },
  });
  if (matches.length !== 1) return null;
  return noteRecordById(matches[0]!.id);
}

export type MemoryMutationCaller = {
  tier: "operator" | "agent";
  principal: string;
  chatId?: string;
  /** ADR-0026 — the caller's own partition, DERIVED from the authenticated
   *  capability exactly as a read's is. Present so a mutation can be fenced by the
   *  same rule a read is; absent for the operator tier, which is not partitioned
   *  by a capability. */
  workspacePath?: string;
  /** Server-owned crew-visible setting; never accepted from an agent body. */
  crewVisible?: boolean;
};

export type MemoryDeleteResult =
  | {
      status: "deleted" | "already_deleted";
      noteId: string;
    }
  | {
      status: "missing" | "forbidden" | "protected";
      noteId: string;
      reason: string;
    };

export type MemoryCloneResult =
  | {
      status: "cloned";
      sourceNoteId: string;
      note: MemoryNoteRecord;
    }
  | {
      status: "missing" | "forbidden";
      sourceNoteId: string;
      reason: string;
    };

export type MemoryCompactionResult = {
  /**
   * What this run's counts depended on — the retention window and the bound.
   * Binding matters MORE here than for a sweep: a compaction clears text, so
   * an apply against a different candidate set than the one reviewed cannot be
   * undone.
   */
  previewDigest?: string;
  retentionDays: number;
  cutoff: string;
  scanned: number;
  tombstoned: number;
  noteIds: string[];
  dryRun: boolean;
  batchId: string | null;
  reason: string | null;
};

/** Options shared by bounded bulk memory removal paths (TODO 4.16). */
/**
 * An apply arrived bound to a preview the policy has since moved past.
 *
 * Its own class so the route can answer 409 (a state conflict) rather than a
 * generic 500 — the operator's move is to preview again, not to retry.
 */
export class MemoryPreviewStaleError extends Error {
  constructor() {
    super(
      "The policy changed since that preview, so this run would touch a different set of notes than the one you reviewed. Preview again before applying.",
    );
    this.name = "MemoryPreviewStaleError";
  }
}

export type BulkMemoryRemovalOptions = {
  /** When true, return the candidate set and counts without writing. */
  dryRun?: boolean;
  /**
   * BIND an apply to the dry run that justified it.
   *
   * Both bulk paths recompute eligibility from the CURRENT policy, so a TTL or
   * retention window changed between preview and apply — from the CLI, from a
   * second window — silently moved the candidate set out from under the
   * counts the operator approved. That is survivable for a sweep (reversible)
   * and not for a compaction (its text is cleared).
   *
   * Optional, and absent means today's behaviour exactly: an operator typing
   * `muon memory sweep-expired` has no preview to be bound to.
   */
  previewDigest?: string;
  /** Cap how many notes this run may remove (after eligibility filtering). */
  maxForget?: number;
  /** Groups removed notes for audit and expire-sweep reversal. Auto-generated on apply when omitted. */
  batchId?: string;
  /** Operator-authored reason recorded in provenance (bounded at the route). */
  reason?: string;
  limit?: number;
  mirrorGraph?: boolean;
};

export type MemoryExpirySweepResult = {
  /**
   * What this run's counts depended on. Pass it back on an apply to bind that
   * apply to THIS preview; the run is refused if the policy moved since.
   * Absent on the fail-closed path, where nothing was computed to bind to.
   */
  previewDigest?: string;
  /** Legacy-compatible uniform value; null for unreadable or kind-dependent policy. */
  ttlDays: number | null;
  policySource: "legacy_global" | "kind_table" | null;
  daysByKind: MemoryLifecyclePolicy["daysByKind"] | null;
  scanned: number;
  expired: number;
  noteIds: string[];
  skipped: boolean;
  dryRun: boolean;
  batchId: string | null;
  reason: string | null;
};

export type MemoryLifecycleMigrationResult = {
  policy: MemoryLifecyclePolicy;
  previousSource: "legacy_global" | "kind_table";
  dryRun: boolean;
  applied: boolean;
  previewDigest: string;
  scanned: number;
  changed: number;
  wouldHideNow: number;
  wouldRestoreNow: number;
  wouldBecomePermanent: number;
};

export class MemoryLifecyclePreviewMismatchError extends Error {
  constructor() {
    super(
      "Memory lifecycle preview is stale; run the dry-run again before applying.",
    );
    this.name = "MemoryLifecyclePreviewMismatchError";
  }
}

export type RevertExpiredBatchResult = {
  batchId: string;
  reverted: number;
  noteIds: string[];
};

const MAX_BULK_MEMORY_REMOVAL_REASON_CHARS = 500;

function resolveBulkRemovalBatch(
  options: BulkMemoryRemovalOptions,
  dryRun: boolean,
): { batchId: string | null; reason: string | null } {
  const reason =
    options.reason === undefined
      ? null
      : options.reason.trim().slice(0, MAX_BULK_MEMORY_REMOVAL_REASON_CHARS) ||
        null;
  if (dryRun) {
    return { batchId: null, reason };
  }
  const batchId = (options.batchId ?? randomUUID()).trim();
  return batchId.length > 0
    ? { batchId, reason }
    : { batchId: randomUUID(), reason };
}

function resolveMaxForget(
  options: BulkMemoryRemovalOptions,
  ceiling: number,
): number {
  if (options.maxForget === undefined) {
    return ceiling;
  }
  return Math.max(1, Math.min(options.maxForget, ceiling));
}

export type MemoryPromoteResult =
  | {
      status: "promoted" | "already_global";
      noteId: string;
      note: MemoryNoteRecord;
    }
  | {
      status: "missing" | "unconfirmed";
      noteId: string;
      reason: string;
    };

async function tombstoneMemoryRow(
  row: MemoryNoteRow,
  principal: string,
  decision: "delete" | "compact",
  at: Date,
  mirrorGraph = true,
  provenance: { batchId?: string | null; reason?: string | null } = {},
): Promise<void> {
  await prisma.$transaction([
    prisma.memoryNote.update({
      where: { id: row.id },
      data: {
        // Hard delete: remove the only content-bearing field while retaining the
        // original hash + coordinates needed for revocation/audit tombstones.
        text: MEMORY_TOMBSTONE_TEXT,
        status: "rejected",
        retiredAt: row.retiredAt ?? at,
        validTo: row.validTo ?? at,
        staleSince: null,
        accessCount: 0,
        lastUsedAt: null,
        modules: [],
        topics: [],
        symbols: [],
      },
    }),
    prisma.memoryAnchor.deleteMany({ where: { noteId: row.id } }),
    prisma.confirmation.create({
      data: {
        noteId: row.id,
        principal,
        decision,
        at,
        batchId: provenance.batchId ?? null,
        reason: provenance.reason ?? null,
      },
    }),
  ]);
  if (mirrorGraph) {
    // A hard-delete response must not race a still-readable graph projection.
    // The ledger remains authoritative, so graph failure is still best-effort,
    // but wait for the deletion attempt before returning to the caller.
    //
    // Drain the in-flight mirrors FIRST. This note's own ingest/edit projection
    // rides an unawaited chain, and a chain that lands after this delete
    // re-MERGEs the node — resurrecting a deleted note's TEXT in the projection
    // until the next reproject. Ordering the delete behind the drain makes that
    // structurally impossible rather than merely unlikely.
    await awaitGraphMirrors();
    await getGraph()
      .deleteMemoryNote(row.id)
      .catch(() => undefined);
  }
}

/**
 * Governed hard delete. Operators may tombstone any note. An agent may
 * tombstone only an agent-authored, unconfirmed note in its exact chat
 * partition. The bearer authenticates one shared agent principal, so no
 * body-supplied lane/vendor label participates in this authorization decision.
 */
export async function deleteMemoryNote(
  noteId: string,
  caller: MemoryMutationCaller,
): Promise<MemoryDeleteResult> {
  return runExclusive(async () => {
    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    if (!row) {
      return {
        status: "missing",
        noteId,
        reason: "The requested memory note does not exist.",
      };
    }
    const confirmations = await prisma.confirmation.findMany({
      where: { noteId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    const confirmed = deriveConfirmedSet(confirmations).has(noteId);
    const owner = parsePrincipal(row.createdBy);
    if (
      caller.tier === "agent" &&
      (confirmed ||
        owner.kind === "human" ||
        !caller.chatId ||
        row.chatId !== caller.chatId)
    ) {
      return {
        status: "forbidden",
        noteId,
        reason:
          "Agents may delete only an agent-authored unconfirmed note in the current chat.",
      };
    }
    if (isLedgerTombstone(row)) {
      return { status: "already_deleted", noteId };
    }
    if (derivePinnedSet(confirmations).has(noteId)) {
      return {
        status: "protected",
        noteId,
        reason: "This memory note is pinned. Unpin it before forgetting it.",
      };
    }

    await tombstoneMemoryRow(
      row,
      caller.tier === "operator" ? "human" : caller.principal,
      "delete",
      new Date(),
    );
    return { status: "deleted", noteId };
  });
}

/**
 * B6 operator-governed scope promotion. Only an active, human-confirmed note can
 * escape its chat partition. The route owns the operator-tier check; this
 * ledger guard independently fails closed on confirmation/state, then projects
 * the authoritative row before returning. Graph failure remains best-effort
 * because the relational ledger is the source of truth.
 */
export async function promoteMemoryNoteToGlobal(
  noteId: string,
): Promise<MemoryPromoteResult> {
  return runExclusive(async () => {
    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    if (!row || row.status !== "active" || isLedgerTombstone(row)) {
      return {
        status: "missing",
        noteId,
        reason: "Only an active memory note can be promoted.",
      };
    }
    if (!(await isConfirmed(noteId))) {
      return {
        status: "unconfirmed",
        noteId,
        reason:
          "A memory note must be human-confirmed before global promotion.",
      };
    }
    if (row.scope !== "global") {
      await prisma.memoryNote.update({
        where: { id: noteId },
        data: { scope: "global" },
      });
    }
    const note = await noteRecordById(noteId);
    if (!note) {
      return {
        status: "missing",
        noteId,
        reason: "The requested memory note no longer exists.",
      };
    }
    await getGraph()
      .projectMemoryNote(note)
      .catch(() => undefined);
    return {
      status: row.scope === "global" ? "already_global" : "promoted",
      noteId,
      note,
    };
  });
}

/**
 * Clone an active note without running dedup: the copy gets a fresh id,
 * caller-derived trust/author, no Confirmation row, and a durable CLONED_FROM
 * edge. Agent callers remain same-chat and may read unconfirmed source text only
 * under the server-owned crew-visible gate.
 */
export async function cloneMemoryNote(
  sourceNoteId: string,
  caller: MemoryMutationCaller,
): Promise<MemoryCloneResult> {
  return runExclusive(async () => {
    const source = await prisma.memoryNote.findUnique({
      where: { id: sourceNoteId },
    });
    if (!source || source.status !== "active" || isLedgerTombstone(source)) {
      return {
        status: "missing",
        sourceNoteId,
        reason: "Only an active memory note can be cloned.",
      };
    }

    const confirmed = await isConfirmed(sourceNoteId);
    const sourceRecord = await noteRecordById(sourceNoteId);
    const crewVouched = sourceRecord?.confirmedBy === "orchestrator";
    const confirmedGlobal = confirmed && source.scope === "global";
    // ADR-0026 §6 — THE WORKSPACE FENCE, checked BEFORE the chat rule and OUTSIDE
    // `confirmedGlobal`'s short-circuit, exactly as `visibilityClauses` orders its
    // terms. §9 listed this function and asked only that the clone PROPAGATE the
    // source's workspace; the GUARD was never revisited, so `confirmedGlobal`
    // skipped every check and a repo-B agent could clone repo A's confirmed-global
    // note — landing a foreign-authored row IN REPO A's partition, visible in repo
    // A's operator library, and orchestrator-vouched by default so it need not even
    // surface in the unvouched review queue. Reproduced by an adversarial review.
    //
    // A clone is a WRITE, so the rule is the same one a read gets: an agent acts
    // inside its own partition or not at all. A capability with no workspace fails
    // closed here for the same reason it does on the read path.
    if (
      caller.tier === "agent" &&
      (source.workspacePath ?? "") !== (caller.workspacePath ?? "\u0000none")
    ) {
      return {
        status: "forbidden",
        sourceNoteId,
        reason: "The source note belongs to another workspace." as string,
      };
    }
    if (
      caller.tier === "agent" &&
      (!caller.chatId ||
        (!confirmedGlobal &&
          (source.chatId !== caller.chatId ||
            (!confirmed && !(caller.crewVisible && crewVouched)))))
    ) {
      return {
        status: "forbidden",
        sourceNoteId,
        reason:
          "The source note is outside this chat's confirmed/crew-visible memory.",
      };
    }

    const author = parsePrincipal(caller.principal);
    const principal = await prisma.principal.findUnique({
      where: { id: author.id },
    });
    const now = new Date();
    // R3: a clone is a FRESH unconfirmed proposal authored by the caller, so it
    // takes the same TTL policy as any other new note. It never inherits the
    // source's expiry — an agent must not be able to launder a stale note into a
    // permanent one, nor to shorten a confirmed source's life by cloning it.
    // ADR-0027: cloning is explicitly NOT an independent proposal, so it neither
    // records corroboration nor receives an orchestrator vouch.
    const cloneTrust = (principal?.trust ?? author.trust) as MemoryTrust;
    const lifecycle = await getMemoryLifecyclePolicy();
    const cloneExpiresAt = ttlExpiresAt({
      policy: lifecycle?.policy ?? null,
      kind: source.kind as MemoryLifecycleKind,
      legacyFallbackDays: lifecycle?.legacyFallbackDays,
      authorIsHuman: author.kind === "human",
      trust: cloneTrust,
      now,
    });
    // D1: the clone's coordinates are RE-RESOLVED against the tracked set as it is
    // now, against the SOURCE's workspace (the same one the row below inherits).
    // A clone is how an agent re-anchors a fact, so a stale label copied verbatim
    // would be the one anchor in the brain that nothing ever re-checked. The
    // source's `planned` declarations ride along so a clone cannot turn the
    // caller's claim into our assertion.
    const cloneResolver = await coordinateResolverFor({
      workspacePath: source.workspacePath,
      plannedCoordinates: await plannedCoordinatesOf(sourceNoteId),
    });
    const { id, ops, parsed } = noteCreateOps(
      {
        kind: source.kind as MemoryNoteInput["kind"],
        text: source.text,
        taskId: source.taskId ?? undefined,
        laneId: source.laneId ?? undefined,
        chatId:
          caller.tier === "agent"
            ? caller.chatId
            : (source.chatId ?? undefined),
        // ADR-0026: a clone of a fact about repo X is a fact about repo X, so the
        // clone stays in the SOURCE's workspace. Unlike `chatId` and `scope` this
        // is not re-derived per tier: the partition follows the CONTENT, and
        // re-stamping a clone into the caller's workspace would be the one way an
        // operator action could move a note across the boundary.
        workspacePath: source.workspacePath ?? undefined,
        modules: asStringArray(source.modules),
        topics: asStringArray(source.topics),
        symbols: asStringArray(source.symbols),
        trust: cloneTrust,
        createdBy: caller.principal,
        // An agent clone is a fresh same-chat proposal, never a second global
        // grant. Only the operator promotion path may confer global scope.
        scope: caller.tier === "agent" ? "project" : source.scope,
        provenance: {
          sourceType: "clone",
          rawRef: `note:${sourceNoteId}`,
        },
      },
      now,
      cloneExpiresAt,
      cloneResolver,
    );
    await prisma.$transaction([
      ...ops,
      prisma.memoryEdge.create({
        data: { fromId: id, toId: sourceNoteId, kind: "cloned_from" },
      }),
    ]);
    const note = (await noteRecordById(id))!;
    const cloneVector = (
      await loadNoteVectors([{ id, text: source.text }], getEmbedder()?.id)
    ).get(id);
    const authorRow = await prisma.principal.findUnique({
      where: { id: parsed.id },
    });
    mirrorToGraph(async (graph) => {
      await graph.projectMemoryNote(
        note,
        cloneVector,
        authorRow ? toPrincipalRecord(authorRow) : undefined,
        getEmbedder()?.id,
      );
      // BOTH endpoints, in THIS chain, before the edge. `projectMemoryEdge` is a
      // `MATCH (a),(b) MERGE (a)->(b)`: with an endpoint not yet projected it
      // writes nothing and reports nothing, and the link is then lost until a
      // full reproject. The source node arrives on a DIFFERENT fire-and-forget
      // mirror chain, and a graph write costs 30–130ms on a loaded host, so
      // under contention the edge simply lost the race — a silently dropped
      // mirror write, the same class of divergence as F3 one level down.
      //
      // Reprojecting the source here makes the ordering STRUCTURAL rather than
      // temporal: the endpoint is present because this chain put it there, not
      // because it happened to arrive in time. The MERGE is idempotent and reads
      // authoritative ledger values (`noteRecordById` re-derives confirmed +
      // conflict, so a re-projection cannot clobber either), which is exactly
      // what the `superseded` branch of ingest already does for its predecessor.
      // `awaitEndpoints` stays on as belt-and-braces for the residual case where
      // the source was never mirrored at all.
      const sourceRecord = await noteRecordById(sourceNoteId);
      if (sourceRecord) {
        await graph.projectMemoryNote(sourceRecord);
      }
      await graph.projectMemoryEdge(id, sourceNoteId, "cloned_from", {
        awaitEndpoints: true,
      });
    }, "memory.clone");
    return { status: "cloned", sourceNoteId, note };
  });
}

/**
 * Compact only already-retired history. Active notes are categorically
 * ineligible. Superseded rows require a surviving successor coordinate;
 * contradicted rows compact only when every contradiction peer is also retired.
 */
export async function compactMemory(
  retentionDays: number,
  now = new Date(),
  options: BulkMemoryRemovalOptions = {},
): Promise<MemoryCompactionResult> {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3_650
  ) {
    throw new Error("Memory compaction retention must be 1-3650 days.");
  }
  const dryRun = options.dryRun === true;
  const mirrorGraph = options.mirrorGraph !== false;
  const { batchId, reason } = resolveBulkRemovalBatch(options, dryRun);
  // Bind an apply to the preview that justified it. A compaction CLEARS TEXT,
  // so acting on a set the operator did not review is unrecoverable.
  //
  // THE DIGEST BINDS THE SET, NOT THE INPUTS THAT WERE MEANT TO DETERMINE IT.
  // Hashing only the retention window and the bounds was wrong twice over: the
  // cutoff moves with wall-clock `now` (the route passes a fresh Date on every
  // request, so an hour between preview and apply widens the window by an
  // hour), and eligibility also turns on pins, successor edges and
  // contradiction-peer status, none of which the caller supplied. An operator
  // could review three notes, apply the digest they were handed, and clear the
  // text of a fourth they never saw. Digesting the note ids that will actually
  // be tombstoned makes every one of those drifts a mismatch, by construction
  // rather than by enumerating the causes.
  const digestOf = (noteIds: readonly string[]): string =>
    createHash("sha256")
      .update(
        JSON.stringify({
          kind: "compact",
          retentionDays,
          maxForget: options.maxForget ?? null,
          limit: options.limit ?? null,
          noteIds: [...noteIds].sort(),
        }),
      )
      .digest("hex");
  // NOT A SIGNATURE, so not a constant-time comparison. This digest is handed
  // to the caller in the dry-run response and recomputed here from what the
  // ledger itself selected. It is `createHash`, not `createHmac` — there is no
  // key, and both routes are behind `requireOperator` already. A timing side
  // channel here would leak a value the response body hands over openly;
  // treating it as a secret would imply an authenticity property it does not
  // have and must not be relied on for.
  const assertPreviewFresh = (digest: string): void => {
    if (!dryRun && options.previewDigest && options.previewDigest !== digest) {
      throw new MemoryPreviewStaleError();
    }
  };
  return runExclusive(async () => {
    const cutoffDate = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1_000,
    );
    const candidates = await prisma.memoryNote.findMany({
      where: {
        status: "rejected",
        text: { not: MEMORY_TOMBSTONE_TEXT },
        retiredAt: { lte: cutoffDate },
      },
      orderBy: [{ retiredAt: "asc" }, { id: "asc" }],
      take: MAX_MEMORY_COMPACTION_BATCH,
    });
    const candidateIds = candidates.map((row) => row.id);
    if (candidateIds.length === 0) {
      // Checked here too: a preview that found three notes and an apply that
      // now finds none is exactly the drift this guard exists for, and
      // returning "tombstoned: 0" as a success would report it as agreement.
      const previewDigest = digestOf([]);
      assertPreviewFresh(previewDigest);
      return {
        previewDigest,
        retentionDays,
        cutoff: cutoffDate.toISOString(),
        scanned: 0,
        tombstoned: 0,
        noteIds: [],
        dryRun,
        batchId,
        reason,
      };
    }

    const [edges, confirmations] = await Promise.all([
      prisma.memoryEdge.findMany({
        where: {
          kind: { in: ["supersedes", "contradicts"] },
          OR: [
            { fromId: { in: candidateIds } },
            { toId: { in: candidateIds } },
          ],
        },
      }),
      prisma.confirmation.findMany({
        where: { noteId: { in: candidateIds } },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      }),
    ]);
    const pinnedIds = derivePinnedSet(confirmations);
    const peerIds = [
      ...new Set(edges.flatMap((edge) => [edge.fromId, edge.toId])),
    ];
    const peers = await prisma.memoryNote.findMany({
      where: { id: { in: peerIds } },
      select: { id: true, status: true },
    });
    const peerStatus = new Map(peers.map((row) => [row.id, row.status]));
    const eligible = candidates.filter((row) => {
      if (pinnedIds.has(row.id)) {
        return false;
      }
      const successorExists =
        Boolean(row.supersededBy) && peerStatus.has(row.supersededBy!);
      const contradictionPeers = edges
        .filter(
          (edge) =>
            edge.kind === "contradicts" &&
            (edge.fromId === row.id || edge.toId === row.id),
        )
        .map((edge) => (edge.fromId === row.id ? edge.toId : edge.fromId));
      const fullyContradicted =
        contradictionPeers.length > 0 &&
        contradictionPeers.every(
          (peerId) =>
            peerStatus.has(peerId) && peerStatus.get(peerId) !== "active",
        );
      return successorExists || fullyContradicted;
    });
    const maxForget = resolveMaxForget(options, MAX_MEMORY_COMPACTION_BATCH);
    const toTombstone = eligible.slice(0, maxForget);
    // The last point at which nothing has been destroyed yet.
    const previewDigest = digestOf(toTombstone.map((row) => row.id));
    assertPreviewFresh(previewDigest);

    if (!dryRun) {
      for (const row of toTombstone) {
        await tombstoneMemoryRow(
          row,
          "system:compaction",
          "compact",
          now,
          mirrorGraph,
          { batchId, reason },
        );
      }
    }
    const noteIds = toTombstone.map((row) => row.id).sort();
    return {
      previewDigest,
      retentionDays,
      cutoff: cutoffDate.toISOString(),
      scanned: candidates.length,
      tombstoned: noteIds.length,
      noteIds,
      dryRun,
      batchId,
      reason,
    };
  });
}

/**
 * R3 sweeper. Materializes the soft tombstone (`expiredAt`) for notes whose
 * policy deadline has passed. Runs at backend boot and on demand from the
 * operator route; it is NOT on any request path.
 *
 * Three properties the reviewer should hold this to:
 *  • BOUNDED. One run scans and writes at most MAX_MEMORY_EXPIRY_SWEEP_BATCH
 *    rows, and `expiredAt IS NULL` is the cursor, so repeated runs make forward
 *    progress without ever re-touching a swept row.
 *  • NON-DESTRUCTIVE. It writes one timestamp and appends one provenance row. No
 *    text is cleared, no status changes, no edge is removed. `compactMemory` (the
 *    only path that empties text) is untouched and still requires a retired note
 *    with a successor or fully-retired contradiction peers, so an expired note is
 *    categorically not a compaction candidate.
 *  • RE-CHECKED. Eligibility is verified against the CURRENT ledger, not against
 *    whatever was true at stamp time: a note confirmed, raised to high trust, or
 *    (impossibly, but cheaply guarded) human-authored since the stamp is skipped
 *    AND has its stale deadline cleared, so it stops being a candidate forever.
 */
export async function sweepExpiredMemory(
  now = new Date(),
  options: BulkMemoryRemovalOptions = {},
): Promise<MemoryExpirySweepResult> {
  const dryRun = options.dryRun === true;
  const { batchId, reason } = resolveBulkRemovalBatch(options, dryRun);
  // READ THE POLICY UNDER THE LOCK.
  //
  // A lifecycle MIGRATION takes this same write-actor queue, so a policy read
  // out here could be superseded while this sweep waits its turn: the digest
  // would validate against the snapshot the operator previewed and the
  // eviction would then run under a policy that had already moved. Reading
  // (and binding) inside the critical section makes the policy that authorises
  // the eviction the same one that is current when it happens.
  return runExclusive(async () => {
    const lifecycle = await getMemoryLifecyclePolicy();
    if (!lifecycle) {
      // Fail closed on an unreadable/malformed policy: eviction under uncertainty
      // is the unsafe direction, so the sweep does nothing and says so.
      return {
        ttlDays: null,
        policySource: null,
        daysByKind: null,
        scanned: 0,
        expired: 0,
        noteIds: [],
        skipped: true,
        dryRun,
        batchId,
        reason,
      };
    }
    const { policy } = lifecycle;
    const dayValues = Object.values(policy.daysByKind);
    const ttlDays = dayValues.every((days) => days === dayValues[0])
      ? (dayValues[0] ?? null)
      : null;
    const limit = Math.max(
      1,
      Math.min(
        options.limit ?? MAX_MEMORY_EXPIRY_SWEEP_BATCH,
        MAX_MEMORY_EXPIRY_SWEEP_BATCH,
      ),
    );
    // What the operator's counts DEPENDED ON — which is the SET, not the policy
    // that was supposed to imply it. Hashing policy and limits alone left two
    // ways for an apply to act on notes nobody reviewed: the candidate query
    // filters `expiresAt <= now` and the route passes a fresh Date per request,
    // so notes that lapse between preview and apply join the set; and
    // permanence is recomputed here from confirmations and pins, so a note
    // confirmed in another window silently moves between evict and redeem.
    // Digesting the resulting ids makes both a mismatch without having to
    // enumerate them.
    const digestOf = (evict: readonly string[], redeem: readonly string[]) =>
      createHash("sha256")
        .update(
          JSON.stringify({
            kind: "sweep-expired",
            source: lifecycle.source,
            policy,
            maxForget: options.maxForget ?? null,
            limit,
            evict: [...evict].sort(),
            redeem: [...redeem].sort(),
          }),
        )
        .digest("hex");
    // NOT A SIGNATURE, so not a constant-time comparison. This digest is handed
    // to the caller in the dry-run response and recomputed here from what the
    // ledger itself selected. It is `createHash`, not `createHmac` — there is
    // no key, and both routes are behind `requireOperator` already. A timing
    // side channel here would leak a value the response body hands over openly;
    // treating it as a secret would imply an authenticity property it does not
    // have and must not be relied on for.
    const assertPreviewFresh = (digest: string): void => {
      if (!dryRun && options.previewDigest && options.previewDigest !== digest) {
        throw new MemoryPreviewStaleError();
      }
    };
    {
      const candidates = await prisma.memoryNote.findMany({
        where: {
          status: "active",
          expiredAt: null,
          expiresAt: { not: null, lte: now },
        },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: limit,
      });
      if (candidates.length === 0) {
        // A preview that counted notes and an apply that finds none is drift,
        // not agreement — reporting "expired: 0" as success would hide it.
        const previewDigest = digestOf([], []);
        assertPreviewFresh(previewDigest);
        return {
          ttlDays,
          policySource: lifecycle.source,
          daysByKind: policy.daysByKind,
          scanned: 0,
          expired: 0,
          noteIds: [],
          skipped: false,
          dryRun,
          batchId,
          reason,
          previewDigest,
        };
      }

      const candidateIds = candidates.map((row) => row.id);
      const confirmations = await prisma.confirmation.findMany({
        where: { noteId: { in: candidateIds } },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      });
      const confirmedIds = deriveConfirmedSet(confirmations);
      const pinnedIds = derivePinnedSet(confirmations);

      const evicted: string[] = [];
      const redeemed: string[] = [];
      for (const row of candidates) {
        // The SAME invariant check the read path uses, so the sweep can never
        // disagree with what a caller already sees.
        const permanent = ttlRedeemed({
          authorIsHuman: parsePrincipal(row.createdBy).kind === "human",
          confirmed: confirmedIds.has(row.id),
          trust: row.trust as MemoryTrust,
          pinned: pinnedIds.has(row.id),
        });
        (permanent ? redeemed : evicted).push(row.id);
      }

      const maxForget = resolveMaxForget(
        options,
        MAX_MEMORY_EXPIRY_SWEEP_BATCH,
      );
      const toEvict = evicted.slice(0, maxForget);
      // The last point at which nothing has been written yet.
      const previewDigest = digestOf(toEvict, redeemed);
      assertPreviewFresh(previewDigest);

      if (!dryRun) {
        if (redeemed.length > 0) {
          // A note that earned permanence after being stamped drops its deadline for
          // good, so it never re-enters this scan and never hides from recall.
          await prisma.memoryNote.updateMany({
            where: { id: { in: redeemed } },
            data: { expiresAt: null, expiredAt: null },
          });
        }
        if (toEvict.length > 0) {
          await prisma.$transaction([
            prisma.memoryNote.updateMany({
              where: { id: { in: toEvict } },
              data: { expiredAt: now },
            }),
            ...toEvict.map((noteId) =>
              // Append-only provenance for the eviction, the same convention the
              // ledger already uses for system "reconcile"/"compact" markers. It is
              // NOT a confirm or a reject: `deriveConfirmedSet` counts human rows
              // only, so an "expire" row can never flip a note's confirmed state.
              prisma.confirmation.create({
                data: {
                  noteId,
                  principal: "system:ttl",
                  decision: "expire",
                  at: now,
                  batchId,
                  reason,
                },
              }),
            ),
          ]);
        }
      }

      const noteIds = [...toEvict].sort();
      if (!dryRun && options.mirrorGraph !== false && noteIds.length > 0) {
        // Best-effort mirror: the ledger is authoritative and reads derive
        // hidden-ness from `expiresAt`, so a graph failure changes nothing a
        // caller can observe.
        mirrorToGraph(async (graph) => {
          for (const id of noteIds) {
            const note = await noteRecordById(id);
            if (note) {
              await graph.projectMemoryNote(note);
            }
          }
        }, "memory.sweep-expired");
      }
      return {
        ttlDays,
        policySource: lifecycle.source,
        daysByKind: policy.daysByKind,
        scanned: candidates.length,
        expired: noteIds.length,
        noteIds,
        skipped: false,
        dryRun,
        batchId,
        reason,
        previewDigest,
      };
    }
  });
}

/**
 * TODO 4.11 settings-gated migration. A dry-run and apply run fold the exact
 * same ledger snapshot into a digest. Apply is refused unless the caller
 * presents that digest, so a changed note, verdict, trust level, legacy setting,
 * or already-active table forces a fresh one-screen preview first.
 */
export async function migrateMemoryLifecyclePolicy(
  proposed: MemoryLifecyclePolicy,
  options:
    | { dryRun: true; previewDigest?: never }
    | { dryRun: false; previewDigest: string },
  now = new Date(),
): Promise<MemoryLifecycleMigrationResult> {
  const parsed = parseMemoryLifecyclePolicy(proposed);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  const policy = parsed.policy;

  return runExclusive(async () => {
    const previous = await getMemoryLifecyclePolicy();
    if (!previous) {
      throw new Error(
        "Memory lifecycle policy is unreadable; no deadlines were changed.",
      );
    }

    // Paused notes participate: pause suppresses use, not lifecycle. Rejected
    // history is retired and never needs a new future deadline.
    const rows = await prisma.memoryNote.findMany({
      where: { status: { in: ["active", "paused"] } },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
    });
    const confirmations = await prisma.confirmation.findMany({
      where: { noteId: { in: rows.map((row) => row.id) } },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    const confirmedIds = deriveConfirmedSet(confirmations);
    const pinnedIds = derivePinnedSet(confirmations);

    const changes: {
      row: MemoryNoteRow;
      desired: Date | null;
      currentHidden: boolean;
      desiredHidden: boolean;
    }[] = [];
    const digestRows: unknown[] = [];

    for (const row of rows) {
      if (!(row.kind in policy.daysByKind)) {
        throw new Error(
          `Unknown memory kind ${row.kind}; no lifecycle settings were changed.`,
        );
      }
      const confirmed = confirmedIds.has(row.id);
      const kind = row.kind as MemoryLifecycleKind;
      const trust = row.trust as MemoryTrust;
      const redeemed = ttlRedeemed({
        authorIsHuman: parsePrincipal(row.createdBy).kind === "human",
        confirmed,
        trust,
        pinned: pinnedIds.has(row.id),
      });
      const desired = ttlExpiresAt({
        policy,
        kind,
        authorIsHuman: parsePrincipal(row.createdBy).kind === "human",
        confirmed,
        trust,
        pinned: pinnedIds.has(row.id),
        // Migration preserves write-time semantics: the new table is applied
        // from the note's recorded instant, never from the moment Apply is hit.
        now: row.recordedAt,
      });
      const currentIso = row.expiresAt?.toISOString() ?? null;
      const desiredIso = desired?.toISOString() ?? null;
      const currentHidden =
        !redeemed &&
        row.expiresAt !== null &&
        row.expiresAt.getTime() <= now.getTime();
      const desiredHidden =
        desired !== null && desired.getTime() <= now.getTime();

      digestRows.push({
        id: row.id,
        status: row.status,
        kind,
        trust,
        createdBy: row.createdBy,
        confirmed,
        pinned: pinnedIds.has(row.id),
        recordedAt: row.recordedAt.toISOString(),
        expiresAt: currentIso,
        desiredExpiresAt: desiredIso,
        // Bind the operator's one-screen consequence preview, not only the
        // underlying deadlines. If wall time crosses either deadline before
        // Apply, the digest becomes stale and the operator previews again.
        currentHidden,
        desiredHidden,
      });
      if (currentIso !== desiredIso) {
        changes.push({ row, desired, currentHidden, desiredHidden });
      }
    }

    const previewDigest = createHash("sha256")
      .update(
        JSON.stringify({
          previousSource: previous.source,
          previousPolicy: previous.policy,
          proposedPolicy: policy,
          rows: digestRows,
        }),
      )
      .digest("hex");

    if (!options.dryRun && options.previewDigest !== previewDigest) {
      throw new MemoryLifecyclePreviewMismatchError();
    }

    if (!options.dryRun) {
      await prisma.$transaction([
        prisma.operatorSetting.upsert({
          where: { key: MEMORY_LIFECYCLE_POLICY_KEY },
          create: {
            key: MEMORY_LIFECYCLE_POLICY_KEY,
            value: JSON.stringify(policy),
          },
          update: { value: JSON.stringify(policy) },
        }),
        ...changes.map(({ row, desired, desiredHidden }) =>
          prisma.memoryNote.update({
            where: { id: row.id },
            data: {
              expiresAt: desired,
              // A restored/future note is no longer swept. A newly-past
              // deadline remains a derived hide until the bounded sweeper adds
              // its ordinary append-only expiry marker.
              expiredAt: desiredHidden ? row.expiredAt : null,
            },
          }),
        ),
      ]);

      // The graph is a mirror but performs its own expiry filtering before the
      // ledger narrows a result. Reproject every changed row so extending a
      // deadline can become visible immediately, not only after restart.
      await awaitGraphMirrors();
      mirrorToGraph(async (graph) => {
        for (const { row } of changes) {
          const note = await noteRecordById(row.id);
          if (note) {
            await graph.projectMemoryNote(
              note.status === "paused" ? { ...note, confirmed: false } : note,
            );
          }
        }
      }, "memory.lifecycle-migrate");
      // Unlike ordinary ingest, Apply is a one-off operator migration whose
      // response is the commit point. Do not acknowledge it while the old
      // expiry posture can still win a direct graph read.
      await awaitGraphMirrors();
    }

    return {
      policy,
      previousSource: previous.source,
      dryRun: options.dryRun,
      applied: !options.dryRun,
      previewDigest,
      scanned: rows.length,
      changed: changes.length,
      wouldHideNow: changes.filter(
        ({ currentHidden, desiredHidden }) => !currentHidden && desiredHidden,
      ).length,
      wouldRestoreNow: changes.filter(
        ({ currentHidden, desiredHidden }) => currentHidden && !desiredHidden,
      ).length,
      wouldBecomePermanent: changes.filter(
        ({ row, desired }) => row.expiresAt !== null && desired === null,
      ).length,
    };
  });
}

/**
 * Reverse a bounded expire sweep as a unit (TODO 4.16). Clears `expiredAt` on
 * notes that were expired under the given batchId. Compaction batches are NOT
 * reversible — their text was cleared.
 */
export async function revertExpiredMemoryBatch(
  batchId: string,
  now = new Date(),
  options: { mirrorGraph?: boolean } = {},
): Promise<RevertExpiredBatchResult> {
  const trimmed = batchId.trim();
  if (!trimmed) {
    throw new Error("batchId is required.");
  }
  return runExclusive(async () => {
    const markers = await prisma.confirmation.findMany({
      where: { batchId: trimmed, decision: "expire" },
      select: { noteId: true },
    });
    const noteIds = [...new Set(markers.map((row) => row.noteId))].sort();
    if (noteIds.length === 0) {
      return { batchId: trimmed, reverted: 0, noteIds: [] };
    }
    const rows = await prisma.memoryNote.findMany({
      where: { id: { in: noteIds } },
      select: { id: true, status: true, expiredAt: true },
    });
    const revertible = rows
      .filter((row) => row.status === "active" && row.expiredAt !== null)
      .map((row) => row.id);
    if (revertible.length === 0) {
      return { batchId: trimmed, reverted: 0, noteIds: [] };
    }
    await prisma.$transaction([
      prisma.memoryNote.updateMany({
        where: { id: { in: revertible } },
        data: { expiredAt: null },
      }),
      ...revertible.map((noteId) =>
        prisma.confirmation.create({
          data: {
            noteId,
            principal: "system:ttl",
            decision: "revert-expire",
            at: now,
            batchId: trimmed,
          },
        }),
      ),
    ]);
    const reverted = [...revertible].sort();
    if (options.mirrorGraph !== false && reverted.length > 0) {
      mirrorToGraph(async (graph) => {
        for (const id of reverted) {
          const note = await noteRecordById(id);
          if (note) {
            await graph.projectMemoryNote(note);
          }
        }
      }, "memory.revert-expired-batch");
    }
    return { batchId: trimmed, reverted: reverted.length, noteIds: reverted };
  });
}

/** The R3 expiry state a read surface attaches to a note it is about to return. */
export type MemoryExpiryState = {
  expiresAt: string | null;
  expired: boolean;
  /** Append-only operator protection verdict. */
  pinned: boolean;
  /**
   * The ledger's LIVENESS verdict for this read's instant (with `asOf`: "was
   * this the answer at T"). A read that does not opt into `showRetired` never
   * sees `false` here, because those rows are dropped — the provenance walks
   * that DO opt in need it, since a node they must keep in the answer is exactly
   * a node whose TEXT they must withhold (`redactExpiredNodes`).
   *
   * A note the ledger could not answer for (unreadable ledger, or no row) is
   * reported LIVE, matching how `expired` degrades: this pass is recall hygiene
   * over an already-gated set, not authorization.
   */
  live: boolean;
  /**
   * P0-2 — WHO vouched, carried onto the graph-backed reads (search / recall /
   * the pre-edit gate). The graph mirror has no confirmation ledger of its own,
   * so without this annotation the vouch DIED AT THE WIRE: `renderMemorySlice`
   * admits a note that is human-confirmed OR orchestrator-vouched, and every
   * recall response reaching it reported `confirmedBy: undefined`. The crew
   * therefore still coordinated on human-confirmed memory alone — the whole
   * point of the vouch, defeated one layer below where it was fixed.
   */
  confirmedBy: "human" | "orchestrator" | null;
};

/**
 * The ledger-authoritative fields for one note. `MemoryExpiryState` is what
 * every caller is TYPED on; everything below it is an OVERRIDE of the mirror's
 * own copy, applied only when the ledger actually answered (see the degradation
 * note below) — which is exactly why the overrides are not in the exported type:
 * a degraded read must leave the mirror's fields as they arrived, and a field
 * the type demanded would have to be invented there.
 *
 * The override set is R5's: `MEMORY_FILTER_FIELDS` publishes 20 filterable
 * fields, `governedMemoryView` runs the filter AFTER this pass, and a predicate
 * evaluated against the mirror's copy answers a question about the mirror. Every
 * field here is also a GOVERNANCE claim in its own right — `trust` is the
 * destructive-write authority and the never-expire dial, `status` is the
 * liveness label that must not contradict the `confirmed`/`stale` beside it, and
 * `createdBy` is who is being believed. They cost nothing: the row is already
 * read for expiry.
 *
 * Deliberately NOT overridden. This list is the scope statement, not an
 * oversight:
 *  • CONTENT (`text`, `modules`, `topics`, `symbols`) — the surface that handed
 *    us the note owns content exposure, and several deliberately hand over a
 *    coordinates-only note. Writing the ledger's text back would RESTORE text a
 *    gate withheld, turning a narrower into a widener. This is the one exclusion
 *    that is load-bearing for security rather than for tidiness.
 *  • PARTITION / coordinates (`chatId`, `workspacePath`, `scope`, `taskId`,
 *    `laneId`, `kind`) — the authorization clauses in the candidate query already
 *    decided these. Relabelling a row afterwards cannot un-select a mis-selected
 *    one, and a filter would then be answered against a partition label this read
 *    was never scoped by.
 *
 *    ADR-0026 §11 makes `workspacePath`'s membership here LOAD-BEARING rather than
 *    tidy, and states the consequence in the direction a future refactor is most
 *    likely to get wrong: the workspace decision is made in the candidate query
 *    and NOWHERE else. This function's degradation path below returns
 *    `notes.map(neutral)` — it drops NOTHING when the ledger is unreadable, which
 *    is safe only because the workspace gate already ran upstream, in the same
 *    position the confirmed-only gate occupies. Move the predicate in here and that
 *    branch becomes a fail-OPEN on a visibility invariant. It must not move.
 *  • `accessCount` — a ranking counter, not a governance claim, and it is
 *    reinforced off the read path by design (KG-2).
 *
 * `staleSince` is carried raw rather than a resolved `stale`, because staleness
 * is the one field with TWO independent witnesses and resolving it needs the
 * note as well as the row (see `resolveStale`).
 */
type MemoryLedgerVerdict = MemoryExpiryState & {
  confirmed: boolean;
  staleSince: Date | null;
  status: MemoryNoteRecord["status"];
  trust: MemoryTrust;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  validFrom: string;
  validTo: string | null;
};

/**
 * Staleness is the ONE reconciled field where the ledger is not the only
 * witness, so it is OR'd rather than replaced.
 *
 * `markModulesStale` (the ledger write) and `graph.touchModules` (the mirror
 * write) are two separate writes off the same event, and the events route makes
 * the LEDGER half best-effort (`.catch(...)`) while the mirror half still runs.
 * So mirror-`true` / ledger-`null` is an ordinary outcome, not a corruption —
 * and `staleSince` is SET-ONCE, so the ledger can never recover it afterwards.
 * Replacing the flag there rewrote a note we already suspect back to
 * trustworthy and let `selectMemorySliceNotes` put it into a worker's brief.
 *
 * OR is also the only direction that keeps this pass a NARROWER: "suspect" is a
 * monotone claim, so either witness suffices and neither can clear the other.
 */
function resolveStale(note: unknown, staleSince: Date | null): boolean {
  if (staleSince != null) {
    return true;
  }
  return (note as { stale?: unknown }).stale === true;
}

/**
 * Is this ledger row the current-set answer — or, with `asOf`, was it the answer
 * at that instant? The bitemporal branch mirrors `visibilityClauses` in
 * MuonGraph term for term (validFrom / recordedAt / validTo / retiredAt), which
 * is the point: the two must agree, and where they disagree the LEDGER wins.
 *
 * An unparseable `asOf` falls back to the CURRENT-set predicate, the stricter of
 * the two. The routes already reject unparseable instants, so this is only ever
 * the fail-closed tail.
 */
function ledgerRowLive(
  row: Pick<
    MemoryNoteRow,
    "status" | "retiredAt" | "validFrom" | "validTo" | "recordedAt"
  >,
  asOf?: Date,
): boolean {
  // Pause is deliberately outside bitemporal validity. It means "do not use
  // this now" even while inspecting an older instant; resume simply removes
  // this current suppression without rewriting the confirmation history.
  if (row.status === "paused") {
    return false;
  }
  if (!asOf || Number.isNaN(asOf.getTime())) {
    return row.status === "active" && row.retiredAt === null;
  }
  const at = asOf.getTime();
  return (
    row.validFrom.getTime() <= at &&
    row.recordedAt.getTime() <= at &&
    (row.validTo === null || row.validTo.getTime() > at) &&
    (row.retiredAt === null || row.retiredAt.getTime() > at)
  );
}

/**
 * Reconcile an ALREADY-AUTHORIZED note set against the authoritative ledger:
 * annotate each note with its R3 expiry state, replace the mirror's copies of
 * the fields a consumer STEERS on with the ledger's, and drop the rows the
 * ledger says are not the answer.
 *
 * (Historically named for its first job — R3 expiry. It is the one place the
 * ledger overrules the mirror on a governed read, and every widening since has
 * landed here rather than growing a second reconciliation point.)
 *
 * This is the route-layer bridge for the graph-backed reads (search / recall /
 * the pre-edit gate): the authoritative ledger is consulted for exactly the ids
 * that are about to be returned. Bounded by the caller's own result limit, never
 * by anything an agent supplies.
 *
 * THE LEDGER DECIDES, IN BOTH DIRECTIONS. `memory-graph-mirror.test.ts` pinned
 * one half — a stale mirror may not HIDE a note the ledger calls live. The other
 * half is this function's, and it was open: `mirrorToGraph` is fire-and-forget,
 * so ONE dropped write left the graph serving a note the ledger had rejected,
 * hard-deleted (text and all), un-confirmed, or marked suspect — and the read
 * path consulted the ledger for `expiresAt` alone and repeated the mirror's
 * answer for everything else. Everything a consumer STEERS on now comes from the
 * ledger (`MemoryExpiryState` is the exact list, with the deliberate exclusions
 * named there):
 *   • LIVENESS — a retired/rejected row is dropped (`showRetired` opts out for
 *     the provenance walks, whose entire job is to explain a supersede; those
 *     read `live` and withhold the node's TEXT instead of dropping it).
 *   • `confirmed` — the human-confirmed flag `selectMemorySliceNotes` puts
 *     straight into a worker's brief under a heading claiming a person signed
 *     off. Derived HERE from the Confirmation ledger by the same
 *     `deriveConfirmedSet` the rest of the system uses.
 *   • `stale` — two independent witnesses, so it is OR'd, not replaced. See
 *     `resolveStale`.
 *   • `status` / `trust` / `createdBy` / the bitemporal timestamps — the rest of
 *     what R5 lets a caller FILTER on, so a predicate is answered about the
 *     ledger rather than about the mirror.
 *
 * It is a NARROWER of the ROW SET. It is handed notes the caller already passed
 * every gate for, so it can remove rows and can never add one — the same property
 * that keeps the filter grammar from becoming a side channel.
 *
 * It is NOT a narrower of every FIELD, and must not be read as one: on the fields
 * above the ledger is simply the authority, and a correction can make a note look
 * better (a vouch the mirror missed) as easily as worse. `stale` is the sole
 * exception and the reason the distinction is written down — its two witnesses
 * are independent, neither is a superset, and replacing rather than OR'ing there
 * silently WIDENED what reached a brief.
 *
 * DEGRADATION: an unreadable ledger annotates everything as never-expiring and
 * live, drops nothing, and leaves the mirror's fields exactly as they
 * arrived. That is deliberate and is NOT a fail-open on a governance gate: every
 * note in this set already passed the confirmed-only / partition gate, so this
 * pass is recall hygiene, not authorization. Blanking the crew's memory because
 * a bounded lookup hiccuped would be the worse failure — and guessing `confirmed
 * = false` on a broken read would blank it just as thoroughly.
 *
 * `confirmedBy` degrades the OTHER way, to null, and deliberately so: it is a
 * CLAIM about who vouched, and a lookup that failed has not learned that anyone
 * did. The cost of the honest answer is a thinner brief on a broken read; the
 * cost of guessing would be an unvouched note presented to the crew as settled.
 */
export async function applyMemoryExpiry<T extends { id: string }>(
  notes: readonly T[],
  options: {
    showExpired?: boolean;
    /**
     * Bitemporal instant (ISO-8601). Liveness is then measured AS OF this
     * instant instead of now, so an as-of read still returns the notes that were
     * the answer at T — including ones since retired, which is the whole point.
     */
    asOf?: string;
    /**
     * Keep rows the ledger has retired. For the provenance surfaces
     * (`/neighbors`, `/explain`), where dropping a superseded node would break
     * the very path the caller asked to have explained.
     */
    showRetired?: boolean;
    now?: Date;
  } = {},
): Promise<(T & MemoryExpiryState)[]> {
  const now = options.now ?? new Date();
  const neutral = (note: T): T & MemoryExpiryState => ({
    ...note,
    expiresAt: null,
    expired: false,
    live: true,
    confirmedBy: null,
    pinned: false,
  });
  if (notes.length === 0) {
    return [];
  }
  const asOf = options.asOf ? new Date(options.asOf) : undefined;
  const ids = [...new Set(notes.map((note) => note.id))];
  let state = new Map<string, MemoryLedgerVerdict>();
  try {
    const rows = await prisma.memoryNote.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        expiresAt: true,
        trust: true,
        createdBy: true,
        // The liveness + provenance columns the mirror also carries, and which
        // it may be wrong about.
        status: true,
        retiredAt: true,
        validFrom: true,
        validTo: true,
        recordedAt: true,
        updatedAt: true,
        staleSince: true,
      },
    });
    // P0-2: the ledger is now read for EVERY id, not only the stamped ones. The
    // old shape resolved confirmations only where expiry hinged on them, which
    // is precisely the set a VOUCHED note is not in (a vouch clears the
    // deadline) — so the one annotation the crew coordinates on was the one
    // guaranteed to be missing. One indexed query on `Confirmation.noteId`,
    // bounded by the caller's own page.
    const confirmations = await prisma.confirmation.findMany({
      where: { noteId: { in: ids } },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    const confirmedIds = deriveConfirmedSet(confirmations);
    const confirmedByIds = deriveConfirmedByMap(confirmations);
    const pinnedIds = derivePinnedSet(confirmations);
    state = new Map(
      rows.map((row) => [
        row.id,
        {
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          expired: isExpiredRow(
            row,
            confirmedIds.has(row.id),
            now,
            pinnedIds.has(row.id),
          ),
          pinned: pinnedIds.has(row.id),
          confirmedBy: confirmedByIds.get(row.id) ?? null,
          confirmed: confirmedIds.has(row.id),
          staleSince: row.staleSince,
          live: ledgerRowLive(row, asOf),
          status: row.status as MemoryNoteRecord["status"],
          trust: row.trust as MemoryTrust,
          createdBy: row.createdBy,
          // `createdAt` on the wire IS the transaction-time column, exactly as
          // `toRecord` spells it. Two names for one instant is confusing enough
          // without two VALUES for it.
          createdAt: row.recordedAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          validFrom: row.validFrom.toISOString(),
          validTo: row.validTo ? row.validTo.toISOString() : null,
        },
      ]),
    );
  } catch (error) {
    // OBSERVABLE degradation. The fallback is right (expiry opens, `confirmedBy`
    // fails closed to null), but nulling `confirmedBy` silently drops every
    // orchestrator vouch from this page — so a crew brief quietly narrows to
    // human-confirmed-only memory and the agents simply coordinate worse, with
    // nothing anywhere saying why. COORDINATES ONLY: how many ids and the error
    // message, never a note id and never note text.
    console.error(
      `[memory] confirmation lookup failed for ${ids.length} note(s); ` +
        `expiry opens and crew vouches are dropped from this read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return notes.map(neutral);
  }
  const annotated = notes.map((note) => {
    const found = state.get(note.id);
    if (!found) {
      // No ledger row for this id at all. Nothing was learned, so nothing is
      // overridden and nothing is dropped — the same posture as the degradation
      // path above, for the same reason.
      return neutral(note);
    }
    const { staleSince, ...verdict } = found;
    return { ...note, ...verdict, stale: resolveStale(note, staleSince) };
  });
  const liveOnly = options.showRetired
    ? annotated
    : annotated.filter((note) => note.live);
  return options.showExpired
    ? liveOnly
    : liveOnly.filter((note) => !note.expired);
}

export type MemoryLibraryFilter = {
  q?: string;
  chatId?: string;
  /**
   * ADR-0026 §5 — the WORKSPACE fence on the operator library, the surface §1
   * measured actually leaking (its first page already spanned two workspaces, with
   * nothing on the wire or on screen distinguishing them).
   *
   * A plain SQL column predicate, ANDed OUTSIDE the `chatId` admission's
   * `scope:"global"` leg, which is what makes promotion cross MISSIONS and never
   * REPOS (§6). It stays in the relational `where` rather than joining the derived
   * predicates in `libraryRowMatches` for the reason §5 gives about LIMIT
   * completeness: a page must not be filled with foreign-workspace rows that a
   * post-filter then drops, leaving an under-filled page of in-workspace notes.
   * Absent = today's unscoped view.
   */
  workspacePath?: string;
  /** ADR-0026 §8 residue view: ONLY the notes with no workspace. The review queue
   *  is exactly where an unassigned note has to be visible, because assigning or
   *  confirming it is how it stops being residue. Mutually exclusive with
   *  `workspacePath`. */
  unscopedWorkspace?: boolean;
  status?: "all" | "active" | "paused" | "rejected";
  /**
   * `confirmed` / `unconfirmed` mean exactly what they say: whether a HUMAN
   * said so. They are honest labels and they are NOT the review queue.
   *
   * P0-2 adds `unvouched` for the only question a queue surface should ask:
   * has ANYONE vouched — a human or the orchestrator? Every "pending review"
   * count built on `unconfirmed` silently billed the operator for settled crew
   * memory, which is what kept the founder clicking Confirm on notes MUON had
   * already approved. A queue asks for `unvouched`; a library browsing the
   * human tier keeps asking for `unconfirmed`.
   */
  confirmed?: "all" | "confirmed" | "unconfirmed" | "unvouched";
  /** Internal derived selector used by the cold-start decision projection. */
  pinned?: boolean;
  kind?: MemoryNoteRecord["kind"];
  trust?: MemoryTrust;
  /** Scalar selectors used by internal projections; operator grammar stays R5. */
  scope?: MemoryNoteRecord["scope"];
  stale?: boolean;
  limit?: number;
  /** mem0's `show_expired`: include R3-expired notes. Default false (hidden). */
  showExpired?: boolean;
  /** R5 bounded filter grammar, already VALIDATED by @muon/protocol. */
  filter?: MemoryFilter;
  /** TODO 4.8: provenance tier filter (`authored` includes legacy NULL rows). */
  derivation?: NoteDerivation;
  /** TODO 4.8: operator review stamp filter. */
  reviewStatus?: NoteReviewStatus;
  /**
   * TODO 4.8: review-queue ordering. Default `updatedAt` preserves today's library
   * page. `supportCount` ranks corroborated facts first (same `textHash` in the
   * workspace fence), then inferred-before-authored, then recency.
   */
  orderBy?: MemoryLibraryOrderBy;
};

export type MemoryLibrarySnapshot = {
  notes: MemoryLedgerNote[];
  edges: {
    id: string;
    fromId: string;
    toId: string;
    kind: string;
    weight: number | null;
    at: string;
  }[];
  confirmations: {
    id: string;
    noteId: string;
    principal: string;
    /** Wide on purpose: besides human confirm/reject the ledger writes system
     *  "reconcile" markers (KG-6 conflict convention; P1.4 pack tombstones).
     *  Provenance is returned verbatim — consumers must treat unknown
     *  decisions as neutral, never as a confirm or reject. */
    decision: string;
    at: string;
  }[];
  /** P1.4 memory packs (additive): import provenance rows for the returned
   *  notes — origin workspace/author/confirmation as DATA (never authority),
   *  so review surfaces can show clearly-labeled origin evidence. */
  imports: {
    id: string;
    noteId: string | null;
    originWorkspace: string;
    originLabel: string;
    originNoteId: string;
    recordHash: string;
    textHash: string;
    disposition: string;
    originAuthor: string;
    originConfirmedBy: string;
    originConfirmedAt: string;
    importedAt: string;
  }[];
  /** Rows matching the whole query (filters + derived state), NOT just the page.
   *  Exact whenever `totalExact` is true. */
  total: number;
  truncated: boolean;
  /** Whether `total` counted the ENTIRE matching set. False only when the read
   *  hit `MAX_MEMORY_LIBRARY_SCAN`, in which case `total` is a FLOOR and the
   *  consumer must render it as "at least N" rather than as a count. Additive:
   *  a consumer that ignores it sees exactly today's fields. */
  totalExact: boolean;
};

/**
 * Does this row's visibility depend on the append-only Confirmation ledger?
 * Confirmation is not a MemoryNote column, so resolving it costs a second query;
 * this keeps that query off the overwhelmingly common page where nothing about
 * the answer hinges on it.
 */
function libraryNeedsConfirmation(
  row: MemoryNoteRow,
  filter: MemoryLibraryFilter,
  now: Date,
): boolean {
  if (filter.confirmed !== undefined && filter.confirmed !== "all") {
    return true;
  }
  if (filter.pinned !== undefined) {
    return true;
  }
  // B6: a chat-scoped view admits a note from ANOTHER partition only as
  // human-confirmed global memory, so those rows need the ledger.
  if (filter.chatId !== undefined && row.chatId !== filter.chatId) {
    return true;
  }
  // The R5 grammar can predicate on `confirmed` directly. Walking its AST to
  // find out would be a SECOND definition of the grammar living here; one extra
  // indexed lookup per page is the cheaper correctness.
  if (filter.filter !== undefined) {
    return true;
  }
  // R3: expiry hinges on confirmation only for a note that is stamped AND
  // already past its deadline. Everything else is visible without the ledger.
  return (
    filter.showExpired !== true &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() <= now.getTime()
  );
}

/**
 * The DERIVED predicates, in one place: chat admission, confirmation state, R3
 * expiry, R5 filter. None of them is a MemoryNote column, which is exactly why
 * they cannot be pushed into the SQL `where` and why the scan below exists.
 */
function libraryRowMatches(
  record: MemoryLedgerNote,
  filter: MemoryLibraryFilter,
): boolean {
  if (
    filter.chatId !== undefined &&
    record.chatId !== filter.chatId &&
    !(record.scope === "global" && record.confirmed)
  ) {
    return false;
  }
  if (filter.confirmed === "confirmed" && !record.confirmed) {
    return false;
  }
  if (filter.confirmed === "unconfirmed" && record.confirmed) {
    return false;
  }
  if (filter.pinned !== undefined && record.pinned !== filter.pinned) {
    return false;
  }
  // P0-2 — the REVIEW QUEUE predicate: nobody has vouched. An EXPIRED note is
  // unvouched in effect no matter who once vouched for it (nothing is vouching
  // for it now, and a human confirm is the only way back), so it stays in the
  // queue — the same rule the desktop inbox applies.
  if (
    filter.confirmed === "unvouched" &&
    (record.status !== "active" ||
      (record.confirmedBy !== null && !record.expired))
  ) {
    return false;
  }
  if (filter.showExpired !== true && record.expired) {
    return false;
  }
  return filter.filter
    ? matchesMemoryFilter(record as MemoryFilterRecord, filter.filter)
    : true;
}

/** D12 corroboration signal: active notes sharing a content hash in one fence. */
export async function computeTextHashSupportCounts(
  textHashes: string[],
  fence?: Pick<MemoryLibraryFilter, "workspacePath" | "unscopedWorkspace">,
): Promise<Map<string, number>> {
  const unique = [...new Set(textHashes.filter(Boolean))];
  if (unique.length === 0) {
    return new Map();
  }
  const where: Prisma.MemoryNoteWhereInput = {
    status: "active",
    textHash: { in: unique },
  };
  if (fence?.unscopedWorkspace) {
    where.workspacePath = null;
  } else if (fence?.workspacePath) {
    where.workspacePath = fence.workspacePath;
  }
  const rows = await prisma.memoryNote.findMany({
    where,
    select: { textHash: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.textHash, (counts.get(row.textHash) ?? 0) + 1);
  }
  return counts;
}

function reviewQueueCompare(
  a: MemoryNoteRow,
  b: MemoryNoteRow,
  supportCounts: Map<string, number>,
): number {
  const supportA = supportCounts.get(a.textHash) ?? 1;
  const supportB = supportCounts.get(b.textHash) ?? 1;
  if (supportB !== supportA) {
    return supportB - supportA;
  }
  const tier = (value: string | null) => (value === "inferred" ? 0 : 1);
  const tierA = tier(a.derivation);
  const tierB = tier(b.derivation);
  if (tierA !== tierB) {
    return tierA - tierB;
  }
  const updatedDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function orderLibraryRows(
  rows: MemoryNoteRow[],
  filter: MemoryLibraryFilter,
): Promise<MemoryNoteRow[]> {
  if ((filter.orderBy ?? "updatedAt") !== "supportCount" || rows.length <= 1) {
    return rows;
  }
  const supportCounts = await computeTextHashSupportCounts(
    rows.map((row) => row.textHash),
    filter,
  );
  return [...rows].sort((a, b) => reviewQueueCompare(a, b, supportCounts));
}

/**
 * Keyset scan of the matching set: evaluate the derived predicates in order,
 * newest first, and paginate ONCE over the result.
 *
 * This replaces a pre-pass that resolved matching ids and then handed them back
 * to SQL as `where.id = { in: matchingIds }` alongside `take: limit`. That shape
 * is broken above 999 ids — the SQLite connector chunks the `IN` list and
 * applies `take` PER CHUNK, so a default read of a 2 500-note brain returned 600
 * rows for `limit: 200` and was missing 103 of the true newest 200. Here the
 * limit is applied exactly once, by this loop, over an ordered stream, and no
 * query it issues ever pairs a caller-sized `IN` list with a `take`.
 *
 * Memory is O(limit), not O(scanned): only the page being returned is retained,
 * every other matching row is counted and dropped. `total` is therefore exact
 * for the whole matching set unless the scan ceiling is reached, which the
 * caller reports as `totalExact: false` rather than as a smaller number.
 */
async function scanMemoryLibrary(
  where: Prisma.MemoryNoteWhereInput,
  filter: MemoryLibraryFilter,
  limit: number,
  now: Date,
): Promise<{ rows: MemoryNoteRow[]; total: number; totalExact: boolean }> {
  const rows: MemoryNoteRow[] = [];
  let total = 0;
  let scanned = 0;
  let totalExact = true;
  let cursor: { updatedAt: Date; id: string } | null = null;
  const collectAll = (filter.orderBy ?? "updatedAt") === "supportCount";

  for (;;) {
    // Annotated because the cursor this loop assigns is derived from the rows
    // it reads, which TS would otherwise walk as a circular inference.
    const batch: MemoryNoteRow[] = await prisma.memoryNote.findMany({
      where: cursor
        ? {
            AND: [
              where,
              {
                OR: [
                  { updatedAt: { lt: cursor.updatedAt } },
                  { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: MEMORY_LIBRARY_ORDER,
      take: MEMORY_LIBRARY_SCAN_PAGE,
    });
    if (batch.length === 0) {
      break;
    }
    const needsLedger = batch.filter((row) =>
      libraryNeedsConfirmation(row, filter, now),
    );
    const ledgerRows =
      needsLedger.length === 0
        ? []
        : await prisma.confirmation.findMany({
            where: { noteId: { in: needsLedger.map((row) => row.id) } },
            // Deterministic replay order: equal timestamps must not make
            // confirmation depend on SQLite row order.
            orderBy: [{ at: "asc" }, { id: "asc" }],
          });
    const confirmed = deriveConfirmedSet(ledgerRows);
    // P0-2: derived from the SAME rows, no extra query. The `unvouched` queue
    // predicate reads `confirmedBy`, and the default toRecord() applies below
    // ("human" iff confirmed) would have reported EVERY vouched note as
    // unvouched — a review queue that counts precisely the notes it must not.
    const confirmedBy = deriveConfirmedByMap(ledgerRows);
    const pinned = derivePinnedSet(ledgerRows);

    for (const row of batch) {
      // `confirmed`/`confirmedBy` are resolved only for the rows whose ANSWER
      // depends on them (libraryNeedsConfirmation), so a row outside that set
      // carries `false`/null here. That is safe by construction, not by luck:
      // every predicate that reads either one — the explicit filter (including
      // P0-2's `unvouched`), chat admission, the R5 grammar, and expiry on a
      // stamped past-deadline row — is exactly a case that function returns true
      // for. The RETURNED records are rebuilt below from a second lookup over
      // the page ids, so the page never carries this scan-local approximation
      // out of the function.
      const record = toRecord(
        row,
        confirmed.has(row.id),
        null,
        now,
        confirmedBy.get(row.id) ?? null,
        1,
        pinned.has(row.id),
      );
      if (!libraryRowMatches(record, filter)) {
        continue;
      }
      total += 1;
      if (collectAll || rows.length < limit) {
        rows.push(row);
      }
    }

    scanned += batch.length;
    const last = batch[batch.length - 1]!;
    cursor = { updatedAt: last.updatedAt, id: last.id };
    if (batch.length < MEMORY_LIBRARY_SCAN_PAGE) {
      break;
    }
    if (scanned >= MAX_MEMORY_LIBRARY_SCAN) {
      totalExact = false;
      break;
    }
  }
  return { rows, total, totalExact };
}

/** Operator-facing ledger read: all memory states plus bounded provenance/edges. */
export async function listMemoryLibrary(
  filter: MemoryLibraryFilter = {},
): Promise<MemoryLibrarySnapshot> {
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 200));
  const where: Prisma.MemoryNoteWhereInput = {};
  if (filter.status && filter.status !== "all") {
    where.status = filter.status;
  }
  if (filter.kind) where.kind = filter.kind;
  if (filter.trust) where.trust = filter.trust;
  if (filter.scope) where.scope = filter.scope;
  if (filter.stale !== undefined) {
    where.staleSince = filter.stale ? { not: null } : null;
  }
  if (filter.derivation) {
    const authoredClause = {
      OR: [{ derivation: null }, { derivation: "authored" }],
    };
    if (filter.derivation === "authored") {
      where.AND = [
        ...(Array.isArray(where.AND)
          ? where.AND
          : where.AND
            ? [where.AND]
            : []),
        authoredClause,
      ];
    } else {
      where.derivation = filter.derivation;
    }
  }
  if (filter.reviewStatus) {
    where.reviewStatus = filter.reviewStatus;
  }
  if (filter.q?.trim()) {
    where.text = { contains: filter.q.trim() };
  }
  // ADR-0026: the workspace fence, assigned BEFORE the chat `OR` below and as a
  // TOP-LEVEL field, which is what ANDs it outside that `OR` in Prisma. Written
  // this way round on purpose: folding it INTO the `OR` array would make a
  // `scope:"global"` note from another repo admissible again, which is precisely
  // §6's hole. `null` is Prisma's `IS NULL`, i.e. the §8 residue and nothing else.
  if (filter.unscopedWorkspace) {
    where.workspacePath = null;
  } else if (filter.workspacePath) {
    where.workspacePath = filter.workspacePath;
  }
  if (filter.chatId) {
    // Per-chat operator view: the selected chat's review queue plus global
    // memory. The SQL side admits every global row and `libraryRowMatches` drops
    // the unconfirmed ones, because confirmation is append-only ledger state and
    // not a MemoryNote column. Expressing the admission as a RELATIONAL `OR`
    // (rather than as an id list of confirmed globals) is what keeps this query
    // free of the caller-sized `IN` list that made pagination lie.
    where.OR = [{ chatId: filter.chatId }, { scope: "global" }];
  }

  const now = new Date();
  // Does anything about this read depend on state SQL cannot see? Confirmation,
  // R3 expiry and the R5 grammar all do; when none of them is in play the
  // relational query is authoritative on its own and stays a single count+page.
  const derived =
    filter.showExpired !== true ||
    filter.filter !== undefined ||
    filter.pinned !== undefined ||
    (filter.confirmed !== undefined && filter.confirmed !== "all") ||
    filter.chatId !== undefined;

  let rows: MemoryNoteRow[];
  let candidateTotal: number;
  let totalExact: boolean;
  if (derived) {
    const scan = await scanMemoryLibrary(where, filter, limit, now);
    rows = scan.rows;
    candidateTotal = scan.total;
    totalExact = scan.totalExact;
  } else {
    [candidateTotal, rows] = await Promise.all([
      prisma.memoryNote.count({ where }),
      prisma.memoryNote.findMany({
        where,
        orderBy: MEMORY_LIBRARY_ORDER,
        take:
          (filter.orderBy ?? "updatedAt") === "supportCount"
            ? MAX_MEMORY_LIBRARY_SCAN
            : limit,
      }),
    ]);
    totalExact = true;
  }
  rows = await orderLibraryRows(rows, filter);
  if ((filter.orderBy ?? "updatedAt") === "supportCount") {
    rows = rows.slice(0, limit);
  }
  const supportCounts = await computeTextHashSupportCounts(
    rows.map((row) => row.textHash),
    filter,
  );
  const candidateIds = rows.map((row) => row.id);
  const candidateConfirmations =
    candidateIds.length === 0
      ? []
      : await prisma.confirmation.findMany({
          where: { noteId: { in: candidateIds } },
          orderBy: { at: "asc" },
        });
  const confirmedIds = deriveConfirmedSet(candidateConfirmations);
  // P0-2: who vouched, so the library can show an orchestrator-confirmed note as
  // settled crew knowledge instead of a review debt the operator owes.
  const confirmedByIds = deriveConfirmedByMap(candidateConfirmations);
  const pinnedIds = derivePinnedSet(candidateConfirmations);
  const filteredRows = rows;
  const ids = new Set(filteredRows.map((row) => row.id));
  const [edges, confirmations, importRows, episodeRows] =
    ids.size === 0
      ? [[], [], [], []]
      : await Promise.all([
          prisma.memoryEdge.findMany({
            // ANY fence, not just the chat one. This guard was written for the
            // chat axis and keyed on `filter.chatId` alone, so ADR-0026's
            // workspace fence — which the CLI sends by default, and the desktop
            // sends whenever no chat is selected — took the unguarded `OR` branch
            // and returned edges whose other endpoint is a note the SAME response
            // had just fenced out. A one-sided edge is a note id, and the reason
            // it must not leak does not depend on which axis hid the note.
            where:
              filter.chatId || filter.workspacePath || filter.unscopedWorkspace
                ? {
                    // A scoped snapshot must not reveal a hidden note's id through a
                    // one-sided relationship.
                    fromId: { in: [...ids] },
                    toId: { in: [...ids] },
                  }
                : {
                    OR: [
                      { fromId: { in: [...ids] } },
                      { toId: { in: [...ids] } },
                    ],
                  },
            orderBy: { at: "desc" },
          }),
          prisma.confirmation.findMany({
            where: { noteId: { in: [...ids] } },
            orderBy: { at: "desc" },
          }),
          prisma.memoryImport.findMany({
            where: { noteId: { in: [...ids] } },
            orderBy: [{ importedAt: "desc" }, { id: "asc" }],
          }),
          prisma.episode.findMany({
            where: {
              id: {
                in: filteredRows.flatMap((row) =>
                  row.episodeId ? [row.episodeId] : [],
                ),
              },
            },
          }),
        ]);
  const episodesById = new Map(episodeRows.map((row) => [row.id, row]));
  const conflicts = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind === "contradicts" && !conflicts.has(edge.fromId)) {
      conflicts.set(edge.fromId, edge.toId);
    }
  }

  return {
    notes: filteredRows.map((row) =>
      toRecord(
        row,
        confirmedIds.has(row.id),
        conflicts.get(row.id) ?? null,
        now,
        confirmedByIds.get(row.id) ?? null,
        supportCounts.get(row.textHash) ?? 1,
        pinnedIds.has(row.id),
        (() => {
          const episode = row.episodeId
            ? episodesById.get(row.episodeId)
            : undefined;
          return episode
            ? {
                sourceType: episode.sourceType,
                rawRef: episode.rawRef,
                createdAt: episode.createdAt.toISOString(),
              }
            : null;
        })(),
      ),
    ),
    edges: edges.map((edge) => ({
      id: edge.id,
      fromId: edge.fromId,
      toId: edge.toId,
      kind: edge.kind,
      weight: edge.weight,
      at: edge.at.toISOString(),
    })),
    confirmations: confirmations.map((confirmation) => ({
      id: confirmation.id,
      noteId: confirmation.noteId,
      principal: confirmation.principal,
      decision: confirmation.decision,
      at: confirmation.at.toISOString(),
    })),
    imports: importRows.map((row) => ({
      id: row.id,
      noteId: row.noteId,
      originWorkspace: row.originWorkspace,
      originLabel: row.originLabel,
      originNoteId: row.originNoteId,
      recordHash: row.recordHash,
      textHash: row.textHash,
      disposition: row.disposition,
      originAuthor: row.originAuthor,
      originConfirmedBy: row.originConfirmedBy,
      originConfirmedAt: row.originConfirmedAt.toISOString(),
      importedAt: row.importedAt.toISOString(),
    })),
    total: candidateTotal,
    truncated: candidateTotal > rows.length,
    totalExact,
  };
}

/**
 * TODO 4.22 — cold-start decision canon, projected from existing append-only
 * ledger facts rather than stored a second time. A decision joins only when a
 * human confirmed it, explicitly pinned it, and promoted it to workspace-global
 * scope. The library scanner keeps derived pin/confirmation selection bounded
 * and LIMIT-complete; ADR-0026's workspace predicate is pushed into SQL.
 */
export async function listStandingDecisionLog(options: {
  workspacePath?: string;
  unscopedWorkspace?: boolean;
  limit?: number;
}): Promise<MemoryLedgerNote[]> {
  const snapshot = await listMemoryLibrary({
    workspacePath: options.workspacePath,
    unscopedWorkspace: options.unscopedWorkspace,
    status: "active",
    confirmed: "confirmed",
    pinned: true,
    kind: "decision",
    scope: "global",
    stale: false,
    showExpired: false,
    limit: Math.max(1, Math.min(options.limit ?? 64, 64)),
  });
  return snapshot.notes;
}

/** D1: `resolution` is spelled EXPLICITLY on every row, including the `null`s. An
 *  omitted key and a `null` mean the same thing to Prisma here, but a `createMany`
 *  whose objects disagree about which keys exist is how a column silently stops
 *  being written for one anchor kind. */
type AnchorRow = {
  noteId: string;
  kind: string;
  value: string;
  resolution: MemoryAnchorResolution | null;
};

/** One MemoryAnchor row per (note, anchor), the indexed dedup lookup key. The
 *  `symbol` rows (ADR-0012) need NO schema change (`kind` is free-form); each
 *  symbol also contributes its AUTO-DERIVED module row (a symbol-anchored note is
 *  always module-anchored too), so a module-precise edit still dedup/recalls it.
 *
 *  D1: the two COORDINATE kinds (`module`, `symbol`) also carry a `resolution` —
 *  did this value name a real file in the note's workspace? Every other kind is
 *  not a coordinate at all (a taskId is not a path), so its resolution is NULL by
 *  construction rather than by omission. `resolver` absent → NULL everywhere,
 *  which is what a caller that cannot resolve must land.
 *
 *  D15: the module list is PASSED IN rather than re-derived from `input`, because it
 *  is the union of `effectiveModules` and the coordinates promoted out of the note's
 *  own prose, and the note's `modules` scalar must be that same union — the graph
 *  mirror projects `n.modules` AND `ANCHORED_TO` from the scalar, so a promoted
 *  anchor row with no scalar entry would be an anchor NO READ PATH can ever see, and
 *  nothing would report it: §1.2 row 23's divergence check is mirror-internal (both
 *  of its queries read the mirror), which was MEASURED while shipping the backfill.
 *  One list, computed once, used for both. */
function anchorRowsFor(
  noteId: string,
  input: MemoryNoteInput,
  modules: readonly string[],
  resolver?: CoordinateResolver,
): AnchorRow[] {
  const rows: AnchorRow[] = [];
  if (input.taskId) {
    rows.push({ noteId, kind: "task", value: input.taskId, resolution: null });
  }
  if (input.laneId) {
    rows.push({ noteId, kind: "lane", value: input.laneId, resolution: null });
  }
  // #126: the chat is a first-class anchor so the dedup candidate lookup is
  // scoped to the SAME chat (see anchorScopedCandidates) — two identical notes in
  // DIFFERENT chats must NOT dedup-collapse into one (that would drop the second
  // chat's write and leave it with no in-chat copy at all).
  if (input.chatId) {
    rows.push({ noteId, kind: "chat", value: input.chatId, resolution: null });
  }
  // ADR-0026: the workspace is a first-class anchor too, minted from the FIRST
  // write after 0041 (which backfilled the same row for every pre-existing note),
  // so the partition is an indexed coordinate rather than only a note column.
  if (input.workspacePath) {
    rows.push({
      noteId,
      kind: "workspace",
      value: input.workspacePath,
      // An ABSOLUTE workspace root, not a repo-relative path — it is the thing
      // coordinates resolve AGAINST, so it is not itself one.
      resolution: null,
    });
  }
  for (const mod of modules) {
    rows.push({
      noteId,
      kind: "module",
      value: mod,
      // D15: a PROMOTED module lands `resolved` here by construction — promotion's
      // own gate is this predicate — so the label is re-derived rather than assumed.
      // If that ever stops being true, the row says so instead of lying.
      resolution: resolutionOf("module", mod, resolver),
    });
  }
  for (const topic of input.topics ?? []) {
    rows.push({ noteId, kind: "topic", value: topic, resolution: null });
  }
  for (const symbol of input.symbols ?? []) {
    rows.push({
      noteId,
      kind: "symbol",
      value: symbol,
      // BY MODULE PREFIX ONLY (see `resolutionOf`): validating the symbol NAME
      // needs the code index, which §D1 rejected as the identity resolver.
      resolution: resolutionOf("symbol", symbol, resolver),
    });
  }
  return rows;
}

/**
 * D1: the `planned` declaration a SUCCESSOR or a CLONE inherits.
 *
 * `cloneMemoryNote` and `updateMemoryNote`'s text-edit supersede both mint a NEW
 * note carrying the source's anchors, and both already propagate its workspace for
 * a stated reason — "an operator fixing a typo would drop the successor into the §8
 * residue and take a live fact away from every agent in that repo". A declaration
 * is inherited for exactly that reason: a typo fix must not silently restate a
 * caller's `planned` declaration as OUR `unresolved` assertion.
 *
 * Reality still wins on the way back in: an inherited declaration for a file that
 * has since been committed lands `resolved`, so this can only ever preserve a
 * claim, never revive a stale one.
 */
async function plannedCoordinatesOf(noteId: string): Promise<string[]> {
  const rows = await prisma.memoryAnchor.findMany({
    where: { noteId, resolution: "planned" },
    select: { value: true },
  });
  return rows.map((row) => row.value);
}

/**
 * Anchor-scoped dedup/contradiction candidate set (KG-1 F1). Fetches active
 * notes that SHARE an anchor with the incoming note via the indexed MemoryAnchor
 * table, so an aged note sharing the anchor is still found no matter how many
 * newer notes exist (the prior global recency window silently missed it once the
 * brain exceeded the window, insert-ing true duplicates and dropping
 * contradiction edges). classifyIncomingNote re-applies sharesAnchor, so a small
 * superset here is harmless.
 */
/**
 * P0-2 — a byte-identical restatement of an ACTIVE note in the same chat.
 *
 * The anchor pass below only ever COMPARES notes that already share a task,
 * lane, module, topic or symbol (`sharesAnchor`). A mined note carries no
 * modules whenever its job had no governed worktree, and every job brings its
 * own taskId, so two jobs minting the same sentence were never compared at all
 * — both inserted. Combined with the extractor's related-note hint being
 * confirmed-only (it is never shown the unconfirmed notes it just wrote, so it
 * restates them next turn), that is how one short mission accumulates a review
 * queue of the same handful of facts.
 *
 * `textHash` (the same normalize+sha256 identity packs content-address on) was
 * already computed at write time and indexed — it was simply never read back.
 *
 * The key is (textHash, kind, scope, chat) — every axis that PARTITIONS who can
 * see the note, so this only ever collapses rows that were already
 * interchangeable. Chat scoping matches the anchor pass (#126): each chat keeps
 * its own copy, so a fact is never collapsed across missions, and a NULL-chat
 * (legacy / operator) write keeps today's global behaviour. `scope` is in for
 * the same reason: the same sentence at `project` and at `lane:codex` is two
 * different visibilities, not a restatement. Deliberately NOT keyed on author —
 * two agents landing on the same fact SHOULD collapse; that is the point.
 */
async function findExactTextDuplicate(
  input: MemoryNoteInput,
): Promise<MemoryNoteRecord | null> {
  const row = await prisma.memoryNote.findFirst({
    where: {
      textHash: textHash(input.text),
      kind: input.kind,
      status: "active",
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
      // ADR-0026 + TODO 4.15: ALWAYS fence by workspace, including the §8
      // residue. `null` matches `IS NULL` only — an unassigned write dedups
      // against other unassigned notes, never against an assigned repo's copy
      // (and never the reverse). The old conditional omitted the clause when
      // workspace was absent and collapsed globally; that let a residue write
      // supersede/dedup a live workspace note. Failure direction is
      // non-destructive: two copies beat a silent merge across partitions.
      workspacePath: input.workspacePath ?? null,
    },
    // The ORIGINAL is the survivor, so a restatement always resolves to the
    // same note id rather than hopping between equals.
    orderBy: { recordedAt: "asc" },
  });
  return row ? toRecord(row, false, null) : null;
}

async function anchorScopedCandidates(
  input: MemoryNoteInput,
): Promise<MemoryNoteRecord[]> {
  const or: Prisma.MemoryAnchorWhereInput[] = [];
  if (input.taskId) {
    or.push({ kind: "task", value: input.taskId });
  }
  if (input.laneId) {
    or.push({ kind: "lane", value: input.laneId });
  }
  const mods = effectiveModules(input);
  if (mods.length) {
    or.push({ kind: "module", value: { in: mods } });
  }
  if (input.topics?.length) {
    or.push({ kind: "topic", value: { in: input.topics } });
  }
  // Two notes about the SAME symbol are dedup candidates (ADR-0012).
  if (input.symbols?.length) {
    or.push({ kind: "symbol", value: { in: input.symbols } });
  }
  // #126: a chat-anchored note can share the chat with the incoming (so a
  // chat-only-anchored write still finds same-chat candidates).
  if (input.chatId) {
    or.push({ kind: "chat", value: input.chatId });
  }
  if (or.length === 0) {
    return []; // no anchors → nothing to dedup against (matches sharesAnchor)
  }
  const anchors = await prisma.memoryAnchor.findMany({
    where: { OR: or },
    select: { noteId: true },
  });
  const ids = [...new Set(anchors.map((anchor) => anchor.noteId))];
  if (ids.length === 0) {
    return [];
  }
  const rows = await prisma.memoryNote.findMany({
    // #126: dedup is CHAT-SCOPED. When the incoming carries a chat, only same-chat
    // active notes are candidates, so an identical note in ANOTHER chat is never
    // treated as a duplicate/supersede/contradiction of it — each chat keeps its
    // own copy. A NULL-chat (legacy / operator) write keeps today's global dedup.
    where: {
      id: { in: ids },
      status: "active",
      ...(input.chatId ? { chatId: input.chatId } : {}),
      // ADR-0026 + TODO 4.15: ALWAYS fence by workspace (including §8 residue →
      // residue). Same rationale as `findExactTextDuplicate`: an identical note
      // in another repo — or an assigned note vs an unassigned residue — is not
      // a duplicate/supersede/contradiction target. The workspace is deliberately
      // NOT added to the anchor `OR` above: that would widen the comparison set
      // to every note in the workspace and change dedup behaviour far beyond
      // partitioning.
      workspacePath: input.workspacePath ?? null,
    },
  });
  return rows.map((row) => toRecord(row, false, null));
}

/**
 * Build the durable create-ops for a new note (Episode + MemoryNote + anchor
 * index rows) WITHOUT executing them. Returning the ops lets a caller compose
 * the insert with a supersede/conflict op set into ONE atomic `$transaction`
 * (KG-2): the successor row, the predecessor retire, and the supersede/
 * contradicts edge either all commit or none do, no crash can orphan an active
 * successor with no supersede link.
 */
type LedgerMemoryNoteInput = MemoryNoteInput & {
  provenance?: { sourceType: string; rawRef?: string | null };
};

function noteCreateOps(
  input: LedgerMemoryNoteInput,
  // A caller threads a SINGLE `now` (F1-sub) so a supersede's predecessor
  // `validTo` and successor `validFrom` are the SAME instant, contiguous
  // half-open valid-time `[validFrom, validTo)` with no window where both notes
  // are active in an as-of view (D2's contiguous ingest-time).
  now: Date = new Date(),
  // R3: the resolved TTL deadline for THIS note, or null when it never expires.
  // Threaded in rather than resolved here, so the one caller that already knows
  // the derived trust AND the author's kind owns the entire eligibility decision.
  expiresAt: Date | null = null,
  // D1: the tracked-file set + the caller's `planned` declaration for THIS write.
  // Threaded in for the same reason `expiresAt` is: obtaining it is an `await`
  // (a `git ls-files` subprocess) and this function must stay synchronous so its
  // ops compose into ONE atomic `$transaction`. Absent → every coordinate lands
  // a NULL resolution, which is the honest answer for a caller that cannot
  // resolve rather than a silent `unresolved`.
  resolver?: CoordinateResolver,
): {
  id: string;
  ops: Prisma.PrismaPromise<unknown>[];
  parsed: ParsedPrincipal;
} {
  const id = `mem-${randomUUID()}`;
  const episodeId = `ep-${randomUUID()}`;
  // D15 (§D15, option B): the coordinate layer fills itself from the note's own
  // prose. A path-shaped token the tracked set CONFIRMS becomes a module anchor,
  // spelled the way the repository spells it. This is the ONE place it happens, so
  // ingest, a clone and a text-edit successor cannot disagree about it — all three
  // already thread a resolver in, and a caller with none (or with a NULL tracked
  // set) promotes nothing.
  const promoted = promoteResolvedPathEntities(input.text, resolver);
  const modules = promoted.modules.length
    ? [...new Set([...effectiveModules(input), ...promoted.modules])]
    : effectiveModules(input);
  const anchors = anchorRowsFor(id, input, modules, resolver);
  // Provenance principal (KG-5): upsert the author IN the same transaction so the
  // note + Episode + Principal land atomically. Note trust DERIVES from the
  // principal's kind-default unless the caller supplied an explicit trust
  // (ingestMemoryNote resolves an already-overridden principal trust first).
  const parsed = parsePrincipal(input.createdBy);
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.episode.create({
      data: {
        id: episodeId,
        sourceType: input.provenance?.sourceType ?? parsed.kind,
        rawRef: input.provenance?.rawRef ?? null,
      },
    }),
    principalUpsertOp(parsed),
    prisma.memoryNote.create({
      data: {
        id,
        kind: input.kind,
        text: input.text,
        textHash: textHash(input.text),
        scope: input.scope ?? "project",
        trust: input.trust ?? parsed.trust,
        createdBy: input.createdBy,
        taskId: input.taskId ?? null,
        laneId: input.laneId ?? null,
        // #126: the per-chat partition key on the durable ledger row (source of
        // truth). Null → a NULL-chat note. Chat-scoped agent reads filter on it.
        chatId: input.chatId ?? null,
        // ADR-0026: the per-workspace partition key on the durable ledger row
        // (source of truth). Null → the §8 residue: an unassigned note, visible to
        // operator-tier reads only and to no agent read or pack export.
        workspacePath: input.workspacePath ?? null,
        // ADR-0012: the note's module scalar includes the AUTO-DERIVED modules of
        // its symbol anchors, so module recall/staleness cover a symbol-anchored note.
        // D15: and the coordinates PROMOTED out of the note's prose, because the
        // scalar is what the mirror projects `n.modules` + `ANCHORED_TO` from, and
        // every read path (recallForGate → preEditContext) reads the mirror.
        modules,
        topics: input.topics ?? [],
        symbols: input.symbols ?? [],
        episodeId,
        recordedAt: now,
        validFrom: now,
        // R3: null for every human-authored / high-trust / policy-off write, so
        // the overwhelmingly common case stays byte-identical to pre-TTL rows.
        expiresAt,
        outcome:
          input.kind === "attempt" &&
          input.outcome &&
          isAttemptOutcome(input.outcome)
            ? input.outcome
            : null,
        derivation:
          input.derivation && isNoteDerivation(input.derivation)
            ? input.derivation
            : null,
      },
    }),
  ];
  if (anchors.length > 0) {
    ops.push(prisma.memoryAnchor.createMany({ data: anchors }));
  }
  return { id, ops, parsed };
}

/**
 * Dedup-aware, ledger-FIRST ingest. Writes the authoritative row(s) to the
 * relational ledger, then mirrors the result into the graph (best-effort). The
 * graph write is never the only record, so a graph wipe loses nothing.
 */
export async function ingestMemoryNote(
  input: LedgerMemoryNoteInput,
  options?: {
    /**
     * ADR-0027 opt-OUT of crew corroboration. Default (omitted) follows the
     * operator posture. A single writer never receives a vouch: two distinct
     * crew principals must support the same normalized claim in one mission.
     *
     * Pack IMPORT passes `false`: a pack is a FOREIGN workspace's claims, not
     * something this crew learned, and it is designed to land unconfirmed until
     * a human HERE admits it. Auto-vouching it would let another workspace write
     * durable crew knowledge into this one with nobody reviewing it.
     */
    orchestratorConfirm?: boolean;
  },
): Promise<MemoryIngestResult> {
  // Compute the note's dense vector OUTSIDE the write-actor mutex (KG-3): a cold
  // embed is a local model call, and holding the mutex across it would stall
  // every other ingest. Cache-first, so a repeat text is instant; no embedder /
  // failure → undefined and dedup + recall stay purely lexical (D3 default).
  const incomingVec = await embedNoteText(input.text);
  // R3: resolve the operator-owned TTL policy OFF the mutex too (a settings read
  // must not serialize behind ingests). An unreadable/malformed policy resolves
  // to null → the note simply never expires, the non-destructive direction.
  const lifecycle = await getMemoryLifecyclePolicy();
  const ingestPolicy = await getMemoryIngestPolicy();
  const ingestDecision = evaluateMemoryIngestPolicy(input.text, ingestPolicy);
  if (!ingestDecision.allowed) {
    throw new Error(ingestDecision.reason);
  }
  // ADR-0027 D12-C: the operator posture enables corroboration, never a single
  // writer's vouch. An unreadable setting resolves false — fail-closed.
  const autoConfirmAgentMemory =
    options?.orchestratorConfirm === false
      ? false
      : await getAutoConfirmAgentMemory();
  // D1: resolve the note's COORDINATES off the mutex too, for the same reason as
  // the three above — this one spawns `git ls-files`, and holding the write actor
  // across a subprocess would serialize every other ingest behind it. It can
  // never throw and never refuses the write: a missing `git`, a non-repo
  // workspace, a timeout or an absent workspace all yield a resolver that labels
  // every coordinate NULL. Resolved BEFORE the mutex and used INSIDE it, so the
  // set is at most one write-actor turn old.
  //
  // D15 rides this same resolver (see `noteCreateOps`), and DELIBERATELY does not
  // reach the DEDUP decision below: `anchorScopedCandidates` and
  // `classifyIncomingNote` keep reading `effectiveModules(input)` — the caller's own
  // coordinates — so what a note MENTIONS never widens the set of notes it can
  // supersede. A supersede RETIRES an existing note, and §D15 is a decision about
  // the coordinate layer, not about which notes are duplicates; letting two notes
  // that merely quote the same file into each other's destructive comparison set is
  // a behaviour change nobody asked for. The consequence is an asymmetry worth
  // knowing about: a promoted anchor IS a real row, so a LATER note that explicitly
  // anchors that file does find this one as a candidate. That direction is the point
  // of D15 (an explicit coordinate is a strong enough claim to dedup on); the
  // inferred one is not, on the side we control.
  const resolver = await coordinateResolverFor(input);

  // Serialized through the single write-actor (KG-2): the whole read-modify-
  // write section runs with no other ingest interleaved, so two concurrent
  // duplicates can never both read "no match" and both insert.
  return runExclusive(async () => {
    // Dedup against the LEDGER (source of truth), scoped by SHARED ANCHOR via the
    // indexed MemoryAnchor table, aged-anchor duplicates/contradictions are caught
    // regardless of how many newer notes exist (F1).
    // P0-2: exact-text idempotency FIRST. A restatement is the same fact by
    // construction, so it NOOPs to the original exactly as any other duplicate
    // verdict does — nothing is retired, no trust is consulted, and a duplicate
    // has never been destructive to the note it matches. Runs inside the write
    // actor, so two concurrent restatements cannot both read "no match".
    const exactDuplicate = await findExactTextDuplicate(input);
    if (exactDuplicate) {
      const promoted = await recordCrewCorroboration(
        exactDuplicate.id,
        input.createdBy,
        autoConfirmAgentMemory,
      );
      const resolved = promoted
        ? await noteRecordById(exactDuplicate.id)
        : exactDuplicate;
      return {
        note: resolved ?? exactDuplicate,
        action: "duplicate",
        relatedNoteId: exactDuplicate.id,
      };
    }
    const existing = await anchorScopedCandidates(input);
    // Dense dedup (KG-3): restore the candidates' vectors from the cache so a
    // PARAPHRASE of an existing note (few shared tokens, high cosine) dedups /
    // supersedes instead of accumulating a near-duplicate, while a genuine
    // contradiction still surfaces as a conflict (polarity gate in classify).
    const candidateVectors = incomingVec
      ? await loadNoteVectors(existing, getEmbedder()?.id)
      : new Map<string, number[]>();
    let verdict = classifyIncomingNote(
      {
        kind: input.kind,
        text: input.text,
        taskId: input.taskId,
        laneId: input.laneId,
        // ADR-0012: dedup against the AUTO-DERIVED module set too, so two notes
        // about the same symbol (hence same derived module) are dedup candidates.
        modules: effectiveModules(input),
        topics: input.topics,
      },
      existing,
      incomingVec
        ? { incoming: incomingVec, byId: (id) => candidateVectors.get(id) }
        : undefined,
    );

    // Trust DERIVATION (KG-5): the note inherits its author principal's CURRENT
    // trust (an already-upserted, possibly human-adjusted principal outranks the
    // kind-default) unless the note supplies an explicit trust. This is BOTH the
    // read KG-6 gates on ("confirmed-only / high-trust") AND the write authority
    // the trust gate below keys on.
    const parsed = parsePrincipal(input.createdBy);
    const existingPrincipal = await prisma.principal.findUnique({
      where: { id: parsed.id },
    });
    const derivedTrust: MemoryTrust = (input.trust ??
      existingPrincipal?.trust ??
      parsed.trust) as MemoryTrust;
    const incomingIsHuman = parsed.kind === "human";

    // ── KG-6 trust gate: governed multi-principal writes ────────────────────
    //
    // Only a SUPERSEDE is destructive to the VICTIM (it retires an existing note),
    // so only a supersede is trust-gated. A `duplicate` is the SAME fact, harmless
    // to the victim, so it ALWAYS NOOP-drops the redundant incoming (below),
    // authorized or not: a low-trust writer can never flood active near-duplicates
    // or unbounded proposals through the duplicate path (F2).
    //
    // A supersede may APPLY only when the writer is AUTHORIZED over the victim
    // (authorizesDestructiveWrite, the pure, shared predicate): the incoming is
    // human-authored, OR its trust ≥ the victim's AND the victim is not
    // human-confirmed. `classifyIncomingNote` stays pure/trust-agnostic; the
    // authoritative confirmed/trust/principal signals are applied HERE. When NOT
    // authorized:
    //   • victim is human-CONFIRMED  → downgrade to the non-destructive `related`
    //     (KG-5's protection, kept: a confirmed fact is never even proposed away,
    //     it can only be superseded by a human refinement, which IS authorized).
    //   • victim is UNCONFIRMED but out-of-reach (higher trust / lower writer) →
    //     record a contestable PROPOSES_SUPERSEDE (KG-6): BOTH notes stay active,
    //     a reconcile is enqueued, and the deferred supersede applies only when a
    //     human (or peer-or-higher-trust principal) confirms it.
    // A same-or-higher-trust writer against an UNCONFIRMED peer still supersedes
    // normally (no over-block).
    let proposeSupersedeVictim: string | null = null;
    if (verdict.action === "supersede") {
      const victimId = verdict.ofNoteId;
      const victim = existing.find((note) => note.id === victimId);
      const victimConfirmed = await isConfirmed(victimId);
      // P1.4 pack-import staging: `proposalOnly` short-circuits authorization so
      // EVERY supersede verdict from an import degrades to the non-destructive
      // branches below (`related` for a confirmed victim, `proposes_supersede` +
      // reconcile for an unconfirmed one) — an import can retire nothing, even a
      // low-trust vs low-trust unconfirmed victim. Absent → unchanged behavior.
      const authorized =
        !input.proposalOnly &&
        authorizesDestructiveWrite({
          incomingTrust: derivedTrust,
          incomingIsHuman,
          existingTrust: (victim?.trust ?? "medium") as MemoryTrust,
          existingConfirmed: victimConfirmed,
        });
      if (!authorized) {
        if (victimConfirmed) {
          verdict = {
            action: "related",
            withNoteId: victimId,
            similarity: verdict.similarity,
          };
        } else {
          proposeSupersedeVictim = victimId;
        }
      }
    }

    // A duplicate is a NOOP: drop the redundant incoming, return the original,
    // regardless of writer trust (a duplicate never touches the victim). This is
    // the pre-KG-6 behaviour and the F2 fix: no duplicate ever becomes a proposal.
    if (verdict.action === "duplicate") {
      const dup = existing.find((note) => note.id === verdict.ofNoteId);
      if (dup) {
        return {
          // D12-C is deliberately narrower than the semantic duplicate
          // classifier: only an exact normalized textHash (handled above) or a
          // future explicitly-approved `extends` relation may corroborate. A
          // fuzzy duplicate is useful dedup evidence, not identity of claims.
          note: dup,
          action: "duplicate",
          relatedNoteId: dup.id,
        };
      }
    }

    // Single `now` (F1-sub): the successor's validFrom/recordedAt and the
    // predecessor's validTo/retiredAt are the SAME instant, so a supersede's
    // valid-time intervals are contiguous (no both-active window in an as-of view).
    const now = new Date();
    // A first proposal is never vouched. It takes the ordinary TTL; a second
    // independent principal may clear that deadline only through D12-C below.
    const { id, ops } = noteCreateOps(
      { ...input, trust: derivedTrust },
      now,
      ttlExpiresAt({
        policy: lifecycle?.policy ?? null,
        kind: input.kind,
        legacyFallbackDays: lifecycle?.legacyFallbackDays,
        authorIsHuman: incomingIsHuman,
        trust: derivedTrust,
        now,
      }),
      resolver,
    );
    // Persist the first principal's support in the SAME transaction as the
    // claim. Without this op, a process exit after note commit but before the
    // follow-up promotion check would permanently lose one side of D12-C.
    const firstSupport = corroborationUpsertOp(
      {
        id,
        textHash: textHash(input.text),
        workspacePath: input.workspacePath ?? null,
        chatId: input.chatId ?? null,
        createdBy: input.createdBy,
      },
      input.createdBy,
      autoConfirmAgentMemory,
    );
    if (firstSupport) {
      ops.push(firstSupport);
    }
    let action: MemoryIngestResult["action"] = "inserted";
    let relatedNoteId: string | undefined;
    let conflictsWith: string | null = null;

    if (proposeSupersedeVictim) {
      // KG-6 gated destructive write: the writer is NOT authorized to retire an
      // UNCONFIRMED higher-trust victim. Do NOT destroy, insert the incoming as a
      // normal ACTIVE note, record a contestable PROPOSES_SUPERSEDE edge, and
      // enqueue a human reconcile. The victim is UNTOUCHED (stays active). The
      // deferred supersede applies only when a human/peer confirms the incoming
      // (updateMemoryNote). ONE transaction so the note never lands without its
      // proposal edge / reconcile, wipe-survivable like every other MemoryEdge.
      relatedNoteId = proposeSupersedeVictim;
      action = "proposed";
      await prisma.$transaction([
        ...ops,
        prisma.memoryEdge.create({
          data: {
            fromId: id,
            toId: proposeSupersedeVictim,
            kind: "proposes_supersede",
          },
        }),
        prisma.confirmation.create({
          data: { noteId: id, principal: "system", decision: "reconcile" },
        }),
      ]);
    } else if (verdict.action === "extends") {
      relatedNoteId = verdict.ofNoteId;
      action = "extended";
      // TODO 4.9: an extension keeps BOTH facts live. The inferred relation and
      // its reconcile marker commit atomically with the new note, so a crash can
      // never leave unlabelled derived structure. Human-confirmed gate authority
      // is unchanged: neither row is confirmed by this verdict.
      await prisma.$transaction([
        ...ops,
        prisma.memoryEdge.create({
          data: { fromId: id, toId: verdict.ofNoteId, kind: "extends" },
        }),
        prisma.confirmation.create({
          data: { noteId: id, principal: "system", decision: "reconcile" },
        }),
      ]);
    } else if (verdict.action === "supersede") {
      relatedNoteId = verdict.ofNoteId;
      action = "superseded";
      // ONE transaction (KG-2): insert successor + retire predecessor + link.
      // A crash can no longer leave an active successor with no supersede edge.
      await prisma.$transaction([
        ...ops,
        prisma.memoryNote.update({
          where: { id: verdict.ofNoteId },
          data: {
            status: "rejected",
            supersededBy: id,
            retiredAt: now,
            validTo: now,
          },
        }),
        prisma.memoryEdge.create({
          data: { fromId: id, toId: verdict.ofNoteId, kind: "supersedes" },
        }),
      ]);
    } else if (verdict.action === "conflict") {
      relatedNoteId = verdict.withNoteId;
      conflictsWith = verdict.withNoteId;
      action = "conflict";
      // Both notes stay active; record the contradiction AND enqueue a human
      // reconciliation, never silently pick a winner (ADR-0009 §Write
      // governance). All in ONE transaction so the successor never lands
      // without its contradicts edge / reconcile confirmation.
      await prisma.$transaction([
        ...ops,
        prisma.memoryEdge.create({
          data: { fromId: id, toId: verdict.withNoteId, kind: "contradicts" },
        }),
        prisma.confirmation.create({
          data: { noteId: id, principal: "system", decision: "reconcile" },
        }),
      ]);
    } else if (verdict.action === "related") {
      relatedNoteId = verdict.withNoteId;
      action = "related";
      // KG-3 F1: a dense-only (lexically-unsupported) high-similarity match,
      // keep BOTH notes active, record a "related"/possible-duplicate edge, and
      // enqueue a human reconcile. Dense similarity ALONE must NEVER reject or
      // drop a note (irreversible loss of a distinct-but-related fact). ONE
      // transaction so the note never lands without its related edge / reconcile.
      await prisma.$transaction([
        ...ops,
        prisma.memoryEdge.create({
          data: { fromId: id, toId: verdict.withNoteId, kind: "related" },
        }),
        prisma.confirmation.create({
          data: { noteId: id, principal: "system", decision: "reconcile" },
        }),
      ]);
    } else {
      await prisma.$transaction(ops);
    }

    await recordCrewCorroboration(id, input.createdBy, autoConfirmAgentMemory);

    const note = (await noteRecordById(id, conflictsWith))!;
    // The just-upserted author principal (authoritative trust) → AUTHORED_BY.
    const authorRow = await prisma.principal.findUnique({
      where: { id: parsed.id },
    });
    const author = authorRow ? toPrincipalRecord(authorRow) : undefined;
    mirrorToGraph(async (graph) => {
      // Project the REAL vector (KG-3) so the graph node's embedding is set (not
      // []), dense recall + dedup now fire on live data. undefined → lexical.
      // The author (KG-5) projects the Principal node + AUTHORED_BY edge.
      await graph.projectMemoryNote(
        note,
        incomingVec,
        author,
        getEmbedder()?.id,
      );
      if (relatedNoteId) {
        // Reproject the PEER endpoint in THIS chain before linking to it. It was
        // written by an earlier ingest whose mirror is a separate, unawaited
        // chain, so an edge that assumed it was already there could silently
        // write nothing (see the clone path for the full reasoning). Idempotent,
        // and `noteRecordById` re-derives confirmed + conflict from the ledger so
        // a re-projection never clobbers either. The `superseded` branch always
        // did this because the predecessor's STATE changed; the other three
        // kinds need it for the endpoint alone.
        const peer = await noteRecordById(relatedNoteId);
        if (peer) {
          await graph.projectMemoryNote(peer);
        }
      }
      if (action === "superseded" && relatedNoteId) {
        await graph.projectMemoryEdge(id, relatedNoteId, "supersedes", {
          awaitEndpoints: true,
        });
      } else if (action === "extended" && relatedNoteId) {
        await graph.projectMemoryEdge(id, relatedNoteId, "extends", {
          awaitEndpoints: true,
        });
      } else if (action === "conflict" && relatedNoteId) {
        // KG-5: a detected contradiction is a first-class CONTRADICTS edge (both
        // notes stay active, human reconciles), non-destructive, like KG-3.
        await graph.projectMemoryEdge(id, relatedNoteId, "contradicts", {
          awaitEndpoints: true,
        });
      } else if (action === "related" && relatedNoteId) {
        await graph.projectMemoryEdge(id, relatedNoteId, "related", {
          awaitEndpoints: true,
        });
      } else if (action === "proposed" && relatedNoteId) {
        // KG-6: a governed, contested destructive write → PROPOSES_SUPERSEDE.
        // Both notes stay active; the victim's own STATE is unchanged, it is
        // reprojected above only so the edge has an endpoint to bind to.
        await graph.projectMemoryEdge(id, relatedNoteId, "proposes_supersede", {
          awaitEndpoints: true,
        });
      }
    }, "memory.ingest");

    return { note, action, relatedNoteId };
  });
}

/**
 * Ledger-first note update: confirm/reject (append-only Confirmation + derived
 * state), trust/status edits, or a text edit (supersede: successor inserted, old
 * retired, history kept). Mirrors the result into the graph.
 */
export async function updateMemoryNote(
  noteId: string,
  update: MemoryNoteUpdate & { pinned?: boolean },
): Promise<MemoryLedgerNote | null> {
  // Also through the write-actor (KG-2): a text-edit is a supersede, the same
  // read-modify-write shape as ingest, so it must not interleave with a
  // concurrent ingest/edit that races on the same note.
  return runExclusive(async () => {
    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    if (!row) {
      return null;
    }
    const now = new Date();

    // Text edit → supersede (Graphiti-style temporal validity: old kept, new wins).
    if (update.text !== undefined && update.text !== row.text) {
      // The successor is a NEW note with new text → embed + cache it (KG-3).
      const successorVec = await embedNoteText(update.text);
      // KG-6 F1: a text-edit confirmation is the CONFIRMING principal's act, not
      // the note author's, default omitted → non-elevating "system", and only a
      // human confirmer elevates / projects CONFIRMED_BY (same rule as the plain
      // confirm route below). Resolved BEFORE the successor is built so the R3
      // TTL below can see whether this edit also confirms.
      const textConfirmer =
        update.confirmed !== undefined
          ? parsePrincipal(update.principal ?? "system")
          : null;
      const textConfirmerIsHuman = textConfirmer?.kind === "human";
      // R3: the successor is a NEW unconfirmed note carrying the PREDECESSOR's
      // author, so it takes the ordinary TTL policy — an operator retyping an
      // agent note does not make that note permanent. A HUMAN confirm in the same
      // request does: the successor lands with no expiry at all, so "confirming
      // clears the expiry" holds on this path too, atomically.
      //
      // ...and so does editing a note a human ALREADY confirmed. Without that
      // second case a typo fix on an adjudicated constraint minted a successor
      // that was unconfirmed by construction, inherited the agent author, and
      // was therefore re-armed with a fresh 30-day deadline — so a
      // human-adjudicated fact quietly disappeared a month after a proofread.
      // The successor deliberately stays UNCONFIRMED (only a human blessing
      // makes THIS text confirmed; the confirmed-only gate is untouched), it
      // simply is not an unreviewed agent guess, which is the only thing the TTL
      // exists to evict. `PATCH /:noteId` is operator-only, so no agent can
      // reach this branch to launder a deadline away.
      const predecessorConfirmations = await prisma.confirmation.findMany({
        where: { noteId },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      });
      const predecessorConfirmed = deriveConfirmedSet(
        predecessorConfirmations,
      ).has(noteId);
      const predecessorPinned = derivePinnedSet(predecessorConfirmations).has(
        noteId,
      );
      const textPinPrincipal =
        update.pinned !== undefined
          ? parsePrincipal(update.principal ?? "system")
          : null;
      if (textPinPrincipal && textPinPrincipal.kind !== "human") {
        throw new Error("Only a human operator may pin or unpin memory.");
      }
      const successorPinned = update.pinned ?? predecessorPinned;
      const successorTrust = (update.trust ?? row.trust) as MemoryTrust;
      const successorLifecycle = await getMemoryLifecyclePolicy();
      const successorExpiresAt =
        (update.confirmed === true && textConfirmerIsHuman) ||
        predecessorConfirmed ||
        successorPinned
          ? null
          : ttlExpiresAt({
              policy: successorLifecycle?.policy ?? null,
              kind: row.kind as MemoryLifecycleKind,
              legacyFallbackDays: successorLifecycle?.legacyFallbackDays,
              authorIsHuman: parsePrincipal(row.createdBy).kind === "human",
              trust: successorTrust,
              now,
            });
      // D1: the successor's coordinates are re-resolved against the predecessor's
      // workspace (the same one it inherits below), carrying the predecessor's
      // `planned` declarations forward — a typo fix must not silently restate the
      // caller's claim as our `unresolved` assertion. A file committed since the
      // predecessor was written now lands `resolved`, which is the point of
      // re-resolving rather than copying the labels.
      const successorResolver = await coordinateResolverFor({
        workspacePath: row.workspacePath,
        plannedCoordinates: await plannedCoordinatesOf(noteId),
      });
      // Single `now` (F1-sub): successor.validFrom === predecessor.validTo, so the
      // valid-time intervals are contiguous (no both-active as-of window).
      const {
        id: successorId,
        ops,
        parsed,
      } = noteCreateOps(
        {
          kind: row.kind as MemoryNoteInput["kind"],
          text: update.text,
          taskId: row.taskId ?? undefined,
          laneId: row.laneId ?? undefined,
          // #126: a text-edit successor inherits the predecessor's chat so an
          // edit never silently moves a note out of its chat partition.
          chatId: row.chatId ?? undefined,
          // ADR-0026: and its workspace, for exactly the same reason. Without
          // this, an operator fixing a typo would drop the successor into the §8
          // residue and take a live fact away from every agent in that repo.
          workspacePath: row.workspacePath ?? undefined,
          // D15: the predecessor's scalar MINUS what the PREDECESSOR's own prose
          // promoted, so `noteCreateOps` can union the NEW text's promoted set
          // onto a clean base. Passing `row.modules` verbatim made the coordinate
          // set monotone — an edit could only ever add anchors — see
          // {@link successorModules} for what that cost and why subtraction is
          // safe. Deliberately NOT applied on the clone path: a clone keeps the
          // source's TEXT, so the subtracted and re-unioned sets are identical and
          // the subtraction would be a no-op there by construction.
          modules: successorModules(
            row.text,
            asStringArray(row.modules),
            successorResolver,
          ),
          topics: asStringArray(row.topics),
          symbols: asStringArray(row.symbols),
          trust: successorTrust as MemoryNoteInput["trust"],
          createdBy: row.createdBy,
          scope: row.scope,
          provenance: {
            sourceType: "edit",
            rawRef: `note:${noteId}`,
          },
        },
        now,
        successorExpiresAt,
        successorResolver,
      );
      const textRejectBind =
        update.confirmed === false && textConfirmer
          ? rejectBindOp(
              {
                id: successorId,
                textHash: textHash(update.text),
                workspacePath: row.workspacePath,
                chatId: row.chatId,
              },
              textConfirmer,
              update.principal ?? "system",
            )
          : null;
      // ONE transaction (KG-2): successor insert + predecessor retire + link
      // (+ optional confirmation) commit atomically, no orphaned successor.
      await prisma.$transaction([
        ...ops,
        prisma.memoryNote.update({
          where: { id: noteId },
          data: {
            status: "rejected",
            supersededBy: successorId,
            retiredAt: now,
            validTo: now,
          },
        }),
        prisma.memoryEdge.create({
          data: { fromId: successorId, toId: noteId, kind: "supersedes" },
        }),
        ...(update.confirmed !== undefined && textConfirmer
          ? [
              principalUpsertOp(textConfirmer),
              prisma.confirmation.create({
                data: {
                  noteId: successorId,
                  principal: update.principal ?? "system",
                  decision: update.confirmed ? "confirm" : "reject",
                },
              }),
            ]
          : []),
        ...(update.pinned !== undefined && textPinPrincipal
          ? [principalUpsertOp(textPinPrincipal)]
          : []),
        ...(successorPinned
          ? [
              prisma.confirmation.create({
                data: {
                  noteId: successorId,
                  principal: update.principal ?? "human",
                  decision: "pin",
                },
              }),
            ]
          : []),
        ...(update.pinned === false && predecessorPinned
          ? [
              prisma.confirmation.create({
                data: {
                  noteId,
                  principal: update.principal ?? "human",
                  decision: "unpin",
                },
              }),
            ]
          : []),
        ...(textRejectBind ? [textRejectBind] : []),
      ]);
      const successor = await noteRecordById(successorId);
      const authorRow = await prisma.principal.findUnique({
        where: { id: parsed.id },
      });
      const author = authorRow ? toPrincipalRecord(authorRow) : undefined;
      // AWAITED, unlike every other mirror on this path, because this one
      // change is visible in TWO stores at different speeds. The predecessor
      // retires inside the transaction above — instantly, in the ledger — while
      // the successor's anchors only reach the graph when the mirror lands. In
      // between, an edit-boundary gate on that ground returned NEITHER note:
      // measured at ~50ms, deterministic, and long enough for an agent's
      // preflight to land in it. An operator fixing a typo would have taken the
      // finding off its ground for that window, which is the opposite of what
      // editing a finding means.
      //
      // So the PATCH answers only once the corrected note is readable. This is
      // an operator action, not an ingest on the hot path, and the mirror keeps
      // its never-throws contract: a graph failure still degrades to a reported
      // mirror failure rather than failing the edit.
      await awaitMirrorBounded(
        mirrorToGraphNow(async (graph) => {
          // RE-READ, never the record captured before the wait — the same rule
          // the predecessor below already follows.
          //
          // Past the 2s budget this callback keeps running while the write
          // actor moves on, so a second edit can supersede this successor and
          // mirror that fact FIRST. Projecting the captured row would then put
          // a retired note back into the graph as live, and the edit-boundary
          // gate reads the graph — which is the exact failure the awaited
          // mirror was added to prevent, re-introduced on its slow path.
          const successorNow = await noteRecordById(successorId);
          if (successorNow) {
            await graph.projectMemoryNote(
              successorNow,
              successorVec,
              author,
              getEmbedder()?.id,
            );
          }
          const predecessor = await noteRecordById(noteId);
          if (predecessor) {
            await graph.projectMemoryNote(predecessor);
          }
          await graph.projectMemoryEdge(successorId, noteId, "supersedes", {
            awaitEndpoints: true,
          });
          // KG-6: a HUMAN-confirmed text-edit records CONFIRMED_BY on the successor.
          if (
            update.confirmed === true &&
            textConfirmerIsHuman &&
            textConfirmer
          ) {
            await graph.projectPrincipal(derivedPrincipalRecord(textConfirmer));
            await graph.projectConfirmedBy(successorId, textConfirmer.id);
          }
        }, "memory.text-edit"),
      );
      return successor;
    }

    // KG-6 F1: parse the confirming principal FIRST. A `confirmed` decision is a
    // HUMAN governance act. An OMITTED principal defaults to a NON-elevating
    // "system" principal (NEVER auto-human), and ONLY a human principal flips a
    // note's confirmed state, clears its staleness, projects a CONFIRMED_BY, or
    // applies a deferred proposal. An agent honestly identifying as `agent:x` (or
    // an unauthenticated omitted caller) can NEVER self-confirm a note into the
    // gate. The Confirmation row keeps the real (or "system") principal for audit,
    // but isConfirmed/deriveConfirmedSet count HUMAN rows only → a non-human
    // "confirm" is inert. (Spoofing a `human:*` principal STRING is the
    // declared-trust/authn boundary explicitly deferred to P3, see ADR-0009.)
    let confirmer: ParsedPrincipal | null = null;
    let confirmerIsHuman = false;
    if (update.confirmed !== undefined) {
      confirmer = parsePrincipal(update.principal ?? "system");
      confirmerIsHuman = confirmer.kind === "human";
    }

    const data: Prisma.MemoryNoteUpdateInput = {};
    let pinPrincipal: ParsedPrincipal | null = null;
    if (update.pinned !== undefined) {
      pinPrincipal = parsePrincipal(update.principal ?? "system");
      if (pinPrincipal.kind !== "human") {
        throw new Error("Only a human operator may pin or unpin memory.");
      }
      if (update.pinned) {
        data.expiresAt = null;
        data.expiredAt = null;
      } else {
        const currentConfirmations = await prisma.confirmation.findMany({
          where: { noteId },
          orderBy: [{ at: "asc" }, { id: "asc" }],
        });
        const lifecycle = await getMemoryLifecyclePolicy();
        data.expiresAt = ttlExpiresAt({
          policy: lifecycle?.policy ?? null,
          kind: row.kind as MemoryLifecycleKind,
          legacyFallbackDays: lifecycle?.legacyFallbackDays,
          authorIsHuman: parsePrincipal(row.createdBy).kind === "human",
          confirmed: deriveConfirmedSet(currentConfirmations).has(noteId),
          trust: (update.trust ?? row.trust) as MemoryTrust,
          now,
        });
        data.expiredAt = null;
      }
    }
    if (update.trust !== undefined) {
      data.trust = update.trust;
      // R3: "a high-trust note never auto-expires" is a LIVE invariant, not just
      // an ingest-time one. An operator raising a note to high trust must clear
      // any stamped deadline, otherwise the note would still vanish from recall
      // while every surface reported it as high-trust and permanent.
      if (update.trust === "high") {
        data.expiresAt = null;
        data.expiredAt = null;
      }
    }
    if (update.status !== undefined) {
      data.status = update.status;
      if (update.status === "rejected") {
        data.retiredAt = now;
        data.validTo = now;
      } else {
        data.retiredAt = null;
        data.validTo = null;
      }
    }
    // A HUMAN confirmation clears suspicion (staleness); a non-human/omitted one
    // does not (it never elevated the note in the first place).
    if (update.confirmed === true && confirmerIsHuman) {
      data.staleSince = null;
      // R3: confirming CLEARS the expiry — the note has earned permanence, and
      // the sweeper's materialized marker is cleared with it so an already-swept
      // note is genuinely redeemed rather than merely un-deadlined. Gated on
      // `confirmerIsHuman` for the same reason `confirmed` is: an agent (or an
      // omitted → "system") confirm is inert everywhere else, and letting it
      // clear an expiry would be exactly the self-confirm side channel that has
      // been closed twice already.
      data.expiresAt = null;
      data.expiredAt = null;
    }
    if (update.outcome !== undefined) {
      if (update.outcome !== null && !isAttemptOutcome(update.outcome)) {
        throw new Error(
          "outcome must be worked, abandoned, superseded, or unknown",
        );
      }
      data.outcome = update.outcome;
    }
    if (update.reviewStatus !== undefined) {
      if (
        update.reviewStatus !== null &&
        !isNoteReviewStatus(update.reviewStatus)
      ) {
        throw new Error("reviewStatus must be pending, reviewed, or deferred");
      }
      data.reviewStatus = update.reviewStatus;
    }
    if (update.derivation !== undefined) {
      if (update.derivation !== null && !isNoteDerivation(update.derivation)) {
        throw new Error("derivation must be authored or inferred");
      }
      data.derivation = update.derivation;
    }
    if (Object.keys(data).length > 0) {
      if (update.pinned !== undefined && pinPrincipal) {
        await prisma.$transaction([
          prisma.memoryNote.update({ where: { id: noteId }, data }),
          principalUpsertOp(pinPrincipal),
          prisma.confirmation.create({
            data: {
              noteId,
              principal: update.principal ?? "human",
              decision: update.pinned ? "pin" : "unpin",
            },
          }),
        ]);
      } else {
        await prisma.memoryNote.update({ where: { id: noteId }, data });
      }
    }

    // KG-6 supersede-proposed resolution: a decision on a note that AUTHORED a
    // PROPOSES_SUPERSEDE resolves that proposal. Only an EXPLICIT, authorized
    // confirmer (a human, OR a peer-or-higher-trust principal over the victim)
    // may APPLY the deferred supersede (retire victim + swap the proposal edge to
    // a real `supersedes`); a reject drops the proposal and keeps the victim. An
    // OMITTED principal never resolves a proposal (leaves it pending). Ledger-first.
    const appliedVictims: string[] = [];
    const droppedVictims: string[] = [];
    if (update.confirmed !== undefined && confirmer) {
      const confirmerRaw = update.principal ?? "system";
      const confirmerRow = await prisma.principal.findUnique({
        where: { id: confirmer.id },
      });
      const confirmerTrust: MemoryTrust = (confirmerRow?.trust ??
        confirmer.trust) as MemoryTrust;

      const proposals =
        update.principal !== undefined
          ? await prisma.memoryEdge.findMany({
              where: { fromId: noteId, kind: "proposes_supersede" },
            })
          : [];

      const txnOps: Prisma.PrismaPromise<unknown>[] = [
        principalUpsertOp(confirmer),
        prisma.confirmation.create({
          data: {
            noteId,
            principal: confirmerRaw,
            decision: update.confirmed ? "confirm" : "reject",
          },
        }),
      ];
      if (update.confirmed === false && confirmerIsHuman) {
        const bind = rejectBindOp(row, confirmer, confirmerRaw);
        if (bind) {
          txnOps.push(bind);
        }
      }

      for (const proposal of proposals) {
        const victimId = proposal.toId;
        if (update.confirmed === true) {
          // Only a human OR a peer-or-higher-trust principal may APPLY it.
          const victim = await prisma.memoryNote.findUnique({
            where: { id: victimId },
          });
          const victimTrust = (victim?.trust ?? "medium") as MemoryTrust;
          const authorized =
            confirmerIsHuman ||
            trustRank(confirmerTrust) >= trustRank(victimTrust);
          if (!authorized || !victim || victim.status !== "active") {
            continue; // stays pending (unauthorized) or already resolved
          }
          appliedVictims.push(victimId);
          txnOps.push(
            // Retire the victim, the confirmed note is now its successor.
            prisma.memoryNote.update({
              where: { id: victimId },
              data: {
                status: "rejected",
                supersededBy: noteId,
                retiredAt: now,
                validTo: now,
              },
            }),
            // Swap the contested proposal for a real supersede link.
            prisma.memoryEdge.deleteMany({
              where: {
                fromId: noteId,
                toId: victimId,
                kind: "proposes_supersede",
              },
            }),
            prisma.memoryEdge.create({
              data: { fromId: noteId, toId: victimId, kind: "supersedes" },
            }),
          );
        } else {
          // Reject → drop the proposal, keep the victim active (untouched).
          droppedVictims.push(victimId);
          txnOps.push(
            prisma.memoryEdge.deleteMany({
              where: {
                fromId: noteId,
                toId: victimId,
                kind: "proposes_supersede",
              },
            }),
          );
        }
      }

      await prisma.$transaction(txnOps);
    }

    const note = await noteRecordById(noteId);
    // DRAIN THE IN-FLIGHT MIRRORS FIRST, for the same reason the hard delete does
    // (see `deleteMemoryNoteRow`) — and the confirm case is worse than the delete
    // case, because it is silent.
    //
    // Every mirror chain carries a SNAPSHOT of the note taken when the chain was
    // created. This note's own ingest/edit projection rides an unawaited chain
    // holding `confirmed: false`; the chain created below holds `confirmed: true`.
    // If the older one lands second, the MIRROR ends up less confirmed than the
    // ledger — and `recallForGate` reads the mirror, so a human-confirmed,
    // module-anchored note is withheld from the confirmed-only gate with nothing
    // reporting it, until the next boot reproject. That is exactly the "the gate
    // returns nothing" failure D15 measured away, arriving from another direction.
    //
    // Measured: 3 failures in 20 runs of an unrelated suite before this line, and
    // deterministically reproducible by delaying the first projection
    // (`memory-mirror-confirm-race.test.ts`).
    //
    // CONSIDERED AND NOT CHOSEN: making every chain re-read the note from the
    // ledger at projection time instead of carrying a snapshot. That fixes the
    // whole class rather than this instance and needs no drain, but it adds a query
    // to every projection and rewrites ~14 call sites — a bigger change than the
    // one precedent already sanctions. If a third instance of this shape appears,
    // that is the fix to make.
    //
    // COST, stated: this awaits inside the write actor, so a slow graph write
    // briefly blocks memory writes. Bounded by one round of in-flight chains (and
    // `MAX_MIRROR_DRAIN_ROUNDS`), and a confirm is a human action. The delete path
    // already accepts the same cost.
    await awaitGraphMirrors();
    mirrorToGraph(async (graph) => {
      if (note) {
        // Pausing preserves the human verdict in the ledger, but the graph's
        // boolean is gate-facing. A live pause must match wipe+reproject: retain
        // CONFIRMED_BY provenance, withhold confirmed authority until resume.
        await graph.projectMemoryNote(
          note.status === "paused" ? { ...note, confirmed: false } : note,
        );
      }
      // CONFIRMED_BY is a HUMAN blessing (KG-6 F1): only project it for a human
      // confirmer, an agent/system "confirm" never produces a provenance edge.
      if (confirmer && confirmerIsHuman && update.confirmed === true) {
        await graph.projectPrincipal(derivedPrincipalRecord(confirmer));
        await graph.projectConfirmedBy(noteId, confirmer.id);
      }
      // KG-6: reflect a resolved proposal in the graph, retired victims + the
      // proposal→supersedes edge swap (reprojecting the retired victim so the read
      // path/gate sees it inactive). The graph is a projection; the ledger already
      // holds the authoritative post-resolution state, so a wipe restores it.
      for (const victimId of appliedVictims) {
        const victim = await noteRecordById(victimId);
        if (victim) {
          await graph.projectMemoryNote(victim);
        }
        // Swap the contested proposal for the real supersede link on the LIVE
        // graph too (the ledger already did the swap; a full reproject would show
        // only SUPERSEDES).
        await graph.deleteMemoryEdge(noteId, victimId, "proposes_supersede");
        await graph.projectMemoryEdge(noteId, victimId, "supersedes", {
          awaitEndpoints: true,
        });
      }
      // Dropped proposals: the PROPOSES_SUPERSEDE row is gone from the ledger; a
      // targeted delete keeps the live graph honest without a full reproject.
      for (const victimId of droppedVictims) {
        await graph.deleteMemoryEdge(noteId, victimId, "proposes_supersede");
      }
    }, "memory.govern");
    return note;
  });
}

// ── ADR-0026 §11: the operator opt-in for the RESIDUE ────────────────────────
//
// `0041_memory_note_workspace` backfilled every note whose two witnesses
// (`taskId → Task.workspacePath`, corroborated by
// `chatId → OrchestratorChat.workspacePath`) agreed, and deliberately left the
// rest NULL — a witness disagreement is a fact about the brain and must not be
// resolved by silently preferring one witness.
//
// That residue is not permanent. A `Task` pruned on some other install can be
// restored, a chat can be re-bound, and a disagreement can be adjudicated. So the
// join is re-runnable on demand, operator-only, and DRY-RUN BY DEFAULT: it
// reports what it would write before it writes anything, because a partition
// assignment is what decides which agents can be told a fact.
//
// Two differences from the migration, both deliberate:
//   • The value is put through `repoRootOf`, so a residue note lands on exactly
//     the key an agent WRITE would derive today. Raw SQL could not do that, and a
//     witness value that differs from the runtime identity only in case or in a
//     worktree tail would otherwise mint a second island for the same repo.
//   • The `kind:"workspace"` anchor row and the graph mirror are written too, so
//     a repaired note is indistinguishable from one written after the migration.
//
// Deliberately NOT here: assigning an unscoped note to an operator-NAMED
// workspace. §15 records that an operator's workspace coordinate is unauthenticated
// on a direct HTTP write, exactly as `chatId` is, and that belongs with the read
// surfaces (§11 step 4) where the coordinate is validated on every surface. This
// function only ever re-derives from state MUON already recorded.
//
// ── AND THE SECOND CLASS: 0041's RAW witness values (the MIS-KEYED partition) ──
//
// The migration copied `Task.workspacePath` / `OrchestratorChat.workspacePath`
// VERBATIM, because raw SQL cannot call `repoRootOf`. Every read derives its key
// through `repoRootOf` instead — which strips a `.muon/worktrees/<taskId>` tail,
// resolves symlinks, and case-corrects against the filesystem. So a witness that
// was a worktree path, a case variant, a symlinked spelling or trailing-slashed
// produced a stored partition NO READ COORDINATE CAN NAME: those notes are
// invisible to every agent read and non-exportable by every pack, silently, and
// nothing counts them.
//
// The NULL-class scan above cannot reach them — its query is
// `where: { workspacePath: null }` and 0041 already assigned these rows — so this
// is a second pass with its own predicate (`workspacePath !== repoRootOf(...)`) and
// its own counters. THE MIGRATION IS NOT THE PLACE TO FIX IT: 0041 has run on every
// install that has one, rewriting a shipped migration changes nothing already
// applied, and `ensureSchema` would not re-run it.
//
// BOUNDED BY DISTINCT PARTITION, not by note. `repoRootOf` is async, spawns
// `git rev-parse` and walks the filesystem one segment at a time; running it per
// ROW would make an operator's repair scale with the size of the brain. The scan
// therefore groups first, canonicalizes ONCE per distinct stored value (sharing the
// SAME memo as the NULL class, so a value in both costs one probe), and only then
// fetches the note ids of the partitions that actually move. On a healthy install
// — the founder's, where all six witness values are already canonical — this PASS
// is one grouped count and six memoized probes, and it reads no note rows at all.
//
// TWO THINGS IT DOES NOT DO, both on purpose. It never MERGES the note bodies when
// two stored partitions canonicalize to one key (retire-never-delete; the notes
// simply land in the same partition and dedup is not this function's job), and it
// never touches a row whose stored value already IS its own `repoRootOf` — the
// reduction is idempotent, so re-running is free.

export type MemoryWorkspaceBackfillResult = {
  /** Notes still carrying no workspace when the scan started. */
  scanned: number;
  /** Rows written (`apply: true`), or resolvable rows (`apply: false`). */
  written: number;
  /** Left NULL: neither witness resolves. */
  noWitness: number;
  /** Left NULL: the two witnesses resolve and DISAGREE. */
  disagreed: number;
  /** Whether anything was actually written. */
  applied: boolean;
  /** Resolvable counts per canonical workspace, for the operator's review. */
  byWorkspace: { workspacePath: string; notes: number }[];
  /** The disagreeing notes, so a human can adjudicate them by hand. */
  conflicts: { noteId: string; fromTask: string; fromChat: string }[];
  /**
   * The SECOND class, reported apart from the NULL one because it is a different
   * defect with a different remedy: rows 0041 ASSIGNED, to a raw witness value that
   * no `repoRootOf`-derived read coordinate can name.
   */
  rekeyed: {
    /**
     * Distinct non-NULL stored partitions examined (one `repoRootOf` each).
     * Counted BEFORE this run's NULL-class writes land, so a partition the residue
     * pass is about to create is not in it — and does not need to be, because that
     * pass already writes `repoRootOf`'s answer.
     */
    partitionsScanned: number;
    /** Of those, how many are not their own `repoRootOf`. */
    partitionsMisKeyed: number;
    /** Notes carrying one: re-keyed (`apply: true`) or re-keyable (`false`). */
    notes: number;
    /** Every move, so an operator sees exactly which key becomes which. */
    moves: { from: string; to: string; notes: number }[];
  };
};

export async function backfillMemoryNoteWorkspace(
  options: { apply?: boolean } = {},
): Promise<MemoryWorkspaceBackfillResult> {
  const apply = options.apply === true;
  const rows = await prisma.memoryNote.findMany({
    where: { workspacePath: null },
    select: { id: true, taskId: true, chatId: true },
    orderBy: { recordedAt: "asc" },
  });
  const taskIds = [
    ...new Set(
      rows.map((row) => row.taskId).filter((id): id is string => !!id),
    ),
  ];
  const chatIds = [
    ...new Set(
      rows.map((row) => row.chatId).filter((id): id is string => !!id),
    ),
  ];
  const [tasks, chats] = await Promise.all([
    taskIds.length
      ? prisma.task.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, workspacePath: true },
        })
      : Promise.resolve([]),
    chatIds.length
      ? prisma.orchestratorChat.findMany({
          where: { id: { in: chatIds } },
          select: { id: true, workspacePath: true },
        })
      : Promise.resolve([]),
  ]);
  const taskWitness = new Map(
    tasks
      .filter((task) => task.workspacePath)
      .map((task) => [task.id, task.workspacePath!]),
  );
  const chatWitness = new Map(
    chats
      .filter((chat) => chat.workspacePath)
      .map((chat) => [chat.id, chat.workspacePath]),
  );

  const resolvable: { noteId: string; workspacePath: string }[] = [];
  const conflicts: MemoryWorkspaceBackfillResult["conflicts"] = [];
  let noWitness = 0;
  // One `repoRootOf` per DISTINCT witness value (it memoizes internally, but the
  // residue can be large and this keeps the git probe count at O(workspaces)).
  const canonical = new Map<string, string>();
  const canonicalize = async (raw: string): Promise<string> => {
    const hit = canonical.get(raw);
    if (hit !== undefined) {
      return hit;
    }
    const resolved = await repoRootOf(raw);
    canonical.set(raw, resolved);
    return resolved;
  };

  for (const row of rows) {
    const fromTask = row.taskId ? taskWitness.get(row.taskId) : undefined;
    const fromChat = row.chatId ? chatWitness.get(row.chatId) : undefined;
    if (!fromTask && !fromChat) {
      noWitness += 1;
      continue;
    }
    // Compare CANONICALIZED witnesses: two spellings of one repo are agreement,
    // not a conflict, and reporting them as a conflict would send an operator to
    // adjudicate a difference that does not exist.
    const taskKey = fromTask ? await canonicalize(fromTask) : undefined;
    const chatKey = fromChat ? await canonicalize(fromChat) : undefined;
    if (taskKey && chatKey && taskKey !== chatKey) {
      conflicts.push({
        noteId: row.id,
        fromTask: taskKey,
        fromChat: chatKey,
      });
      continue;
    }
    resolvable.push({ noteId: row.id, workspacePath: (taskKey ?? chatKey)! });
  }

  // The MIS-KEYED class. Grouped, so the probe count is O(distinct partitions)
  // rather than O(notes) — see the header. `groupBy` also means a healthy install
  // reads no note rows here at all.
  const partitions = await prisma.memoryNote.groupBy({
    by: ["workspacePath"],
    where: { workspacePath: { not: null } },
    _count: { _all: true },
  });
  const moves: MemoryWorkspaceBackfillResult["rekeyed"]["moves"] = [];
  let partitionsScanned = 0;
  for (const partition of partitions) {
    const from = partition.workspacePath;
    if (!from) {
      continue; // belt-and-braces: the `where` already excludes NULL
    }
    partitionsScanned += 1;
    const to = await canonicalize(from);
    if (to === from) {
      continue; // already the key every read derives — the reduction is idempotent
    }
    moves.push({ from, to, notes: partition._count._all });
  }

  if (apply) {
    for (const entry of resolvable) {
      await prisma.$transaction([
        prisma.memoryNote.update({
          where: { id: entry.noteId },
          data: { workspacePath: entry.workspacePath },
        }),
        // The same anchor row 0041 minted for every backfilled note. An `upsert`
        // on `(noteId, kind, value)` rather than a `create`, so a re-run is
        // idempotent (SQLite has no `createMany({ skipDuplicates })`).
        prisma.memoryAnchor.upsert({
          where: {
            noteId_kind_value: {
              noteId: entry.noteId,
              kind: "workspace",
              value: entry.workspacePath,
            },
          },
          create: {
            noteId: entry.noteId,
            kind: "workspace",
            value: entry.workspacePath,
          },
          update: {},
        }),
      ]);
      const note = await noteRecordById(entry.noteId);
      if (note) {
        mirrorToGraph(
          (graph) => graph.projectMemoryNote(note),
          "memory.backfill-workspace",
        );
      }
    }
    for (const move of moves) {
      const misKeyed = await prisma.memoryNote.findMany({
        where: { workspacePath: move.from },
        select: { id: true },
        orderBy: { recordedAt: "asc" },
      });
      for (const row of misKeyed) {
        await prisma.$transaction([
          prisma.memoryNote.update({
            where: { id: row.id },
            data: { workspacePath: move.to },
          }),
          // The STALE anchor has to GO, not just be joined by a canonical sibling.
          // `kind:"workspace"` is an indexed coordinate, and leaving 0041's raw
          // value behind would keep the note reachable through a key the note no
          // longer belongs to — the same invisibility defect pointed the other way.
          prisma.memoryAnchor.deleteMany({
            where: { noteId: row.id, kind: "workspace", value: move.from },
          }),
          // `upsert`, not `create`: a note can already carry the canonical anchor
          // (0041 minted one per backfilled note, and a later write mints another),
          // and `(noteId, kind, value)` is unique.
          prisma.memoryAnchor.upsert({
            where: {
              noteId_kind_value: {
                noteId: row.id,
                kind: "workspace",
                value: move.to,
              },
            },
            create: { noteId: row.id, kind: "workspace", value: move.to },
            update: {},
          }),
        ]);
        const note = await noteRecordById(row.id);
        if (note) {
          mirrorToGraph(
            (graph) => graph.projectMemoryNote(note),
            "memory.backfill-workspace",
          );
        }
      }
    }
  }

  const byWorkspace = new Map<string, number>();
  for (const entry of resolvable) {
    byWorkspace.set(
      entry.workspacePath,
      (byWorkspace.get(entry.workspacePath) ?? 0) + 1,
    );
  }
  return {
    scanned: rows.length,
    written: resolvable.length,
    noWitness,
    disagreed: conflicts.length,
    applied: apply,
    byWorkspace: [...byWorkspace.entries()]
      .map(([workspacePath, notes]) => ({ workspacePath, notes }))
      .sort(
        (a, b) =>
          b.notes - a.notes || (a.workspacePath < b.workspacePath ? -1 : 1),
      ),
    conflicts,
    rekeyed: {
      partitionsScanned,
      partitionsMisKeyed: moves.length,
      notes: moves.reduce((total, move) => total + move.notes, 0),
      moves: moves.sort(
        (a, b) => b.notes - a.notes || (a.from < b.from ? -1 : 1),
      ),
    },
  };
}

// ── Reinforcement OFF the read path (ADR-0009 §2.4 / KG-2) ───────────────────
//
// Reads (searchMemory/relatedToTask) NO LONGER reinforce, a search that merely
// RETRIEVES a note is not a search that USED it (retrieved ≠ used), and writing
// on every read amplifies reads into writes. Instead an EXPLICIT used-signal (a
// note actually cited/applied) is buffered in the graph and flushed on a
// timer/shutdown; the flushed accessCount/lastUsedAt are written back to the
// durable ledger so reinforcement SURVIVES a store wipe (closes KG-1 F3). The
// buffered count is time-decayed on flush (recent usefulness, not lifetime).

/**
 * Record an EXPLICIT used-signal for one or more notes. Buffered in memory
 * (in the graph), NOT written synchronously, so it is safe to call on a hot
 * path. `flushMemoryReinforcement` (timer/shutdown) makes it durable.
 */
export function recordMemoryUsed(noteIds: string[]): void {
  if (noteIds.length === 0) {
    return;
  }
  try {
    getGraph().markMemoryUsed(noteIds);
  } catch {
    // A degraded graph must never fail a caller, the signal is a ranking hint.
  }
}

/** The graph's flushReinforcement empties its buffer SYNCHRONOUSLY at its start,
 *  so a second flush racing the first would see an empty buffer, return 0, and
 *  let shutdown proceed to closeGraph/$disconnect while the first flush is still
 *  mid ledger-write (F2). This coalesces concurrent callers onto the SAME
 *  in-flight run, so `stopReinforcementFlush` awaits the real writes. */
let flushInFlight: Promise<number> | null = null;

/**
 * Flush buffered used-signals: apply them to the graph (with time-decay) and
 * persist the new accessCount/lastUsedAt to the DURABLE ledger so they survive a
 * store wipe (the projector restores them on reproject). Best-effort end to end
 *, a soft signal never fails the process. Returns how many notes were updated.
 * Reentrancy-safe: a concurrent call returns the in-flight flush (F2).
 */
export function flushMemoryReinforcement(): Promise<number> {
  if (flushInFlight) {
    return flushInFlight;
  }
  flushInFlight = doFlushMemoryReinforcement().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function doFlushMemoryReinforcement(): Promise<number> {
  let applied: { noteId: string; accessCount: number; lastUsedAt: string }[] =
    [];
  try {
    applied = await getGraph().flushReinforcement();
  } catch {
    return 0;
  }
  for (const signal of applied) {
    await prisma.memoryNote
      .update({
        where: { id: signal.noteId },
        data: {
          accessCount: signal.accessCount,
          lastUsedAt: new Date(signal.lastUsedAt),
        },
      })
      // The note may have been retired/removed between use and flush, the soft
      // signal is disposable, so skip rather than throw.
      .catch(() => undefined);
  }
  return applied.length;
}

let reinforcementTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic reinforcement flush (idempotent). Unref'd so it never
 *  keeps the process alive on its own. */
export function startReinforcementFlush(intervalMs = 30_000): void {
  if (reinforcementTimer) {
    return;
  }
  reinforcementTimer = setInterval(() => {
    void flushMemoryReinforcement();
  }, intervalMs);
  reinforcementTimer.unref?.();
}

/** Stop the flush timer AND drain any buffered signals (call on shutdown). The
 *  first flush awaits any in-flight timer-fired run (coalesced via flushInFlight)
 *  so shutdown never races an ongoing ledger write; the second drains anything
 *  buffered while the first was running. */
export async function stopReinforcementFlush(): Promise<void> {
  if (reinforcementTimer) {
    clearInterval(reinforcementTimer);
    reinforcementTimer = null;
  }
  await flushMemoryReinforcement();
  await flushMemoryReinforcement();
}

/**
 * Persist module-touch STALENESS to the ledger (source of truth) so it survives
 * a graph wipe (KG-2 / F3). Mirrors graph.touchModules' rule: an active note
 * anchored to a touched module and written BEFORE the touch becomes suspect
 * (`staleSince` set once, never destroyed). The projector restores it; the
 * graph mirror stays best-effort in the caller.
 */
export async function markModulesStale(
  modules: string[],
  timestamp: Date,
  /**
   * The task whose OWN observed edit produced this staleness signal. Its own
   * notes are exempt: a note a task writes about the change it is making is
   * DESCRIBED BY that change, not contradicted by it — without this, the
   * runner's "touched N file(s)" report stale-marked the implementer's fresh
   * constraint ~1 minute after it was written (mission 420c8bf4), and every
   * mission-authored note aged out of trust before its mission even ended.
   * A DIFFERENT task editing the same module is still the true signal and
   * still marks.
   */
  exemptTaskId?: string,
): Promise<void> {
  if (modules.length === 0) {
    return;
  }
  const anchors = await prisma.memoryAnchor.findMany({
    where: { kind: "module", value: { in: modules } },
    select: { noteId: true },
  });
  const ids = [...new Set(anchors.map((anchor) => anchor.noteId))];
  if (ids.length === 0) {
    return;
  }
  await prisma.memoryNote.updateMany({
    where: {
      id: { in: ids },
      status: "active",
      staleSince: null,
      validFrom: { lt: timestamp },
      // NULL-safe exemption: Prisma's `NOT: { taskId: X }` (three-valued SQL)
      // also excludes rows where taskId IS NULL — which would silently exempt
      // every human/operator-authored note from ledger staleness forever,
      // while the graph witness (taskId ?? "" projection) still marked them:
      // the exact ledger/mirror divergence resolveStale exists to survive,
      // created by the exemption itself. A task-less note is never "the
      // touching task's own" and must stay markable.
      ...(exemptTaskId
        ? {
            OR: [{ taskId: null }, { NOT: { taskId: exemptTaskId } }],
          }
        : {}),
    },
    data: { staleSince: timestamp },
  });
}

/**
 * P0-2 — the orchestrator's own confirming principal for one dispatched job.
 *
 * `parsePrincipal` reads this as kind `agent` (it is one), so it can never be
 * mistaken for a human anywhere `isHumanPrincipal` / `deriveConfirmedSet` looks.
 * That is the whole point: the crew's coordinator vouches for what the crew
 * learned so the operator owes no review, and the ledger still records WHO
 * vouched. A confirmation attributed to a human who never looked would be a lie
 * in the audit trail and would quietly re-tier every provenance surface built on
 * human-only confirmation (pack export, global-scope promotion, the KG-6
 * destructive-write protection, the merge attestation).
 */
export function orchestratorConfirmingPrincipal(jobId: string | null): string {
  return `agent:orchestrator:corroborated:${
    jobId && jobId.trim() ? jobId.trim() : "session"
  }`;
}

/**
 * The ONE derivation of "which of these notes is HUMAN-confirmed", exported so a
 * route cannot grow a second, subtly different one.
 *
 * `POST /used` had exactly that: it took the latest decision of ANY principal,
 * so an orchestrator vouch read as `confirmed` there and nowhere else — and its
 * `scope === "global" && confirmed` clause then admitted a vouched global note
 * for CROSS-PARTITION reinforcement. Ranking-only in effect, but `confirmed`
 * must mean one thing everywhere or the next surface to read it inherits the
 * divergence.
 */
export function deriveConfirmedNoteIds(
  confirmations: { noteId: string; principal: string; decision: string }[],
): Set<string> {
  return deriveConfirmedSet(confirmations);
}

/** True for a principal minted by {@link orchestratorConfirmingPrincipal}. */
export function isOrchestratorPrincipal(raw: string | undefined): boolean {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .startsWith("agent:orchestrator:corroborated:");
}

/**
 * P0-2 — a FOREIGN workspace's author (`pack:<fingerprint>`, memory-pack-import).
 * `parsePrincipal` reads it as an agent, correctly (a machine wrote it), which is
 * exactly why this second predicate has to exist: "an agent wrote it" and "MY
 * crew learned it" are different facts, and only the second one the orchestrator
 * may vouch for. Import already opts out explicitly; this makes the exclusion
 * STRUCTURAL, so a future creation path cannot re-open it by forgetting to.
 */
function isForeignPackPrincipal(raw: string): boolean {
  return raw.trim().toLowerCase().startsWith("pack:");
}

/**
 * P0-2 — is this note something THIS crew learned, and therefore something the
 * Which principal may contribute crew corroboration? Agent-authored, but never
 * a foreign pack identity. Human authorship remains a separate authority tier.
 */
function crewAuthoredNote(createdBy: string): boolean {
  return (
    parsePrincipal(createdBy).kind === "agent" &&
    !isForeignPackPrincipal(createdBy)
  );
}

/**
 * ADR-0027 — ledger ops for the coordinator's attributed D12-C vouch. These are
 * called only after the durable support count reaches the independent-principal
 * threshold and no mission-scoped human reject bind exists.
 */
function orchestratorVouchOps(
  noteId: string,
  jobId: string | null,
): Prisma.PrismaPromise<unknown>[] {
  const principal = orchestratorConfirmingPrincipal(jobId);
  return [
    principalUpsertOp(parsePrincipal(principal)),
    prisma.confirmation.create({
      data: { noteId, principal, decision: "confirm" },
    }),
  ];
}

const CREW_CORROBORATION_THRESHOLD = 2;

type CorroborationScope = {
  noteId: string;
  textHash: string;
  workspacePath: string;
  missionId: string;
  principal: string;
};

function corroborationScope(
  note: Pick<
    MemoryNoteRow,
    "id" | "textHash" | "workspacePath" | "chatId" | "createdBy"
  >,
  principal: string,
): CorroborationScope | null {
  if (
    !note.workspacePath ||
    !note.chatId ||
    !crewAuthoredNote(principal) ||
    !crewAuthoredNote(note.createdBy)
  ) {
    return null;
  }
  return {
    noteId: note.id,
    textHash: note.textHash,
    workspacePath: note.workspacePath,
    missionId: note.chatId,
    principal,
  };
}

function corroborationUpsertOp(
  note: Pick<
    MemoryNoteRow,
    "id" | "textHash" | "workspacePath" | "chatId" | "createdBy"
  >,
  principal: string,
  enabled: boolean,
): Prisma.PrismaPromise<unknown> | null {
  const scope = enabled ? corroborationScope(note, principal) : null;
  if (!scope) {
    return null;
  }
  return prisma.memoryCorroboration.upsert({
    where: {
      workspacePath_missionId_textHash_principal: {
        workspacePath: scope.workspacePath,
        missionId: scope.missionId,
        textHash: scope.textHash,
        principal: scope.principal,
      },
    },
    update: { noteId: scope.noteId },
    create: scope,
  });
}

/**
 * ADR-0027 D12-C: register one independent crew principal's support and promote
 * only after two distinct principals corroborate the same normalized claim in
 * the same workspace+mission. A D11 reject bind wins permanently for that scope.
 * Returns true only when this call created the orchestrator vouch.
 */
async function recordCrewCorroboration(
  noteId: string,
  principal: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) {
    return false;
  }
  const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
  if (!row) {
    return false;
  }
  const scope = corroborationScope(row, principal);
  if (!scope) {
    return false;
  }
  const supportOp = corroborationUpsertOp(row, principal, true);
  if (supportOp) {
    await supportOp;
  }
  const claimKey = {
    workspacePath: scope.workspacePath,
    missionId: scope.missionId,
    textHash: scope.textHash,
  };
  const [rejectBind, support, vouch] = await Promise.all([
    prisma.memoryRejectBind.findUnique({
      where: { workspacePath_missionId_textHash: claimKey },
    }),
    prisma.memoryCorroboration.count({ where: claimKey }),
    prisma.confirmation.findFirst({
      where: {
        noteId: scope.noteId,
        principal: orchestratorConfirmingPrincipal(scope.missionId),
        decision: "confirm",
      },
    }),
  ]);
  if (rejectBind || support < CREW_CORROBORATION_THRESHOLD || vouch) {
    return false;
  }
  await prisma.$transaction([
    ...orchestratorVouchOps(scope.noteId, scope.missionId),
    prisma.memoryNote.update({
      where: { id: scope.noteId },
      data: { expiresAt: null, expiredAt: null },
    }),
  ]);
  // The graph has no confirmation ledger on its read path. Re-project the
  // promoted canonical row so coordinate-only analytics can distinguish a
  // durable D12-C vouch from a single agent's uncorroborated note. The mirror
  // remains best-effort and observable through the existing failure event.
  mirrorToGraph(async (graph) => {
    const promoted = await noteRecordById(scope.noteId);
    if (promoted) {
      await graph.projectMemoryNote(promoted);
    }
  }, "memory.crew-corroborated");
  return true;
}

function rejectBindOp(
  note: Pick<MemoryNoteRow, "id" | "textHash" | "workspacePath" | "chatId">,
  principal: ParsedPrincipal,
  principalRaw: string,
): Prisma.PrismaPromise<unknown> | null {
  if (principal.kind !== "human" || !note.workspacePath || !note.chatId) {
    return null;
  }
  return prisma.memoryRejectBind.upsert({
    where: {
      workspacePath_missionId_textHash: {
        workspacePath: note.workspacePath,
        missionId: note.chatId,
        textHash: note.textHash,
      },
    },
    update: {},
    create: {
      noteId: note.id,
      textHash: note.textHash,
      workspacePath: note.workspacePath,
      missionId: note.chatId,
      principal: principalRaw,
    },
  });
}

/**
 * P0-2 — who vouched for a note, most authoritative first. `null` = nobody yet.
 *
 * DELIBERATELY separate from `confirmed`, which stays human-only: an
 * orchestrator confirmation makes a note durable and usable by the crew without
 * claiming the strictly stronger thing a human confirm claims.
 */
function deriveConfirmedByMap(
  confirmations: { noteId: string; principal: string; decision: string }[],
): Map<string, "human" | "orchestrator"> {
  const latest = new Map<string, "human" | "orchestrator" | null>();
  // "A human decision wins, in BOTH DIRECTIONS" has to key on the DECIDER, not
  // on the surviving verdict. Keying on `latest === "human"` protected a human
  // CONFIRM and silently dropped a human REJECT — a reject stores `null`, which
  // is indistinguishable from "nobody has decided", so a later orchestrator row
  // re-vouched a note the operator had just killed. Not reachable today (vouch
  // rows are only minted at note creation, before any human can act), which is
  // exactly why it had to be closed now: the invariant is the contract, and the
  // next creation path that vouches later would inherit the hole silently.
  const decidedByHuman = new Set<string>();
  for (const confirmation of confirmations) {
    if (
      confirmation.decision !== "confirm" &&
      confirmation.decision !== "reject"
    ) {
      continue;
    }
    const human = parsePrincipal(confirmation.principal).kind === "human";
    if (!human && !isOrchestratorPrincipal(confirmation.principal)) {
      continue; // any other agent "confirm" row stays inert, exactly as before
    }
    if (!human && decidedByHuman.has(confirmation.noteId)) {
      continue;
    }
    if (human) {
      decidedByHuman.add(confirmation.noteId);
    }
    latest.set(
      confirmation.noteId,
      confirmation.decision === "confirm"
        ? human
          ? "human"
          : "orchestrator"
        : null,
    );
  }
  const out = new Map<string, "human" | "orchestrator">();
  for (const [id, by] of latest) {
    if (by) {
      out.set(id, by);
    }
  }
  return out;
}

/** Derive each note's confirmed state from its latest HUMAN Confirmation (asc
 *  feed). KG-6 F1: only human-principal confirmations count, this is the reproject
 *  twin of `isConfirmed`, so a wipe+reproject restores the SAME human-only confirmed
 *  set (an agent/system "confirm" row never flips the flag).
 *
 *  P0-2 keeps this human-only ON PURPOSE. The orchestrator now confirms mined
 *  memory so the operator owes no review, but that confirmation rides
 *  `confirmedBy: "orchestrator"` (deriveConfirmedByMap) rather than this flag —
 *  so global-scope promotion, pack export, the merge attestation and the KG-6
 *  protection of a confirmed victim all keep meaning "a HUMAN said so". */
function deriveConfirmedSet(
  confirmations: { noteId: string; principal: string; decision: string }[],
  eligibleNoteIds?: ReadonlySet<string>,
): Set<string> {
  const latest = new Map<string, boolean>();
  for (const confirmation of confirmations) {
    if (parsePrincipal(confirmation.principal).kind !== "human") {
      continue; // non-human confirm is inert, never elevates
    }
    if (
      confirmation.decision !== "confirm" &&
      confirmation.decision !== "reject"
    ) {
      continue; // pin/unpin and audit markers are neutral to confirmation
    }
    latest.set(confirmation.noteId, confirmation.decision === "confirm");
  }
  const confirmed = new Set<string>();
  for (const [id, ok] of latest) {
    if (ok && (eligibleNoteIds == null || eligibleNoteIds.has(id))) {
      confirmed.add(id);
    }
  }
  return confirmed;
}

/** Fold the latest human pin/unpin verdict for each note. */
function derivePinnedSet(
  confirmations: { noteId: string; principal: string; decision: string }[],
): Set<string> {
  const latest = new Map<string, boolean>();
  for (const confirmation of confirmations) {
    if (parsePrincipal(confirmation.principal).kind !== "human") {
      continue;
    }
    if (confirmation.decision === "pin") {
      latest.set(confirmation.noteId, true);
    } else if (confirmation.decision === "unpin") {
      latest.set(confirmation.noteId, false);
    }
  }
  return new Set(
    [...latest.entries()]
      .filter(([, pinned]) => pinned)
      .map(([noteId]) => noteId),
  );
}

/**
 * Idempotent projector (ADR-0009 Slice 1): rebuild the graph from the ledger.
 * MERGE-based node/edge upserts make it safe to re-run, on boot (repopulating a
 * fresh/recovered store) and after any partial mirror. This is what makes a graph
 * wipe non-destructive: every note here is re-derived from the durable ledger.
 *
 * After a wipe, note CONTENT + GOVERNANCE (kind/text/trust/confirmed/status/
 * conflicts) + scalar recall (by taskId/laneId/module/topic column filters) are
 * FULLY restored. Residuals (by design, healed over time):
 *  - F2: BY_LANE edges require LaneNodes, index.ts seeds + awaits them BEFORE
 *    this runs. TaskNodes are NOT seeded on boot, so the `relatedToTask` graph
 *    TRAVERSAL self-heals only as task activity re-creates TaskNodes/TOUCHED
 *    edges; recall-by-taskId (scalar column) is unaffected.
 *  - F3 (CLOSED in KG-2): soft signals (reinforcement accessCount/lastUsedAt +
 *    module-touch staleSince) are now written back to the ledger columns
 *    (flushMemoryReinforcement + markModulesStale), so `projectMemoryNote`
 *    restores them ON CREATE when the store is rebuilt fresh, they no longer
 *    reset on a wipe. They remain ranking hints, never confirmed memory.
 */
export async function projectLedgerToGraph(
  graph: MuonGraph = getGraph(),
): Promise<{ notes: number; edges: number }> {
  const [notes, confirmations, edges, principals] = await Promise.all([
    prisma.memoryNote.findMany(),
    prisma.confirmation.findMany({ orderBy: { at: "asc" } }),
    prisma.memoryEdge.findMany({ orderBy: { at: "asc" } }),
    prisma.principal.findMany(),
  ]);

  const tombstoneIds = new Set(
    notes.filter(isLedgerTombstone).map((row) => row.id),
  );
  const projectedNotes = notes.filter((row) => !tombstoneIds.has(row.id));
  for (const noteId of tombstoneIds) {
    await graph.deleteMemoryNote(noteId);
  }

  // Human confirmation stays durable while paused, but the graph's boolean is
  // gate-facing. Project it for every non-paused note: rejected notes still need
  // it for bitemporal reads from before their verdict, while CONFIRMED_BY
  // provenance remains intact so resume restores authority without another
  // confirmation.
  const confirmedById = deriveConfirmedSet(
    confirmations,
    new Set(
      projectedNotes
        .filter((row) => row.status !== "paused")
        .map((row) => row.id),
    ),
  );
  const conflictById = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind === "contradicts") {
      conflictById.set(edge.fromId, edge.toId); // asc order → latest wins
    }
  }

  // Provenance principals (KG-5): the AUTHORITATIVE source of trust. Resolve each
  // note's author (a ledger Principal row, or one derived from a legacy createdBy
  // that predates the table) and project every DISTINCT principal exactly ONCE,
  // so a wipe+reproject of a brain with thousands of same-author notes never
  // re-MERGEs the same node per row.
  const principalById = new Map<string, PrincipalRecord>();
  for (const row of principals) {
    principalById.set(row.id, toPrincipalRecord(row));
  }
  const authorByNoteId = new Map<string, PrincipalRecord>();
  const distinctPrincipals = new Map<string, PrincipalRecord>(principalById);
  for (const row of projectedNotes) {
    const parsed = parsePrincipal(row.createdBy);
    const author =
      principalById.get(parsed.id) ?? derivedPrincipalRecord(parsed);
    authorByNoteId.set(row.id, author);
    if (!distinctPrincipals.has(author.id)) {
      distinctPrincipals.set(author.id, author);
    }
  }
  for (const principal of distinctPrincipals.values()) {
    await graph.projectPrincipal(principal);
  }

  // Restore dense vectors from the durable EmbeddingCache (KG-3): reproject
  // REPOPULATES MemoryNote.embedding from the cache and NEVER recomputes, so a
  // .lbug wipe → reproject brings the semantic tier back with zero embed calls
  // (the vectors outlive the graph because they live in the relational ledger).
  // Scoped to the CURRENT model (F2): if dense is off, or a different model is
  // now configured, we restore nothing rather than revive cross-space vectors.
  const vectorByNoteId = await loadNoteVectors(
    projectedNotes.map((row) => ({ id: row.id, text: row.text })),
    getEmbedder()?.id,
  );

  // D6: `projectMemoryNote` now THROWS when a note's `ANCHORED_TO` write fails,
  // because that edge became the anchored read's ACCESS PATH and a dropped write
  // is a lost memory rather than a lost decoration. That must not turn a
  // whole-brain replay into an abort on note 1 of 214, so the failure is caught
  // PER NOTE, surfaced on the SAME coalesced `memory.graph_mirror_failed` Event
  // every other mirror failure uses, and the replay continues. The reconciler at
  // the tail of this function then reports the resulting divergence as a NUMBER and
  // repairs it, so a transient per-note failure is self-healing rather than
  // permanent. COORDINATES ONLY reaches the Event — see `reportMirrorFailure`.
  for (const row of projectedNotes) {
    try {
      await graph.projectMemoryNote(
        toRecord(
          row,
          confirmedById.has(row.id),
          conflictById.get(row.id) ?? null,
        ),
        vectorByNoteId.get(row.id),
        undefined,
        getEmbedder()?.id,
      );
      // AUTHORED_BY (KG-5): the principal node is already projected above.
      await graph.projectAuthoredBy(row.id, authorByNoteId.get(row.id)!.id);
    } catch (error) {
      reportMirrorFailure("projectLedgerToGraph.note", error);
    }
  }

  // CONFIRMED_BY (KG-5/KG-6): the confirming principal per HUMAN confirm decision.
  // System reconcile markers (decision "reconcile"/"reject") are NOT confirmations,
  // and an agent/system "confirm" is inert (KG-6 F1), neither projects a
  // CONFIRMED_BY edge, so provenance shows only genuine human blessings.
  for (const confirmation of confirmations) {
    if (tombstoneIds.has(confirmation.noteId)) {
      continue;
    }
    if (confirmation.decision !== "confirm") {
      continue;
    }
    const parsed = parsePrincipal(confirmation.principal);
    if (parsed.kind !== "human") {
      continue;
    }
    const principal =
      principalById.get(parsed.id) ?? derivedPrincipalRecord(parsed);
    await graph.projectPrincipal(principal);
    await graph.projectConfirmedBy(confirmation.noteId, parsed.id);
  }

  // Note→note edge vocabulary (KG-5/KG-6): supersedes / contradicts / related /
  // proposes_supersede, all rebuilt from the durable MemoryEdge rows (a wipe
  // restores every link). proposes_supersede is the one TRANSIENT kind (a resolved
  // proposal deletes/swaps its row), so clear it FIRST, the reproject is then
  // authoritative for it: a resolved proposal never lingers as a stale graph edge,
  // even if the best-effort live-mirror delete lost a race (KG-6).
  await graph.clearMemoryEdges("proposes_supersede");
  for (const edge of edges) {
    if (tombstoneIds.has(edge.fromId) || tombstoneIds.has(edge.toId)) {
      continue;
    }
    // Deliberately WITHOUT `awaitEndpoints` (the live-mirror sites all opt in).
    // Here every node is projected above, in this same sequential pass, before
    // any edge is written — there is no race to lose. And this loop walks EVERY
    // MemoryEdge in the brain, some of whose endpoints are legitimately absent
    // (a deleted/compacted note), so a bounded retry per edge would buy nothing
    // and cost 100ms on each one that can never succeed.
    await graph.projectMemoryEdge(edge.fromId, edge.toId, edge.kind);
  }

  // KG-8 (ADR-0014): replay the REBUILDABLE recent-activity projection so a .lbug
  // wipe restores which task recently touched which symbol/module with zero loss,
  // exactly as memory replays from MemoryNote.
  await projectActivityEdges(graph);

  // D6's COMPLETENESS RECONCILER, at boot. This is the "boot" half of
  // "asserted at boot and on demand": it runs at the tail of the projector that
  // just wrote every anchor edge, which is the one moment the invariant
  // (`count(ANCHORED_TO) == Σ size(n.modules)`) is both cheapest to check and most
  // meaningful to check — the projector is the authority for what should be there.
  // Four scalar queries when healthy; only a mismatch materializes pairs and
  // repairs. Best-effort: a reconcile that cannot run must not fail a replay that
  // already landed, and the operator route can re-run it.
  const anchorReconcile = await graph
    .reconcileAnchorEdges({ repair: true })
    .catch((error: unknown) => {
      reportMirrorFailure("projectLedgerToGraph.reconcileAnchors", error);
      return null;
    });
  if (anchorReconcile && !anchorReconcile.complete) {
    // Coordinates and counts only, like every other line here.
    console.error(
      `[memory] anchor edges diverged from n.modules/n.symbols after replay: ` +
        `modules ${anchorReconcile.modules.edges}/${anchorReconcile.modules.expected}, ` +
        `symbols ${anchorReconcile.symbols.edges}/${anchorReconcile.symbols.expected}; ` +
        `reprojected ${anchorReconcile.repairedNotes} note(s)`,
    );
  }

  return {
    notes: projectedNotes.length,
    edges: edges.filter(
      (edge) => !tombstoneIds.has(edge.fromId) && !tombstoneIds.has(edge.toId),
    ).length,
  };
}

/** Coerce a free-form Event.metadata value into a clean string[] (drops
 *  non-strings/empties). We read ONLY `metadata.symbols`/`metadata.modules`. */
function activityAnchors(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
}

/**
 * How many Event rows the boot replay reads, most-recent first.
 *
 * The read used to have NO `take` at all: it materialized the ENTIRE Event table
 * into JS objects at every boot and then skipped the uninteresting rows in the
 * loop. `Event` is append-only with no retention sweep, and D14's `recordGateRead`
 * writes one row per PRE-EDIT GATE READ — so the boot path scaled with agent edit
 * volume, which is the one number this product is built to grow.
 *
 * 5,000 is chosen against what the projection IS: `ACTED_ON`/`ACTED_ON_MODULE` is
 * the RECENT-activity edge set (`recordActivity` is monotonic-latest, so an older
 * touch of the same coordinate would be overwritten by a newer one anyway). The
 * truncation is therefore real but bounded to genuinely old touches, and it is
 * stated here rather than left to be discovered: a brain with more than 5,000
 * anchor-bearing events replays only the newest 5,000 of them.
 *
 * NOT A FULL FIX FOR THE SQL SIDE, stated honestly: `Event` is indexed on
 * `(taskId, timestamp)`, so a global `ORDER BY timestamp DESC LIMIT n` still sorts
 * inside SQLite. What the bound removes is the unbounded HYDRATION — the part that
 * allocates one JS object per row. A `timestamp` index would remove the rest and
 * costs a migration; it is the honest follow-up, not this change.
 *
 * EXPORTED for the test that pins the truncation. A bound nobody can name from the
 * outside is a bound whose test has to hard-code a number and rot the day it moves.
 */
export const ACTIVITY_REPLAY_MAX_EVENTS = 5_000;

/**
 * KG-8 (ADR-0014), replay the `ACTED_ON`/`ACTED_ON_MODULE` projection from the
 * append-only Event log (+ the trusted `DispatchJob` claim-state) inside
 * `projectLedgerToGraph`, so a graph wipe restores recent activity with zero loss.
 *
 * COORDINATES, NEVER CONTENT: the Event read selects taskId/laneId/timestamp/
 * metadata ONLY, NEVER `message`; `metadata` is mined for its `symbols`/`modules`
 * anchor arrays only. `jobId`/`vendor` are enriched from the DispatchJob's
 * id/vendor (NEVER `brief`), keyed by taskId (most-recent claim wins). Events are
 * append-only and the graph MERGE is idempotent + monotonic-latest, so replaying
 * over an intact or freshly-wiped store yields identical edges (no clear needed);
 * ascending timestamp order makes the last write the newest touch.
 *
 * BOUNDED, and the truncation is real: the newest {@link ACTIVITY_REPLAY_MAX_EVENTS}
 * non-audit rows are replayed and anything older is not. "Zero loss" above is
 * therefore a claim about the RECENT window this projection has always been,
 * not about the whole event log.
 */
async function projectActivityEdges(graph: MuonGraph): Promise<void> {
  const [recentEvents, jobs] = await Promise.all([
    prisma.event.findMany({
      // MUON'S OWN AUDIT ROWS ARE NOT ACTIVITY, and excluding them in SQL rather
      // than in the loop is what makes the bound above spend its budget on real
      // agent touches. Neither producer ever writes `metadata.symbols` or
      // `metadata.modules` (both write counts, an enum member and an op label), so
      // this can never drop an edge the loop would have built. The kinds are
      // IMPORTED from their producers, never restated, because a filter keyed on a
      // drifted string literal is a filter that silently stops filtering.
      where: {
        kind: {
          notIn: [
            GATE_READ_EVENT_KIND,
            GRAPH_MIRROR_FAILED_EVENT_KIND,
            MEMORY_INJECTED_EVENT_KIND,
          ],
        },
      },
      // Newest first + `take`, then replayed in ascending order below. Bounding on
      // `asc` would have kept the OLDEST rows, which is the wrong half of a
      // recent-activity projection.
      orderBy: { timestamp: "desc" },
      take: ACTIVITY_REPLAY_MAX_EVENTS,
      // COORDINATES ONLY, deliberately NO `message`.
      select: { taskId: true, laneId: true, timestamp: true, metadata: true },
    }),
    prisma.dispatchJob.findMany({
      orderBy: { createdAt: "asc" },
      // TRUSTED claim-state coordinates, deliberately NO `brief`.
      select: { id: true, taskId: true, vendor: true },
    }),
  ]);
  // Ascending again, so the LAST `recordActivity` for one coordinate is the newest
  // touch — the property the monotonic-latest MERGE relies on.
  const events = recentEvents.reverse();
  // Most-recent DispatchJob per task → the {jobId, vendor} coordinate (asc order,
  // so the last write is the newest claim).
  const jobByTask = new Map<string, { jobId: string; vendor: string }>();
  for (const job of jobs) {
    jobByTask.set(job.taskId, { jobId: job.id, vendor: job.vendor });
  }
  for (const event of events) {
    const meta = (event.metadata ?? {}) as {
      symbols?: unknown;
      modules?: unknown;
      intentModules?: unknown;
    };
    const symbols = activityAnchors(meta.symbols);
    const modules = Array.from(
      new Set([
        ...activityAnchors(meta.modules),
        ...activityAnchors(meta.intentModules),
      ]),
    );
    if (symbols.length === 0 && modules.length === 0) {
      continue;
    }
    const claim = jobByTask.get(event.taskId);
    await graph.recordActivity({
      taskId: event.taskId,
      laneId: event.laneId,
      vendor: claim?.vendor ?? "",
      jobId: claim?.jobId ?? "",
      at: event.timestamp.toISOString(),
      symbols,
      modules,
    });
  }
}
