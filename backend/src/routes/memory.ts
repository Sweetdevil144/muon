import type { FastifyInstance, FastifyRequest } from "fastify";
import { requestAuditColumns } from "../lib/event-audit.js";
import {
  citationsByNote,
  type CitingPeer,
} from "../lib/cited-findings.js";

/**
 * How many recent finding-shaped peer messages one gate call scans for
 * citations. Bounded so a chatty mission cannot turn every preflight into an
 * unbounded scan; a citation older than this simply waits for ordinary recall.
 */
const CITATION_SCAN_LIMIT = 100;
import { z } from "zod";
import { redactedTail } from "@muon/core";
import {
  gitnexusUidToLocalSymbolId,
  MEMORY_TRAVERSAL_TEXT_POLICY,
  memoryPassesGate,
  type MemoryGraphRelation,
} from "@muon/graph";
import {
  attemptOutcomeNullableSchema,
  attemptOutcomeSchema,
  matchesMemoryFilter,
  memoryAccessTypeSchema,
  memoryIngestPolicySchema,
  memoryLifecyclePolicySchema,
  memoryLibraryOrderBySchema,
  noteDerivationSchema,
  noteReviewStatusSchema,
  parseMemoryFilterJson,
  MEMORY_FILTER_MAX_JSON_LENGTH,
  RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
  type MemoryFilter,
  type MemoryFilterRecord,
} from "@muon/protocol";
import {
  agentJobPrincipal,
  agentMemoryPartition,
  authoringPrincipal,
  confirmingPrincipal,
  requireAgentJobCapability,
  requireOperator,
} from "../lib/auth.js";
import { readActivity } from "../lib/activity.js";
import { selectCodeGraphProvider } from "../lib/codegraph.js";
import { prisma } from "../lib/db.js";
import { readDuplicateWork } from "../lib/duplicate-work.js";
import { getEmbedder, getGraph } from "../lib/graph.js";
import {
  applyMemoryExpiry,
  backfillMemoryNoteWorkspace,
  cloneMemoryNote,
  compactMemory,
  deleteMemoryNote,
  getMemoryNote,
  resolveMemoryNoteByIdOrPrefix,
  ingestMemoryNote,
  listMemoryLibrary,
  listStandingDecisionLog,
  migrateMemoryLifecyclePolicy,
  MemoryLifecyclePreviewMismatchError,
  MemoryPreviewStaleError,
  promoteMemoryNoteToGlobal,
  recordMemoryUsed,
  revertExpiredMemoryBatch,
  sweepExpiredMemory,
  updateMemoryNote,
  type MemoryExpiryState,
} from "../lib/memory-ledger.js";
import { collectMemoryPack } from "../lib/memory-pack.js";
import { importMemoryPack } from "../lib/memory-pack-import.js";
import {
  appendMemoryAccesses,
  getMemoryAccessAnalytics,
} from "../lib/memory-access.js";
import {
  getAutoConfirmAgentMemory,
  getMemoryCompactionRetentionDays,
  getMemoryMining,
  getMemoryLifecyclePolicy,
  getMemoryTtlPolicy,
  setAutoConfirmAgentMemory,
  setMemoryCompactionRetentionDays,
  setMemoryMining,
  setMemoryTtlPolicy,
  getMemoryIngestPolicy,
  setMemoryIngestPolicy,
} from "../lib/operator-settings.js";
import { preEditContext } from "../lib/preedit.js";
import { tallyGateCoverage } from "../lib/preedit-coverage.js";
import { recordGateRead } from "../lib/gate-telemetry.js";
import { createHash } from "node:crypto";
import {
  hasDeliveredContent,
  injectionLedgerForJob,
  recordMemoryInjected,
} from "../lib/injection-telemetry.js";
import {
  buildMemoryDirectorySnapshot,
  MemoryDirectoryTooLargeError,
} from "../lib/memory-directory.js";
import { validateWorkspacePath } from "../lib/workspace.js";
import { repoRootOf } from "../lib/workspace-identity.js";

const EMPTY_MEMORY_ANALYTICS = {
  noteScores: [],
  hotModules: [],
  communities: [],
  source: { notes: 0, modules: 0, edges: 0, truncated: false },
} as const;

// ── B3: the memory graph is a MIRROR, so its outage is a partial one ──
//
// ADR-0021 settled where the authority lives: the relational ledger is the
// source of truth and the memory graph is a best-effort projection kept for
// PROVENANCE. `/library` has always honoured that (`.catch(() =>
// EMPTY_MEMORY_ANALYTICS)` on its graph half); the traversal and recall routes
// did not, so one embedded-graph outage — exactly the segfault-and-recover
// window `graph boot-probe auto-recovery` exists for — turned the whole Memory
// tab into an unmapped 500 instead of costing provenance detail.
//
// Two rules, both load-bearing:
//  • DEGRADE, never fail the response. A graph that cannot answer costs the
//    caller its provenance/traversal half, nothing else.
//  • NEVER a silent empty success. Every degraded body carries `degraded`
//    naming the subsystem and a redacted reason, so a surface renders "the
//    provenance graph is unavailable" rather than "this note has no
//    provenance" — which is a different, and false, claim. The reason rides
//    the SAME `redactedTail` scrub every other operator-facing diagnostic uses.
//
// Deliberately NOT applied to the WRITE paths: an ingest whose graph mirror
// fails is already ledger-first and reports its own outcome, and a write that
// answered "fine" while the mirror was down would be the papering-over this
// guard exists to prevent.
const GRAPH_DEGRADED_REASON_CHARS = 200;

type MemoryGraphDegraded = {
  degraded: { subsystem: "memory-graph"; reason: string };
};

function graphDegraded(error: unknown): MemoryGraphDegraded {
  return {
    degraded: {
      subsystem: "memory-graph",
      reason: redactedTail(
        error instanceof Error ? error.message : String(error),
        GRAPH_DEGRADED_REASON_CHARS
      ),
    },
  };
}

/** The traversal provenance envelope for a graph that could not answer. */
function degradedTraversalProvenance(root: string, hops: number) {
  return {
    root,
    hops,
    relations: [] as MemoryGraphRelation[],
    truncated: false,
    textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
  };
}

const createNoteSchema = z.object({
  kind: z.enum(["decision", "constraint", "convention", "attempt", "question"]),
  text: z.string().min(3),
  taskId: z.string().min(1).optional(),
  laneId: z.string().min(1).optional(),
  // #126 per-chat partition key. Threaded from the agent's MCP env (MUON_CHAT_ID,
  // set by the runner from the trusted job.chatId) so an agent WRITE lands in its
  // chat's partition; a chat-scoped agent read then hard-filters on it. Absent →
  // a NULL-chat note (today's global behavior). Like taskId/laneId this is a
  // free-form body coordinate (not an authenticated authority): it can only
  // partition/narrow, and an agent write still lands UNCONFIRMED, so it can never
  // pass the confirmed-only hero gate on its own.
  chatId: z.string().min(1).optional(),
  modules: z.array(z.string().min(1)).default([]),
  topics: z.array(z.string().min(1)).default([]),
  // Symbol anchors (ADR-0012): `<module>#<name>` ids. A symbol-anchored note is
  // auto-derived to its module too (ledger), so a curated/captured write may carry
  // them; absent → module-only, unchanged. Capped like the other anchor arrays.
  symbols: z.array(z.string().min(1)).max(128).default([]),
  // D1 (§D1, option B): coordinates the caller EXPLICITLY declares do not exist
  // yet, so their anchors land `planned` rather than `unresolved`. Explicit and
  // per-coordinate precisely so a TYPO can never silently become "planned", and a
  // declared coordinate that IS tracked lands `resolved` anyway — reality outranks
  // the declaration. It can only LABEL an anchor the note already carries: it
  // never mints one, and it is never persisted as text, so unlike `text` it is not
  // a content channel. Bounded exactly like `symbols`, because every array on this
  // surface is bounded and a new one that is not is how the next hole opens.
  plannedCoordinates: z
    .array(z.string().min(1).max(512))
    .max(128)
    .default([]),
  // Declared trust. TIER-CLAMPED before it reaches the ledger (see
  // `writeTrust`): "high" is an authority level, not a label, so a body may
  // never mint it.
  trust: z.enum(["low", "medium", "high"]).optional(),
  createdBy: z.string().min(2),
  // Visibility scope (KG-5 / D5): defaults to "project" in the ledger; a caller
  // may set it now, but v1 does NOT hard-enforce isolation (hosted mode flips on).
  scope: z.string().min(1).optional(),
  // Substrate §3.4: meaningful only when kind === "attempt".
  outcome: attemptOutcomeNullableSchema.optional(),
});

// Bitemporal as-of param (F1 / KG-5). REJECT an unparseable value (→ 400) and
// NORMALIZE the rest to a canonical millisecond-precision UTC-Z ISO string, so it
// is compared against the graph's stored `Date.toISOString()` values on the SAME
// format/precision/zone. Without this, a second-precision (`...:00Z`),
// timezone-offset (`...+05:30`), or date-only (`2026-07-11`) input is compared
// lexicographically against ms-UTC-Z and returns the WRONG active set.
const asOfSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "asOf must be a parseable ISO-8601 date-time",
  })
  .optional();

function normalizeAsOf(value: string | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

const updateNoteSchema = z
  .object({
    confirmed: z.boolean().optional(),
    text: z.string().min(3).optional(),
    trust: z.enum(["low", "medium", "high"]).optional(),
    status: z.enum(["active", "paused", "rejected"]).optional(),
    pinned: z.boolean().optional(),
    outcome: attemptOutcomeNullableSchema.optional(),
    reviewStatus: noteReviewStatusSchema.nullish().optional(),
    derivation: noteDerivationSchema.nullish().optional(),
    // KG-6: the confirming/rejecting principal (e.g. "human:carol" | "agent:x").
    // Optional → defaults to the human operator ("human") in the ledger, so
    // CONFIRMED_BY points at the ACTUAL confirmer and a confirm can resolve a
    // PROPOSES_SUPERSEDE the note authored. Backward-compatible (prior callers
    // omit it). `principal` alone is NOT a decision, the refine still requires a
    // confirmed/text/trust/status field so a bare principal can't no-op a PATCH.
    principal: z.string().min(2).optional(),
  })
  .refine(
    (value) =>
      value.confirmed !== undefined ||
      value.text !== undefined ||
      value.trust !== undefined ||
      value.status !== undefined ||
      value.pinned !== undefined ||
      value.outcome !== undefined ||
      value.reviewStatus !== undefined ||
      value.derivation !== undefined,
    { message: "At least one of confirmed/text/trust/status/pinned/outcome/reviewStatus/derivation must be provided." }
  );

const memoryGraphRelationSchema = z.enum([
  "SUPERSEDES",
  "EXTENDS",
  "CONTRADICTS",
  "AUTHORED_BY",
  "CONFIRMED_BY",
  "ANCHORED_TO",
  "ABOUT_SYMBOL",
  "ABOUT_TASK",
  "BY_LANE",
  "TOUCHED",
  "WORKED_ON",
  "GATED_BY",
  "CLONED_FROM",
]);

const traversalCoordinateSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9@._~:+#$%/-]+$/);

function parseTraversalRelations(
  value: string | undefined
): MemoryGraphRelation[] | undefined {
  if (!value) {
    return undefined;
  }
  const relations = value
    .split(",")
    .map((relation) => relation.trim())
    .filter(Boolean);
  return z.array(memoryGraphRelationSchema).max(12).parse(relations);
}

// ── R3 `showExpired` + R5 `filter`, the two knobs every memory READ shares ──
//
// Both ride the same rules on every route, so a surface can never drift into a
// laxer variant of either:
//
//  • `showExpired` is an OPERATOR knob, exactly like `trustFloor` on the hero
//    gate. An agent-tier request that asks for it is SILENTLY DOWNGRADED to the
//    hygienic default rather than 403'd — refusing would turn the parameter into
//    a tier oracle, and the agent loses nothing it was entitled to (an expired
//    note is one it could read before the deadline and can read again the moment
//    a human confirms it).
//  • `filter` is validated by the SHARED @muon/protocol grammar (one set of
//    bounds for backend + MCP + client + CLI) and is only ever applied to a set
//    the caller has ALREADY been authorized to receive. It narrows; it never
//    selects. A predicate therefore cannot distinguish, count, or time a note
//    outside the caller's scope, because such a note is never evaluated.
const boolFlagSchema = z.enum(["true", "false"]).optional();

/** TODO 4.16 — shared body for bounded bulk memory removal routes. */
const bulkMemoryRemovalBodySchema = z.object({
  dryRun: z.boolean().optional(),
  maxForget: z.number().int().min(1).max(500).optional(),
  batchId: z.string().min(1).max(100).optional(),
  reason: z.string().min(1).max(500).optional(),
  /**
   * BIND this apply to the dry run that justified it (409 if the policy moved
   * since). Optional: `muon memory sweep-expired` has no preview to bind to,
   * and omitting it is exactly today's behaviour.
   */
  previewDigest: z.string().length(64).optional(),
});

/** Query-param booleans arrive as strings; `z.coerce.boolean("false")` is TRUE,
 *  so the flag is an explicit enum and anything else is simply absent. */
function flagEnabled(value: "true" | "false" | undefined): boolean {
  return value === "true";
}

const filterParamSchema = z
  .string()
  .max(MEMORY_FILTER_MAX_JSON_LENGTH)
  .optional();

/** Parse + bound a wire filter, or 400 with the grammar's own reason. A refusal
 *  is always explicit: silently dropping an unparseable predicate would let a
 *  caller widen its result set by sending garbage. */
function parseFilterParam(
  app: FastifyInstance,
  raw: string | undefined
): MemoryFilter | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseMemoryFilterJson(raw);
  if (!parsed.ok) {
    throw app.httpErrors.badRequest(parsed.reason);
  }
  return parsed.filter;
}

