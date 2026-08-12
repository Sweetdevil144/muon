import { randomUUID } from "node:crypto";
import {
  capRefusesDispatch,
  describeCapVerdict,
  evaluateCap,
  VENDOR_REGISTRY,
  vendorIdSchema,
} from "@muon/protocol";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { confirmingPrincipal, requireOperator } from "../lib/auth.js";
import { readMissionCost } from "../lib/mission-cost.js";
import {
  getMissionCostCapDefaultUsd,
  setMissionCostCapDefaultUsd,
} from "../lib/operator-settings.js";

const createChatSchema = z.object({
  title: z.string().min(1).max(120).default("New chat"),
  workspacePath: z.string().min(1),
});

// Which lifecycle slice the list returns. Default "active" matches the TUI
// resume filter and the desktop sidebar: an archived (soft-deleted) chat drops
// out of the working list but is never destroyed, and stays reachable by id or
// with an explicit ?status. Invalid values are rejected (400), never ignored.
const listChatsQuerySchema = z.object({
  status: z.enum(["active", "archived", "all"]).default("active"),
});

const updateChatSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    // Provider output is data, never unbounded durable authority. Match the
    // dispatch resume-handle limit so an oversized SDK coordinate is rejected
    // before it can bloat the chat row or become an unusable stale binding.
    vendorSessionId: z.string().min(1).max(512).optional(),
    // G7, the chat-continuity binding. A POSITIVE capability check, never a bare
    // widening to every vendor id: the lane must be one MUON actually persists a
    // provider-session handle for. Exactly one vendor declares that today, so
    // this admits exactly what the `z.enum(["claude-code"])` it replaces did —
    // the difference is that the answer now comes from the registry column that
    // means it, so a second lane that earns the handle is admitted by stating
    // that ONCE rather than by someone remembering this line exists.
    vendorSessionVendor: vendorIdSchema
      .refine((vendor) => VENDOR_REGISTRY[vendor].session.persistsSessionHandle, {
        message:
          "That vendor does not persist a chat-continuity session handle, so it cannot own this chat's provider session.",
      })
      .optional(),
    vendorSessionRootJobId: z.string().min(1).optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field must be provided.",
  })
  .superRefine((value, ctx) => {
    const sessionFields = [
      value.vendorSessionId,
      value.vendorSessionVendor,
      value.vendorSessionRootJobId,
    ];
    const present = sessionFields.filter((entry) => entry !== undefined).length;
    if (present > 0 && present !== sessionFields.length) {
      ctx.addIssue({
        code: "custom",
        path: ["vendorSessionId"],
        message:
          "vendorSessionId, vendorSessionVendor, and vendorSessionRootJobId must be updated together.",
      });
    }
  });

/**
 * The archive precondition — UNCHANGED in strength: a chat that still owns a
 * queued or running dispatch cannot be archived, full stop. What changed is
 * honesty. The bare 409 told the human nothing about WHICH job was holding the
 * chat open, so a failed archive read as a mystery (and, from the desktop, as a
 * raw devtools error). Naming the blockers costs one bounded read inside the
 * same serializable transaction and makes the refusal actionable on every
 * surface — desktop, CLI, TUI, or a plain curl.
 *
 * Jobs are named by id prefix + vendor + status only: no brief, no result, no
 * agent-authored text ever rides an error message.
 */
