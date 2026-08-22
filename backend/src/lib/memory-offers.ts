import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import type {
  MemoryDecisionHistory,
  MemoryOfferSurface,
} from "@muon/protocol";
import { prisma } from "./db.js";
import {
  agentJobPrincipal,
  agentMemoryPartition,
  requireAgentJobCapability,
} from "./auth.js";
import { repoRootOf } from "./workspace-identity.js";

/**
 * ADR-0060 — the offer ledger: "MUON offered note N to job J", recorded
 * server-side INSIDE the serve paths, at the moment a route returns note
 * content to a governed session.
 *
 * Three properties the call sites must preserve:
 *
 *  • DERIVED COORDINATES ONLY. The caller object here is the route's
 *    `memoryCallerScope` result — partition and job come from the
 *    authenticated capability, never from a body or query claim. A serve
 *    with no capability-derived job (an operator read) records NOTHING:
 *    offers attribute context to governed sessions, and an operator at the
 *    desk is not one.
 *
 *  • WHAT WAS SERVED, not what was fetched: call sites pass the ids of the
 *    bounded, fenced, redacted response — a note whose text was withheld
 *    was not offered (see `noteIdsFromTraversalNodes`).
 *
 *  • AWAITED, NEVER FATAL. Recording is awaited in the request (it is not
 *    the fire-and-forget reinforcement signal), but a failed write must not
 *    fail the read: the serve answers from the graph mirror, the offer row
 *    lands in the relational ledger, and the two failure domains stay
 *    separate (the ADR-0058 D3 posture). A drop UNDERSTATES provenance —
 *    the safe direction — and is logged loudly.
 */

/** Notes recorded before the offer ledger existed have NO offer-set, and the
 *  dossier must say "predates the offer ledger", never "read nothing"
 *  (ADR-0060 non-goals). Fallback epoch: the 0062_memory_offer migration
 *  DATE — the true boundary is when the migration actually APPLIED on this
 *  machine, which `offerLedgerSince` reads from the migration ledger itself
 *  (review finding: a rollout-day note between midnight and the apply time
 *  must not read "ok + empty"). */
export const MEMORY_OFFER_LEDGER_SINCE = new Date("2026-08-21T00:00:00.000Z");

let ledgerSincePromise: Promise<Date> | undefined;

/** The instant this machine's offer ledger began: `finished_at` of migration
 *  0062 from Prisma's own migration table, memoized; the migration-date
 *  constant when unreadable (older reading, never a throw). */
export function offerLedgerSince(): Promise<Date> {
  ledgerSincePromise ??= (async () => {
    try {
      const rows = (await prisma.$queryRaw`
        SELECT finished_at FROM _prisma_migrations
        WHERE migration_name = '0062_memory_offer'
        LIMIT 1
      `) as Array<{ finished_at: unknown }>;
      const finished = rows?.[0]?.finished_at;
      const parsed =
        finished instanceof Date
          ? finished
          : typeof finished === "string" || typeof finished === "number"
            ? new Date(finished)
            : undefined;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    } catch {
      // fall through to the constant
    }
    return MEMORY_OFFER_LEDGER_SINCE;
  })();
  return ledgerSincePromise;
}

export type MemoryOfferCaller = {
  chatId?: string;
  jobId?: string;
  workspacePath?: string;
  principal: string;
};

export type MemoryCallerScope = {
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
 * THE caller-scope derivation for every route that serves or records memory
 * content — moved here from routes/memory.ts (ADR-0088's direction, first
 * step) when the 0069 pre-answer needed the SAME derivation and the
 * alternative was a second spelling in routes/questions.ts.
 */
export async function memoryCallerScope(
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

/** Ids from a plain note-list response ({notes: [...]} / items arrays). */
export function noteIdsFromNotes(
  notes: ReadonlyArray<{ id?: string | null } | null | undefined>
): string[] {
  const ids: string[] = [];
  for (const note of notes) {
    const id = note?.id?.trim();
    if (id) ids.push(id);
  }
  return ids;
}

/** Ids from traversal nodes (/neighbors, /explain): only note nodes WHOSE
 *  TEXT WAS SERVED count — a redacted node disclosed existence, not content,
 *  and an offer is a claim about content having been put in front of the
 *  session. */
export function noteIdsFromTraversalNodes(
  nodes: ReadonlyArray<{
    type?: string;
    entityId?: string;
    text?: string;
  } | null>
): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (
      node?.type === "note" &&
      typeof node.text === "string" &&
      node.entityId
    ) {
      ids.push(node.entityId);
    }
  }
  return ids;
}