/**
 * The ONE post-gate view every graph-backed memory read returns: reconcile
 * against the authoritative ledger (R3 expiry, liveness, and the `confirmed` /
 * `stale` flags a consumer steers on), then narrow with the R5 filter.
 *
 * Order is load-bearing. Reconciliation runs FIRST so `expiresAt`/`confirmed`/
 * `stale` are the LEDGER's values before a predicate can mention them — the R5
 * grammar publishes all three as filterable fields, and a filter evaluated
 * against the mirror's copy would answer a question about the mirror — and the
 * filter runs LAST so it can only ever remove rows from an already-gated,
 * already-hygienic set.
 *
 * `asOf` is threaded through so a BITEMPORAL read still returns the notes that
 * were the answer at T. Without it, the liveness narrowing would delete the
 * entire point of an as-of query, which is to show retired history.
 *
 * THE LEDGER DECIDES HIDDEN-NESS, NOT THE MIRROR. Every hot read below asks the
 * graph for candidates with `showExpired: true` and lets `applyMemoryExpiry`
 * (which reads the authoritative `expiresAt` + Confirmation ledger) make the
 * call. That is not belt-and-braces, it is the only arrangement that holds:
 * this function is a NARROWER, so it can remove a row but can never add back one
 * the graph already dropped — and the graph's copies of `confirmed`/`expiresAt`
 * come from a BEST-EFFORT mirror. One failed mirror write on a human confirm and
 * the graph would keep a human-adjudicated note hidden from every recall path,
 * with the ledger insisting it is live and no surface able to disagree.
 *
 * The graph's own expiry clause stays exactly where its authors put it: defence
 * in depth for callers that read the store directly (the explorer, provenance
 * walks), never the deciding authority on a governed read. The cost is that a
 * page can come back under-filled when the candidate window contains expired
 * notes — recall hygiene, not governance, and precisely the pre-R3 behaviour.
 */
async function governedMemoryView<T extends { id: string }>(
  notes: readonly T[],
  options: { showExpired: boolean; filter?: MemoryFilter; asOf?: string }
): Promise<(T & MemoryExpiryState)[]> {
  const visible = await applyMemoryExpiry(notes, {
    showExpired: options.showExpired,
    asOf: options.asOf,
  });
  const filter = options.filter;
  return filter
    ? visible.filter((note) =>
        matchesMemoryFilter(note as MemoryFilterRecord, filter)
      )
    : visible;
}

function crewReadableMemoryView<
  T extends {
    confirmedBy: "human" | "orchestrator" | null;
    chatId?: string | null;
  },
>(
  notes: T[],
  options: { tier: "operator" | "agent"; chatId?: string; crewVisible: boolean }
): T[] {
  if (options.tier === "operator") {
    return notes;
  }
  // LOCKSTEP with `memoryGateTier`'s #133 crew_vouched tier: under the
  // crew-visible posture, a SAME-CHAT note is readable by this mission's crew
  // regardless of vouch state. This filter used to additionally demand
  // `confirmedBy === "orchestrator"` — the D12-C corroboration vouch, whose
  // job is DURABILITY (it clears the TTL), not recall visibility — which
  // silently undid the gate's admission: a scout's unique finding has one
  // author by definition, can never reach the 2-principal corroboration
  // threshold, and so never reached a sibling (0/3 recalls, mission
  // 420c8bf4). The wire still reports `confirmed:false, confirmedBy:null`,
  // and briefs keep the stricter bar (`vouchedForCrew` in @muon/core admits
  // only human-confirmed or orchestrator-vouched notes) — explicit recall is
  // the documented "reachable, flagged as suspect" surface.
  return notes.filter(
    (note) =>
      note.confirmedBy === "human" ||
      (options.crewVisible &&
        Boolean(options.chatId) &&
        note.chatId === options.chatId)
  );
}

/**
 * R3 + LIVENESS on the graph-TRAVERSAL surfaces (`/neighbors`, `/explain`).
 * These are provenance walks, not recall, so a node is never REMOVED — dropping
 * one would break the very path the caller asked to be explained. Instead the
 * note's `text` is withheld and it degrades to coordinates-only, which is the
 * same treatment an ungoverned note already gets here.
 *
 * Two strip conditions, and the second is why this function was a bounded
 * surface with a hole:
 *
 *  • EXPIRED (R3). Completeness is the point: the crew-visible tier can carry an
 *    unconfirmed agent note's verbatim text, and a TTL that covered recall but
 *    left that text reachable one hop away would be exactly such a hole.
 *  • NOT LIVE per the ledger — retired, rejected, or hard-DELETED. This is the
 *    one that mattered. `tombstoneMemoryRow` blanks the ledger's `text`, sets
 *    `status:"rejected"` + `retiredAt`, and leaves `expiresAt` NULL, so a
 *    tombstoned note is not EXPIRED and never entered the strip set — while
 *    `graph.deleteMemoryNote` is best-effort, so one dropped write leaves the
 *    mirror holding the ORIGINAL prose. `memoryTraversalNode` then serves it to
 *    anything the note is confirmed or crew-visible for. A sub-agent could be
 *    handed the verbatim text of a note the operator ordered DESTROYED.
 *
 * `showRetired` is what keeps the NODE in the answer (a provenance walk exists
 * to explain a supersede, so the retired endpoint of a SUPERSEDES edge must
 * stay); `live` is what takes its TEXT away. The two are not the same question,
 * and conflating them is what left the hole: a superseded note's coordinates
 * still explain the path, its prose is no longer the brain's answer, and a human
 * who needs the prose fetches it by id through the operator-only note read.
 */
async function redactExpiredNodes<
  T extends { entityId: string; type: string; text?: string },
>(
  nodes: T[],
  access?: { tier: "operator" | "agent"; chatId?: string; crewVisible: boolean }
): Promise<T[]> {
  const noteIds = nodes
    .filter((node) => node.type === "note" && node.text !== undefined)
    .map((node) => ({ id: node.entityId }));
  if (noteIds.length === 0) {
    return nodes;
  }
  const annotated = await applyMemoryExpiry(noteIds, {
    showExpired: true,
    showRetired: true,
  });
  // The LEDGER's own chat coordinates for the crew leg below. The traversal
  // response deliberately omits partition coordinates, and trusting the
  // graph's fence alone re-opened the exact hole this second pass exists
  // for: a global note whose human confirm was REVOKED (row stays live) but
  // whose re-projection lagged reads `confirmed: true` in the mirror — the
  // ledger must independently agree before prose is served.
  const chatById = new Map(
    (
      await prisma.memoryNote.findMany({
        where: { id: { in: annotated.map((note) => note.id) } },
        select: { id: true, chatId: true },
      })
    ).map((row) => [row.id, row.chatId])
  );
  const withheld = new Set(
    annotated
      .filter((note) => {
        return (
          note.expired ||
          !note.live ||
          (access?.tier === "agent" &&
            !(
              note.confirmedBy === "human" ||
              // Same rule as `crewReadableMemoryView` — the posture admits
              // SAME-MISSION crew prose without the D12-C durability vouch —
              // but the mission comparison is the LEDGER's, never presumed
              // from the graph's admission.
              (access.crewVisible &&
                Boolean(access.chatId) &&
                chatById.get(note.id) === access.chatId)
            ))
        );
      })
      .map((note) => note.id)
  );
  if (withheld.size === 0) {
    return nodes;
  }
  return nodes.map((node) => {
    if (node.type !== "note" || !withheld.has(node.entityId)) {
      return node;
    }
    const { text: _text, ...rest } = node as T & { textTruncated?: boolean };
    delete (rest as { textTruncated?: boolean }).textTruncated;
    return rest as T;
  });
}

// ── Tier-clamped write trust ────────────────────────────────────────────────
//
// `trust` arrives on the create body, and "high" is not a label — it is
// authority. A high-trust note NEVER auto-expires (`ttlRedeemed`, an invariant
// the TTL policy is explicitly forbidden from dialling: `settings/memory-ttl`
// caps `trustCeiling` at "medium" for exactly this reason), AND it is the value
// the destructive-write gate compares against a victim's, so a self-asserted
// "high" buys an agent both permanence and supersede authority over unconfirmed
// peers. Left unclamped, the writer held the dial.
//
// So the ceiling is stated POSITIVELY, per tier — never derived by subtracting a
// forbidden set from a wider one, because a future trust level would then land
// on the permissive side by default. An over-ceiling value is CLAMPED, not
// refused, matching how every other operator knob behaves on an agent-facing
// surface (`showExpired`, `trustFloor`): a 403 here would turn `trust` into a
// tier oracle, and an honest lower declaration is still respected.
const MEMORY_TRUST_CEILING = {
  operator: "high",
  agent: "medium",
} as const satisfies Record<"operator" | "agent", "low" | "medium" | "high">;

const MEMORY_TRUST_ORDER = ["low", "medium", "high"] as const;

function writeTrust(
  tier: "operator" | "agent",
  claimed: "low" | "medium" | "high" | undefined
): "low" | "medium" | "high" | undefined {
  if (claimed === undefined) {
    return undefined; // absent → the ledger derives it from the author principal
  }
  const ceiling = MEMORY_TRUST_CEILING[tier];
  return MEMORY_TRUST_ORDER.indexOf(claimed) >
    MEMORY_TRUST_ORDER.indexOf(ceiling)
    ? ceiling
    : claimed;
}

type MemoryCallerScope = {
  chatId?: string;
  taskId?: string;
  jobId?: string;
  /** ADR-0026: the canonical repo root this caller's memory belongs to. Present
   *  only for the agent tier, where it is DERIVED from authenticated state; an
   *  operator caller has no derived workspace (its explicit coordinate arrives
   *  with the read surfaces, ADR-0026 §11 step 4). */
  workspacePath?: string;
  principal: string;
};

/**
 * ADR-0026 §11 step 3 — the READ coordinate, resolved once for every read route.
 *
 * Two powers, two fields, never one value with two meanings:
 *  • `workspacePath` — the HARD fence. `n.workspacePath = $ws`.
 *  • `unscopedWorkspace` — §8's residue view, ONLY the unassigned notes.
 *
 * Absent both = today's unscoped-everything view, which §5 requires so the
 * rollout is monotonic and so no existing caller becomes a 400.
 */
type MemoryReadWorkspace = {
  workspacePath?: string;
  unscopedWorkspace?: boolean;
};

/**
 * The `workspace` / `unscoped` read parameters, shared by every read route so the
 * rule is parsed once. Two SEPARATE params rather than a reserved `"unscoped"`
 * path value: a single field carrying two authorities is the overload §6 rejects
 * for `scope:"global"`, and it would change meaning for anyone whose directory is
 * genuinely spelled that way.
 */
const workspaceReadSchema = {
  workspace: z.string().min(1).max(4_096).optional(),
  // `boolFlagSchema`, so `unscoped` behaves exactly like `showExpired` on every
  // surface rather than inventing a second truthiness convention.
  unscoped: boolFlagSchema,
};

// Declared HERE, below `workspaceReadSchema`, rather than beside the other
// traversal helpers above: a `const` initializer runs in source order, so reading
// the workspace shape from further up the file would be a TDZ ReferenceError at
// import. Moved rather than restated, because two spellings of one query shape is
// how one route ends up with a laxer parameter than its sibling.
const traversalQuerySchema = z.object({
  hops: z.coerce.number().int().min(1).max(3).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  relations: z.string().max(500).optional(),
  // Agent callers receive this from trusted ToolScope.chatId. The route treats
  // it only as a narrowing partition key; it confers no write/govern authority.
  chatId: z.string().min(1).max(200).optional(),
  // ADR-0026: a provenance walk is a READ. §9 lists `/neighbors` and `/explain`
  // among the surfaces that must learn the predicate, and their gate is one TS
  // predicate in `memoryTraversalNode` — leaving two operator- and agent-reachable
  // routes able to reveal a foreign-workspace note's existence one hop from a
  // permitted note would be exactly the unclosed hole §5 warns about.
  ...workspaceReadSchema,
});

