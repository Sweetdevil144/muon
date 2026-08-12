import {
  A2A_PROTOCOL_VERSION,
  CLAIM_TTL_MS,
  MAX_CLAIMED_PATHS_PER_JOB,
  MAX_PEER_INBOX_PAGE,
  MAX_PEER_MESSAGES_PER_JOB,
  MIN_PEER_SEND_INTERVAL_MS,
  agentRoleSchema,
  claimCoordinateFile,
  claimCoordinateKindSchema,
  claimCoordinatesOverlap,
  claimIntentSchema,
  publishFindingSchema,
  publishFindingResultSchema,
  claimKindFor,
  claimResultSchema,
  claimsConflict,
  coordinationSnapshotSchema,
  fileClaimSchema,
  peerInboxSchema,
  peerMessageSchema,
  peerMessageSendSchema,
  type AgentRole,
  type ClaimConflict,
  type ClaimIntent,
  type PeerMessage,
} from "@muon/protocol";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  clampWaitTimeout,
  conditionSatisfied,
  peerWaitRequestSchema,
  type PeerWaitCondition,
} from "@muon/protocol";
import { refuseForbidden } from "../lib/refusal-http.js";
import {
  agentJobPrincipal,
  requireAgentJobCapability,
  requireOperator,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import {
  CLAIM_REFUSED_EVENT_KIND,
  recordClaimRefused,
} from "../lib/coordination-telemetry.js";
import { MEMORY_INJECTED_EVENT_KIND } from "../lib/injection-telemetry.js";
import { ingestMemoryNote } from "../lib/memory-ledger.js";
import { repoRootOf } from "../lib/workspace-identity.js";

// ── A2A: governed agent-to-agent coordination (packages/protocol/src/a2a.ts) ──
//
// The horizontal edge between the peers of one crew, under the same fail-closed
// contract as every other agent-facing surface:
//
//  • NO AMBIENT ADDRESSING. `chatId`, `missionId`, `fromJobId`, `fromRole` and
//    `fromVendor` are derived from the authenticated exact-job bearer. Nothing
//    an agent puts in a body or query can become identity or scope: a supplied
//    coordinate is only ever a CONSTRAINT to check, so naming another job's id
//    is a 403, never an impersonation.
//  • CHAT-BOUNDED. Every read and every comparison goes through ONE predicate,
//    the sender's own chat (`crewScope`), so there is no cross-chat edge to
//    find. Scoping on the ROOT TURN instead is what made this feature silently
//    undeliverable end to end; `crewScope` carries that story.
//  • DATA, NEVER INSTRUCTIONS. `subject`/`body` are UNTRUSTED agent text. They
//    are stored and returned verbatim and are never parsed for authority, never
//    written to memory, and never surfaced on the coordinate-only snapshot the
//    operator UI polls.
//  • PULL-BASED, PER JOB. Nobody is pushed a peer's text mid-turn: an agent
//    reads when it chooses, and each job walks the crew's traffic behind its
//    OWN (createdAt, id) cursor — so a crew broadcast reaches every peer exactly
//    once each, instead of being consumed by whoever polled first.
//  • BOUNDED. Every cap in a2a.ts is enforced HERE, not merely documented.
//
// Operator-tier reads (`GET /messages`, `GET /coordination`) are the human's
// window onto the same rows; agents can never reach them (requireOperator).

/** The sender/reader identity, derived entirely from the bearer. */
type PeerIdentity = {
  jobId: string;
  chatId: string;
  /**
   * PROVENANCE, not scope: which orchestrator ROOT TURN produced this job (a
   * root job is its own; a child inherits its root). Stamped on every row it
   * writes so the audit trail still says which turn said what — but never
   * compared, because a crew outlives a turn. See `crewScope`.
   */
  missionId: string;
  role: AgentRole;
  vendor: string;
  /**
   * THE CLAIM FENCE. Absent when the job runs without a workspace, which the
   * claim routes refuse rather than papering over: an unfenced claim is how
   * two repositories with matching relative paths report a false collision.
   */
  workspacePath?: string;
  name?: string;
};

type PeerMessageRow = {
  id: string;
  chatId: string;
  missionId: string;
  fromJobId: string;
  fromRole: string;
  fromVendor: string;
  fromName: string | null;
  toKind: string;
  toJobId: string | null;
  toRole: string | null;
  kind: string;
  subject: string;
  body: string;
  refs: Prisma.JsonValue;
  memoryNoteId: string | null;
  replyTo: string | null;
  createdAt: Date;
  readAt: Date | null;
};

type FileClaimRow = {
  id: string;
  workspacePath: string;
  chatId: string;
  missionId: string;
  jobId: string;
  coordinateKind: string;
  coordinate: string;
  intent: string;
  role: string;
  vendor: string;
  createdAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
};

/**
 * How many live claims the collision read will examine.
 *
 * Generous against the per-job cap (a job holds at most
 * `MAX_CLAIMED_PATHS_PER_JOB`), so this is reached only by a crew far larger
 * than MUON dispatches. It exists so the query is BOUNDED; hitting it is
 * treated as an inability to answer, never as "no conflict".
 */
const CLAIM_COLLISION_SCAN_LIMIT = MAX_CLAIMED_PATHS_PER_JOB * 8;

/** Reusable "this lease is live" filter: a released or expired claim is inert. */
function activeClaimFilter(now: Date) {
  return { releasedAt: null, expiresAt: { gt: now } } as const;
}

/**
 * WHERE A CREW CAN HEAR EACH OTHER: one CHAT. The single scope predicate every
 * peer read and every peer comparison in this file goes through, so no surface
 * can quietly partition the crew again.
 *
 * It used to be (chat, missionId) — and `missionId` is the ROOT JOB, while a
 * chat enqueues a NEW root every orchestrator turn. So two children of one crew
 * dispatched from two turns landed in two buckets and were structurally unable
 * to see each other's mail: every send returned 201, every inbox returned
 * empty, and nothing anywhere errored. MUON's own contract-retry path enqueues
 * exactly such a second root, so the correction mechanism silently cut the crew
 * it was correcting in half. The contract verifier already reasons ACROSS roots
 * ("Verified N governed child dispatch(es) … across roots"); this layer did not.
 *
 * Chat is the honest boundary: one workspace, one task ledger, one memory
 * partition, one crew working one objective. The root turn is an implementation
 * detail of dispatch, which is why it stays STORED as provenance and is never
 * compared.
 *
 * WHAT THIS DELIBERATELY DOES NOT WIDEN: the chat. Cross-chat is a security
 * boundary for untrusted agent text and stays fail-closed — the honest cost of
 * this change is that an exact-job capability now reaches its whole chat's crew
 * instead of its own turn's, which is the same blast radius the chat already
 * grants over the workspace, the ledger and memory.
 */
function crewScope(chatId: string) {
  return { chatId } as const;
}

/**
 * On the OPERATOR reads, `missionId` names a root job — the turn the human is
 * looking at. It anchors the answer rather than partitioning it (the crew is
 * the chat's, above), so it is a coordinate to VALIDATE, not a filter to apply:
 * an anchor belonging to another chat is refused, because answering with this
 * chat's crew under another chat's coordinate is precisely the coordinate
 * confusion that hid the delivery bug for as long as it hid.
 *
 * An anchor with no surviving job row is allowed through: the scope is the
 * chat the caller already named, so nothing can leak, and a pruned root must
 * not blank the human's crew view.
 */
async function assertMissionAnchor(
  app: FastifyInstance,
  chatId: string,
  missionId: string | undefined
): Promise<void> {
  if (!missionId) {
    return;
  }
  const anchor = await prisma.dispatchJob.findUnique({
    where: { id: missionId },
    select: { chatId: true },
  });
  if (anchor && anchor.chatId !== chatId) {
    throw app.httpErrors.badRequest(
      "That missionId belongs to another chat. A coordination view is anchored on a mission of the chat it reports."
    );
  }
}

/**
 * A finished job has no inbox. Its delivery cursor can never advance again, so
 * anything still addressed to it stays undelivered forever — counting it would
 * pin a permanent "N unread" on a peer nobody is waiting for. Mirrors the
 * terminal set dispatch already transitions jobs into.
 */
const TERMINAL_JOB_STATUSES = new Set(["done", "failed", "interrupted"]);

/** One reap page. Bounded so a claim call never turns into a table scan. */
const CLAIM_REAP_BATCH = 128;

/** The snapshot's own participant bound (`coordinationSnapshotSchema`). */
const MAX_CREW_PARTICIPANTS = 32;

/**
 * Drop this chat's INERT claim rows: released, or expired past their TTL.
 * Nothing reads them — `activeClaimFilter` excludes both — but `/coordination`
 * scans this table on every poll and the only standing cap counts ACTIVE rows,
 * so claim → release churn would grow it without bound.
 *
 * Deliberately on a path that already writes, one bounded page at a time: no
 * background timer, no unbounded delete, and nothing to schedule or supervise.
 */
async function reapDeadClaims(chatId: string, now: Date): Promise<void> {
  const dead = await prisma.fileClaim.findMany({
    where: {
      ...crewScope(chatId),
      OR: [{ releasedAt: { not: null } }, { expiresAt: { lte: now } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: CLAIM_REAP_BATCH,
    select: { id: true },
  });
  if (dead.length === 0) {
    return;
  }
  await prisma.fileClaim.deleteMany({
    where: { id: { in: dead.map((row) => row.id) } },
  });
}

/**
 * Crew codenames for the UI, resolved from the fleet seat a job holds so no
 * surface has to render a raw job id. Display-only; never an identity check.
 */
async function seatNames(
  agentIds: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const ids = [...new Set(agentIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) {
    return new Map();
  }
  const seats = await prisma.agent.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(seats.map((seat) => [seat.id, seat.name.slice(0, 64)]));
}

/**
 * A job's crew role. Fail-closed: an unrecognized or missing role is NOT
 * defaulted — a guessed role would silently widen peer addressing (every
 * `to: {kind:"role"}` fan-out is keyed on it). The one derivation allowed is the
 * root coordinator, whose seat is authenticated by its own capability mode.
 */
function jobRole(
  storedRole: string | null | undefined,
  capabilityMode: string | undefined
): AgentRole | undefined {
  const parsed = agentRoleSchema.safeParse(storedRole ?? undefined);
  if (parsed.success) {
    return parsed.data;
  }
  return capabilityMode === "orchestrator" ? "orchestrator" : undefined;
}

/** Resolve the caller's peer identity, or refuse. Never reads the body. */
async function peerIdentity(
  app: FastifyInstance,
  request: FastifyRequest
): Promise<PeerIdentity> {
  const capability = requireAgentJobCapability(app, request);
  if (!capability.chatId) {
    throw app.httpErrors.forbidden(
      "A2A coordination requires a chat-bound job capability."
    );
  }
  const job = await prisma.dispatchJob.findUnique({
    where: { id: capability.jobId },
    select: { role: true, agentId: true, workspacePath: true },
  });
  const role = jobRole(job?.role, capability.capabilityMode);
  if (!role) {
    throw app.httpErrors.forbidden(
      "This job runs without a crew role, so it has no peer identity. Bind the crew (POST /api/crew/roles) and dispatch under a role."
    );
  }
  const names = await seatNames([job?.agentId]);
  const name = job?.agentId ? names.get(job.agentId) : undefined;
  return {
    jobId: capability.jobId,
    chatId: capability.chatId,
    // A root job IS its own mission; every descendant carries the root id.
    missionId: capability.rootJobId ?? capability.jobId,
    role,
    vendor: capability.vendor,
    // May be absent — a job can run without one. The CLAIM path refuses in
    // that case rather than writing an unfenceable row; messaging does not
    // need it and is unaffected.
    ...(job?.workspacePath ? { workspacePath: job.workspacePath } : {}),
    ...(name ? { name } : {}),
  };
}

function toPeerMessage(row: PeerMessageRow): PeerMessage {
  return peerMessageSchema.parse({
    version: A2A_PROTOCOL_VERSION,
    id: row.id,
    chatId: row.chatId,
    missionId: row.missionId,
    fromJobId: row.fromJobId,
    fromRole: row.fromRole,
    fromVendor: row.fromVendor,
    ...(row.fromName ? { fromName: row.fromName } : {}),
    to:
      row.toKind === "job"
        ? { kind: "job", jobId: row.toJobId }
        : row.toKind === "role"
          ? { kind: "role", role: row.toRole }
          : { kind: "crew" },
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    refs: row.refs,
    // WITHOUT THIS THE LINK IS WRITE-ONLY. A recipient that cannot see the
    // note id cannot look the finding up, which is the entire point of
    // publishing it as one act.
    ...(row.memoryNoteId ? { memoryNoteId: row.memoryNoteId } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.readAt ? { readAt: row.readAt.toISOString() } : {}),
  });
}

function toFileClaim(row: FileClaimRow) {
  return fileClaimSchema.parse({
    version: A2A_PROTOCOL_VERSION,
    id: row.id,
    workspacePath: row.workspacePath,
    chatId: row.chatId,
    missionId: row.missionId,
    jobId: row.jobId,
    coordinateKind: row.coordinateKind,
    coordinate: row.coordinate,
    intent: row.intent,
    role: row.role,
    vendor: row.vendor,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.releasedAt ? { releasedAt: row.releasedAt.toISOString() } : {}),
  });
}

function toClaimConflict(
  row: FileClaimRow,
  name: string | undefined,
  requestedCoordinate?: string
): ClaimConflict {
  return {
    coordinateKind: claimCoordinateKindSchema.parse(row.coordinateKind),
    coordinate: row.coordinate,
    ...(requestedCoordinate && requestedCoordinate !== row.coordinate
      ? { requestedCoordinate }
      : {}),
    heldByJobId: row.jobId,
    heldByRole: agentRoleSchema.parse(row.role),
    heldByVendor: row.vendor,
    ...(name ? { heldByName: name } : {}),
    expiresAt: row.expiresAt.toISOString(),
  };
}

type InboxCursor = {
  lastReadAt: Date;
  lastReadMessageId: string | null;
};

/**
 * Is this envelope addressed to that job — directly, to the role it holds, or to
 * the whole crew? A job never receives its own sends. Kept as one predicate so
 * the inbox query and the operator snapshot's unread counter cannot drift apart.
 */
function addressesJob(
  message: {
    fromJobId: string;
    toKind: string;
    toJobId: string | null;
    toRole: string | null;
  },
  jobId: string,
  role: AgentRole
): boolean {
  if (message.fromJobId === jobId) {
    return false;
  }
  return (
    message.toJobId === jobId ||
    (message.toKind === "role" && message.toRole === role) ||
    message.toKind === "crew"
  );
}

/**
 * Everything addressed to this job by its crew, STRICTLY AFTER its delivery
 * cursor. The cursor is per job, so a `crew` broadcast is delivered to every
 * peer independently — a shared read flag on the message could only ever record
 * the first reader and would silently swallow the broadcast for everyone else.
 *
 * The cursor compares the TUPLE (createdAt, id): two messages can be written in
 * the same millisecond, and a timestamp-only cursor would skip one of them.
 *
 * `missionId` is deliberately ABSENT from the identity this takes: it is the
 * root turn, it is provenance, and comparing on it here is what made every read
 * on the founder's mission return empty. The scope is `crewScope`.
 */
/** Poll interval for a bounded peer wait — short enough to feel responsive,
 *  long enough that a 2-minute wait is not 120 database round trips. */
const PEER_WAIT_POLL_MS = 1_000;

/**
 * Observe the condition ONCE. Returns coordinates and counts only (ADR-0034
 * D3) — there is no code path here that reads `subject` or `body`, and that
 * absence is the contract.
 */
async function observePeerCondition(
  identity: PeerIdentity,
  condition: PeerWaitCondition
): Promise<{ state?: string; matchingUnread?: number }> {
  if (condition.kind === "peer_state") {
    const job = await prisma.dispatchJob.findUnique({
      where: { id: condition.jobId },
      select: { status: true, interruptRequested: true },
    });
    if (!job) return {};
    // `blocked` is the state worth waiting on — it is why a peer stopped —
    // and it is not a column: a job is blocked when a human gate is pending
    // against it. Queried rather than inferred from status, because `running`
    // covers both "working" and "parked at a gate".
    const pendingGate =
      job.status === "running"
        ? await prisma.approvalRequest.count({
            where: { jobId: condition.jobId, status: "pending" },
          })
        : 0;
    return { state: coarsePeerState(job.status, pendingGate > 0) };
  }

  const cursor = await prisma.peerInboxCursor.findUnique({
    where: { jobId: identity.jobId },
    select: { lastReadAt: true, lastReadMessageId: true },
  });
  const matchingUnread = await prisma.peerMessage.count({
    where: { ...inboxFilter(identity, cursor), kind: condition.messageKind },
  });
  return { matchingUnread };
}

/**
 * Job status (+ a pending gate) reduced to the five states an agent may wait on.
 *
 * Narrower than the operator's rail on purpose (ADR-0034 D4): a peer learns
 * THAT a sibling is working, not that it is 30 seconds from a budget wall. The
 * rail's amber early-warnings are the operator's business, not a peer's, so
 * they are not represented here at all rather than leaked through a synonym.
 */
function coarsePeerState(status: string, gatePending: boolean): string {
  if (gatePending) return "blocked";
  switch (status) {
    case "running":
      return "working";
    case "done":
      return "done";
    case "failed":
    case "interrupted":
      return "failed";
    case "queued":
      return "idle";
    default:
      return "idle";
  }
}

function inboxFilter(
  identity: {
    jobId: string;
    chatId: string;
    role: AgentRole;
  },
  cursor: InboxCursor | null
) {
  const addressed = {
    OR: [
      { toJobId: identity.jobId },
      { toKind: "role", toRole: identity.role },
      { toKind: "crew" },
    ],
  };
  const afterCursor = !cursor
    ? []
    : [
        {
          OR: [
            { createdAt: { gt: cursor.lastReadAt } },
            ...(cursor.lastReadMessageId
              ? [
                  {
                    createdAt: cursor.lastReadAt,
                    id: { gt: cursor.lastReadMessageId },
                  },
                ]
              : []),
          ],
        },
      ];
  return {
    ...crewScope(identity.chatId),
    fromJobId: { not: identity.jobId },
    AND: [addressed, ...afterCursor],
  };
}

/** Claim paths reuse the protocol's own canonical-relative-path rule. */
/**
 * ONE FIELD, NOT TWO. The agent writes a coordinate and MUON derives the kind
 * (`claimKindFor`) — a `kind` the caller sets is a field the caller can get
 * wrong, and `path#Symbol` is already unambiguous.
 */
const claimCoordinateField = fileClaimSchema.shape.coordinate;

const claimBodySchema = z
  .object({
    coordinates: z
      .array(claimCoordinateField)
      .min(1)
      .max(MAX_CLAIMED_PATHS_PER_JOB),
    intent: claimIntentSchema,
  })
  .strict();

const releaseBodySchema = z
  .object({
    coordinates: z
      .array(claimCoordinateField)
      .min(1)
      .max(MAX_CLAIMED_PATHS_PER_JOB),
  })
  .strict();

const recordIdSchema = z.string().trim().min(1).max(128);

export async function registerA2ARoutes(app: FastifyInstance) {
  // ── AGENT TIER ─────────────────────────────────────────────────────────────

  // Send one peer message. The body carries only WHAT to say and TO WHOM; who
  // is saying it, in which chat, on which mission is authenticated, not claimed.
  /**
   * The two durable send fences, in one place because TWO routes now write a
   * `PeerMessage`. A publish that skipped these would be a second, unbounded
   * way to say the same thing — the budget is per JOB, not per route.
   */
  async function assertPeerSendBudget(
    fastify: FastifyInstance,
    jobId: string
  ): Promise<void> {
    // Count cap first: it is the durable fence. A job that has spent its budget
    // gets the budget reason even when it is also sending too fast.
    const sent = await prisma.peerMessage.count({ where: { fromJobId: jobId } });
    if (sent >= MAX_PEER_MESSAGES_PER_JOB) {
      throw fastify.httpErrors.tooManyRequests(
        `This job has sent its ${MAX_PEER_MESSAGES_PER_JOB}-message A2A budget for the mission; summarize in a handoff packet instead of messaging again.`
      );
    }
    const last = await prisma.peerMessage.findFirst({
      where: { fromJobId: jobId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      last &&
      Date.now() - last.createdAt.getTime() < MIN_PEER_SEND_INTERVAL_MS
    ) {
      throw fastify.httpErrors.tooManyRequests(
        `Peer sends are spaced at least ${MIN_PEER_SEND_INTERVAL_MS}ms apart; retry shortly.`
      );
    }
  }

  app.post("/messages", async (request, reply) => {
    const identity = await peerIdentity(app, request);
    // Size caps (subject/body/refs) are the schema's, so an oversized envelope
    // is a 400 before any lookup or write happens.
    const payload = peerMessageSendSchema.parse(request.body);

    // A2A is the HORIZONTAL edge, so an envelope addressed at the sender is not
    // a coordination act: `addressesJob` excludes a job's own sends, so it would
    // be delivered to nobody, would never receive a `readAt`, and would inflate
    // the mission's `messageCount` permanently. The MCP handler refuses it too,
    // but the exact-job bearer lives in the agent's OWN process env — the route
    // is the boundary, not the tool layer.
    if (payload.to.kind === "job" && payload.to.jobId === identity.jobId) {
      throw app.httpErrors.badRequest(
        "A peer message addresses a PEER; a job cannot address itself. Use to.kind 'role' or 'crew' to reach the rest of the crew."
      );
    }

    await assertPeerSendBudget(app, identity.jobId);

    // Direct addressing is the only mode that names another job, so it is the
    // only one that can attempt a cross-chat edge. The CHAT is the check (the
    // root turn is not: a crew's members are routinely dispatched from
    // different turns of one chat — see `crewScope`).
    if (payload.to.kind === "job") {
      const target = await prisma.dispatchJob.findUnique({
        where: { id: payload.to.jobId },
        select: { chatId: true },
      });
      if (!target || target.chatId !== identity.chatId) {
        throw app.httpErrors.forbidden(
          "A peer message can only be addressed to a job on the same chat."
        );
      }
    }

    if (payload.replyTo) {
      const parent = await prisma.peerMessage.findUnique({
        where: { id: payload.replyTo },
        select: { chatId: true },
      });
      if (!parent || parent.chatId !== identity.chatId) {
        throw app.httpErrors.badRequest(
          "replyTo must reference a message on this chat."
        );
      }
    }

    const row = await prisma.peerMessage.create({
      data: {
        chatId: identity.chatId,
        missionId: identity.missionId,
        fromJobId: identity.jobId,
        fromRole: identity.role,
        fromVendor: identity.vendor,
        ...(identity.name ? { fromName: identity.name } : {}),
        toKind: payload.to.kind,
        ...(payload.to.kind === "job" ? { toJobId: payload.to.jobId } : {}),
        ...(payload.to.kind === "role" ? { toRole: payload.to.role } : {}),
        kind: payload.kind,
        subject: payload.subject,
        body: payload.body,
        refs: payload.refs as Prisma.InputJsonValue,
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      },
    });

    reply.code(201);
    return { message: toPeerMessage(row) };
  });

  // Pull-based delivery: nobody is pushed a peer's untrusted text mid-turn. The
  // oldest messages are delivered first, so truncation withholds the NEWEST and
  // a slow reader never loses the head of its queue.
  app.get("/inbox", async (request) => {
    const identity = await peerIdentity(app, request);
    const { limit } = z
      .object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(MAX_PEER_INBOX_PAGE)
          .default(MAX_PEER_INBOX_PAGE),
      })
      .parse(request.query ?? {});

    const cursor = await prisma.peerInboxCursor.findUnique({
      where: { jobId: identity.jobId },
      select: { lastReadAt: true, lastReadMessageId: true },
    });
    const where = inboxFilter(identity, cursor);
    const unread = await prisma.peerMessage.count({ where });
    const rows = await prisma.peerMessage.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });

    const readAt = new Date();
    const last = rows[rows.length - 1];
    if (last) {
      // Advance THIS job's cursor only. Nothing another peer does can move it,
      // and re-reading never re-delivers what this job already consumed.
      await prisma.peerInboxCursor.upsert({
        where: { jobId: identity.jobId },
        create: {
          jobId: identity.jobId,
          chatId: identity.chatId,
          missionId: identity.missionId,
          lastReadAt: last.createdAt,
          lastReadMessageId: last.id,
        },
        update: { lastReadAt: last.createdAt, lastReadMessageId: last.id },
      });
      // Display-only "delivered" stamp for DIRECTLY addressed mail, where there
      // is exactly one recipient. No delivery decision reads this column.
      const direct = rows
        .filter((row) => row.toKind === "job" && row.toJobId === identity.jobId)
        .map((row) => row.id);
      if (direct.length > 0) {
        await prisma.peerMessage.updateMany({
          where: { id: { in: direct }, readAt: null },
          data: { readAt },
        });
      }
    }

    return peerInboxSchema.parse({
      messages: rows.map((row) =>
        toPeerMessage(
          row.toKind === "job" && row.toJobId === identity.jobId
            ? { ...row, readAt: row.readAt ?? readAt }
            : row
        )
      ),
      unread,
      truncated: unread > rows.length,
    });
  });

  // Advisory file leases. First-writer-wins, expiring, and reported rather than
  // enforced: a conflict is surfaced to the caller (and to the human) instead of
  // blocking, so a worker that dies holding a claim cannot freeze the crew.
  app.post("/claims", async (request) => {
    const identity = await peerIdentity(app, request);
    const payload = claimBodySchema.parse(request.body);
    // A CLAIM'S WORKSPACE IS THE RAW ONE, deliberately — see the finding
    // route, which resolves to the repo root instead. Two agents editing one
    // relative path in two WORKTREES are not standing on the same ground, so a
    // claim must distinguish them; a memory note about that path is about the
    // repository, so a finding must not.
    const workspacePath = identity.workspacePath;
    if (!workspacePath) {
      throw app.httpErrors.badRequest(
        "This job has no workspace, so a claim could not be fenced to one. An unfenced claim collides with unrelated repositories that happen to share a relative path, so it is refused rather than recorded."
      );
    }
    const requested = [...new Set(payload.coordinates)].map((coordinate) => ({
      coordinate,
      kind: claimKindFor(coordinate),
    }));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);

    // The same anti-flood fence `/messages` carries. Measured BEFORE the reap
    // below, so releasing a batch cannot erase the evidence that this job just
    // wrote one — the fence and the reaper must not cancel each other out.
    const lastClaim = await prisma.fileClaim.findFirst({
      where: { jobId: identity.jobId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      lastClaim &&
      now.getTime() - lastClaim.createdAt.getTime() < MIN_PEER_SEND_INTERVAL_MS
    ) {
      throw app.httpErrors.tooManyRequests(
        `Claims from one job are spaced at least ${MIN_PEER_SEND_INTERVAL_MS}ms apart; claim the batch in ONE call (up to ${MAX_CLAIMED_PATHS_PER_JOB} paths) instead of a call per path.`
      );
    }
    await reapDeadClaims(identity.chatId, now);

    // Same scope as the inbox, for the same reason: two workers dispatched from
    // different orchestrator turns of one chat share ONE workspace, so a claim
    // partitioned by turn announces a file collision to nobody who can collide.
    //
    // THE CANDIDATE SET IS NARROWED IN SQL, not scanned in JS. Overlap is a
    // rule about coordinates (`claimCoordinatesOverlap`) that SQL cannot state,
    // but everything it can possibly match is reachable from three indexed
    // predicates: the exact coordinates asked for, the FILES those coordinates
    // live in (a symbol contends with someone editing its whole file), and any
    // symbol inside those files (`file#…`). A chat-wide scan would work and
    // would grow with the crew; this stays proportional to the request.
    const files = [
      ...new Set(
        requested
          .map((entry) => claimCoordinateFile(entry.kind, entry.coordinate))
          .filter((file): file is string => file !== null)
      ),
    ];
    const live = (await prisma.fileClaim.findMany({
      where: {
        workspacePath,
        ...crewScope(identity.chatId),
        ...activeClaimFilter(now),
        OR: [
          {
            coordinate: {
              in: [...new Set([...requested.map((e) => e.coordinate), ...files])],
            },
          },
          ...files.map((file) => ({ coordinate: { startsWith: `${file}#` } })),
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      // +1 so a full page is DETECTABLE rather than silently complete.
      take: CLAIM_COLLISION_SCAN_LIMIT + 1,
    })) as FileClaimRow[];

    // A TRUNCATED COLLISION READ CANNOT GRANT. If the candidate set filled the
    // page, some live claim on this ground was not examined — and granting on
    // evidence known to be incomplete is the one outcome a collision detector
    // must never produce. It refuses and says why, rather than reporting "no
    // conflict" it cannot support.
    if (live.length > CLAIM_COLLISION_SCAN_LIMIT) {
      throw app.httpErrors.conflict(
        `Too many live claims on this ground to check collisions completely (over ${CLAIM_COLLISION_SCAN_LIMIT}). Nothing was claimed. Release finished claims, or claim fewer coordinates at once.`
      );
    }

    // A refresh is matched EXACTLY — re-announcing `a.ts#one` refreshes that
    // row, and never the row for `a.ts`, which belongs to a different claim.
    const mine = new Map<string, FileClaimRow>();
    for (const claim of live) {
      if (claim.jobId === identity.jobId && !mine.has(claim.coordinate)) {
        mine.set(claim.coordinate, claim);
      }
    }

    const grantable: string[] = [];
    const blockers: { row: FileClaimRow; requested: string }[] = [];
    for (const entry of requested) {
      // Conflict is exactly `claimsConflict` (two `edit`s) on OVERLAPPING
      // ground, and only ever against ANOTHER job: re-claiming what you already
      // hold is a refresh. `live` is ordered (createdAt, id) asc, so this is
      // the OLDEST holder — the one the crew must yield to.
      const blocker = live.find(
        (claim) =>
          claim.jobId !== identity.jobId &&
          claimsConflict(claim.intent as ClaimIntent, payload.intent) &&
          claimCoordinatesOverlap(entry, {
            kind: claimCoordinateKindSchema.parse(claim.coordinateKind),
            coordinate: claim.coordinate,
          })
      );
      if (blocker) {
        blockers.push({ row: blocker, requested: entry.coordinate });
        continue;
      }
      grantable.push(entry.coordinate);
    }

    // EVERY requested path is recorded, contended ones included. A claim is an
    // advisory ANNOUNCEMENT of intent, not a lease, so a second agent declaring
    // the same path is a fact the human and `/coordination` have to be able to
    // see — dropping the row left exactly ONE live claim on a governed
    // collision, which is why a conflict was unreachable end to end and could
    // only ever appear through a TOCTOU race between two concurrent posts.
    //
    // The CALLER'S answer is unchanged: a contended path comes back under
    // `conflicts` and never under `granted`, so the contender still learns it
    // lost. An announcement costs the same budget a grant does (it is a live
    // row), and re-announcing refreshes this job's own row rather than
    // duplicating it.
    const fresh = requested.filter((entry) => !mine.has(entry.coordinate));
    const held = await prisma.fileClaim.count({
      where: { jobId: identity.jobId, ...activeClaimFilter(now) },
    });
    if (held + fresh.length > MAX_CLAIMED_PATHS_PER_JOB) {
      throw app.httpErrors.badRequest(
        `A job may hold at most ${MAX_CLAIMED_PATHS_PER_JOB} active file claims (holding ${held}, requested ${fresh.length} new). Release what you have finished.`
      );
    }

    await prisma.$transaction([
      ...requested
        .filter((entry) => mine.has(entry.coordinate))
        .map((entry) =>
          prisma.fileClaim.update({
            where: { id: mine.get(entry.coordinate)!.id },
            data: { intent: payload.intent, expiresAt },
          })
        ),
      ...fresh.map((entry) =>
        prisma.fileClaim.create({
          data: {
            workspacePath,
            chatId: identity.chatId,
            missionId: identity.missionId,
            jobId: identity.jobId,
            coordinateKind: entry.kind,
            coordinate: entry.coordinate,
            intent: payload.intent,
            role: identity.role,
            vendor: identity.vendor,
            expiresAt,
          },
        })
      ),
    ]);

    // Scoped to `grantable`, never to `paths`: the announcement row written for
    // a contended path is deliberately NOT reported as granted.
    const granted =
      grantable.length === 0
        ? []
        : ((await prisma.fileClaim.findMany({
            where: {
              jobId: identity.jobId,
              workspacePath,
              ...crewScope(identity.chatId),
              coordinate: { in: grantable },
              ...activeClaimFilter(now),
            },
            orderBy: [{ coordinate: "asc" }],
          })) as FileClaimRow[]);

    const holderJobs = await prisma.dispatchJob.findMany({
      where: { id: { in: [...new Set(blockers.map((b) => b.row.jobId))] } },
      select: { id: true, agentId: true },
    });
    const names = await seatNames(holderJobs.map((job) => job.agentId));
    const holderName = new Map(
      holderJobs.map((job) => [
        job.id,
        job.agentId ? names.get(job.agentId) : undefined,
      ])
    );

    // One entry per contended PATH — the oldest holder, the one to yield to —
    // so the array stays inside `claimResultSchema`'s per-path bound even when
    // several jobs have announced on the same file. The human's view of ALL the
    // parties to a collision is `/coordination`, which is unbounded by a single
    // caller's request.
    // A REFUSAL IS AN EVENT (#92). The response tells the caller; nothing told
    // the record, so "coordination changed someone's plan" — the whole point —
    // could not be counted afterwards. Fire-and-forget: this can never fail a
    // claim, and the answer below is already decided.
    for (const blocker of blockers) {
      recordClaimRefused({
        jobId: identity.jobId,
        chatId: identity.chatId,
        coordinate: blocker.requested,
        heldByJobId: blocker.row.jobId,
        // The CLAIM, not just its holder: a released-and-reacquired coordinate
        // is a new collision and must record a new yield.
        heldClaimId: blocker.row.id,
        requestedIntent: payload.intent,
        heldIntent: blocker.row.intent,
      });
    }

    return claimResultSchema.parse({
      granted: granted.map(toFileClaim),
      conflicts: blockers.map((blocker) =>
        toClaimConflict(
          blocker.row,
          holderName.get(blocker.row.jobId),
          blocker.requested
        )
      ),
    });
  });


  /**
   * PUBLISH A FINDING — the one call that makes a finding addressable.
   *
   * Today a reviewer records a defect with `memory_add` and, separately and
   * only if it thinks to, tells the implementer with `peer_message`. Nothing
   * links them, so the finding can exist in memory while the implementer edits
   * the same symbol having never seen it, and the human becomes the transport
   * layer. Here the note and the announcement are made together, and the
   * message carries the note's id.
   *
   * WHAT IS AND IS NOT ATOMIC, stated because overclaiming this would be worse
   * than the gap it closes. The note is written first, through the SAME
   * `ingestMemoryNote` every other path uses — so the ingest policy, dedup, TTL
   * and the write-actor mutex all still apply, rather than a second memory
   * write path that skips a governance gate. If the message write then fails,
   * the response is an error that NAMES the noteId: the note exists, exactly
   * as `memory_add` would have left it, and nothing is orphaned silently.
   */
  app.post("/findings", async (request, reply) => {
    const identity = await peerIdentity(app, request);
    const payload = publishFindingSchema.parse(request.body);

    if (payload.to.kind === "job" && payload.to.jobId === identity.jobId) {
      throw app.httpErrors.badRequest(
        "A finding is published to a PEER; a job cannot address itself. Use to.kind 'role' or 'crew'."
      );
    }
    if (payload.to.kind === "job") {
      const target = await prisma.dispatchJob.findUnique({
        where: { id: payload.to.jobId },
        select: { chatId: true },
      });
      if (!target || target.chatId !== identity.chatId) {
        throw app.httpErrors.forbidden(
          "A finding can only be addressed to a job on the same chat."
        );
      }
    }
    // The SAME budget a plain message spends. A publish that skipped it would
    // be an unbounded second way to say the same thing.
    await assertPeerSendBudget(app, identity.jobId);

    // THROUGH `repoRootOf`, exactly as `POST /api/memory` and the runner's
    // capture do. Memory is partitioned by REPO ROOT, and a job dispatched
    // into `.muon/worktrees/<x>` carries that path — taking the raw column
    // wrote every finding from a worktree into a partition its own
    // `memory_recall` never reads, so the peer it was published to could not
    // look it up. The whole feature, defeated by one missing call.
    const workspacePath = identity.workspacePath
      ? await repoRootOf(identity.workspacePath)
      : undefined;
    if (!workspacePath) {
      throw app.httpErrors.badRequest(
        "This job has no workspace, so a finding could not be scoped to one. Memory is workspace-scoped (ADR-0026); an unscoped finding would be visible to work it has nothing to do with."
      );
    }

    // The coordinate vocabulary the ledger already has: a `#` makes it a
    // SYMBOL anchor, anything else a MODULE. Same split `claimKindFor` makes
    // for claims, so a finding and a claim can name the same ground.
    const symbols = payload.coordinates.filter((c) => c.includes("#"));
    const modules = payload.coordinates.filter((c) => !c.includes("#"));

    const ingested = await ingestMemoryNote({
      text: payload.text,
      kind: payload.kind,
      // THE JOB, not the vendor. Every other agent write uses
      // `agentJobPrincipal()` → `agent:job:<jobId>`, and crew corroboration
      // promotes a note once TWO DISTINCT principal strings support the same
      // text. `agent:<vendor>` is a third spelling, so one job that published a
      // finding and then `memory_add`ed the same text would have contributed
      // two principals and auto-vouched a claim only it ever made.
      createdBy: agentJobPrincipal(requireAgentJobCapability(app, request)),
      // Agent-authored memory is ALWAYS a proposal. Without this an agent's
      // publish could take the ordinary supersede path and destructively
      // retire a peer's unconfirmed note of equal-or-lower trust before any
      // human saw either — the exact class the route allowlist comment claims
      // this path cannot reach.
      proposalOnly: true,
      workspacePath,
      chatId: identity.chatId,
      taskId: identity.missionId,
      ...(symbols.length > 0 ? { symbols } : {}),
      ...(modules.length > 0 ? { modules } : {}),
      ...(payload.outcome ? { outcome: payload.outcome } : {}),
    });

    const noteId = ingested.note.id;

    let row;
    try {
      row = await prisma.peerMessage.create({
        data: {
          chatId: identity.chatId,
          missionId: identity.missionId,
          fromJobId: identity.jobId,
          fromRole: identity.role,
          fromVendor: identity.vendor,
          ...(identity.name ? { fromName: identity.name } : {}),
          toKind: payload.to.kind,
          ...(payload.to.kind === "job" ? { toJobId: payload.to.jobId } : {}),
          ...(payload.to.kind === "role" ? { toRole: payload.to.role } : {}),
          kind: "finding",
          subject: payload.subject,
          // One thing said once: the announcement defaults to the finding.
          body: payload.body ?? payload.text,
          refs: { files: [], symbols: [], noteIds: [noteId] } as Prisma.InputJsonValue,
          memoryNoteId: noteId,
        },
      });
    } catch (error) {
      throw app.httpErrors.conflict(
        `The finding was recorded as note ${noteId}, but announcing it to the crew failed (${
          error instanceof Error ? error.message : "unknown error"
        }). The note exists — send a peer message referencing it rather than publishing again, which would duplicate it.`
      );
    }

    reply.code(201);
    return publishFindingResultSchema.parse({ noteId, messageId: row.id });
  });

  // Release is self-only: the `jobId` filter is the bearer's, so one agent can
  // never drop another's lease (which would be a way to steal a contested file).
  app.post("/claims/release", async (request) => {
    const identity = await peerIdentity(app, request);
    const payload = releaseBodySchema.parse(request.body);
    const released = await prisma.fileClaim.updateMany({
      where: {
        jobId: identity.jobId,
        ...crewScope(identity.chatId),
        // EXACT, never overlapping: releasing `a.ts` must not drop your claim
        // on `a.ts#one`, which is a different piece of work you may still hold.
        coordinate: { in: [...new Set(payload.coordinates)] },
        releasedAt: null,
      },
      data: { releasedAt: new Date() },
    });
    return { released: released.count };
  });

  // ── OPERATOR TIER ──────────────────────────────────────────────────────────

  // The human's transcript of the crew's peer traffic. Bodies ARE returned here
  // (the human is the one surface allowed to read untrusted agent text in
  // full), newest first. `missionId` ANCHORS the view on a root turn; it does
  // not partition it, or the operator's transcript would under-report by
  // exactly as much as the agents' inboxes did.
  app.get("/messages", async (request) => {
    requireOperator(app, request);
    const query = z
      .object({
        chatId: recordIdSchema,
        missionId: recordIdSchema.optional(),
        // ONE page bound across the stack: the protocol's per-job cap, which
        // `@muon/client` already narrows to and `muon crew coord` validates
        // against. A route maximum of its own drifted from both, so an operator
        // asking for a page the CLI allowed died on a raw zod message.
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(MAX_PEER_MESSAGES_PER_JOB)
          .default(50),
      })
      .parse(request.query ?? {});

    await assertMissionAnchor(app, query.chatId, query.missionId);
    const rows = await prisma.peerMessage.findMany({
      where: crewScope(query.chatId),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit,
    });
    return { messages: rows.map(toPeerMessage) };
  });

  // COORDINATES ONLY. Deliberately no message text: this is the snapshot the
  // crew UI polls, and it must stay safe on a surface that has not passed the
  // memory text gate. The selects below never read `subject`/`body`.
  /**
   * ADR-0034 — block on a peer FACT, bounded by the caller's own budget.
   *
   * Coordinates and counts only: this returns the peer's lifecycle state or an
   * arrival count, never a message body. Reading untrusted peer prose stays the
   * separate, deliberate `GET /inbox` act, so the A2A contract's pull-based
   * rule (§4) survives — the text still arrives only at a boundary the agent
   * chose to open.
   *
   * The wait is a bounded server-side poll, never a held-open request past the
   * clamp: a socket parked for longer than the waiter's budget is the deadlock
   * this design exists to refuse.
   */
  app.post("/wait", async (request) => {
    const identity = await peerIdentity(app, request);
    const body = peerWaitRequestSchema.parse(request.body ?? {});

    // The waiter's own remaining budget bounds the wait (D2). Read from the
    // job row rather than trusted from the caller: a self-declared budget
    // would let an agent buy itself an unbounded wait.
    const self = await prisma.dispatchJob.findUnique({
      where: { id: identity.jobId },
      select: { maxWallMs: true, startedAt: true },
    });
    const remainingBudgetMs =
      self?.maxWallMs != null && self.startedAt
        ? Math.max(0, self.maxWallMs - (Date.now() - self.startedAt.getTime()))
        : null;
    const clamp = clampWaitTimeout(body.timeoutMs, remainingBudgetMs);

    // A peer_state wait names a sibling; it must be in THIS chat. The refusal
    // discloses nothing about the other side (ADR-0033 partition.mismatch is
    // forced `withheld`), so an out-of-chat job id cannot be used to probe for
    // the existence of work elsewhere.
    if (body.condition.kind === "peer_state") {
      const peer = await prisma.dispatchJob.findUnique({
        where: { id: body.condition.jobId },
        select: { chatId: true },
      });
      if (!peer || peer.chatId !== identity.chatId) {
        refuseForbidden(app, "agent", {
          rule: "partition.mismatch",
          summary:
            "That job is not part of this chat's crew, so it cannot be waited on.",
          surface: "a2a wait",
          nextAction: {
            kind: "none",
            because: "a wait is confined to the crew of one chat",
          },
        });
      }
    }

    const startedAt = Date.now();
    const deadline = startedAt + clamp.timeoutMs;
    let observed: { state?: string; matchingUnread?: number } = {};

    // Poll until satisfied or out of time. `clamp.timeoutMs === 0` still runs
    // the body once: an immediate honest "no" beats the same "no" a second
    // later.
    for (;;) {
      observed = await observePeerCondition(identity, body.condition);
      if (conditionSatisfied(body.condition, observed)) {
        return {
          result: {
            outcome: "satisfied",
            waitedMs: Date.now() - startedAt,
            ...(observed.state ? { observedState: observed.state } : {}),
            ...(observed.matchingUnread !== undefined
              ? { matchingUnread: observed.matchingUnread }
              : {}),
            ...(clamp.clamped ? { clampedFrom: body.timeoutMs } : {}),
          },
        };
      }
      if (Date.now() + PEER_WAIT_POLL_MS >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, PEER_WAIT_POLL_MS));
    }

    return {
      result: {
        // `budget` and `timeout` are different facts: one says the mission is
        // running out, the other that nobody answered in time.
        outcome: clamp.reason === "budget" ? "budget" : "timeout",
        waitedMs: Date.now() - startedAt,
        ...(observed.state ? { observedState: observed.state } : {}),
        ...(observed.matchingUnread !== undefined
          ? { matchingUnread: observed.matchingUnread }
          : {}),
        ...(clamp.clamped ? { clampedFrom: body.timeoutMs } : {}),
      },
    };
  });

  app.get("/coordination", async (request) => {
    requireOperator(app, request);
    const query = z
      .object({ chatId: recordIdSchema, missionId: recordIdSchema })
      .parse(request.query ?? {});
    const now = new Date();
    await assertMissionAnchor(app, query.chatId, query.missionId);

    // THE JOIN HAZARD, HANDLED EXPLICITLY. This used to read
    // `OR: [{id: missionId}, {rootJobId: missionId}]` — the one site that used
    // `missionId` as a JOB ID rather than as a string to compare, and so the
    // one site a plain widening of the comparison would have left silently
    // narrow. The crew is every job of the chat; the anchor is validated
    // against that chat above (`assertMissionAnchor`) instead of joined on.
    const jobs = await prisma.dispatchJob.findMany({
      where: crewScope(query.chatId),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        vendor: true,
        role: true,
        status: true,
        agentId: true,
        capabilityMode: true,
      },
    });

    const claims = (await prisma.fileClaim.findMany({
      where: { ...crewScope(query.chatId), ...activeClaimFilter(now) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })) as FileClaimRow[];

    // COORDINATES ONLY: `subject`/`body` are deliberately not selected, so an
    // untrusted body cannot reach this surface even by accident. The set is
    // bounded by the per-job send budget times the participant cap.
    const envelopes = await prisma.peerMessage.findMany({
      where: crewScope(query.chatId),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        createdAt: true,
        fromJobId: true,
        toKind: true,
        toJobId: true,
        toRole: true,
      },
    });
    // The cap is applied BEFORE the per-participant unread scan (and before the
    // cursor read below), and it keeps the MOST RECENT crew members. The scope
    // is now the whole chat, which spans every turn it has ever run, so slicing
    // the head would have pinned the crew view to the oldest jobs the chat ever
    // had and hidden the live one.
    const crew = jobs
      .flatMap((job) => {
        const role = jobRole(job.role, job.capabilityMode ?? undefined);
        // A job with no crew role is not a peer: it cannot send, cannot be
        // addressed, and is not rendered as a crew member.
        return role ? [{ job, role }] : [];
      })
      .slice(-MAX_CREW_PARTICIPANTS);

    const cursors = await prisma.peerInboxCursor.findMany({
      where: { jobId: { in: crew.map(({ job }) => job.id) } },
      select: { jobId: true, lastReadAt: true, lastReadMessageId: true },
    });
    const cursorByJob = new Map(cursors.map((row) => [row.jobId, row]));

    const names = await seatNames(jobs.map((job) => job.agentId));
    const claimCount = new Map<string, number>();
    for (const claim of claims) {
      claimCount.set(claim.jobId, (claimCount.get(claim.jobId) ?? 0) + 1);
    }

    const participants = crew.map(({ job, role }) => {
      const name = job.agentId ? names.get(job.agentId) : undefined;
      const cursor = cursorByJob.get(job.id);
      // Same predicate + same tuple cursor the job's own inbox uses, so the
      // human's view of "outstanding" cannot drift from what the agent sees —
      // except for a job that has FINISHED, which is reported as zero. A
      // terminal job never polls its inbox again, so its cursor is frozen and
      // its backlog would otherwise read as a standing "N unread" against a
      // peer that has no inbox left to drain.
      const unreadMessages = TERMINAL_JOB_STATUSES.has(job.status)
        ? 0
        : envelopes.filter((message) => {
            if (!addressesJob(message, job.id, role)) {
              return false;
            }
            if (!cursor) {
              return true;
            }
            const at = message.createdAt.getTime();
            const readAt = cursor.lastReadAt.getTime();
            return (
              at > readAt ||
              (at === readAt &&
                !!cursor.lastReadMessageId &&
                message.id > cursor.lastReadMessageId)
            );
          }).length;
      return {
        jobId: job.id,
        vendor: job.vendor,
        role,
        ...(name ? { name } : {}),
        status: job.status,
        claimedPaths: claimCount.get(job.id) ?? 0,
        unreadMessages,
      };
    });

    // A contested path is one whose live claims contain a conflicting PAIR from
    // two different jobs, compared PAIRWISE. Comparing every claim against the
    // oldest one hid the normal draft → critique → patch order completely: if a
    // reviewer claimed the file first, `claimsConflict("review", "edit")` is
    // false for every later claim, so two genuine `edit` holders were never
    // reported.
    //
    // EVERY contending holder is emitted, one entry each, because the crew view
    // keys its conflict badges on `heldByJobId` — naming only the first party
    // leaves the agent that is actually blocked unmarked. Each emitted row
    // therefore says exactly what `claimConflictSchema.heldByJobId` documents:
    // a job that holds a conflicting (`edit`) claim on that path.
    // BUCKETED BY FILE, not by exact coordinate. Overlap is a rule about
    // coordinates, and two claims that contend may not be spelled the same —
    // `a.ts` and `a.ts#one` collide. The file is the coarsest thing they can
    // share, so it is the bucket; the pairwise test inside still applies the
    // real rule, which is why two DIFFERENT symbols in one file share a bucket
    // and are correctly not a conflict.
    const byPath = new Map<string, FileClaimRow[]>();
    for (const claim of claims) {
      const kind = claimCoordinateKindSchema.parse(claim.coordinateKind);
      // KEYED BY WORKSPACE TOO. `/claims` fences collisions by workspace, and
      // this view must agree with it or the human reads a conflict the
      // contender was never told about — a crew whose child runs in a worktree
      // shares a chat but not a workspace, and the same relative path in both
      // is not one collision.
      const file = claimCoordinateFile(kind, claim.coordinate) ?? claim.coordinate;
      const bucket = `${claim.workspacePath}\u0000${file}`;
      byPath.set(bucket, [...(byPath.get(bucket) ?? []), claim]);
    }
    const holderName = (jobId: string): string | undefined => {
      const agentId = jobs.find((job) => job.id === jobId)?.agentId;
      return agentId ? names.get(agentId) : undefined;
    };
    const openConflicts: ClaimConflict[] = [];
    for (const [, held] of byPath) {
      // `claims` is ordered (createdAt, id) asc, so the first row a job has on
      // the path represents it, and the holder the crew must yield to sorts
      // first — the same precedence `/claims` reports to the contender.
      const contending = new Map<string, FileClaimRow>();
      held.forEach((claim, index) => {
        const at = (row: FileClaimRow) => ({
          kind: claimCoordinateKindSchema.parse(row.coordinateKind),
          coordinate: row.coordinate,
        });
        const collides = held.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.jobId !== claim.jobId &&
            claimsConflict(
              claim.intent as ClaimIntent,
              other.intent as ClaimIntent
            ) &&
            // Sharing a FILE is not sharing the ground: two agents on two
            // different symbols of one file are working in parallel, which is
            // the precision this slice exists to give them.
            claimCoordinatesOverlap(at(claim), at(other))
        );
        if (collides && !contending.has(claim.jobId)) {
          contending.set(claim.jobId, claim);
        }
      });
      for (const claim of contending.values()) {
        openConflicts.push(toClaimConflict(claim, holderName(claim.jobId)));
      }
    }

    const messageCount = await prisma.peerMessage.count({
      where: crewScope(query.chatId),
    });

    // THE SCORE (#92). Counted from the record, so a dogfood run is graded on
    // what happened rather than on what the transcripts claim happened.
    //
    // The first four are exact SQL counts. The last two read Event rows and
    // filter in JS — SQLite has no reliable JSON-path filter through Prisma —
    // so they are BOUNDED, and hitting the bound is reported rather than
    // rounded off into a confident number.
    const EVENT_SCAN_BOUND = 4_096;
    // BOUNDED ID LIST. `jobs` is every job the CHAT has ever had, which grows
    // without limit across turns, and SQLite caps the parameters one statement
    // may bind — a long-lived chat would have turned this read into a hard
    // error rather than a slow one. The NEWEST jobs are kept, because a score
    // is about the mission being watched, and dropping any of them makes the
    // event-derived counts a floor (reported, never rounded off).
    const JOB_SCAN_BOUND = 400;
    const scannedJobs = jobs.slice(-JOB_SCAN_BOUND);
    const crewJobIds = scannedJobs.map((job) => job.id);
    const [claimsTaken, claimsActive, findingsPublished, findingsWithNoteLink] =
      await Promise.all([
        prisma.fileClaim.count({ where: crewScope(query.chatId) }),
        prisma.fileClaim.count({
          where: { ...crewScope(query.chatId), ...activeClaimFilter(now) },
        }),
        prisma.peerMessage.count({
          where: { ...crewScope(query.chatId), kind: "finding" },
        }),
        prisma.peerMessage.count({
          where: {
            ...crewScope(query.chatId),
            kind: "finding",
            memoryNoteId: { not: null },
          },
        }),
      ]);
    const eventRows = crewJobIds.length
      ? await prisma.event.findMany({
          where: {
            taskId: { in: crewJobIds },
            kind: { in: [CLAIM_REFUSED_EVENT_KIND, MEMORY_INJECTED_EVENT_KIND] },
          },
          select: { kind: true, metadata: true },
          // ORDERED, so a truncated scan is a floor over the NEWEST events
          // rather than over whatever the database happened to return. Without
          // this, `truncated` said a bound was hit but not that the sample was
          // arbitrary — two different admissions.
          orderBy: [{ timestamp: "desc" }, { id: "desc" }],
          take: EVENT_SCAN_BOUND,
        })
      : [];
    let claimsRefused = 0;
    let findingDeliveries = 0;
    for (const row of eventRows) {
      if (row.kind === CLAIM_REFUSED_EVENT_KIND) {
        claimsRefused += 1;
        continue;
      }
      // Only the CREW-FINDING deliveries: the same Event kind also carries the
      // pre-edit gate's path-triggered standing injections, and counting those
      // as findings reaching a peer would inflate exactly the number this
      // exists to make honest (the #99 lesson — the reason is load-bearing).
      const meta = row.metadata as { reason?: unknown } | null;
      if (meta?.reason === "crew-finding-at-preedit") {
        findingDeliveries += 1;
      }
    }

    return {
      snapshot: coordinationSnapshotSchema.parse({
        version: A2A_PROTOCOL_VERSION,
        chatId: query.chatId,
        missionId: query.missionId,
        participants,
        openConflicts: openConflicts.slice(0, 64),
        messageCount,
        score: {
          claimsTaken,
          claimsActive,
          claimsRefused,
          findingsPublished,
          findingsWithNoteLink,
          findingDeliveries,
          truncated:
            eventRows.length >= EVENT_SCAN_BOUND ||
            jobs.length > JOB_SCAN_BOUND,
        },
      }),
    };
  });
}