declare const servedContentBrand: unique symbol;
/**
 * ADR-0088, first implementation step: content that has passed THE recording
 * boundary. The brand is TYPE-ONLY — runtime bytes are identical — and
 * exists so content-bearing response values carry proof they were recorded.
 * Today the proof travels with the VALUE (every response-path serve below
 * builds its content field through {@link serveNoteContent}); the ADR's full
 * compiler enforcement — response schemas that accept only this type —
 * lands when route responses gain typed builders, and is the named
 * remainder of 0088, not a silent claim.
 */
export type ServedContent<T> = T & { readonly [servedContentBrand]: true };

/**
 * THE response-path serve boundary (ADR-0088): takes ALREADY-FENCED,
 * already-bounded content a route is about to return, records its offers
 * (fail-open-LOUD, per-job key, all of 0060's rules via the one recorder
 * below — which is MODULE-PRIVATE: this boundary is the only way to record
 * an offer at all), and returns the content branded. The 0069 pre-answer
 * serves its disclosed excerpts through here too, even though they travel
 * by event rather than response — one boundary, no raw path.
 */
export async function serveNoteContent<T>(
  caller: MemoryOfferCaller,
  surface: MemoryOfferSurface,
  content: T,
  noteIds: ReadonlyArray<string>,
  log?: FastifyBaseLogger
): Promise<ServedContent<T>> {
  await recordMemoryOffers(caller, surface, noteIds, log);
  return content as ServedContent<T>;
}

/**
 * The SOFT entry to the same derivation: `null` for an agent-tier request
 * with no exact-job capability (the shared runner token's control-plane
 * bookkeeping) instead of the 403 `memoryCallerScope` correctly raises for
 * memory reads. For serves that are LEGAL without a capability but record
 * only when one exists (the 0080 packet serve on task detail), this is the
 * one spelling — never a route-local re-derivation.
 */
export async function optionalMemoryCallerScope(
  app: FastifyInstance,
  request: FastifyRequest
): Promise<MemoryCallerScope | null> {
  if (request.tier === "agent" && !request.agentJobCapability) {
    return null;
  }
  return memoryCallerScope(app, request);
}

/** ADR-0080: which serve paths may deliver packet content. The positive
 *  list, exactly as MEMORY_OFFER_SURFACES is for notes. */
export const PACKET_OFFER_SURFACES = [
  "handoff-read",
  // ADR-0082: a packet excerpt served into a question's crew-context block.
  "question-crew-context",
] as const;
export type PacketOfferSurface = (typeof PACKET_OFFER_SURFACES)[number];

/**
 * ADR-0080 through the 0088 boundary: serve packet content, recording the
 * DELIVER rows ("MUON served packet P to job J") into the HandoffOffer
 * ledger with the same posture as note offers — per-job set semantics,
 * operator serves record nothing, fail-open LOUD, rows grant nothing.
 * Returns the content BRANDED, identical at runtime.
 */