/**
 * ADR-0026 — resolve the workspace a READ is answered for.
 *
 * AGENT TIER: the derived capability value WINS and is the only value that can
 * ever land. A caller that names a DIFFERENT workspace is refused, not silently
 * overridden, exactly as `memoryCallerScope` refuses a mismatched `chatId` claim —
 * an agent must never be able to discover that another repo exists by watching
 * which claims are tolerated. `unscoped` is refused outright: §8 makes the residue
 * invisible to every agent read, so honouring it would be the one way an agent
 * could reach an unpartitioned note.
 *
 * A job whose `DispatchJob.workspacePath` is NULL FAILS CLOSED — it reads NOTHING.
 *
 * THIS PARAGRAPH USED TO SAY THE OPPOSITE, and the reasoning was wrong. It claimed
 * such a job yielded no clause but stayed bounded anyway "because
 * `OrchestratorChat.workspacePath` is NOT NULL, so a chat lives in exactly one
 * workspace" — a coincidence of two keys, recorded rather than relied on. An
 * adversarial review showed the coincidence CANNOT hold for exactly this job:
 * `registerDispatchRoutes` forces the chat's workspace onto every chat-bound job,
 * so a NULL-workspace job by construction has NO chat and no `OrchestratorChat`
 * row. The cited property could never apply to the only case it was cited for.
 *
 * What that bought an attacker, reproduced: with no clause, the read fell through
 * to the chat clause, whose `(n.scope = 'global' AND n.confirmed = true)` leg is
 * the one predicate that matches ACROSS every workspace on the machine. A
 * chat-less job's partition is `task:<taskId>`, so the global leg was the only leg
 * that could match anything — and it returned another repository's confirmed
 * memory verbatim, through `/search` and through the pre-edit hero gate.
 *
 * So an agent with no partition now gets `unscopedWorkspace: true`, which selects
 * the §8 residue — notes with NO workspace — and that set is invisible to agent
 * reads by construction. The read returns nothing rather than everything. That is
 * a NARROWING, consistent with §11's "narrower, never a widener": a capability
 * that cannot name its partition has no business reading a partitioned corpus.
 *
 * OPERATOR TIER: the coordinate is EXPLICIT and validated through
 * `validateWorkspacePath` (the same trust boundary `/pack/export` uses) and then
 * reduced by `repoRootOf`, so a worktree, a symlink or a case-variant spelling all
 * resolve to the same partition the write path stored. One evaluator of that
 * reduction, server-side: a surface that reduced the path itself would be a second
 * evaluator of one rule, and every read would then depend on the surface agreeing
 * with the writer.
 */
async function memoryReadWorkspace(
  app: FastifyInstance,
  request: FastifyRequest,
  caller: MemoryCallerScope,
  claimed: { workspace?: string; unscoped?: "true" | "false" }
): Promise<MemoryReadWorkspace> {
  const wantsUnscoped = flagEnabled(claimed.unscoped);
  if (request.tier === "agent") {
    if (wantsUnscoped) {
      throw app.httpErrors.forbidden(
        "The unscoped memory view is operator-only."
      );
    }
    if (claimed.workspace) {
      // VALIDATE BEFORE REDUCING, exactly as the operator branch below does.
      // `repoRootOf` walks the path segment by segment and then spawns `git` with
      // the result as its CWD, so reducing first would let an agent aim a
      // subprocess at any directory on the machine — and would leave the AGENT
      // tier less checked than the operator tier, which is the wrong way round.
      //
      // Both refusals carry the SAME message on purpose. The allowlist reason
      // (which names every configured root) and "that is not your workspace" are
      // separately informative, and telling them apart is precisely how an agent
      // would map the machine by watching which claims are tolerated. §4's
      // posture is that a claim is refused, and an agent learns nothing else.
      const denied = app.httpErrors.forbidden(
        "The requested memory workspace is outside this job capability."
      );
      const validation = validateWorkspacePath(claimed.workspace);
      if (!validation.ok) {
        throw denied;
      }
      if ((await repoRootOf(validation.path)) !== caller.workspacePath) {
        throw denied;
      }
    }
    // FAIL CLOSED on a capability with no partition — see the header. `{}` here
    // used to mean "no clause", which the `scope:"global"` leg turned into a
    // cross-repository read. `unscopedWorkspace` fences to the §8 residue, which
    // no agent read may see, so the answer is empty rather than universal.
    return caller.workspacePath
      ? { workspacePath: caller.workspacePath }
      : { unscopedWorkspace: true };
  }
  if (wantsUnscoped) {
    if (claimed.workspace) {
      throw app.httpErrors.badRequest(
        "workspace and unscoped are mutually exclusive: a read is either fenced to one workspace or is the unassigned-residue view."
      );
    }
    return { unscopedWorkspace: true };
  }
  if (!claimed.workspace) {
    return {};
  }
  const validation = validateWorkspacePath(claimed.workspace);
  if (!validation.ok) {
    throw app.httpErrors.badRequest(validation.reason);
  }
  return { workspacePath: await repoRootOf(validation.path) };
}

// ── ADR-0026 §4: the workspace comes from the CAPABILITY, never from the env ──
//
// `AgentJobCapability.workspacePath` is read server-side from
// `DispatchJob.workspacePath` at authentication time (`lib/auth.ts`), a column no
// agent can write. That is the same derive-from-authenticated-state idiom
// `chatId` already uses via `agentMemoryPartition`, including its refusal when a
// body's claim disagrees.
//
// It is deliberately NOT `MUON_WORKSPACE`. `packages/runner/src/execute.ts`
// remaps that env var to the governed task WORKTREE for every worker under an
// editing harness (so GitNexus and review_diff inspect the exact execution
// tree), which means a partition derived from it would mint one memory island per
// dispatch, by construction, on the most common code path. Measured: zero
// `DispatchJob` rows carry a worktree-shaped path, so the capability value is
// already the parent repo — and `repoRootOf` is the belt-and-braces that keeps it
// so, because "already true" is not an invariant.
async function memoryCallerScope(
  app: FastifyInstance,
  request: FastifyRequest,
  claimedChatId?: string
): Promise<MemoryCallerScope> {
  if (request.tier === "operator") {
    return {
      ...(claimedChatId ? { chatId: claimedChatId } : {}),
      principal: "human",
    };
  }
  const capability = requireAgentJobCapability(app, request);
  const chatId = agentMemoryPartition(capability);
  if (claimedChatId && claimedChatId !== chatId) {
    throw app.httpErrors.forbidden(
      "The requested memory partition is outside this job capability."
    );
  }
  const workspacePath = capability.workspacePath
    ? await repoRootOf(capability.workspacePath)
    : undefined;
  return {
    chatId,
    taskId: capability.taskId,
    jobId: capability.jobId,
    ...(workspacePath ? { workspacePath } : {}),
    principal: agentJobPrincipal(capability),
  };
}

