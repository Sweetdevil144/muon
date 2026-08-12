import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  blockingQuestionAnswerSchema,
  blockingQuestionAskSchema,
  deriveBlockingQuestions,
  openBlockingQuestions,
  MAX_OPEN_QUESTIONS_PER_JOB,
  MIN_QUESTION_ASK_INTERVAL_MS,
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
  type QuestionSpineEvent,
} from "@muon/protocol";
import {
  AGENT_PRINCIPAL,
  OPERATOR_PRINCIPAL,
  requireAgentJobCapability,
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
        const stamp = buildEventAuditStamp({ actor: AGENT_PRINCIPAL });
        await tx.event.create({
          data: {
            laneId: "muon",
            taskId: capability.taskId,
            kind: QUESTION_WITHDRAWN_EVENT_KIND,
            message: `blocking question ${params.questionId} withdrawn`,
            timestamp: new Date(),
            metadata: { questionId: params.questionId } as Prisma.InputJsonValue,
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
        if (question.status !== "open") {
          throw app.httpErrors.conflict(
            `Question '${params.questionId}' is already ${question.status}; an answered question is never silently re-answered.`
          );
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
    const updated = deriveBlockingQuestions(
      await questionSpine(body.taskId)
    ).find((candidate) => candidate.id === params.questionId);
    return { question: updated ?? null };
  });
}