export async function servePacketContent<T>(
  caller: MemoryOfferCaller,
  surface: PacketOfferSurface,
  content: T,
  handoffIds: ReadonlyArray<string>,
  log?: FastifyBaseLogger
): Promise<ServedContent<T>> {
  const jobId = caller.jobId;
  const partition = caller.chatId;
  if (!jobId || !partition || handoffIds.length === 0) {
    return content as ServedContent<T>;
  }
  const unique = [...new Set(handoffIds)];
  try {
    await prisma.$transaction(
      unique.map((handoffId) =>
        prisma.handoffOffer.upsert({
          where: { jobId_handoffId: { jobId, handoffId } },
          update: {},
          create: {
            partition,
            jobId,
            handoffId,
            surface,
            principal: caller.principal,
            ...(caller.workspacePath
              ? { workspacePath: caller.workspacePath }
              : {}),
          },
        })
      )
    );
  } catch (error) {
    log?.error(
      { err: error, surface, jobId, handoffCount: unique.length },
      "handoff delivery recording failed; the serve was answered without it"
    );
  }
  return content as ServedContent<T>;
}

/**
 * Record the offer rows for one serve. Set semantics per (jobId, noteId):
 * re-offering updates nothing, so growth is bounded by |notes a job actually
 * saw|. Skips entirely when the caller has no capability-derived job+partition.
 */
async function recordMemoryOffers(
  caller: MemoryOfferCaller,
  surface: MemoryOfferSurface,
  noteIds: ReadonlyArray<string>,
  log?: FastifyBaseLogger
): Promise<void> {
  const jobId = caller.jobId;
  const partition = caller.chatId;
  if (!jobId || !partition || noteIds.length === 0) {
    return;
  }
  const unique = [...new Set(noteIds)];
  try {
    // One transaction, not a per-id awaited loop (review finding): the
    // writes are independent, and a multi-note serve must not pay one DB
    // round trip per note. `surface` records the FIRST offer's surface —
    // set semantics keep later re-serves from touching the row at all.
    await prisma.$transaction(
      unique.map((noteId) =>
        prisma.memoryOffer.upsert({
          where: { jobId_noteId: { jobId, noteId } },
          update: {},
          create: {
            partition,
            jobId,
            noteId,
            surface,
            principal: caller.principal,
            ...(caller.workspacePath
              ? { workspacePath: caller.workspacePath }
              : {}),
          },
        })
      )
    );
  } catch (error) {
    // Availability wins; the drop understates provenance (never overstates)
    // and is loud enough to be found.
    log?.error(
      { err: error, surface, jobId, noteCount: unique.length },
      "memory offer recording failed; the serve was answered without it"
    );
  }
}

const DERIVED_FROM_LIMIT = 50;
const OFFERED_TO_LIMIT = 20;

/**
 * ADR-0060 D4 — the decision-history section of a note dossier: who wrote
 * the note, what the brain had offered its partition by then, and where the
 * note has been offered since. COORDINATES ONLY — no note text ever rides a
 * history entry; reading a listed note still passes every fence (D5).
 *
 * The caller is responsible for the FENCE: this builder must only run for a
 * note the asking session may read (the route reuses the same scope check
 * grounding uses).
 */