export async function registerMemoryRoutes(app: FastifyInstance) {
  app.post("/", async (request, reply) => {
    const payload = createNoteSchema.parse(request.body);
    // B6: an agent cannot mint a global note directly. Even though an
    // unconfirmed global note is filtered everywhere, global scope is a human
    // governance act.
    if (payload.scope === "global") {
      requireOperator(app, request);
    }
    const caller = await memoryCallerScope(app, request, payload.chatId);
    // PRINCIPAL FROM AUTH (P3-A / closes H2): the author is derived from the
    // authenticated tier, NOT the free-form body. An agent-tier caller that
    // claims "human:*" is downgraded to the agent principal, so the note can
    // never become human-confirmed or pass the hero gate on a forged human
    // identity (KG-6 keys "confirmed" on human-kind, now authenticated, not
    // asserted). An honest agent id ("codex", a lane key) is preserved.
    const createdBy =
      request.tier === "operator"
        ? authoringPrincipal(request.tier, payload.createdBy)
        : caller.principal;
    // Ledger-FIRST dual-write (ADR-0009 Slice 1 / KG-1): the durable relational
    // ledger is written authoritatively, THEN mirrored to the graph, so a graph
    // wipe/recovery can never lose a note. Dedup stays intact: duplicates NOOP,
    // refinements supersede, contradictions surface for human reconciliation.
    //
    // The ingest input is built FIELD BY FIELD, never `{ ...payload }`. Spreading
    // the parsed body and then overriding a few keys is a deny-list, and a
    // deny-list on an authority-bearing surface is a hole waiting for the next
    // field: `trust` sat in exactly that gap and let an agent declare its own
    // notes permanent. Every field below is either a caller COORDINATE (kind /
    // text / anchors), derived from AUTHENTICATED authority (createdBy, taskId,
    // chatId, proposalOnly), or explicitly clamped by tier (trust).
    const result = await ingestMemoryNote({
      kind: payload.kind,
      text: payload.text,
      laneId: payload.laneId,
      modules: payload.modules,
      topics: payload.topics,
      symbols: payload.symbols,
      // D1: a caller COORDINATE like the anchor arrays above, and deliberately NOT
      // clamped by tier the way `trust` is. It confers no authority — nothing reads
      // `MemoryAnchor.resolution` yet, and when D15 and D4+D6 do, a `planned`
      // coordinate is a label on a row that is already in the note, not a
      // visibility grant.
      plannedCoordinates: payload.plannedCoordinates,
      scope: payload.scope,
      outcome: payload.outcome ?? undefined,
      trust: writeTrust(request.tier, payload.trust),
      createdBy,
      // Agent-authored memory is always a proposal. Even an equal-trust agent
      // may not retire an unconfirmed peer note before human governance; the
      // ledger's proposalOnly branch keeps both records and reconciliation
      // evidence. Operator/human writes retain the ordinary supersede path.
      ...(request.tier === "agent" ? { proposalOnly: true } : {}),
      // An authenticated job capability's coordinates WIN over the body's.
      taskId: caller.taskId ?? payload.taskId,
      chatId: caller.chatId ?? payload.chatId,
      // ADR-0026: the workspace partition is DERIVED and has NO body field to
      // override it — `createNoteSchema` does not accept one and must not, or the
      // partition becomes a caller claim. An operator write lands NULL (the §8
      // residue, invisible to every agent read and to every pack export).
      ...(caller.workspacePath
        ? { workspacePath: caller.workspacePath }
        : {}),
      // TODO 4.21: provenance is server-derived. A job id is stable and
      // addressable; no agent-authored description is allowed to masquerade as
      // the circumstance under which MUON saved this revision.
      provenance: caller.jobId
        ? { sourceType: "job", rawRef: `job:${caller.jobId}` }
        : { sourceType: request.tier === "operator" ? "human" : "agent" },
    });
    reply.code(201);
    return {
      note: result.note,
      action: result.action,
      relatedNoteId: result.relatedNoteId ?? null,
    };
  });

  app.get("/search", async (request) => {
    const { q, asOf, scope, chatId, showExpired, filter, workspace, unscoped } = z
      .object({
        q: z.string().min(1),
        // Bitemporal as-of (KG-5): "what did the brain believe about X at T".
        asOf: asOfSchema,
        scope: z.string().min(1).optional(),
        // #126: an agent's chat-scoped search (from MUON_CHAT_ID). Absent → the
        // global view (operator/CLI). Enforced post-fusion so FTS/semantic
        // candidates from another chat cannot leak.
        chatId: z.string().min(1).optional(),
        // R3 / R5, see the shared helpers above.
        showExpired: boolFlagSchema,
        filter: filterParamSchema,
        // ADR-0026 §1: this route was NOT in the reported unfenced list and is the
        // same hole as `/library` and `/recall` — the operator tier yields
        // `{principal:"human"}` with no chatId, so `visibilityClauses` added no
        // clause at all and one search spanned every repo on the machine.
        ...workspaceReadSchema,
      })
      .parse(request.query);
    const memoryFilter = parseFilterParam(app, filter);
    const caller = await memoryCallerScope(app, request, chatId);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace,
      unscoped,
    });
    const crewVisible =
      request.tier === "agent" && caller.chatId
        ? await getAutoConfirmAgentMemory()
        : false;
    // Pure read: searchMemory reads accessCount for ranking but NEVER writes it
    // (reinforcement is off the read path, KG-2). Use is signalled explicitly
    // via POST /used when a note is actually cited/applied. asOf/scope give the
    // bitemporal + scope-aware view (KG-5); absent = current active set.
    // R3 / LEDGER DECIDES EXPIRY (see the note above `governedMemoryView`): the
    // graph is asked for candidates WITHOUT its own expiry clause, because the
    // post-filter can only REMOVE rows and could never add back one the mirror
    // wrongly dropped.
    // B3, NOT in the reported list but the same unguarded call: search reads the
    // mirror exactly as recall does, so it took the same unmapped 500. Leaving
    // one of four open is how a bounded surface stays broken — see the guard
    // block above `GRAPH_DEGRADED_REASON_CHARS`.
    const found = await getGraph()
      .searchMemory(q, 20, {
        asOf: normalizeAsOf(asOf),
        scope,
        chatId: caller.chatId,
        // ADR-0026: derived for an agent, explicit-and-validated for an operator.
        ...readWorkspace,
        governedOnly: request.tier === "agent",
        crewChatId: crewVisible ? caller.chatId : undefined,
        showExpired: true,
      })
      .catch((error: unknown) => graphDegraded(error));
    if ("degraded" in found) {
      return { notes: [], ...found };
    }
    const reconciled = await governedMemoryView(found, {
      showExpired: request.tier === "operator" && flagEnabled(showExpired),
      filter: memoryFilter,
      asOf: normalizeAsOf(asOf),
    });
    return {
      notes: crewReadableMemoryView(reconciled, {
        tier: request.tier,
        chatId: caller.chatId,
        crewVisible,
      }),
    };
  });

  // TODO 4.14: a physical projection for vendors that reliably Read/Grep files
  // but may never call an MCP tool. No workspace claim exists on this route: the
  // exact-job capability supplies the one canonical workspace, and an older job
  // token with no workspace fails closed instead of receiving a global brain.
  app.get("/directory-snapshot", async (request) => {
    const capability = requireAgentJobCapability(app, request);
    const workspacePath = capability.workspacePath;
    if (!workspacePath) {
      throw app.httpErrors.forbidden(
        "A governed memory directory requires an exact workspace capability."
      );
    }
    try {
      return await buildMemoryDirectorySnapshot(getGraph(), workspacePath);
    } catch (error) {
      if (error instanceof MemoryDirectoryTooLargeError) {
        throw app.httpErrors.payloadTooLarge(error.message);
      }
      throw error;
    }
  });

  // Explicit "used" signal (ADR-0009 §2.4 / KG-2): a note was actually
  // cited/applied, reinforce it (buffered, decayed, flushed off the read path
  // and persisted to the durable ledger). Retrieval alone never reinforces.
  //
  // REINFORCEMENT FOLLOWS VISIBILITY. `accessCount` is not a log line — it feeds
  // `usageNorm` in the calibrated ranker, so a bump on a note the caller may not
  // READ accrues ranking weight while nobody can see it, and the note then lands
  // PRE-BOOSTED the instant a human confirms it. Confirmation must stay a
  // neutral act. So the ids below are narrowed to exactly what this caller could
  // have read: the chat partition (or confirmed global), admitted by the same
  // crew posture the read gates use, minus notes past their R3 deadline. Every
  // exclusion has the same redemption path the read surfaces have — a human
  // confirm, after which the agent may signal use again and it counts.
  app.post("/used", async (request, reply) => {
    const { noteIds, accessType } = z
      .object({
        noteIds: z.array(z.string().min(1)).min(1).max(100),
        // Absent is an honest rolling-upgrade state, not guessed provenance.
        accessType: memoryAccessTypeSchema.default("legacy_used"),
      })
      .parse(request.body);
    const caller = await memoryCallerScope(app, request);
    let visibleNoteIds = [...new Set(noteIds)];
    if (request.tier === "agent") {
      if (!caller.chatId) {
        throw app.httpErrors.forbidden(
          "Agent memory reinforcement requires an authenticated partition."
        );
      }
      const partition = caller.chatId;
      const rows = await prisma.memoryNote.findMany({
        where: {
          id: { in: visibleNoteIds },
          status: "active",
          retiredAt: null,
          // ADR-0026 — REINFORCEMENT FOLLOWS VISIBILITY on the workspace axis too.
          // This `OR` is a SECOND, independently-written copy of the read rule, so
          // it needs the workspace term or an agent accrues ranking weight on
          // another repo's note: `usageNorm` feeds the calibrated ranker, and the
          // note then lands PRE-BOOSTED in the repo it does belong to. A top-level
          // field, so it ANDs OUTSIDE the `scope:"global"` leg exactly as the
          // library's where-clause and `visibilityClauses` do. Absent capability
          // workspace → no term, matching what the read paths do for the same job.
          ...(caller.workspacePath
            ? { workspacePath: caller.workspacePath }
            : {}),
          OR: [{ chatId: partition }, { scope: "global" }],
        },
        select: { id: true, chatId: true, scope: true },
      });
      const crewVisible = await getAutoConfirmAgentMemory();
      const readable = new Map(
        (await applyMemoryExpiry(rows.map((row) => ({ id: row.id })))).map(
          (note) => [note.id, note]
        )
      );
      visibleNoteIds = rows
        .filter((row) => {
          const note = readable.get(row.id);
          if (!note) return false;
          const confirmed = note.confirmedBy === "human";
          // Same-chat citation under the crew-visible posture needs no vouch —
          // same rule as `crewReadableMemoryView` (the chatId term below is the
          // partition fence).
          const crewReadable = crewVisible;
          return (
            (row.chatId === partition && (confirmed || crewReadable)) ||
            (row.scope === "global" && confirmed)
          );
        })
        .map((row) => row.id);
    }
    // R3: and, either tier, never reinforce a note past its deadline. An expired
    // note is hidden from every recall path, so this bump would be pure hidden
    // weight, redeemed into a visible ranking boost the moment a human confirms
    // it (confirming clears the expiry). The route has no `showExpired` opt-in
    // precisely because there is no legitimate "cite what nobody can read".
    // Non-destructive: the signal is refused, not stored and ignored, and the
    // `buffered` count says so.
    // Expiry/liveness was applied with the same authoritative ledger hydration
    // above; operator-tier calls enter this branch with their submitted ids.
    if (request.tier === "operator") {
      visibleNoteIds = (
        await applyMemoryExpiry(visibleNoteIds.map((id) => ({ id })))
      ).map((note) => note.id);
    }
    // Evidence first, soft ranking hint second. If the typed append fails, this
    // request cannot silently boost a note while leaving no account of why.
    await appendMemoryAccesses(visibleNoteIds, accessType, {
      principal: caller.principal,
      taskId: caller.taskId,
      jobId: caller.jobId,
      missionId: caller.chatId,
    });
    recordMemoryUsed(visibleNoteIds);
    reply.code(202);
    // Preserve the pre-4.12 response shape for rolling clients; the durable
    // evidence is operator-readable through the separate analytics endpoint.
    return { buffered: visibleNoteIds.length };
  });

  const symbolUidCacheSchema = z.object({
    // GitNexus's own indexed commit (the SAME `repo.graphCommit` a `code_impact`
    // call already returned), never re-derived here — `readSymbolUidCache`
    // treats any OTHER value as a miss, so a wrong commit here just costs a
    // future reader a re-resolve, it can never serve a stale uid as current.
    graphCommit: z.string().min(1).max(128),
    entries: z
      .array(
        z
          .object({
            localId: z.string().min(1).max(1024),
            gitnexusUid: z.string().min(1).max(1024),
          })
          .refine(
            (entry) =>
              gitnexusUidToLocalSymbolId(entry.gitnexusUid) === entry.localId,
            {
              message:
                "gitnexusUid must independently map to the submitted localId",
            }
          )
      )
      .min(1)
      .max(128),
  });

  // D2 option B (docs/design/memory-index-decisions.md): a reader-owned,
  // commit-stamped CACHE of GitNexus uids a caller already resolved (from its
  // own `code_impact` call), so a LATER reader at the same commit can skip
  // re-resolving GitNexus for a symbol it has already seen. Best-effort and
  // idempotent (MuonGraph.cacheSymbolUid MERGEs); this writes ONLY the derived
  // `Symbol` cache fields (`symbolUid`/`symbolUidAt`) and never touches the
  // memory ledger, a gate, or any authority — a failed or dropped write here
  // can never be observed as anything other than a future cache miss.
  app.post("/symbol-uid-cache", async (request, reply) => {
    const { graphCommit, entries } = symbolUidCacheSchema.parse(request.body);
    const graph = getGraph();
    let cached = 0;
    for (const entry of entries) {
      try {
        await graph.cacheSymbolUid(entry.localId, entry.gitnexusUid, graphCommit);
        cached += 1;
      } catch {
        // One bad row must not fail the whole best-effort batch.
      }
    }
    reply.code(202);
    return { cached };
  });

  app.get("/recall", async (request) => {
    const filter = z
      .object({
        // ADR-0027 D13: an addressable coordinate from a peer message. This is
        // still a recall (not the operator-only raw note endpoint): the server
        // applies workspace, mission, liveness and trust-tier fences below and
        // returns [] for missing/hidden ids to avoid an existence oracle.
        // Full id OR a ≥8-hex short prefix (git-style). Agents abbreviate
        // ids relentlessly; an exact-only lookup answered "no such note" for
        // notes that existed, and a coordinator escalated that into a false
        // memory-loss finding. Resolution requires UNIQUENESS
        // (resolveMemoryNoteByIdOrPrefix); ambiguity reads as missing.
        noteId: z
          .string()
          .regex(/^mem-[0-9a-f]{8}(-[0-9a-f-]{0,27})?$/i)
          .optional(),
        taskId: z.string().min(1).optional(),
        laneId: z.string().min(1).optional(),
        module: z.string().min(1).optional(),
        // D4: the SYMBOL anchor, finally reachable. `MemoryRecallFilter.symbol`
        // (ADR-0012) and the graph's anchor predicate have both worked since the
        // symbol tier landed, and no route exposed them — so the finest anchor MUON
        // records was writable and unreadable. It rides the exact same path as
        // `module` (spread into the retrieval request below, then through
        // `visibilityClauses`), so it inherits the workspace fence, the chat
        // partition, `asOf`, TTL and the KG-6 gate with nothing restated. It is a
        // read COORDINATE, not an authority: naming a symbol cannot widen what the
        // caller may see.
        symbol: z.string().min(1).optional(),
        topic: z.string().min(1).optional(),
        kind: z
          .enum(["decision", "constraint", "convention", "attempt", "question"])
          .optional(),
        outcome: attemptOutcomeSchema.optional(),
        relatedToTask: z.string().min(1).optional(),
        // TODO 4.1: the STANDING-MEMORY arm — human-confirmed `constraint` +
        // `convention` canon for the caller's workspace, no anchor, no chat
        // partition (human-confirmed is exactly the tier that crosses chats).
        // A read knob like `showExpired`, stripped before the spread below.
        standing: boolFlagSchema,
        // Bitemporal as-of + scope-aware recall (KG-5). Default (absent) = the
        // current active, all-scope set, unchanged. asOf travels transaction +
        // valid time; scope softly restricts (D5: not hard-gated in v1).
        asOf: asOfSchema,
        scope: z.string().min(1).optional(),
        // #126: an agent's chat-scoped recall (from MUON_CHAT_ID). Absent → the
        // global view. Hard-filters `n.chatId = $chatId` in the graph query, and
        // scopes the relatedToTask traversal to the chat.
        chatId: z.string().min(1).optional(),
        // R3 / R5, see the shared helpers above.
        showExpired: boolFlagSchema,
        filter: filterParamSchema,
        // ADR-0026 §1: measured unfenced — operator recall yields
        // `{principal:"human"}` with no chatId, so no clause was added at all.
        ...workspaceReadSchema,
      })
      .parse(request.query);
    const memoryFilter = parseFilterParam(app, filter.filter);
    // The grammar's own key is `filter`; strip both knobs before the rest of the
    // object is spread into the graph's recall filter, so a read knob can never
    // become a graph query term. ADR-0026: `workspace`/`unscoped` are stripped for
    // the SAME reason and are then re-added below from `memoryReadWorkspace` alone —
    // spreading the raw query would let a caller's CLAIM reach the predicate
    // directly, which is the one thing §4 forbids.
    const {
      showExpired,
      filter: _rawFilter,
      workspace: _workspace,
      unscoped: _unscoped,
      standing,
      noteId: _noteId,
      ...recallFilter
    } = filter;
    const view = {
      showExpired: request.tier === "operator" && flagEnabled(showExpired),
      filter: memoryFilter,
    };
    const caller = await memoryCallerScope(app, request, filter.chatId);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: filter.workspace,
      unscoped: filter.unscoped,
    });
    const crewVisible =
      request.tier === "agent" && caller.chatId
        ? await getAutoConfirmAgentMemory()
        : false;

    if (filter.noteId) {
      const note = await resolveMemoryNoteByIdOrPrefix(filter.noteId);
      if (!note) {
        return { notes: [] };
      }
      const workspaceVisible = readWorkspace.unscopedWorkspace
        ? (note.workspacePath ?? "") === ""
        : !readWorkspace.workspacePath ||
          (note.workspacePath ?? "") === readWorkspace.workspacePath;
      const sameMission = Boolean(
        caller.chatId && note.chatId === caller.chatId
      );
      // Same rule as `crewReadableMemoryView`: crew-visible posture admits a
      // SAME-MISSION note without a vouch (D13 exists precisely so a peer can
      // relay a fresh, necessarily-unvouched note id).
      const trustedForAgent =
        (note.confirmed === true &&
          (sameMission || note.scope === "global")) ||
        (crewVisible && sameMission);
      if (
        !workspaceVisible ||
        (request.tier === "agent" && !trustedForAgent)
      ) {
        return { notes: [] };
      }
      const live = await applyMemoryExpiry([note], view);
      return {
        notes: live.filter(
          (candidate) =>
            candidate.status === "active" &&
            (!memoryFilter || matchesMemoryFilter(candidate, memoryFilter))
        ),
      };
    }

    // TODO 4.1 — the standing-memory arm. Its posture is fixed in the graph
    // method (human-confirmed only, active, not stale, constraint+convention,
    // chat-independent) and the workspace fence rides the same single
    // evaluator as every other candidate query. TODO 4.22 adds the small
    // decision-canon projection from the existing ledger: a decision must be
    // human-confirmed, pinned, promoted-global, fresh, and in this workspace.
    // The ledger then re-gates:
    // `governedMemoryView` → `applyMemoryExpiry` overrides `confirmed` from
    // the Confirmation ledger, and the STRICT gate posture (`governedOnly`
    // with no crew widening and no trust floor — the same `memoryPassesGate`
    // every other evaluator delegates to) is re-applied over those truer
    // copies. The mirror may lag a `PATCH {confirmed:false}`, and a standing
    // note a human just un-blessed must not keep riding into briefs.
    if (flagEnabled(standing)) {
      const recalledStanding = await getGraph()
        .standingMemory({ ...readWorkspace })
        .catch((error: unknown) => graphDegraded(error));
      if ("degraded" in recalledStanding) {
        return { notes: [], ...recalledStanding };
      }
      const [reconciled, decisionCanon] = await Promise.all([
        governedMemoryView(recalledStanding, view),
        listStandingDecisionLog({ ...readWorkspace }),
      ]);
      const seen = new Set<string>();
      return {
        notes: [...decisionCanon, ...reconciled].filter((note) => {
          if (seen.has(note.id)) return false;
          seen.add(note.id);
          const standingKind =
            note.kind === "constraint" ||
            note.kind === "convention" ||
            (note.kind === "decision" && note.pinned === true);
          return (
            standingKind &&
            note.status === "active" &&
            note.scope === "global" &&
            !note.stale &&
            memoryPassesGate(note, { governedOnly: true })
          );
        }),
      };
    }

    // Traversal recall: task -> touched modules -> anchored notes + lane notes.
    if (filter.relatedToTask) {
      // B3: a graph outage costs this caller its recall, not a 500. It returns
      // NO notes and SAYS so — an agent that reads `degraded` knows the brain
      // could not be consulted, which is not the same fact as "nothing is
      // remembered about this task".
      const traversal = await getGraph()
        .relatedToTask(filter.relatedToTask, 50, {
          chatId: caller.chatId,
          // ADR-0026: the traversal builds its own three WHEREs, so it calls the
          // graph's single workspace evaluator directly. This is the path
          // `recallRelatedToTask` uses to seed every worker's brief.
          ...readWorkspace,
          governedOnly: request.tier === "agent",
          crewChatId: crewVisible ? caller.chatId : undefined,
          // The LEDGER decides expiry on this path, not the mirror. See the note
          // above `governedMemoryView`.
          showExpired: true,
        })
        .catch((error: unknown) => graphDegraded(error));
      if ("degraded" in traversal) {
        return { notes: [], ...traversal };
      }
      const reconciled = await governedMemoryView(traversal, view);
      return {
        notes: crewReadableMemoryView(reconciled, {
          tier: request.tier,
          chatId: caller.chatId,
          crewVisible,
        }),
      };
    }

    // Normalize as-of to canonical ms-UTC-Z before it reaches the graph (F1).
    const recalled = await getGraph()
      .recallMemory({
        ...recallFilter,
        chatId: caller.chatId,
        ...readWorkspace,
        asOf: normalizeAsOf(filter.asOf),
        governedOnly: request.tier === "agent",
        crewChatId: crewVisible ? caller.chatId : undefined,
        // The LEDGER decides expiry on this path, not the mirror. See the note
        // above `governedMemoryView`; `view.showExpired` still gates what the
        // authoritative post-filter returns.
        showExpired: true,
      })
      .catch((error: unknown) => graphDegraded(error));
    if ("degraded" in recalled) {
      return { notes: [], ...recalled };
    }
    // The ledger's liveness verdict is measured at the SAME instant the graph's
    // visibility predicate used, so the two cannot disagree about which set this
    // read is answering for. The `relatedToTask` branch above deliberately does
    // NOT thread it: that traversal takes no `asOf` in its graph query either,
    // so its answer is the current set and the ledger must judge it as one.
    const reconciled = await governedMemoryView(recalled, {
      ...view,
      asOf: normalizeAsOf(filter.asOf),
    });
    return {
      notes: crewReadableMemoryView(reconciled, {
        tier: request.tier,
        chatId: caller.chatId,
        crewVisible,
      }),
    };
  });

  app.get("/library", async (request) => {
    requireOperator(app, request);
    const filter = z
      .object({
        q: z.string().max(500).optional(),
        chatId: z.string().min(1).max(200).optional(),
        status: z.enum(["all", "active", "paused", "rejected"]).default("all"),
        // P0-2: `unvouched` is the REVIEW-QUEUE bucket (nobody has vouched,
        // human or orchestrator). `unconfirmed` keeps its literal human-tier
        // meaning — see MemoryLibraryFilter.
        confirmed: z
          .enum(["all", "confirmed", "unconfirmed", "unvouched"])
          .default("all"),
        kind: z
          .enum(["decision", "constraint", "convention", "attempt", "question"])
          .optional(),
        trust: z.enum(["low", "medium", "high"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(200),
        orderBy: memoryLibraryOrderBySchema.default("updatedAt"),
        derivation: noteDerivationSchema.optional(),
        reviewStatus: noteReviewStatusSchema.optional(),
        // R3 / R5. This route is already operator-only, so `showExpired` is a
        // plain toggle here — the human review queue is exactly where an expired
        // note has to be visible, because confirming it is how it is redeemed.
        showExpired: boolFlagSchema,
        filter: filterParamSchema,
        // ADR-0026 §1: THE measured leak. This page already spanned two distinct
        // workspaces on the founder's own brain, with nothing on the wire or on
        // screen distinguishing them, and ADR-0009's back-compat paragraph is what
        // exempted it ("operator-tier reads stay a GLOBAL view"). That exemption is
        // withdrawn here.
        ...workspaceReadSchema,
      })
      .parse(request.query);
    const memoryFilter = parseFilterParam(app, filter.filter);
    // `requireOperator` above already 403'd the agent tier, so this resolves to the
    // human principal with no derived workspace. Called anyway rather than passing a
    // hand-made `{}`, so `memoryReadWorkspace` sees the SAME shape on every read
    // route and the agent branch stays correct if this route's gate ever moves.
    const caller = await memoryCallerScope(app, request, filter.chatId);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: filter.workspace,
      unscoped: filter.unscoped,
    });
    const crewVisible = filter.chatId
      ? await getAutoConfirmAgentMemory()
      : false;
    // FIELD BY FIELD, not `{...filter}`: the raw query object now carries the two
    // workspace CLAIMS, and spreading it would put them into the ledger's filter
    // beside the resolved values, where the last writer wins by accident. The
    // resolved `readWorkspace` is the only workspace input the ledger ever sees.
    const {
      workspace: _workspace,
      unscoped: _unscoped,
      ...libraryFilter
    } = filter;
    const [snapshot, analytics] = await Promise.all([
      listMemoryLibrary({
        ...libraryFilter,
        ...readWorkspace,
        showExpired: flagEnabled(filter.showExpired),
        filter: memoryFilter,
      }),
      getGraph()
        .memoryAnalytics(
          // The analytics half now has its own reason to run: a workspace-fenced
          // library must not be annotated with hot modules computed over every repo
          // on the machine. Previously only a chat scope produced a scoped call.
          filter.chatId || readWorkspace.workspacePath || readWorkspace.unscopedWorkspace
            ? {
                ...(filter.chatId
                  ? {
                      chatId: filter.chatId,
                      governedOnly: true,
                      crewChatId: crewVisible ? filter.chatId : undefined,
                      crewVouchedOnly: crewVisible,
                    }
                  : {}),
                ...readWorkspace,
              }
            : undefined
        )
        .catch(() => EMPTY_MEMORY_ANALYTICS),
    ]);
    return { ...snapshot, analytics };
  });

  // B4 coordinate-only analytics. Agent calls fail closed without a chat
  // partition and analyze only confirmed/crew-visible memory in that chat plus
  // confirmed global notes. No note text is selected or returned.
  app.get("/analytics", async (request) => {
    const query = z
      .object({
        chatId: z.string().min(1).max(200).optional(),
        limit: z.coerce.number().int().min(1).max(5_000).default(2_000),
        // ADR-0026: coordinate-only output, but still an ANSWER about a corpus —
        // "these are the load-bearing modules" is false if it was computed over
        // three repos, and the module PATHS themselves are workspace-relative, so an
        // unfenced answer silently merges repo A's `src/index.ts` with repo B's.
        ...workspaceReadSchema,
      })
      .parse(request.query);
    const caller = await memoryCallerScope(app, request, query.chatId);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: query.workspace,
      unscoped: query.unscoped,
    });
    const crewVisible =
      request.tier === "agent" && caller.chatId
        ? await getAutoConfirmAgentMemory()
        : false;
    return getGraph().memoryAnalytics({
      chatId: caller.chatId,
      ...readWorkspace,
      limit: query.limit,
      governedOnly: request.tier === "agent",
      crewChatId: crewVisible ? caller.chatId : undefined,
      crewVouchedOnly: crewVisible,
    });
  });

  // TODO 4.12: operator-only, text-free outcome measurement. It answers whether
  // an access path is ASSOCIATED with later human confirmation, never whether it
  // caused confirmation and never feeds ranking or authority.
  app.get("/analytics/access-types", async (request) => {
    requireOperator(app, request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(50_000).default(50_000),
        ...workspaceReadSchema,
      })
      .parse(request.query);
    const caller = await memoryCallerScope(app, request);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: query.workspace,
      unscoped: query.unscoped,
    });
    return getMemoryAccessAnalytics({ ...readWorkspace, limit: query.limit });
  });

  // P1.4 memory packs, the operator-only, read-only, deterministic export of
  // the CONFIRMED slice (+ tombstones) for the file-based team sync. Ledger-
  // direct via collectMemoryPack (NOT /library, whose read truncates at 200
  // rows). requireOperator is the FIRST statement: an agent-tier caller is
  // 403'd before any body/query work, so the agent tier can never touch the
  // raw sync transport. The workspace boundary is validated server-side; a
  // path outside the allowed roots refuses with the existing reason string.
  // ADR-0026 §7: that boundary is now an ALLOW-predicate on `MemoryNote.
  // workspacePath` — a note leaves only in its OWN workspace's pack, the §8
  // residue leaves in nobody's, and both withholdings are counted in the
  // manifest's omissions under distinct reasons.
  app.get("/pack/export", async (request) => {
    requireOperator(app, request);
    const { workspace } = z
      .object({ workspace: z.string().min(1).optional() })
      .parse(request.query);
    const validation = validateWorkspacePath(workspace ?? process.cwd());
    if (!validation.ok) {
      throw app.httpErrors.badRequest(validation.reason);
    }
    // ADR-0026 §7 — VALIDATE, then REDUCE, through the same `repoRootOf` every read
    // route uses (never a second evaluator). This route validated and stopped, which
    // was survivable while the boundary was the `taskId` deny-list and is not now:
    // the export compares this string against the stored partition, so an operator
    // exporting from a worktree path, a symlinked spelling or a case variant would
    // compare a DIFFERENT string and export nothing at all. Fail-closed, so never a
    // leak — and a silently empty pack is its own kind of wrong.
    return collectMemoryPack(await repoRootOf(validation.path));
  });

  // P1.4 memory packs, the import side: PROPOSALS ONLY. requireOperator is the
  // FIRST statement (403 before any body work) — the agent tier can never
  // inject records, not even as proposals, and never touches the raw sync
  // transport. The lib re-verifies EVERYTHING server-side (digest, content
  // addresses, confirmation⇔text binding, human origin confirm, redaction
  // re-run); a pack-level defect refuses the whole pack with its reason (400),
  // record-level defects ride the deterministic report. No Confirmation row is
  // ever written by an import — landing unconfirmed is structural.
  app.post(
    "/pack/import",
    { bodyLimit: 16 * 1024 * 1024 },
    async (request) => {
      requireOperator(app, request);
      // CODE-L: thread the operator's workspace into the self-pack guard so it is
      // fingerprinted against the ACTUAL receiving workspace, not just the server
      // cwd + task-anchored paths. Without it, a task-less workspace's OWN
      // exported notes could re-enter as low-trust `pack:ws-…` proposals. The
      // param is validated the same way as the export side; absent → cwd default
      // (unchanged behavior for existing callers).
      //
      // ADR-0026 §7 gives the same value a SECOND, authority-bearing job: it is the
      // partition stamped on every proposal this import creates and on the
      // `MemoryImport` row. So it is VALIDATED and then REDUCED by `repoRootOf`, the
      // one evaluator the read routes share — an operator importing from a worktree
      // path must land the proposal in the repo, not in an island that no read
      // coordinate will ever name again. Absent stays absent (§8's residue): a
      // guessed `process.cwd()` partition would be authority invented by the server.
      const { workspace } = z
        .object({ workspace: z.string().min(1).optional() })
        .parse(request.query);
      let resolvedWorkspace: string | undefined;
      if (workspace !== undefined) {
        const validation = validateWorkspacePath(workspace);
        if (!validation.ok) {
          throw app.httpErrors.badRequest(validation.reason);
        }
        resolvedWorkspace = await repoRootOf(validation.path);
      }
      const result = await importMemoryPack(request.body, {
        workspace: resolvedWorkspace,
      });
      if (!result.ok) {
        throw app.httpErrors.badRequest(result.reason);
      }
      return result.report;
    }
  );

  // P2.5 HERO, the dual-graph pre-edit gate. Fuses the CODE blast-radius with the
  // GOVERNED (confirmed-only, KG-6) memory anchored to it and surfaces prior
  // decisions + contradiction warnings for the HUMAN surfaces (TUI/app, P6). The
  // orchestrator, which holds the hosted GitNexus client, calls impact THERE and
  // passes the affected modules in `blastRadiusModules`; MUON's local-first backend
  // makes NO code-graph call (default provider does no work → no egress). This is a
  // pure READ: no reinforcement here (KG-2 keeps reinforcement off the read path;
  // the MCP tool fires the explicit used-signal for the agent).
  const preeditSchema = z.object({
    symbol: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    // Bounded to guard the loopback graph store from query amplification: the gate
    // fans out one recall per anchor module (a real symbol's blast-radius is well
    // under this), and preEditContext ALSO slices to MAX_ANCHOR_MODULES defensively.
    files: z.array(z.string().min(1)).max(128).optional(),
    // The orchestrator's GitNexus impact result, passed straight in (capped).
    blastRadiusModules: z.array(z.string().min(1)).max(128).optional(),
    blastRadiusSymbols: z.array(z.string().min(1)).max(512).optional(),
    blastRadiusDepth: z.number().int().nonnegative().optional(),
    // Bitemporal + gate knobs (KG-5 / KG-6).
    asOf: asOfSchema,
    scope: z.string().min(1).optional(),
    // #126: the calling agent's chat (from MUON_CHAT_ID). Absent → the global
    // gate (human Brain panel / operator). When set, the gate's confirmed-only
    // recall AND the general pending-proposal recall stay in-chat, with the sole
    // B6 exception for human-confirmed promoted-global notes.
    chatId: z.string().min(1).optional(),
    // ADR-0026 §9 — THE HERO READ. It fans out one `recallForGate` per anchor
    // MODULE, and those anchors are workspace-RELATIVE paths, so this is the single
    // surface where a cross-repo collision would put another repo's decision in
    // front of an editing agent. Unlike `chatId` (whose D1 deferral is documented
    // below), the workspace is AUTHENTICATED for the agent tier: a body claim that
    // disagrees with the capability is refused, never honoured.
    workspace: z.string().min(1).max(4_096).optional(),
    unscoped: z.boolean().optional(),
    trustFloor: z.enum(["low", "medium", "high"]).optional(),
    // R3: mem0's `show_expired` on the hero gate. Operator-only (the human Brain
    // panel adjudicating a note); an agent-tier request is silently downgraded
    // to the hygienic default, exactly like `trustFloor` below.
    showExpired: z.boolean().optional(),
    // KG-7 (ADR-0014) SELF-EXCLUSION: the calling lane's own task/job, so it is
    // never surfaced as a peer "live on this code" against ITSELF. Optional, the
    // human Brain panel omits them (it is not a lane), the MCP tool passes the
    // dispatched lane's own taskId. Additive; absent → no self to exclude.
    excludeTaskId: z.string().min(1).optional(),
    excludeJobId: z.string().min(1).optional(),
  });

  app.post("/preedit", async (request) => {
    const body = preeditSchema.parse(request.body ?? {});
    const caller = await memoryCallerScope(app, request, body.chatId);
    // A JSON body, so `unscoped` is a real boolean here; the shared resolver takes
    // the query-string convention, and this is the one adapter for that.
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: body.workspace,
      unscoped: body.unscoped === true ? "true" : undefined,
    });
    // CG-1 (ADR-0012 Decision 6, ALWAYS-ON): lazily select the local code-graph
    // provider (memoized singleton; the module loads on the first gate call, not at
    // boot). No enable flag; the only "off" is the provider's intrinsic
    // degrade-to-null. A caller-supplied blastRadius below STILL short-circuits it
    // and wins (preedit.ts).
    const provider = await selectCodeGraphProvider();
    // #133: read the OPERATOR-owned crew-visible toggle SERVER-SIDE (default ON).
    // It is deliberately NOT a field on `preeditSchema` — an agent-facing body can
    // never set it, and there is no env override an agent controls. The per-chat
    // blast radius is hard-wired in preEditContext (crewChatId = the request's own
    // chatId), so this flag only decides whether same-chat unconfirmed agent notes
    // become crew-visible; it can never auto-confirm or cross a chat boundary.
    const crewVisibleMemory = await getAutoConfirmAgentMemory();
    // ADR-0035: which notes a same-chat peer has cited as a finding. Bounded to
    // this chat and to finding-shaped kinds; the SELECT deliberately omits
    // `subject` and `body`, so the citing message's prose has no path into the
    // gate payload even by accident.
    //
    // A citation only reorders and labels what the governed read below already
    // returned — `citationsByNote` is handed ids, never used to fetch — so this
    // cannot promote a tier or reach outside the caller's partition.
    let citedFindings = new Map<string, CitingPeer>();
    if (caller.chatId && caller.jobId) {
      try {
        const citingMessages = await prisma.peerMessage.findMany({
          where: {
            chatId: caller.chatId,
            kind: { in: ["review_verdict", "constraint", "blocked", "finding"] },
          },
          orderBy: { createdAt: "desc" },
          take: CITATION_SCAN_LIMIT,
          select: {
            id: true,
            fromJobId: true,
            fromRole: true,
            kind: true,
            createdAt: true,
            refs: true,
          },
        });
        citedFindings = citationsByNote(citingMessages, caller.jobId);
      } catch {
        // A finding that cannot be read is a finding not delivered — never a
        // failed gate. The gate's own evidence is unaffected.
        citedFindings = new Map();
      }
    }
    const result = await preEditContext(
      getGraph(),
      { symbol: body.symbol, module: body.module, files: body.files },
      {
        provider,
        // Key on EITHER input: a symbols-only impact (the orchestrator paid
        // GitNexus to compute it, but the blast radius came back as symbols with
        // no module rollup) must NOT be silently discarded — that dropped the
        // whole "WHY THIS DISPATCH" symbol evidence. `modules` defaults to [] so
        // the provided source still resolves when only symbols were supplied.
        blastRadius:
          body.blastRadiusModules || body.blastRadiusSymbols
            ? {
                modules: body.blastRadiusModules ?? [],
                symbols: body.blastRadiusSymbols,
                depth: body.blastRadiusDepth,
                source: "provided",
              }
            : undefined,
        asOf: normalizeAsOf(body.asOf),
        scope: body.scope,
        // #126 + B6: scope reads to this chat plus confirmed global memory.
        chatId: caller.chatId,
        // ADR-0026: and to this WORKSPACE, ANDed outside that global admission, so
        // an anchor-module collision across repos cannot reach the gate.
        ...readWorkspace,
        // #133: the operator-owned crew-visible toggle (resolved above, default
        // ON). preEditContext hard-wires the admission's scope to `chatId`, so this
        // only widens the gate WITHIN the caller's own chat and never mutates the
        // human-only `confirmed` flag.
        crewVisibleMemory,
        citedFindings,
        // GOVERNANCE GATE (closes the trustFloor gate-bypass): trustFloor lowers
        // the confirmed-only gate to admit lower-trust notes' verbatim TEXT, a
        // HUMAN review knob. An agent-tier caller must never be able to elevate
        // its own unconfirmed note into the hero gate by asking for
        // trustFloor:"low"; the floor is honored ONLY for the operator tier.
        // Agent-tier callers always get the strict confirmed-only gate.
        trustFloor: request.tier === "operator" ? body.trustFloor : undefined,
        // KG-7 + KG-8 (ADR-0014): fuse the cross-agent activity channel, LIVE
        // (present tense, `DispatchJob(running)` over the Event log) PLUS RECENT
        // (past tense, the rebuildable `ACTED_ON` projection within a bounded
        // window). A passive, coordinate-only read (see lib/activity.ts), NEVER a
        // memory, never in the gate. Threads BOTH prisma AND the graph; degrades to
        // `activity: []` (today's hero) with no anchor match / any read error (the
        // recent leg is wrapped so a graph error never 500s the gate). Self-exclusion
        // honors excludeTaskId/excludeJobId for both legs.
        // Substrate §3.1: same workspace (+ chat) fence as memory notes — in the
        // candidate query, never a post-filter. Fail-closed without a workspace.
        // `allowGlobal` is operator-unscoped ONLY; agent `unscopedWorkspace` means
        // the empty residue, not a machine-wide scan.
        activityReader: readActivity(prisma, getGraph(), {
          partition: {
            workspacePath: readWorkspace.workspacePath,
            chatId: caller.chatId,
            allowGlobal:
              request.tier === "operator" &&
              Boolean(readWorkspace.unscopedWorkspace),
          },
        }),
        // KG-10 (ADR-0014 §5): the OPTIONAL duplicate-work channel, flag another
        // LIVE lane whose brief is a semantic paraphrase of the caller's. Reuses
        // the KG-3 loopback embedder (no egress); reads `DispatchJob.brief` ONLY to
        // embed it and surfaces a similarity SCALAR + ids, NEVER the text. Degrades
        // to `duplicateWork: []` with ZERO embed work when dense is off (no Ollama /
        // MUON_EMBED_DISABLE), the default consumer sees today's hero, no latency.
        duplicateWorkReader: readDuplicateWork(prisma, getEmbedder(), {
          workspacePath: readWorkspace.workspacePath,
          chatId: caller.chatId,
          allowGlobal:
            request.tier === "operator" &&
            Boolean(readWorkspace.unscopedWorkspace),
        }),
        excludeTaskId:
          request.tier === "agent" ? caller.taskId : body.excludeTaskId,
        excludeJobId:
          request.tier === "agent" ? caller.jobId : body.excludeJobId,
        // Substrate §3.3: once-per-job path-triggered standing injection ledger.
        // Agent jobs always have a jobId; operator probes may pass excludeJobId
        // as the job coordinate when they want dedup across repeated preflights.
        injectionLedger: injectionLedgerForJob(
          request.tier === "agent" ? caller.jobId : body.excludeJobId,
          request.tier
        ),
      }
    );
    // THE HERO GATE READS FROM THE LEDGER TOO, and it is the surface where that
    // matters most: `memory_preedit` / `preflight_edit` hand `memories[]` to an
    // agent as GOVERNED (human-confirmed) evidence, and it is the ONLY memory
    // surface that admits VERBATIM TEXT on that basis. Every other read reconciles
    // through `governedMemoryView`; this one kept only the id set, so `confirmed`,
    // `stale`, `trust`, `status`, `expiresAt` and the TEXT itself all came from the
    // mirror. Applied at the ROUTE rather than inside preEditContext so the gate
    // library keeps its single responsibility (and stays free of the ledger).
    //
    // Liveness alone does NOT rescue it, which is the whole reason this is a
    // second pass and not a filter: `PATCH { confirmed: false }` writes a `reject`
    // Confirmation and leaves `status`/`retiredAt` untouched, so the row is still
    // LIVE and was kept — carrying the mirror's `confirmed: true` and the note's
    // prose to an agent a human had explicitly un-blessed. So the gate PREDICATE
    // is re-applied over the ledger's copies, using `memoryPassesGate` — the same
    // function MuonGraph.passesGate delegates to, never a second statement of the
    // rule. It is a NARROWER over a set the store already admitted: same inputs,
    // truer values, so it can only ever remove a note.
    //
    // R3 rides along unchanged. Confirmed memory never expires, so expiry can only
    // touch the #133 crew-visible tier (same-chat UNCONFIRMED agent notes) — and
    // that is precisely the tier the TTL exists for: a three-month-old unreviewed
    // guess must not keep reaching the next agent as gate evidence.
    //
    // `asOf` is threaded because the gate takes one: `recallForGate` already
    // answered as-of T, and judging that answer with the CURRENT-set predicate
    // deleted the entire point of a bitemporal read — every note retired since T
    // vanished. `showExpired` (operator-only) opts out of R3 hygiene and NOTHING
    // else; it used to return before any reconciliation at all, which made the one
    // surface a human uses to adjudicate memory the one showing the mirror's raw
    // answer.
    const view = {
      showExpired: request.tier === "operator" && body.showExpired === true,
      asOf: normalizeAsOf(body.asOf),
    };
    // ONE posture object for the authoritative re-gate AND D14 tally. ADR-0027
    // deliberately omits `crewChatId`: crew-vouched text travels in the explicit
    // `crewFindings` inform channel below, never in the edit-governance gate.
    const gatePosture = {
      trustFloor: request.tier === "operator" ? body.trustFloor : undefined,
    };
    const reconciled = await applyMemoryExpiry(result.memories, view);
    const memories = reconciled.filter((note) =>
      memoryPassesGate(note, { governedOnly: true, ...gatePosture })
    );
    const crewFindings =
      crewVisibleMemory && caller.chatId
        ? reconciled
            .filter(
              (note) =>
                note.confirmed === false &&
                // Same rule as recall (2026-08-06): the posture admits the
                // whole SAME-MISSION crew set into the inform channel — an
                // implementer's fresh constraint about the very file under
                // edit is exactly what this channel exists to carry, and the
                // old `confirmedBy === "orchestrator"` term kept every
                // uncorroborated (i.e. unique) finding out of it.
                note.chatId === caller.chatId &&
                // …re-gated over the LEDGER's copies like `memories` above:
                // a PAUSED note (an operator's "not now") must dominate every
                // admission tier, and this channel used to be the one
                // agent-facing text path that never re-asked — a paused note
                // whose mirror update lagged rode into an editor's context.
                memoryPassesGate(note, {
                  governedOnly: true,
                  crewChatId: caller.chatId,
                })
            )
            .map((note) => ({
              ...note,
              confirmed: false as const,
              confirmedBy:
                note.confirmedBy === "orchestrator"
                  ? ("orchestrator" as const)
                  : null,
              tier: "crew_vouched" as const,
              authority: "inform" as const,
            }))
        : [];
    // Slice 3 — DELIVERY IS AN EVENT, not an inference (stance test T3). A
    // sibling's finding riding this channel into an agent's pre-edit context
    // is the moment "publish" becomes "delivered", and until now nothing
    // recorded it: the research doc's finding was that the human is the
    // transport layer and that cost is invisible BECAUSE delivery is not an
    // event. Recorded per (job, note, contentHash): a note EDITED since its
    // last delivery re-fires — new content is new information — while an
    // unchanged one records once. Best-effort and fire-and-forget like every
    // other injection record: telemetry must never fail a gate, and the
    // check-then-record race can at worst double-count one delivery.
    if (request.tier === "agent" && caller.jobId && crewFindings.length > 0) {
      // ONE spelling of the reason, used by BOTH the dedup probe and the
      // record — two literals would be a dedup key that never matches.
      const DELIVERY_REASON = "crew-finding-at-preedit";
      const recipientJobId = caller.jobId;
      const anchor = body.symbol ?? body.module ?? body.files?.[0] ?? "preedit";
      void Promise.all(
        crewFindings.map(async (note) => {
          const contentHash = createHash("sha256")
            .update(note.text ?? "")
            .digest("hex");
          if (
            await hasDeliveredContent(
              recipientJobId,
              note.id,
              contentHash,
              DELIVERY_REASON
            )
          ) {
            return;
          }
          recordMemoryInjected({
            noteId: note.id,
            jobId: recipientJobId,
            anchor,
            gateTier: "crew_vouched",
            tier: request.tier,
            reason: DELIVERY_REASON,
            contentHash,
            recipientJobId,
          });
        })
      ).catch(() => undefined);
    }
    // The coordinate-only channels get the same verdict: a `warnings` /
    // `pendingProposals` entry whose subject is hidden would leak that the note
    // still exists, the same existence channel the gate already withholds proposal
    // text over. `withheld` covers BOTH reasons a subject can be gone — the ledger
    // dropped the row, or the re-applied gate dropped the memory — because an
    // entry naming a memory this response just refused to show is that same leak.
    const kept = new Set(memories.map((note) => note.id));
    const referenced = [
      ...new Set([
        ...result.warnings.flatMap((warning) => [
          warning.noteId,
          warning.relatedNoteId,
        ]),
        ...result.pendingProposals.flatMap((proposal) => [
          proposal.proposalNoteId,
          proposal.victimNoteId,
        ]),
      ]),
    ].map((id) => ({ id }));
    const live = new Set(
      (await applyMemoryExpiry(referenced, view)).map((note) => note.id)
    );
    const gateDropped = new Set(
      result.memories.map((note) => note.id).filter((id) => !kept.has(id))
    );
    // ADR-0026 — THE THIRD TERM, and it was missing.
    //
    // `contradictionsOf` / `proposedSupersedesOf` are raw EDGE reads with no
    // partition predicate, so a cross-workspace edge (the pre-ADR-0026 shape, and
    // any edge an older brain already holds) puts a foreign note's ID into
    // `warnings`. Neither existing term could stop it: `applyMemoryExpiry` is a
    // liveness/expiry narrower with no workspace clause, and `gateDropped` only
    // knows about ids that were in `result.memories` — a foreign id never was.
    // An adversarial review reproduced an agent token receiving another repo's
    // note id this way. Ids only, but the route's own rule two comments up is
    // that "an entry whose subject is hidden would leak that the note still
    // exists", and it is the id source a cross-workspace clone needs.
    const referencedRows = await Promise.all(
      [...new Set(referenced.map((row) => row.id))].map(async (id) => ({
        id,
        workspacePath: (await getMemoryNote(id))?.workspacePath ?? null,
      }))
    );
    const inPartition = new Set(
      referencedRows
        .filter((row) => {
          if (readWorkspace.unscopedWorkspace) {
            return (row.workspacePath ?? "") === "";
          }
          // No coordinate = today's unscoped view (§5 monotonicity), so the term
          // adds nothing rather than hiding everything.
          return (
            !readWorkspace.workspacePath ||
            (row.workspacePath ?? "") === readWorkspace.workspacePath
          );
        })
        .map((row) => row.id)
    );
    const visible = (id: string) =>
      live.has(id) && !gateDropped.has(id) && inPartition.has(id);
    // D14: the ledger pass above is part of the GATE, not a redaction, and it can
    // only ever remove. So re-tally admission over the notes that actually
    // survived it, with the SAME posture. Returning the library's tally would
    // claim the gate admitted notes this response just dropped — and, when the
    // ledger drops the last one, would report no `emptyReason` at all on a
    // response whose `memories` is empty, which is precisely the silence D14
    // exists to remove. `anchors`/`considered`/`crewChat` describe the lookup and
    // are carried through untouched.
    const coverage = tallyGateCoverage(result.coverage, memories, gatePosture);
    // D14's producer. Recorded AFTER the ledger re-gate, so the persisted row is
    // the coverage the caller actually receives rather than the mirror's earlier,
    // wider answer. Fire-and-forget by contract — see `recordGateRead`.
    // TODO 4.3: `contextChars` is the Σ text length of exactly the notes this
    // response surfaces — the size of what actually entered the caller's
    // context, beside the count that was already recorded.
    recordGateRead(coverage, {
      tier: request.tier,
      contextChars: memories.reduce(
        (total, note) =>
          total + (typeof note.text === "string" ? note.text.length : 0),
        0
      ),
      informFindings: crewFindings.length,
      informContextChars: crewFindings.reduce(
        (total, note) => total + note.text.length,
        0
      ),
    });
    return {
      ...result,
      coverage,
      memories,
      crewFindings,
      warnings: result.warnings.filter(
        (warning) => visible(warning.noteId) && visible(warning.relatedNoteId)
      ),
      pendingProposals: result.pendingProposals.filter(
        (proposal) =>
          visible(proposal.proposalNoteId) && visible(proposal.victimNoteId)
      ),
    };
  });

  // B1: bounded memory-graph neighborhood. Text is serialized inside MuonGraph
  // through one complete allowlist: human-confirmed notes, plus same-chat
  // unconfirmed notes only when the server-owned crew-visible setting is ON.
  // Agent-tier requests MUST carry a chat partition; without one the route
  // refuses rather than falling back to an all-chat confirmed view.
  app.get("/neighbors/:nodeId", async (request) => {
    const { nodeId } = z
      .object({ nodeId: traversalCoordinateSchema })
      .parse(request.params);
    const query = traversalQuerySchema.parse(request.query);
    const caller = await memoryCallerScope(app, request, query.chatId);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: query.workspace,
      unscoped: query.unscoped,
    });
    if (
      request.tier === "agent" &&
      nodeId.includes(":") &&
      !nodeId.startsWith("note:")
    ) {
      throw app.httpErrors.badRequest(
        "Agent memory traversal must start from a memory note."
      );
    }
    const crewVisible = caller.chatId
      ? await getAutoConfirmAgentMemory()
      : false;
    // B3: degrade to an EMPTY, explicitly-degraded neighborhood rather than a
    // 500. The partition/text gates above still ran, so nothing is disclosed
    // that would not have been; the caller simply learns the mirror is down.
    const neighbors = await getGraph()
      .memoryNeighbors(nodeId, {
        hops: query.hops,
        limit: query.limit,
        relFilter: parseTraversalRelations(query.relations),
        chatId: caller.chatId,
        ...readWorkspace,
        crewVisible,
      })
      .catch((error: unknown) => graphDegraded(error));
    if ("degraded" in neighbors) {
      return {
        nodes: [],
        edges: [],
        provenance: degradedTraversalProvenance(nodeId, query.hops),
        ...neighbors,
      };
    }
    return {
      ...neighbors,
      nodes: await redactExpiredNodes(neighbors.nodes, {
        tier: request.tier,
        chatId: caller.chatId,
        crewVisible,
      }),
    };
  });

  // B2: shortest governed provenance path + contradiction peers. Same
  // partition and field-complete text gate as /neighbors.
  app.get("/explain/:noteId", async (request) => {
    const { noteId } = z
      .object({ noteId: traversalCoordinateSchema })
      .parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(100),
        chatId: z.string().min(1).max(200).optional(),
        // ADR-0026, same reasoning as `/neighbors` above.
        ...workspaceReadSchema,
      })
      .parse(request.query);
    const caller = await memoryCallerScope(app, request, query.chatId);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: query.workspace,
      unscoped: query.unscoped,
    });
    const crewVisible = caller.chatId
      ? await getAutoConfirmAgentMemory()
      : false;
    // B3: the founder's Memory tab used to take an unmapped 500 straight from
    // here. `goal: "missing"` is the graph's OWN spelling for "no provenance
    // path was found", so the degraded body stays inside the shipped contract —
    // and `degraded` is what tells the surface the difference between "no path
    // exists" and "the graph could not be asked".
    const explanation = await getGraph()
      .memoryExplain(noteId, {
        limit: query.limit,
        chatId: caller.chatId,
        ...readWorkspace,
        crewVisible,
      })
      .catch((error: unknown) => graphDegraded(error));
    if ("degraded" in explanation) {
      return {
        noteId,
        path: { nodes: [], edges: [], goal: "missing" as const },
        contradictions: [],
        provenance: degradedTraversalProvenance(noteId, 6),
        ...explanation,
      };
    }
    const [pathNodes, contradictions] = await Promise.all([
      redactExpiredNodes(explanation.path.nodes, {
        tier: request.tier,
        chatId: caller.chatId,
        crewVisible,
      }),
      redactExpiredNodes(explanation.contradictions, {
        tier: request.tier,
        chatId: caller.chatId,
        crewVisible,
      }),
    ]);
    return {
      ...explanation,
      path: { ...explanation.path, nodes: pathNodes },
      contradictions,
    };
  });

  // B3: governed hard delete. The ledger enforces the final authorization
  // inside the write actor: operator may delete any note; an agent may delete
  // only agent-tier-owned unconfirmed same-chat memory. The response is
  // coordinates-only.
  app.delete("/:noteId", async (request) => {
    const { noteId } = z
      .object({ noteId: traversalCoordinateSchema })
      .parse(request.params);
    const query = z
      .object({
        chatId: z.string().min(1).max(200).optional(),
      })
      .parse(request.query);
    const caller = await memoryCallerScope(app, request, query.chatId);
    const result = await deleteMemoryNote(noteId, {
      tier: request.tier,
      principal: caller.principal,
      chatId: caller.chatId,
    });
    if (result.status === "missing") {
      throw app.httpErrors.notFound(result.reason);
    }
    if (result.status === "forbidden") {
      throw app.httpErrors.forbidden(result.reason);
    }
    if (result.status === "protected") {
      throw app.httpErrors.conflict(result.reason);
    }
    return {
      noteId: result.noteId,
      deleted: true,
      alreadyDeleted: result.status === "already_deleted",
    };
  });

  // B3: clone an active note into a fresh unconfirmed proposal. Agent callers
  // are same-chat and use the server-owned crew-visible gate for unconfirmed
  // sources. The route never echoes source/clone text.
  app.post("/:noteId/clone", async (request) => {
    const { noteId } = z
      .object({ noteId: traversalCoordinateSchema })
      .parse(request.params);
    const body = z
      .object({
        chatId: z.string().min(1).max(200).optional(),
      })
      .parse(request.body ?? {});
    const caller = await memoryCallerScope(app, request, body.chatId);
    const crewVisible =
      request.tier === "agent" && caller.chatId
        ? await getAutoConfirmAgentMemory()
        : false;
    const result = await cloneMemoryNote(noteId, {
      tier: request.tier,
      principal: caller.principal,
      chatId: caller.chatId,
      // ADR-0026: the caller's OWN partition, derived from the capability exactly
      // as a read's is — never a body value. `cloneMemoryNote` fences on it.
      workspacePath: caller.workspacePath,
      crewVisible,
    });
    if (result.status !== "cloned") {
      if (result.status === "missing") {
        throw app.httpErrors.notFound(result.reason);
      }
      throw app.httpErrors.forbidden(result.reason);
    }
    return {
      noteId: result.note.id,
      clonedFromNoteId: result.sourceNoteId,
      confirmed: false as const,
    };
  });

  // B6 PATCH-like govern operation. Tier check is intentionally FIRST: an
  // agent receives 403 before params/body/note lookup, so note existence cannot
  // be probed through this authority boundary.
  app.post("/:noteId/promote-global", async (request) => {
    requireOperator(app, request);
    const { noteId } = z
      .object({ noteId: traversalCoordinateSchema })
      .parse(request.params);
    const result = await promoteMemoryNoteToGlobal(noteId);
    if (result.status === "missing") {
      throw app.httpErrors.notFound(result.reason);
    }
    if (result.status === "unconfirmed") {
      throw app.httpErrors.conflict(result.reason);
    }
    return {
      noteId: result.noteId,
      scope: "global" as const,
      promoted: result.status === "promoted",
      alreadyGlobal: result.status === "already_global",
    };
  });

  // ADR-0026 §11: repair the two classes `0041_memory_note_workspace` left behind.
  //   • the RESIDUE — notes it left unassigned because neither witness resolved,
  //     or because the two disagreed (`scanned`/`written`/`noWitness`/`disagreed`);
  //   • the MIS-KEYED partition — notes it ASSIGNED, to a RAW witness value that no
  //     `repoRootOf`-derived read coordinate can name, so they are invisible to
  //     every agent read and non-exportable by every pack (`rekeyed`).
  // Reported apart, because "no partition" and "a partition nobody can name" are
  // different defects and an operator adjudicates them differently.
  //
  // OPERATOR-ONLY and DRY-RUN BY DEFAULT. A partition assignment decides which
  // agents may be TOLD a fact, so the default answer is a report, never a write;
  // `{ apply: true }` is the explicit second act. The body carries no workspace
  // coordinate on purpose — this route only re-derives from state MUON already
  // recorded, and can therefore never move a note into a workspace nobody's
  // dispatch was ever bound to.
  app.post("/backfill-workspace", async (request) => {
    requireOperator(app, request);
    const { apply } = z
      .object({ apply: z.boolean().optional() })
      .parse(request.body ?? {});
    return backfillMemoryNoteWorkspace({ ...(apply ? { apply } : {}) });
  });

  // B3: operator-only, bounded compaction of already-retired history. A missing
  // or malformed setting fails closed to no deletion.
  app.post("/compact", async (request) => {
    requireOperator(app, request);
    const retentionDays = await getMemoryCompactionRetentionDays();
    if (retentionDays === null) {
      throw app.httpErrors.serviceUnavailable(
        "Memory compaction retention is unavailable; no notes were changed."
      );
    }
    const body = bulkMemoryRemovalBodySchema.parse(request.body ?? {});
    try {
      return await compactMemory(retentionDays, new Date(), body);
    } catch (error) {
      // The binding matters most HERE: compaction clears text, so applying to
      // a set the operator never reviewed cannot be undone.
      if (error instanceof MemoryPreviewStaleError) {
        throw app.httpErrors.conflict(error.message);
      }
      throw error;
    }
  });

  // R3: run the bounded expiry sweep on demand. OPERATOR-ONLY, and deliberately
  // so: the sweep is an eviction act, and eviction is governance (the same rule
  // that keeps `memory_delete` off confirmed memory). It is also idempotent and
  // never required for correctness — reads derive hidden-ness from `expiresAt`
  // directly — so a caller cannot change what anyone sees by invoking it, only
  // how promptly the soft tombstone is materialized. A missing/malformed TTL
  // policy fails closed to no eviction and says so in `skipped`.
  app.post("/sweep-expired", async (request) => {
    requireOperator(app, request);
    const body = bulkMemoryRemovalBodySchema.parse(request.body ?? {});
    try {
      return await sweepExpiredMemory(new Date(), body);
    } catch (error) {
      // A stale preview is a state CONFLICT, not a bad request: the operator's
      // move is to preview again, not to fix their payload.
      if (error instanceof MemoryPreviewStaleError) {
        throw app.httpErrors.conflict(error.message);
      }
      throw error;
    }
  });

  // TODO 4.16: reverse a soft expiry sweep as a unit. Compaction batches are
  // not reversible — their text was cleared.
  app.post("/revert-expired-batch", async (request) => {
    requireOperator(app, request);
    const { batchId } = z
      .object({ batchId: z.string().min(1).max(100) })
      .parse(request.body ?? {});
    return revertExpiredMemoryBatch(batchId);
  });

  // D6, the ON-DEMAND half of "the anchor completeness invariant is asserted at
  // boot and on demand" (the boot half runs at the tail of
  // `projectLedgerToGraph`). It answers, as numbers, the question the mirror could
  // not be asked before: does every entry of `n.modules` / `n.symbols` have its
  // `ANCHORED_TO` / `ABOUT_SYMBOL` edge, and does every edge have its array entry?
  // Those edges are now the anchored read's ACCESS PATH, so a divergence is not
  // cosmetic — it is a note the gate cannot see. They are also rows 15, 17 and 23
  // of the health harness, so an operator can diff this against
  // `npm run health:memory` without a second definition of the same predicate.
  //
  // OPERATOR-ONLY, and REPORT-BY-DEFAULT like `/backfill-workspace`: the read is
  // four scalar queries and always safe, while `{ repair: true }` writes edges, so
  // the write is an explicit second act. The repair can only ever make the edges
  // agree with the note's own arrays — it never invents an anchor, never touches a
  // note's arrays, and never touches the ledger, so it cannot change WHICH notes
  // exist or WHO may see them, only whether a note the ledger already anchored is
  // reachable through the index.
  app.post("/reconcile-anchors", async (request) => {
    requireOperator(app, request);
    const { repair } = z
      .object({ repair: z.boolean().optional() })
      .parse(request.body ?? {});
    return getGraph()
      .reconcileAnchorEdges({ ...(repair ? { repair } : {}) })
      .catch((error: unknown) => graphDegraded(error));
  });

  // P6a, the human's note-by-id read. The hero gate (POST /preedit) surfaces a
  // pending PROPOSES_SUPERSEDE as existence + IDs ONLY (the proposing note is
  // UNTRUSTED, attacker-controllable, its verbatim text is withheld from the
  // agent by OMISSION). To ADJUDICATE it, the human pre-edit ("Brain") panel
  // fetches the note's TEXT here ON DEMAND by id. OPERATOR-TIER ONLY
  // (requireOperator): a human is trusted to read + decide, but an agent-tier
  // caller is 403'd so this can never become an exfiltration path for an
  // unconfirmed note's contents. Pure read, never reinforces (KG-2).
  app.get("/:noteId", async (request) => {
    requireOperator(app, request);
    const params = z
      .object({ noteId: z.string().min(1) })
      .parse(request.params);
    const query = z
      .object({
        chatId: z.string().min(1).max(200).optional(),
        // ADR-0026 §9 lists this route, and it had NEITHER the parameter nor the
        // term — so no caller could fence it even deliberately. It is the surface
        // designed to hand out a note's PROSE on demand, and an adversarial review
        // reproduced it returning another repository's note verbatim, including
        // that repo's absolute `workspacePath`. The chat guard below could not
        // help: its `scope:"global" AND confirmed` escape is exactly the leg that
        // matches across every workspace on the machine.
        ...workspaceReadSchema,
      })
      .parse(request.query);
    const caller = await memoryCallerScope(app, request, query.chatId);
    const readWorkspace = await memoryReadWorkspace(app, request, caller, {
      workspace: query.workspace,
      unscoped: query.unscoped,
    });
    const note = await getMemoryNote(params.noteId);
    if (!note) {
      throw app.httpErrors.notFound("The requested memory note does not exist.");
    }
    // The SAME 404 for every refusal below, so this endpoint can never become an
    // existence oracle — for another chat OR another repository.
    const missing = () =>
      app.httpErrors.notFound("The requested memory note does not exist.");
    // WORKSPACE FIRST, and OUTSIDE the chat clause's global admission — the term
    // order §6 requires, so a promoted global note still cannot cross a repo.
    if (readWorkspace.unscopedWorkspace) {
      if ((note.workspacePath ?? "") !== "") {
        throw missing();
      }
    } else if (
      readWorkspace.workspacePath &&
      (note.workspacePath ?? "") !== readWorkspace.workspacePath
    ) {
      throw missing();
    }
    if (
      query.chatId &&
      note.chatId !== query.chatId &&
      !(note.scope === "global" && note.confirmed)
    ) {
      // Desktop's operator surface is still partitioned by its selected chat.
      throw missing();
    }
    return { note };
  });

  app.patch("/:noteId", async (request) => {
    // The agent bearer authenticates one shared principal, so MUON cannot prove
    // that an unconfirmed note is "owned" by the caller. Keep generic mutation
    // behind the operator boundary until job/chat-bound agent capabilities exist.
    // requireOperator is intentionally first so the agent tier cannot use PATCH
    // as a note-existence oracle.
    requireOperator(app, request);
    const params = z
      .object({ noteId: z.string().min(1) })
      .parse(request.params);
    const payload = updateNoteSchema.parse(request.body);
    // Confirm/trust/status/text edits are ledger-first too (append-only
    // Confirmation + derived state) so a note's confirmed lineage survives a
    // graph rebuild; the graph is then re-projected from the ledger. The
    // confirming principal is derived from authenticated operator authority,
    // never from an agent-supplied body value.
    const note = await updateMemoryNote(params.noteId, {
      ...payload,
      principal: confirmingPrincipal(payload.principal),
    });
    if (!note) {
      throw app.httpErrors.notFound("The requested memory note does not exist.");
    }
    // F5 — a memory adjudication is a governance act and gets an audit row:
    // WHICH fields the human touched (names only, never note text) and the
    // resulting confirmed/status values. Best-effort; never fails the PATCH.
    try {
      await prisma.event.create({
        data: {
          ...(await requestAuditColumns(request, {
            payloadDiff: {
              fields: Object.keys(payload).filter((k) => k !== "principal"),
              confirmed: note.confirmed,
              status: note.status,
            },
          })),
          laneId: "muon",
          taskId: note.taskId ?? "memory",
          kind: "memory.adjudicated",
          message: `memory note ${payload.confirmed === true ? "confirmed" : payload.confirmed === false ? "rejected" : "updated"}`,
          metadata: { noteId: note.id },
        },
      });
    } catch (error) {
      console.error(
        `[audit] memory.adjudicated event failed for ${note.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { note };
  });

  // #133 the operator-owned crew-visible toggle. OPERATOR-TIER ONLY for BOTH read
  // and write (requireOperator FIRST): it is a HUMAN govern posture, so a
  // dispatched sub-agent can neither read nor flip it — the ONLY way it takes
  // effect is server-side in POST /preedit, which resolves it itself. Two path
  // segments, so it never collides with GET/PATCH "/:noteId". Default ON when
  // unset (operator-settings.ts); the per-chat blast radius is hard-wired in code.
  app.get("/settings/auto-confirm-agent-memory", async (request) => {
    requireOperator(app, request);
    return { autoConfirmAgentMemory: await getAutoConfirmAgentMemory() };
  });

  app.put("/settings/auto-confirm-agent-memory", async (request) => {
    requireOperator(app, request);
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .parse(request.body);
    return { autoConfirmAgentMemory: await setAutoConfirmAgentMemory(enabled) };
  });

  // R4 memory mining. WRITE is operator-only like every other posture flag. READ
  // is the one deliberate asymmetry on this file: the reader is MUON's own
  // RUNNER, which holds the shared agent bearer (never the operator one) and has
  // to resolve the flag to decide whether to mine after a job finishes.
  //
  // The widening stops exactly there. A per-job capability — the credential a
  // VENDOR process actually holds — is refused, so the disclosure never reaches
  // a sub-agent, and what the runner learns is one boolean about MUON's own
  // configuration: no note text, no authority, and nothing an agent could act
  // on, since mined notes still land UNCONFIRMED behind the human gate.
  app.get("/settings/memory-mining", async (request) => {
    if (request.agentJobCapability) {
      throw app.httpErrors.forbidden(
        "A per-job capability cannot read operator posture settings."
      );
    }
    return { memoryMining: await getMemoryMining() };
  });

  app.put("/settings/memory-mining", async (request) => {
    requireOperator(app, request);
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .parse(request.body);
    return { memoryMining: await setMemoryMining(enabled) };
  });

  // TODO 4.7 ingest deny/allow policy. Operator-tier only — a content lever the
  // agent tier must never read or write.
  app.get("/settings/memory-ingest-policy", async (request) => {
    requireOperator(app, request);
    return await getMemoryIngestPolicy();
  });

  app.put("/settings/memory-ingest-policy", async (request) => {
    requireOperator(app, request);
    const policy = memoryIngestPolicySchema.parse(request.body);
    return setMemoryIngestPolicy(policy);
  });

  // R3 TTL policy. OPERATOR-TIER ONLY for BOTH read and write: unlike the R4
  // mining flag, this decides when un-governed memory stops being recalled, so
  // it is a human eviction posture and an agent may neither read nor set it.
  // Two path segments, so it never collides with GET/PATCH "/:noteId".
  app.get("/settings/memory-ttl", async (request) => {
    requireOperator(app, request);
    const lifecycle = await getMemoryLifecyclePolicy();
    if (lifecycle?.source === "kind_table") {
      throw app.httpErrors.conflict(
        "Kind-dependent lifecycle policy is active; use /settings/memory-lifecycle."
      );
    }
    const policy = await getMemoryTtlPolicy();
    if (!policy) {
      throw app.httpErrors.serviceUnavailable(
        "Memory TTL policy is unavailable; no notes are being expired."
      );
    }
    return policy;
  });

  app.put("/settings/memory-ttl", async (request) => {
    requireOperator(app, request);
    const lifecycle = await getMemoryLifecyclePolicy();
    if (lifecycle?.source === "kind_table") {
      throw app.httpErrors.conflict(
        "Kind-dependent lifecycle policy is active; use /settings/memory-lifecycle."
      );
    }
    const policy = z
      .object({
        // 0 disables expiry outright; the ceiling can never be "high", because
        // "a high-trust note never auto-expires" is an invariant, not a dial.
        days: z.number().int().min(0).max(3_650),
        trustCeiling: z.enum(["low", "medium"]).default("medium"),
      })
      .parse(request.body);
    return setMemoryTtlPolicy(policy);
  });

  // TODO 4.11. The effective table is operator-readable; activation is a
  // preview-bound migration so changing five lifecycle rows can never silently
  // hide existing memory.
  app.get("/settings/memory-lifecycle", async (request) => {
    requireOperator(app, request);
    const effective = await getMemoryLifecyclePolicy();
    if (!effective) {
      throw app.httpErrors.serviceUnavailable(
        "Memory lifecycle policy is unavailable; no notes are being expired."
      );
    }
    return {
      ...effective,
      recommended: RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
    };
  });

  app.post("/settings/memory-lifecycle/migrate", async (request) => {
    requireOperator(app, request);
    const body = z
      .object({
        policy: memoryLifecyclePolicySchema,
        dryRun: z.boolean(),
        previewDigest: z.string().length(64).optional(),
      })
      .superRefine((value, context) => {
        if (!value.dryRun && !value.previewDigest) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["previewDigest"],
            message:
              "previewDigest is required when applying a lifecycle migration",
          });
        }
      })
      .parse(request.body);
    try {
      return await migrateMemoryLifecyclePolicy(
        body.policy,
        body.dryRun
          ? { dryRun: true }
          : { dryRun: false, previewDigest: body.previewDigest! }
      );
    } catch (error) {
      if (error instanceof MemoryLifecyclePreviewMismatchError) {
        throw app.httpErrors.conflict(error.message);
      }
      throw error;
    }
  });

  app.get("/settings/memory-compaction-retention", async (request) => {
    requireOperator(app, request);
    const retentionDays = await getMemoryCompactionRetentionDays();
    if (retentionDays === null) {
      throw app.httpErrors.serviceUnavailable(
        "Memory compaction retention is unavailable."
      );
    }
    return { retentionDays };
  });

  app.put("/settings/memory-compaction-retention", async (request) => {
    requireOperator(app, request);
    const { retentionDays } = z
      .object({ retentionDays: z.number().int().min(1).max(3_650) })
      .parse(request.body);
    return {
      retentionDays: await setMemoryCompactionRetentionDays(retentionDays),
    };
  });
}
