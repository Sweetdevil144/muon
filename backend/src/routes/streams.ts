import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { redactedTail } from "@muon/core";
import {
  contextWindowChunkKindSchema,
  STREAM_MESSAGE_CONTENT_CHARS,
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type ToolActivityDetail,
} from "@muon/protocol";
import {
  requireAgentJobAccess,
  requireAgentTaskAccess,
  requireOperator,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";

/**
 * Tool-call detail is UNTRUSTED text written by an agent-tier bearer, so the
 * route treats the recorder's bounding and redaction as unverified: it re-bounds
 * (a hostile poster cannot store 100 MB) and re-scrubs through the SAME
 * `redactedTail` control. `.max()` rejects rather than silently trimming so an
 * over-limit poster learns it is over the limit; the scrub then runs on what
 * survives. Absent `detail` stays absent — the column is nullable and additive.
 */
const toolDetailSchema = z.object({
  args: z.string().max(TOOL_ACTIVITY_ARGS_CHARS + 1).optional(),
  argsTruncated: z.boolean().optional(),
  result: z.string().max(TOOL_ACTIVITY_RESULT_CHARS + 1).optional(),
  resultTruncated: z.boolean().optional(),
});

function scrubDetail(
  detail: z.infer<typeof toolDetailSchema> | undefined
): ToolActivityDetail | undefined {
  if (!detail) return undefined;
  const args = detail.args
    ? redactedTail(detail.args, TOOL_ACTIVITY_ARGS_CHARS)
    : undefined;
  const result = detail.result
    ? redactedTail(detail.result, TOOL_ACTIVITY_RESULT_CHARS)
    : undefined;
  if (!args && !result) return undefined;
  return {
    ...(args ? { args, argsTruncated: detail.argsTruncated === true } : {}),
    ...(result
      ? { result, resultTruncated: detail.resultTruncated === true }
      : {}),
  };
}

const chunkInputSchema = z.object({
  taskId: z.string().min(1),
  laneId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  kind: contextWindowChunkKindSchema.default("output"),
  // The write-side bound on untrusted agent text. The recorder already bounds
  // by class (`boundStreamChunkContent`) and its output is never longer than
  // the bound it was given, so a well-behaved poster passes through unchanged;
  // a hostile or out-of-date one is REJECTED rather than silently trimmed, the
  // same posture `toolDetailSchema` takes — a caller that is over the limit
  // learns it is over the limit instead of storing a lie.
  content: z.string().min(1).max(STREAM_MESSAGE_CONTENT_CHARS),
  detail: toolDetailSchema.optional(),
  timestamp: z.iso.datetime().optional(),
});

const recordChunksSchema = z.object({
  chunks: z.array(chunkInputSchema).min(1).max(500),
});

/**
 * Body bound for one recorded batch. The count bound alone stopped being a size
 * bound the moment a chunk could legitimately hold a 64 K final report, so the
 * batch says its size out loud. The recorder flushes at
 * STREAM_BATCH_CONTENT_CHARS (128 K chars) so a legitimate batch lands well
 * inside this even at four bytes per character.
 */
const STREAM_BATCH_BODY_BYTES = 2 * 1024 * 1024;

const claimChunkSchema = z.object({
  taskId: z.string().min(1),
  laneId: z.string().min(1),
  claimKey: z.string().min(1).max(256),
  kind: z.literal("milestone"),
  content: z.string().min(1).max(4096),
});

const listQuerySchema = z
  .object({
    taskId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
    // Return the newest `limit` chunks instead of the oldest after the
    // cursor, for resuming a long history at its tail.
    latest: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .refine(
    (value) => value.taskId || value.runId || value.sessionId || value.agentId,
    {
      message: "One of taskId, runId, sessionId, or agentId is required.",
    }
  );

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

// seq is a plain Int (the SQLite autoincrement rowid alias), a single-user
// local brain never approaches 2^31 chunks. It serializes as a JSON number
// directly (no BigInt round-trip needed).
function serialize(chunk: {
  seq: number;
  taskId: string;
  laneId: string;
  sessionId: string | null;
  runId: string | null;
  kind: string;
  content: string;
  // Null on every row written before 0036, and on every chunk whose adapter
  // captured nothing. Readers must treat absence as "no detail", never as
  // "empty output".
  detail: Prisma.JsonValue | null;
  timestamp: Date;
}) {
  return chunk;
}

export async function registerStreamRoutes(app: FastifyInstance) {
  // Append-only, like Event: streams are provenance, never rewritten.
  const recordOptions = { bodyLimit: STREAM_BATCH_BODY_BYTES };
  app.post("/", recordOptions, async (request, reply) => {
    const payload = recordChunksSchema.parse(request.body);
    const taskIds = [...new Set(payload.chunks.map((chunk) => chunk.taskId))];
    for (const taskId of taskIds) {
      await requireAgentTaskAccess(app, request, taskId);
    }
    const humanTurns = payload.chunks.filter(
      (chunk) => chunk.kind === "user.message"
    );
    if (humanTurns.length > 0) {
      requireOperator(app, request);
      if (humanTurns.some((chunk) => chunk.laneId !== "muon-chat")) {
        throw app.httpErrors.badRequest(
          "A user.message chunk must use the trusted muon-chat lane."
        );
      }
    }
    const chatIds = [
      ...new Set(
        payload.chunks
          .filter((chunk) => chunk.laneId === "muon-chat")
          .map((chunk) => chunk.taskId)
      ),
    ];
    const data = payload.chunks.map((chunk) => {
      const detail = scrubDetail(chunk.detail);
      return {
        taskId: chunk.taskId,
        laneId: chunk.laneId,
        agentId: chunk.agentId,
        sessionId: chunk.sessionId,
        runId: chunk.runId,
        kind: chunk.kind,
        content: chunk.content,
        ...(detail ? { detail } : {}),
        ...(chunk.timestamp ? { timestamp: new Date(chunk.timestamp) } : {}),
      };
    });
    const result =
      chatIds.length === 0
        ? await prisma.streamChunk.createMany({ data })
        : await prisma.$transaction(
            async (tx) => {
              const activeChats = await tx.orchestratorChat.findMany({
                where: { id: { in: chatIds }, status: "active" },
                select: { id: true },
              });
              if (activeChats.length !== chatIds.length) {
                throw app.httpErrors.conflict(
                  "The muon-chat stream is closed because its orchestrator chat is archived or missing."
                );
              }
              return tx.streamChunk.createMany({ data });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          );

    reply.code(201);
    return { recorded: result.count };
  });

  // Atomic append-once claim for cross-process orchestration reconciliation.
  // SQLite enforces taskId+dedupeKey uniqueness; a losing surface receives only
  // `{ claimed:false }` and must not repeat the terminal side effect.
  app.post("/claim", async (request, reply) => {
    const chunk = claimChunkSchema.parse(request.body);
    await requireAgentTaskAccess(app, request, chunk.taskId);
    try {
      const data = {
        taskId: chunk.taskId,
        laneId: chunk.laneId,
        dedupeKey: chunk.claimKey,
        kind: chunk.kind,
        content: chunk.content,
      };
      if (chunk.laneId === "muon-chat") {
        await prisma.$transaction(
          async (tx) => {
            const chat = await tx.orchestratorChat.findFirst({
              where: { id: chunk.taskId, status: "active" },
              select: { id: true },
            });
            if (!chat) {
              throw app.httpErrors.conflict(
                "The muon-chat stream is closed because its orchestrator chat is archived or missing."
              );
            }
            await tx.streamChunk.create({ data });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } else {
        await prisma.streamChunk.create({ data });
      }
      reply.code(201);
      return { claimed: true };
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) {
        return { claimed: false };
      }
      throw error;
    }
  });

  app.get("/", async (request) => {
    const query = listQuerySchema.parse(request.query);
    if (request.agentJobCapability) {
      if (query.taskId) {
        await requireAgentTaskAccess(app, request, query.taskId);
      }
      if (query.runId) {
        await requireAgentJobAccess(app, request, query.runId);
      }
      if (!query.taskId && !query.runId) {
        throw app.httpErrors.forbidden(
          "A job capability must address streams by an authorized taskId or runId."
        );
      }
    }

    const where = {
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      seq: { gt: query.afterSeq },
    };

    if (query.latest) {
      // Newest `limit`, returned in chronological order for rendering.
      const newest = await prisma.streamChunk.findMany({
        where,
        orderBy: { seq: "desc" },
        take: query.limit,
      });
      return { chunks: newest.reverse().map(serialize) };
    }

    const chunks = await prisma.streamChunk.findMany({
      where,
      orderBy: { seq: "asc" },
      take: query.limit,
    });

    return { chunks: chunks.map(serialize) };
  });
}
