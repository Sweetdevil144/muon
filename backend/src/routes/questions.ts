import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  blockingQuestionAnswerSchema,
  blockingQuestionAskSchema,
  canOverrideMemoryAnswer,
  deriveBlockingQuestions,
  openBlockingQuestions,
  MAX_OPEN_QUESTIONS_PER_JOB,
  MAX_PREANSWER_EXCERPT_CHARS,
  MAX_PREANSWER_NOTES,
  MIN_QUESTION_ASK_INTERVAL_MS,
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_CREW_CONTEXT_EVENT_KIND,
  QUESTION_PREANSWER_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
  parseBlockingQuestionWithdraw,
  type QuestionCrewContextItem,
  type QuestionPreAnswerNote,
  type QuestionSpineEvent,
} from "@muon/protocol";
// The ranking module's OWN tokenizer (subpath export — the barrel does not
// re-export it): one spelling of "substantive term" across ranking and floor.
import { tokenize } from "@muon/graph/memory-ranking";
import {
  classifyHandoffPacket,
  handoffContractIsDegraded,
} from "@muon/client";
import { getGraph } from "../lib/graph.js";
import {
  mintContradictionEdge, ingestMemoryNote, isConfirmed } from "../lib/memory-ledger.js";
import {
  memoryCallerScope,
  serveNoteContent,
  servePacketContent,
} from "../lib/memory-offers.js";
import { repoRootOf } from "../lib/workspace-identity.js";
import {
  AGENT_PRINCIPAL,
  agentMemoryPartition,
  OPERATOR_PRINCIPAL,
  requireAgentJobCapability,
  requireAgentOrchestratorCapability,
  requireOperator,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { buildEventAuditStamp, eventAuditData } from "../lib/event-audit.js";

/**
 * ADR-0043 — blocking questions on the event spine.
 *
 * The route is thin on purpose: every state rule lives in the protocol's
 * `deriveBlockingQuestions` fold (both sides fold the same way), and every
 * write here is one event row. No table, no migration (D1).
 *
 * Authority split (D3/D4), enforced per handler:
 *  - ASK / WITHDRAW: agent tier, exact-job bearer. Identity (job, task,
 *    role, vendor) is DERIVED from the capability, never read from the body
 *    — the ask schema is strict and identity-free.
 *  - ANSWER: operator tier only. Answering confers no authority: nothing
 *    here mints a receipt, resolves an approval, or touches a grant.
 *  - Filing a question stops no clock (D5): no job/budget/session state is
 *    touched anywhere in this file.
 */

const QUESTION_EVENT_KINDS = [
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
  // ADR-0069: the brain's pre-answer rides the same spine the fold reads.
  QUESTION_PREANSWER_EVENT_KIND,
  // ADR-0082: the crew's context block rides it too.
  QUESTION_CREW_CONTEXT_EVENT_KIND,
];

// Structural, because the $extends'd client and its TransactionClient do not
// share a nominal type: this names exactly the query the spine needs, and
// both satisfy it.
type SpineEventRow = {
  id: string;
  kind: string;
  taskId: string | null;
  timestamp: Date;
  metadata: unknown;
  principalKind: string | null;
};
type SpineDb = {
  event: {
    findMany(args: {
      where: { taskId: string; kind: { in: string[] } };
      orderBy: ({ timestamp: "desc" } | { id: "desc" })[];
      take: number;
    }): Promise<SpineEventRow[]>;
  };
};

/**
 * The NEWEST window, folded oldest→newest. `asc + take` returned the OLDEST
 * 1024 rows, so a long spine silently dropped every recent answer while its
 * `blocked` row stayed in view — an answered question derived as open
 * forever (review pass 7 HIGH #2). Newest-window truncation fails the safe
 * way instead: an ancient question whose open row ages out disappears,
 * rather than a recent answer being lost. `id` is the stable tiebreak for
 * equal-millisecond rows (the fold needs blocked-before-terminal order).
 */
async function questionSpine(
  taskId: string,
  db: SpineDb = prisma
): Promise<QuestionSpineEvent[]> {
  const rows = await db.event.findMany({
    where: { taskId, kind: { in: QUESTION_EVENT_KINDS } },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: 1024,
  });
  rows.reverse();
  return rows.map((row) => ({
    kind: row.kind,
    taskId: row.taskId ?? taskId,
    timestamp: row.timestamp.toISOString(),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    principalKind: row.principalKind ?? null,
  }));
}

function agentIdentity(app: FastifyInstance, request: FastifyRequest) {
  return requireAgentJobCapability(app, request);
}

/**
 * The serializable LOSER answers 409, not 500: when two transitions overlap,
 * the second's write conflict (Prisma P2034) is the mechanism WORKING — it
 * deserves the same controlled conflict answer the status check gives, not
 * an internal error (Greptile round-2 P1 on PR #35). Anything else rethrows.
 */
function conflictIfSerializationLoss(
  app: FastifyInstance,
  error: unknown
): never {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "P2034") {
    throw app.httpErrors.conflict(
      "Another transition for this question landed at the same instant; re-read and retry."
    );
  }
  throw error;
}