export async function decisionHistoryForNote(note: {
  id: string;
  chatId?: string | null;
  recordedAt: Date | string;
  createdBy: string | null;
  /** ADR-0026: the note's OWN workspace partition. Every history join is
   *  additionally fenced to it (review finding): a chat and a workspace are
   *  1:1 today by construction, but that is a coincidence of two keys — the
   *  fence header itself warns against relying on it — so the join restates
   *  the fence rather than inheriting the coincidence. */
  workspacePath?: string | null;
  /** The note's provenance `rawRef` (`job:<id>` for a dispatched write) —
   *  the authoritative "which job wrote this" when present. */
  provenanceRawRef?: string | null;
}): Promise<MemoryDecisionHistory> {
  const recordedAt =
    note.recordedAt instanceof Date
      ? note.recordedAt
      : new Date(note.recordedAt);
  const partition = note.chatId ?? null;
  const workspaceFence = { workspacePath: note.workspacePath ?? null };
  // Which job wrote it: the provenance episode when it names one; otherwise
  // the write observed as a serve (the note's own add/clone offer row). Null
  // for operator writes and pre-ledger notes — absence of evidence, not
  // "no job".
  const provenanceJob = note.provenanceRawRef?.startsWith("job:")
    ? note.provenanceRawRef.slice("job:".length)
    : null;
  const authored = provenanceJob
    ? null
    : await prisma.memoryOffer.findFirst({
        where: { noteId: note.id, surface: { in: ["add", "clone"] } },
        orderBy: { firstAt: "asc" },
      });
  const written = {
    by: note.createdBy,
    at: recordedAt.toISOString(),
    partition,
    job: provenanceJob ?? authored?.jobId ?? null,
  };
  const derivedFrom = await (async (): Promise<
    MemoryDecisionHistory["derivedFrom"]
  > => {
    if (!partition) {
      return { status: "unpartitioned" };
    }
    if (recordedAt < (await offerLedgerSince())) {
      return { status: "predates-offer-ledger" };
    }
    const where = {
      partition,
      ...workspaceFence,
      firstAt: { lte: recordedAt },
      noteId: { not: note.id },
    };
    const [total, rows] = await Promise.all([
      prisma.memoryOffer.count({ where }),
      prisma.memoryOffer.findMany({
        where,
        orderBy: { firstAt: "asc" as const },
        take: DERIVED_FROM_LIMIT,
      }),
    ]);
    return {
      status: "ok",
      total,
      truncated: total > rows.length,
      offers: rows.map((row) => ({
        noteId: row.noteId,
        jobId: row.jobId,
        surface: row.surface as MemoryOfferSurface,
        firstAt: row.firstAt.toISOString(),
      })),
    };
  })();
  const offeredWhere = { noteId: note.id, ...workspaceFence };
  const [offeredTotal, offeredRecent, distinctCounts] = await Promise.all([
    prisma.memoryOffer.count({ where: offeredWhere }),
    prisma.memoryOffer.findMany({
      where: offeredWhere,
      orderBy: { firstAt: "desc" as const },
      take: OFFERED_TO_LIMIT,
    }),
    // COUNT(DISTINCT …) in the database (review finding: `groupBy`
    // materializes every distinct row just to count it — unbounded work for
    // two numbers). Unreadable → counts from the bounded recent window,
    // reported as such by `truncated` staying honest.
    (async () => {
      try {
        // Two spellings on purpose: `IS <bind>` is SQLite-only — Postgres
        // rejects a parameter as IS's right operand (review finding), and
        // ADR-0008 keeps every query on the portability seam 0072 rides.
        const rows = (await (note.workspacePath
          ? prisma.$queryRaw`
              SELECT COUNT(DISTINCT "jobId") AS jobs,
                     COUNT(DISTINCT "partition") AS partitions
              FROM "MemoryOffer"
              WHERE "noteId" = ${note.id}
                AND "workspacePath" = ${note.workspacePath}
            `
          : prisma.$queryRaw`
              SELECT COUNT(DISTINCT "jobId") AS jobs,
                     COUNT(DISTINCT "partition") AS partitions
              FROM "MemoryOffer"
              WHERE "noteId" = ${note.id}
                AND "workspacePath" IS NULL
            `)) as Array<{ jobs: unknown; partitions: unknown }>;
        const jobs = Number(rows?.[0]?.jobs);
        const partitions = Number(rows?.[0]?.partitions);
        if (Number.isFinite(jobs) && Number.isFinite(partitions)) {
          return { jobs, partitions };
        }
      } catch {
        // fall through to the bounded-window estimate
      }
      return null;
    })(),
  ]);
  const recentJobs = new Set(offeredRecent.map((row) => row.jobId)).size;
  const recentPartitions = new Set(offeredRecent.map((row) => row.partition))
    .size;
  return {
    written,
    derivedFrom,
    offeredTo: {
      total: offeredTotal,
      jobs: distinctCounts?.jobs ?? recentJobs,
      partitions: distinctCounts?.partitions ?? recentPartitions,
      truncated: offeredTotal > offeredRecent.length,
      recent: offeredRecent.map((row) => ({
        jobId: row.jobId,
        partition: row.partition,
        surface: row.surface as MemoryOfferSurface,
        firstAt: row.firstAt.toISOString(),
      })),
    },
  };
}