async function refuseIfChatHasActiveJobs(
  app: FastifyInstance,
  tx: Pick<typeof prisma, "dispatchJob">,
  chatId: string
): Promise<void> {
  const where = {
    chatId,
    status: { in: ["queued", "running"] },
  };
  const activeJobs = await tx.dispatchJob.count({ where });
  if (activeJobs === 0) {
    return;
  }
  const blockers = await tx.dispatchJob.findMany({
    where,
    select: { id: true, vendor: true, status: true },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  const listed = blockers
    .map((job) => `${job.id.slice(0, 8)} (${job.vendor}, ${job.status})`)
    .join("; ");
  const rest = activeJobs - blockers.length;
  throw app.httpErrors.conflict(
    "Stop every queued or running chat job before archiving. " +
      `${activeJobs} still active: ${listed}${rest > 0 ? `; and ${rest} more` : ""}.`
  );
}

export async function registerChatRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const query = listChatsQuerySchema.parse(request.query);
    const chats = await prisma.orchestratorChat.findMany({
      // "all" drops the filter; otherwise scope to the requested lifecycle.
      where: query.status === "all" ? undefined : { status: query.status },
      orderBy: { updatedAt: "desc" },
    });
    return { chats };
  });

  app.post("/", async (request, reply) => {
    const payload = createChatSchema.parse(request.body);
    // Shadow task: approvals FK to Task, so every chat gets a ledger anchor
    // for the super-agent's gates and session provenance.
    const chatId = randomUUID();
    const chat = await prisma.$transaction(async (tx) => {
      // The default is read INSIDE this transaction, not before it.
      //
      // Read outside, a concurrent `muon cost default` could land between the
      // read and the create — so a chat created AFTER a new default was set
      // could still copy the old one, or stay uncapped after one was
      // introduced. The copy-not-reference rule (D7) is about not re-reading
      // it LATER; it says nothing about reading it consistently now.
      //
      // Absent means no cap, which is not a cap of zero — a zero would refuse
      // the very first dispatch of every new chat.
      const defaultCapUsd = await getMissionCostCapDefaultUsd(tx);
      const task = await tx.task.create({
        data: {
          title: `Chat, ${payload.title}`,
          description: `Conversation with the super-orchestrator in ${payload.workspacePath}`,
          status: "in_progress",
          workspacePath: payload.workspacePath,
          chatId,
        },
      });
      return tx.orchestratorChat.create({
        data: {
          id: chatId,
          ...payload,
          taskId: task.id,
          // ADR-0036 D7 — the operator's DEFAULT is COPIED here, never read
          // live. From this moment the number belongs to this mission: editing
          // the default later cannot move a cap that a human is already
          // running under, and clearing it cannot un-cap work in flight.
          ...(defaultCapUsd === null
            ? {}
            : {
                costCapUsd: defaultCapUsd,
                costCapSetBy: "operator-default",
                costCapSetAt: new Date(),
              }),
        },
      });
    });
    reply.code(201);
    return { chat };
  });

  app.get("/:chatId", async (request) => {
    const params = z.object({ chatId: z.string().min(1) }).parse(request.params);
    const chat = await prisma.orchestratorChat.findUnique({
      where: { id: params.chatId },
    });
    if (!chat) {
      throw app.httpErrors.notFound("The requested chat does not exist.");
    }
    return { chat };
  });

  app.patch("/:chatId", async (request) => {
    const params = z.object({ chatId: z.string().min(1) }).parse(request.params);
    const payload = updateChatSchema.parse(request.body);
    // Brain-gate side-channel parity with DELETE (below): status/title are a
    // human-govern surface — archiving/resurrecting or renaming a human's chat
    // is exactly the authority DELETE reserves for the operator, so an
    // agent-tier PATCH to either field must fail closed (403) the same way. Gate
    if (payload.status !== undefined || payload.title !== undefined) {
      requireOperator(app, request);
    }
    if (payload.vendorSessionId !== undefined) {
      const capability = request.agentJobCapability;
      if (
        !capability ||
        capability.capabilityMode !== "orchestrator" ||
        capability.parentJobId ||
        capability.chatId !== params.chatId ||
        capability.jobId !== payload.vendorSessionRootJobId ||
        capability.vendor !== payload.vendorSessionVendor
      ) {
        throw app.httpErrors.forbidden(
          "Only the exact active root coordinator may persist its provider-bound resume session."
        );
      }
      const chat = await prisma.$transaction(
        async (tx) => {
          const updated = await tx.orchestratorChat.updateMany({
            where: { id: params.chatId, status: "active" },
            data: payload,
          });
          if (updated.count !== 1) {
            throw app.httpErrors.conflict(
              "Cannot persist a provider session for an archived or missing chat."
            );
          }
          return tx.orchestratorChat.findUniqueOrThrow({
            where: { id: params.chatId },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      return { chat };
    }
    if (payload.status === "archived") {
      const chat = await prisma.$transaction(
        async (tx) => {
          const existing = await tx.orchestratorChat.findUnique({
            where: { id: params.chatId },
            select: { id: true },
          });
          if (!existing) {
            throw app.httpErrors.notFound(
              "The requested chat does not exist."
            );
          }
          await refuseIfChatHasActiveJobs(app, tx, params.chatId);
          return tx.orchestratorChat.update({
            where: { id: params.chatId },
            data: payload,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      return { chat };
    }
    const chat = await prisma.orchestratorChat.update({
      where: { id: params.chatId },
      data: payload,
    });
    return { chat };
  });

  // Chat "delete" is a SOFT archive (FD-2). Hard delete would cascade the
  // ApprovalRequest audit away via the shadow-Task FK (schema.prisma:157) and
  // strip StreamChunk provenance, incompatible with the append-only ledger. So
  // this is OPERATOR-only (an agent-tier caller cannot govern-delete a human's
  // conversation) and only flips status→"archived"; every audit row survives,
  // and the chat stays fetchable by id and via ?status=archived|all. Provider
  // continuity is separately gated to the exact active root capability above.
  app.delete("/:chatId", async (request) => {
    requireOperator(app, request);
    const params = z.object({ chatId: z.string().min(1) }).parse(request.params);
    const chat = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.orchestratorChat.findUnique({
          where: { id: params.chatId },
          select: { id: true },
        });
        if (!existing) {
          throw app.httpErrors.notFound(
            "The requested chat does not exist."
          );
        }
        await refuseIfChatHasActiveJobs(app, tx, params.chatId);
        return tx.orchestratorChat.update({
          where: { id: params.chatId },
          data: { status: "archived" },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    return { chat };
  });

  /**
   * ADR-0036 D7 — the operator's DEFAULT cap for chats created FROM NOW ON.
   *
   * A static path deliberately, and registered before nothing that would make
   * it ambiguous: `settings` beats `:chatId` in the router, and there is no
   * chat verb it could shadow.
   *
   * This writes a DEFAULT, not a cap. It cannot reach a mission that already
   * exists — that is the copy-not-reference rule in D7, and it is what stops
   * an edit here from silently re-capping work in flight.
   */
  app.get("/settings/cost-cap-default", async (request) => {
    requireOperator(app, request);
    return { capUsd: await getMissionCostCapDefaultUsd() };
  });

  app.put("/settings/cost-cap-default", async (request) => {
    requireOperator(app, request);
    const body = z
      .object({
        capUsd: z.number().positive().finite().max(1_000_000).nullable(),
      })
      .parse(request.body);
    return { capUsd: await setMissionCostCapDefaultUsd(body.capUsd) };
  });

  /**
   * ADR-0036 D4/D7 — read this mission's cap and what it has spent.
   *
   * The figure and its COVERAGE always travel together: the response carries
   * `summary` from the one renderer, so no surface can show a bare number and
   * imply the cap covers lanes it cannot see.
   */
  app.get("/:chatId/cost", async (request) => {
    requireOperator(app, request);
    const params = z.object({ chatId: z.string().min(1) }).parse(request.params);
    const chat = await prisma.orchestratorChat.findUnique({
      where: { id: params.chatId },
      select: { costCapUsd: true, costCapSetBy: true, costCapSetAt: true },
    });
    if (!chat) {
      throw app.httpErrors.notFound("The requested chat does not exist.");
    }
    const reading = await readMissionCost(params.chatId);
    const verdict = evaluateCap(reading.cost, chat.costCapUsd);
    return {
      capUsd: chat.costCapUsd,
      capSetBy: chat.costCapSetBy,
      capSetAt: chat.costCapSetAt?.toISOString() ?? null,
      cost: reading.cost,
      laneCosts: reading.laneCosts,
      silentLanes: reading.silentLanes,
      // A task another mission also dispatched into is EXCLUDED from this
      // bill, and the exclusion is named: a figure that quietly dropped a task
      // is the covered-looking-partial lie in yet another costume.
      contestedTasks: reading.contestedTasks,
      truncated: reading.truncated,
      refusesDispatch: capRefusesDispatch(verdict),
      summary: describeCapVerdict(verdict, reading.silentLanes),
    };
  });

  /**
   * ADR-0036 D4/D7 — set, raise, lower or clear THIS mission's cap.
   *
   * OPERATOR ONLY, and there is deliberately no agent-tier counterpart at all
   * — not a narrow one, not a gated one. An agent that can raise its own
   * spending limit does not have a limit; an agent that wants more files the
   * same `budgetRaiseGateTag` gate it already files for wall-clock, and a
   * human answers it on a MUON surface.
   *
   * Lowering is permitted and is NOT symmetrical with the wall-clock pool's
   * raise-only rule: a wall-clock reservation is already committed to running
   * children, so lowering it would strand them, while a cost cap is only ever
   * tested against spend that has ALREADY happened. Lowering therefore refuses
   * future work and interrupts nothing — which is D2 exactly.
   */
  app.put("/:chatId/cost-cap", async (request) => {
    requireOperator(app, request);
    const params = z.object({ chatId: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        // `null` CLEARS the cap. A cleared cap is not a cap of zero, and zero
        // is rejected outright: it would refuse every dispatch forever while
        // reading like a configured limit.
        capUsd: z.number().positive().finite().max(1_000_000).nullable(),
      })
      .parse(request.body);

    const existing = await prisma.orchestratorChat.findUnique({
      where: { id: params.chatId },
      select: { id: true },
    });
    if (!existing) {
      throw app.httpErrors.notFound("The requested chat does not exist.");
    }

    const chat = await prisma.orchestratorChat.update({
      where: { id: params.chatId },
      data:
        body.capUsd === null
          ? { costCapUsd: null, costCapSetBy: null, costCapSetAt: null }
          : {
              costCapUsd: body.capUsd,
              // Same bound as `compatibility.ts`: the operator gate proves AN
              // operator set this; the name is body-supplied and only
              // shape-checked, because a shared operator token carries no
              // per-human identity. Read this column as provenance, never as
              // proof of which human.
              costCapSetBy: confirmingPrincipal(
                (request.body as { principal?: string } | undefined)?.principal
              ),
              costCapSetAt: new Date(),
            },
      select: { costCapUsd: true, costCapSetBy: true, costCapSetAt: true },
    });

    // The response says what the new cap MEANS against today's spend, not just
    // that it was stored: an operator who sets $10 on a mission that has
    // already observed $12 needs to learn that here, not from the next
    // dispatch being refused.
    const reading = await readMissionCost(params.chatId);
    const verdict = evaluateCap(reading.cost, chat.costCapUsd);
    return {
      capUsd: chat.costCapUsd,
      capSetBy: chat.costCapSetBy,
      capSetAt: chat.costCapSetAt?.toISOString() ?? null,
      cost: reading.cost,
      refusesDispatch: capRefusesDispatch(verdict),
      summary: describeCapVerdict(verdict, reading.silentLanes),
    };
  });
}