export async function registerQuestionRoutes(app: FastifyInstance) {
  // ── ASK (agent tier) ───────────────────────────────────────────────────────
  app.post("/", async (request) => {
    const capability = agentIdentity(app, request);
    const ask = blockingQuestionAskSchema.parse(request.body);

    // Role is optional decoration (a solo job has none); read it from the
    // job row the same way A2A does, but never refuse over its absence.
    const job = await prisma.dispatchJob.findUnique({
      where: { id: capability.jobId },
      select: { role: true },
    });

    const questionId = randomUUID();
    const stamp = buildEventAuditStamp({ actor: AGENT_PRINCIPAL });
    const timestamp = new Date();
    // Fence + cap + write in ONE serializable transaction: the cap was
    // read-then-write, so N concurrent asks could all pass at cap-1 (review
    // pass 7 #5); the fence bounds ask/withdraw churn so a job cannot push
    // the task's spine past the read window (HIGH #2).
    await prisma.$transaction(
      async (tx) => {
        const spine = await questionSpine(capability.taskId, tx);
        const ownAsks = spine.filter(
          (event) =>
            event.kind === QUESTION_BLOCKED_EVENT_KIND &&
            event.metadata.jobId === capability.jobId
        );
        const newestOwnAsk = ownAsks[ownAsks.length - 1];
        if (
          newestOwnAsk &&
          timestamp.getTime() - Date.parse(newestOwnAsk.timestamp) <
            MIN_QUESTION_ASK_INTERVAL_MS
        ) {
          throw app.httpErrors.tooManyRequests(
            `Questions from one job are spaced at least ${MIN_QUESTION_ASK_INTERVAL_MS}ms apart.`
          );
        }
        const openForJob = openBlockingQuestions(spine).filter(
          (question) => question.jobId === capability.jobId
        );
        if (openForJob.length >= MAX_OPEN_QUESTIONS_PER_JOB) {
          throw app.httpErrors.tooManyRequests(
            `This job already holds ${openForJob.length} open questions (cap ${MAX_OPEN_QUESTIONS_PER_JOB}). Withdraw one, or fold the asks into fewer questions.`
          );
        }
        await tx.event.create({
          data: {
            laneId: "muon",
            taskId: capability.taskId,
            kind: QUESTION_BLOCKED_EVENT_KIND,
            // Coordinate-only message: the SUBJECT is untrusted agent text and
            // must not shape a log line — it lives in metadata, rendered as data.
            message: `blocking question ${questionId} filed by job ${capability.jobId}`,
            timestamp,
            metadata: {
              questionId,
              jobId: capability.jobId,
              ...(typeof job?.role === "string" && job.role
                ? { role: job.role }
                : {}),
              vendor: capability.vendor,
              subject: ask.subject,
              body: ask.body,
            } as Prisma.InputJsonValue,
            ...eventAuditData(stamp),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    ).catch((error: unknown) => conflictIfSerializationLoss(app, error));

    // ADR-0069 D1: consult the brain BEFORE the human sees the question — a
    // scoped, HUMAN-CONFIRMED-only recall under the asker's own fence, filed
    // as a spine event so both sides read the same fact. FAIL-OPEN: a
    // pre-answer must never fail an ask, and the brain's silence is not an
    // error. Unconfirmed content NEVER enters the answer path (a blocked
    // agent under deadline pressure reads any answer as permission).
    try {
      const workspacePath = capability.workspacePath
        ? await repoRootOf(capability.workspacePath)
        : undefined;
      let found: Awaited<ReturnType<ReturnType<typeof getGraph>["searchMemory"]>> = [];
      try {
        found = await getGraph().searchMemory(
        `${ask.subject} ${ask.body}`.slice(0, 400),
        MAX_PREANSWER_NOTES * 4,
        {
          // The DERIVED partition (chat id, or task:<id> for a chat-less
          // job) — the same coordinate the offer rows below record under
          // and every memory read fences by (review finding: the raw
          // capability.chatId left a chat-less job's recall in a BROADER
          // view than the partition its offers claimed).
          chatId: agentMemoryPartition(capability),
          // ADR-0026's agent posture, restated: a capability with no
          // partition reads the §8 residue — nothing — never everything.
          ...(workspacePath ? { workspacePath } : { unscopedWorkspace: true }),
          // Deliberately NOT governedOnly: that gates on the MIRROR's cached
          // confirmed flag, which lags in BOTH directions. The candidates
          // stay fenced (workspace + chat) and never leave this block; the
          // LEDGER's confirmation override below is the one authority on
          // what may enter the pre-answer — stricter where it matters,
          // current where the mirror is not.
          governedOnly: false,
          showExpired: true,
        }
        );
      } catch (error) {
        // The graph nominates NOTE candidates only. Its outage must not
        // abort the crew block (review finding: packets are an independent
        // source and were dying with this call) — no notes, loudly, and
        // the packet path still runs.
        app.log.warn(
          { err: error, questionId },
          "question pre-answer recall failed; continuing without note candidates"
        );
      }
      // The graph only NOMINATES candidates; everything that testifies is
      // read from the LEDGER (review P1: `applyMemoryExpiry` degrades to
      // the mirror's cached fields when its confirmation read fails, so a
      // stale mirror could have passed a REVOKED note as human-confirmed).
      // Every read below THROWS into the outer catch — a degraded ledger
      // yields NO pre-answer, loudly, never a wrong one.
      const candidateIds = (found ?? []).map((note) => note.id);
      // Relevance FLOOR: a pre-answer must share at least one substantive
      // term with the question. BM25 over a small corpus returns SOMETHING
      // for anything, and a weak match dressed up as "the brain answered"
      // erodes exactly the trust the pre-answer exists to earn — absence is
      // the honest answer for an unmatched ask.
      const queryTerms = new Set(
        tokenize(`${ask.subject} ${ask.body}`).filter(
          (term) => term.length >= 4
        )
      );
      // ONE transaction for eligibility AND disclosure (review P1: status,
      // confirmation, and the event write were separate reads, so a
      // rejection landing between them could still be persisted as a
      // "HUMAN-CONFIRMED" pre-answer). The graph nominated OUTSIDE the tx;
      // everything that testifies is judged at one snapshot.
      let disclosedNotes: QuestionPreAnswerNote[] = [];
      let crewNotes: {
        noteId: string;
        kind: string;
        text: string;
        createdBy: string;
      }[] = [];
      if (candidateIds.length > 0) {
        const judged = await prisma.$transaction(async (tx) => {
          const ledgerRows = await tx.memoryNote.findMany({
            where: { id: { in: candidateIds } },
            select: {
              id: true,
              kind: true,
              text: true,
              status: true,
              createdBy: true,
              expiresAt: true,
            },
          });
          const rowById = new Map(ledgerRows.map((row) => [row.id, row]));
          const notes: QuestionPreAnswerNote[] = [];
          // ADR-0082: the recall's floor-passing, partition-fenced,
          // ACTIVE-but-unconfirmed remainder IS the crew's working
          // knowledge (published findings mint exactly such notes).
          // Collected here so both blocks judge at ONE snapshot; the
          // confirmed set stays the only ANSWER-path source.
          const crewCandidates: {
            noteId: string;
            kind: string;
            text: string;
            createdBy: string;
          }[] = [];
          for (const id of candidateIds) {
            const row = rowById.get(id);
            if (!row || row.status !== "active") continue;
            if (
              !tokenize(row.text).some(
                (term) => term.length >= 4 && queryTerms.has(term)
              )
            ) {
              continue;
            }
            // The ONE meaning of confirmed (human-blessed per the
            // Confirmation ledger), read from THIS snapshot, fail-CLOSED: a
            // throw is caught above as "no pre-answer".
            if (await isConfirmed(row.id, tx)) {
              if (notes.length < MAX_PREANSWER_NOTES) {
                notes.push({
                  noteId: row.id,
                  kind: row.kind,
                  excerpt: row.text.slice(0, MAX_PREANSWER_EXCERPT_CHARS),
                });
              }
            } else if (crewCandidates.length < MAX_PREANSWER_NOTES) {
              // The ledger's expiry fence applies to the CREW branch too
              // (review finding: the recall deliberately runs showExpired
              // for the confirmed path's own re-judging, so this branch
              // must enforce what that flag bypassed).
              if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
                continue;
              }
              crewCandidates.push({
                noteId: row.id,
                kind: row.kind,
                text: row.text,
                createdBy: row.createdBy,
              });
            }
          }
          if (notes.length > 0) {
            await tx.event.create({
              data: {
                laneId: "muon",
                taskId: capability.taskId,
                kind: QUESTION_PREANSWER_EVENT_KIND,
                message: `memory pre-answer for question ${questionId} (${notes.length} confirmed note(s))`,
                timestamp: new Date(),
                metadata: { questionId, notes } as Prisma.InputJsonValue,
                ...eventAuditData(
                  buildEventAuditStamp({ actor: AGENT_PRINCIPAL })
                ),
              },
            });
          }
          return { disclosed: notes, crewNotes: crewCandidates };
        },
        // SQLite is serializable by construction; STATED anyway because
        // every query lives on the ADR-0008 portability seam and Postgres's
        // default READ COMMITTED would re-open the exact race this
        // transaction exists to close (review finding). A serialization
        // loss lands in the outer catch: no pre-answer, loudly.
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        disclosedNotes = judged.disclosed;
        crewNotes = judged.crewNotes;
      }
      {
        // ADR-0060 via 0088's boundary: the pre-answer is a SERVE — its
        // excerpts reach the asker's session and its ids are citable via
        // `answered_from_memory` — and it shipped UNRECORDED, so every such
        // citation audited as an offered:false relay. Served AFTER the
        // disclosure tx (the recorder runs its own transaction; on SQLite's
        // single writer a nested second connection would deadlock against
        // the open tx), through THE one boundary and the one caller-scope
        // derivation — the recorder itself is module-private now.
        if (disclosedNotes.length > 0) {
          await serveNoteContent(
            await memoryCallerScope(app, request),
            "question-preanswer",
            disclosedNotes,
            disclosedNotes.map((note) => note.noteId),
            app.log
          );
        }
        // ADR-0082: the CREW-CONTEXT block — the crew's working knowledge
        // beside the ask, labeled as what it is and never the answer path
        // (D2: `answered_from_memory` stays confirmed-only; the withdrawal
        // citation binding refuses these ids structurally because they are
        // not in the DISCLOSED pre-answer set). Notes come from the same
        // snapshot's unconfirmed remainder above; packets from the asker's
        // own task, floor-matched like everything else.
        const noteItems: QuestionCrewContextItem[] = crewNotes.map((note) => ({
          kind: "note" as const,
          id: note.noteId,
          standing: `unconfirmed ${note.kind} by ${note.createdBy}`.slice(
            0,
            120
          ),
          excerpt: note.text.slice(0, MAX_PREANSWER_EXCERPT_CHARS),
        }));
        // Packets are queried UNCONDITIONALLY (review finding: gating on
        // remaining slots let three unconfirmed notes starve the second
        // source entirely).
        const packetItems: QuestionCrewContextItem[] = [];
        const packets = await prisma.handoff.findMany({
          where: { taskId: capability.taskId },
          orderBy: { createdAt: "desc" },
          take: 12,
          include: { fromLane: { select: { key: true } } },
        });
        for (const packet of packets) {
          if (packetItems.length >= MAX_PREANSWER_NOTES) break;
          const text = `${packet.packetTitle ?? ""} ${packet.packetBody ?? ""}`;
          if (
            !tokenize(text).some(
              (term) => term.length >= 4 && queryTerms.has(term)
            )
          ) {
            continue;
          }
          // ONE classifier decides what a packet's standing is (the 0086
          // D4 doctrine, applied at this ADR's own birth — review finding:
          // an ad-hoc parser here presented malformed shapes like
          // `{degraded: null}` as clean). `prose_only` is a legacy prose
          // packet, stated as such; anything the shared classifier calls
          // degraded or unparseable says so.
          const classified = classifyHandoffPacket(packet.packetJson);
          const standingPrefix =
            classified.contract === "prose_only"
              ? "prose "
              : handoffContractIsDegraded(classified.contract)
                ? `${classified.contract} `
                : "";
          packetItems.push({
            kind: "packet",
            id: packet.id,
            standing: `${standingPrefix}packet from ${
              packet.fromLane?.key ?? "unknown lane"
            }`.slice(0, 120),
            excerpt: text.trim().slice(0, MAX_PREANSWER_EXCERPT_CHARS),
          });
        }
        // Neither source starves the other: with both matching, notes take
        // at most MAX-1 slots so at least one packet always fits; a lone
        // source may fill everything.
        const noteQuota =
          packetItems.length > 0
            ? MAX_PREANSWER_NOTES - 1
            : MAX_PREANSWER_NOTES;
        const crewItems: QuestionCrewContextItem[] = [
          ...noteItems.slice(0, noteQuota),
          ...packetItems,
        ].slice(0, MAX_PREANSWER_NOTES);
        const servedPacketIds = crewItems
          .filter((item) => item.kind === "packet")
          .map((item) => item.id);
        if (crewItems.length > 0) {
          await prisma.event.create({
            data: {
              laneId: "muon",
              taskId: capability.taskId,
              kind: QUESTION_CREW_CONTEXT_EVENT_KIND,
              message: `crew context for question ${questionId} (${crewItems.length} item(s))`,
              timestamp: new Date(),
              metadata: {
                questionId,
                items: crewItems,
              } as Prisma.InputJsonValue,
              ...eventAuditData(
                buildEventAuditStamp({ actor: AGENT_PRINCIPAL })
              ),
            },
          });
          // Both serves record through the 0088 boundary: note excerpts
          // into the offer ledger, packet excerpts into the 0080 delivery
          // ledger — the crew block is a serve like any other.
          const scope = await memoryCallerScope(app, request);
          const crewNoteIds = crewItems
            .filter((item) => item.kind === "note")
            .map((item) => item.id);
          if (crewNoteIds.length > 0) {
            await serveNoteContent(
              scope,
              "question-crew-context",
              crewNoteIds,
              crewNoteIds,
              app.log
            );
          }
          if (servedPacketIds.length > 0) {
            await servePacketContent(
              scope,
              "question-crew-context",
              servedPacketIds,
              servedPacketIds,
              app.log
            );
          }
        }
      }
    } catch (error) {
      // Fail-open by design — but LOUD (the offer-ledger rule): the ask
      // stands, and the drop is findable.
      app.log.warn(
        { err: error, questionId },
        "question pre-answer recall failed; the ask stands without it"
      );
    }

    const derived = deriveBlockingQuestions([
      ...(await questionSpine(capability.taskId)),
    ]).find((question) => question.id === questionId);
    return { question: derived ?? null };
  });

  // ── READ OWN (agent tier) — the pull path for answers (D2) ────────────────
  app.get("/", async (request) => {
    const capability = agentIdentity(app, request);
    const spine = await questionSpine(capability.taskId);
    const questions = deriveBlockingQuestions(spine).filter(
      (question) => question.jobId === capability.jobId
    );
    return { questions };
  });

  // ── WITHDRAW (agent tier, own question only) ──────────────────────────────
  app.post("/:questionId/withdraw", async (request) => {
    const capability = agentIdentity(app, request);
    const params = z
      .object({ questionId: z.string().min(1) })
      .parse(request.params);
    // ADR-0069 D2: the ONE typed reason. A withdrawal that proceeds on the
    // brain's cited answer records that fact with its citations — a
    // distinct, queryable terminal color, never a human close.
    // THE protocol boundary (review finding: the reason⇄citations invariant
    // lived as three drifting conditionals — route, client, MCP — so it now
    // has exactly one schema). Whether the citations were actually DISCLOSED
    // on this question is checked inside the transaction below, where the
    // question is derived anyway.
    const withdrawal = parseBlockingQuestionWithdraw(request.body);
    // Derive-and-check INSIDE one serializable transaction (Greptile P1 on
    // PR #35): two overlapping terminal transitions both read "open" and
    // both write, so the fold kept the first while the second ALSO reported
    // success — a silently discarded result with contradictory audit rows.
    await prisma.$transaction(
      async (tx) => {
        const spine = await questionSpine(capability.taskId, tx);
        const question = deriveBlockingQuestions(spine).find(
          (candidate) => candidate.id === params.questionId
        );
        if (!question || question.jobId !== capability.jobId) {
          // One message for "not found" and "not yours": naming which
          // discloses another job's question ids.
          throw app.httpErrors.notFound(
            `No open question '${params.questionId}' belongs to this job.`
          );
        }
        if (question.status !== "open") {
          throw app.httpErrors.conflict(
            `Question '${params.questionId}' is already ${question.status}.`
          );
        }
        // The typed reason must cite FROM the question's own disclosed
        // pre-answer (review finding: arbitrary ids were false provenance
        // on the spine). No pre-answer → the typed reason is refused.
        if (withdrawal) {
          const disclosed = new Set(
            (question.memoryPreAnswer?.notes ?? []).map((note) => note.noteId)
          );
          if (disclosed.size === 0) {
            throw app.httpErrors.badRequest(
              "answered_from_memory requires a disclosed pre-answer on this question; none exists."
            );
          }
          const foreign = withdrawal.citedNoteIds.filter(
            (id) => !disclosed.has(id)
          );
          if (foreign.length > 0) {
            throw app.httpErrors.badRequest(
              "answered_from_memory citations must be drawn from this question's own pre-answer."
            );
          }
        }
        const stamp = buildEventAuditStamp({ actor: AGENT_PRINCIPAL });
        await tx.event.create({
          data: {
            laneId: "muon",
            taskId: capability.taskId,
            kind: QUESTION_WITHDRAWN_EVENT_KIND,
            message: `blocking question ${params.questionId} withdrawn`,
            timestamp: new Date(),
            metadata: {
              questionId: params.questionId,
              ...(withdrawal
                ? {
                    reason: withdrawal.reason,
                    citedNoteIds: withdrawal.citedNoteIds,
                  }
                : {}),
            } as Prisma.InputJsonValue,
            ...eventAuditData(stamp),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    ).catch((error: unknown) => conflictIfSerializationLoss(app, error));
    return { withdrawn: params.questionId };
  });

  // ── LIST FOR A TASK (operator tier) — the inbox read ──────────────────────
  // ── OPEN INBOX (operator tier) ──────────────────────────────────────────
  // Every OPEN question on the machine, for the desk and TUI inboxes
  // (surface-parity audit 2026-08-11: agents could ask, and only the CLI —
  // with a --task-id the human had to already know — could see). Derived
  // EXACTLY like the per-task read: group the bounded spine by task and run
  // the same fold, so there is no second statement of the state rules.
  // Newest-asked first; bounded, and the bound is reported, never silent.
  app.get("/open", async (request) => {
    requireOperator(app, request);
    const rows = await prisma.event.findMany({
      where: { kind: { in: QUESTION_EVENT_KINDS } },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: 2048,
    });
    rows.reverse();
    const byTask = new Map<string, QuestionSpineEvent[]>();
    for (const row of rows) {
      if (!row.taskId) continue;
      const spine = byTask.get(row.taskId) ?? [];
      spine.push({
        kind: row.kind,
        taskId: row.taskId,
        timestamp: row.timestamp.toISOString(),
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        principalKind: row.principalKind ?? null,
      });
      byTask.set(row.taskId, spine);
    }
    const open = [...byTask.values()].flatMap((spine) =>
      deriveBlockingQuestions(spine).filter(
        (question) => question.status === "open"
      )
    );
    open.sort((left, right) => (left.askedAt < right.askedAt ? 1 : -1));
    return {
      questions: open.slice(0, 100),
      // BOTH bounds are part of the truth: the response cap AND the spine
      // window. A full 2048-event scan may have aged an older-but-still-open
      // question out of the window entirely, and reporting that read as
      // complete would make the inbox lie by omission (cubic P1, 2026-08-11).
      truncated: open.length > 100 || rows.length >= 2048,
      scannedEvents: rows.length,
      scanBound: 2048,
    };
  });

  app.get("/task/:taskId", async (request) => {
    requireOperator(app, request);
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const questions = deriveBlockingQuestions(await questionSpine(params.taskId));
    return { questions };
  });

  // ── ANSWER (operator tier) ────────────────────────────────────────────────
  app.post("/:questionId/answer", async (request) => {
    requireOperator(app, request);
    const params = z
      .object({ questionId: z.string().min(1) })
      .parse(request.params);
    const body = blockingQuestionAnswerSchema
      .extend({ taskId: z.string().min(1) })
      .strict()
      .parse(request.body);

    // Same serializable derive-and-check as ask/withdraw (Greptile P1 on
    // PR #35): without it, two overlapping answers both read "open", both
    // wrote, and both reported success while the fold kept only the first.
    let overriddenCitedNoteIds: string[] = [];
    let overriddenSubject = "";
    await prisma.$transaction(
      async (tx) => {
        const spine = await questionSpine(body.taskId, tx);
        const question = deriveBlockingQuestions(spine).find(
          (candidate) => candidate.id === params.questionId
        );
        if (!question) {
          throw app.httpErrors.notFound(
            `Unknown question '${params.questionId}' on task '${body.taskId}'.`
          );
        }
        // ADR-0069 D2's override leg: the human may answer a question the
        // ASKER closed from memory — the one legal second terminal, decided
        // by THE one protocol predicate the fold also uses (review finding:
        // two spellings of the precondition were free to drift).
        const overriding = canOverrideMemoryAnswer(question);
        if (question.status !== "open" && !overriding) {
          throw app.httpErrors.conflict(
            `Question '${params.questionId}' is already ${question.status}; an answered question is never silently re-answered.`
          );
        }
        if (overriding) {
          overriddenCitedNoteIds = question.withdrawnCitedNoteIds ?? [];
          overriddenSubject = question.subject;
        }
        const stamp = buildEventAuditStamp({ actor: OPERATOR_PRINCIPAL });
        await tx.event.create({
          data: {
            laneId: "muon",
            taskId: body.taskId,
            kind: QUESTION_ANSWERED_EVENT_KIND,
            message: `blocking question ${params.questionId} answered`,
            timestamp: new Date(),
            metadata: {
              questionId: params.questionId,
              answer: body.answer,
            } as Prisma.InputJsonValue,
            ...eventAuditData(stamp),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    ).catch((error: unknown) => conflictIfSerializationLoss(app, error));
    // ADR-0069 D2, the second half of the override: "an override supersedes
    // the memory answer AND files the contradiction as an unconfirmed
    // proposal against the cited notes" — the brain learns it was stale the
    // moment it misleads. OUTSIDE the state transaction (the ingest owns
    // its own transactionality, exactly as the grounding-mismatch proposal
    // does) and fail-open LOUD: the human's answer must stand even if the
    // learning side-channel hiccups.
    if (overriddenCitedNoteIds.length > 0) {
      try {
        const anchors = (value: unknown): string[] =>
          Array.isArray(value) ? value.map((entry) => String(entry)) : [];
        // The proposal lands in the question's own workspace partition
        // (reduced exactly as the write path reduces), so review finds it
        // where the cited notes live — not in the unassigned residue.
        const task = await prisma.task.findUnique({
          where: { id: body.taskId },
          select: { workspacePath: true },
        });
        const partition = task?.workspacePath
          ? await repoRootOf(task.workspacePath)
          : null;
        const cited = await prisma.memoryNote.findMany({
          where: { id: { in: overriddenCitedNoteIds } },
          select: { id: true, modules: true, symbols: true },
        });
        const modules = [
          ...new Set(cited.flatMap((note) => anchors(note.modules))),
        ].sort();
        const symbols = [
          ...new Set(cited.flatMap((note) => anchors(note.symbols))),
        ].sort();
        const text =
          `A human override contradicted a memory answer. Question: "${overriddenSubject}". ` +
          `The asker closed it citing ${overriddenCitedNoteIds.join(", ")}; the operator then answered: ` +
          `"${body.answer.slice(0, 240)}". Review whether the cited notes still hold.`;
        const proposal = await ingestMemoryNote({
          kind: "question",
          text,
          modules,
          topics: [],
          symbols,
          plannedCoordinates: [],
          trust: "low",
          createdBy: OPERATOR_PRINCIPAL,
          proposalOnly: true,
          ...(partition ? { workspacePath: partition } : {}),
          provenance: {
            sourceType: "question-override",
            rawRef: `question:${params.questionId}`,
          },
        });
        // ADR-0081 A3: THE one edge spelling (upsert + graph mirror) —
        // this loop wrote ledger-only edges before, invisible to the
        // graph-backed derivations until a full rebuild. The per-edge
        // batching tx protected no cross-record invariant; each upsert is
        // independently idempotent. The proposal note re-projects once per
        // citation (bounded by the citation cap, idempotent MERGEs, on a
        // human-rare override path) — accepted over a second batch API
        // spelling for the same edge.
        for (const noteId of overriddenCitedNoteIds) {
          await mintContradictionEdge(proposal.note.id, noteId);
        }
      } catch (error) {
        app.log.error(
          { err: error, questionId: params.questionId },
          "override-contradiction proposal failed; the override stands, the brain did not learn (file it by hand)"
        );
      }
    }
    const updated = deriveBlockingQuestions(
      await questionSpine(body.taskId)
    ).find((candidate) => candidate.id === params.questionId);
    return { question: updated ?? null };
  });

  // ── A13: OPEN QUESTIONS FOR THIS COORDINATOR'S OWN CREW ───────────────────
  //
  // `GET /open` above is the OPERATOR inbox — every open question on the
  // machine — and it is operator-tier for exactly that reason. A coordinator
  // holds an agent-tier job capability, so it could not read it at all, and
  // `GET /` answers only for the caller's OWN job. The result was the gap A13
  // names: a crew could be blocked on a human and the coordinator watching it
  // had no read that would say so.
  //
  // This is that read, fenced positively rather than by subtraction:
  //  - The CAPABILITY must be a chat coordinator's (`orchestrator` or the
  //    ADR-0028 attached seat) — a plain worker gets nothing new here.
  //  - The answer is derived only from jobs in THAT capability's own chat, so
  //    another mission's questions are absent rather than refused by name.
  //  - COORDINATES ONLY: id, task, and when it was asked. The subject and body
  //    are agent-authored text belonging to another job and stay out; the
  //    coordinator needs to know a human is blocking, not to read the question.
  const CREW_QUESTION_TASK_BOUND = 200;
  const CREW_QUESTION_LIMIT = 100;
  app.get("/crew", async (request) => {
    const capability = requireAgentOrchestratorCapability(app, request);
    // `isChatCoordinatorCapability` already required a chatId; this narrows the
    // Prisma type rather than re-checking an invariant.
    const chatId = capability.chatId!;
    const jobs = await prisma.dispatchJob.findMany({
      where: { chatId },
      select: { id: true, taskId: true },
      orderBy: { createdAt: "desc" },
      take: CREW_QUESTION_TASK_BOUND,
    });
    const taskIds = [...new Set(jobs.map((job) => job.taskId))];
    if (taskIds.length === 0) {
      return { questions: [], truncated: false, scannedTasks: 0 };
    }
    const rows = await prisma.event.findMany({
      where: { kind: { in: QUESTION_EVENT_KINDS }, taskId: { in: taskIds } },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: 2048,
    });
    // Fold oldest→newest, per task, exactly as every other question read does:
    // the state rules live in `deriveBlockingQuestions` and are never restated.
    rows.reverse();
    const byTask = new Map<string, QuestionSpineEvent[]>();
    for (const row of rows) {
      if (!row.taskId) continue;
      const spine = byTask.get(row.taskId) ?? [];
      spine.push({
        kind: row.kind,
        taskId: row.taskId,
        timestamp: row.timestamp.toISOString(),
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        principalKind: row.principalKind ?? null,
      });
      byTask.set(row.taskId, spine);
    }
    const open = [...byTask.values()].flatMap((spine) =>
      openBlockingQuestions(spine).map((question) => ({
        id: question.id,
        taskId: question.taskId,
        askedAt: question.askedAt,
      }))
    );
    open.sort((left, right) => (left.askedAt < right.askedAt ? 1 : -1));
    return {
      questions: open.slice(0, CREW_QUESTION_LIMIT),
      // BOTH bounds, for the same reason `/open` reports both: a full spine
      // window may have aged an older-but-still-open question out entirely,
      // and a status line that reported that read as complete would tell a
      // coordinator nothing is blocking when something is.
      truncated:
        open.length > CREW_QUESTION_LIMIT ||
        rows.length >= 2048 ||
        jobs.length >= CREW_QUESTION_TASK_BOUND,
      scannedTasks: taskIds.length,
    };
  });
}
