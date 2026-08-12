import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { policyProfileSchema } from "@muon/protocol";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { validateWorkspacePath } from "../lib/workspace.js";

// ── P0.4 slice 2: workspace policy profile residence ─────────────────────────
//
// The profile ledger mirrors the LaneProfile govern precedent: DEFINING policy
// is an operator-tier act (a dispatched sub-agent must never author the posture
// the next session runs under), while READING it is agent-tier (the runner
// sources the profile at execution). The always-ask fence is enforced at write
// time by the shipped strict schema — a profile that tries to `allow`
// network/merge/ship fails to parse, so no stored row can ever express it.
//
// Precedence at read: task-scoped row > workspace-scoped row > no row. A
// missing row means TODAY'S behavior exactly (every gate asks) — the reader
// returns `profile: null` and never substitutes a default.

const scopeQuerySchema = z.object({
  workspacePath: z.string().min(1),
  taskId: z.string().min(1).optional(),
});

const putBodySchema = z.object({
  workspacePath: z.string().min(1),
  taskId: z.string().min(1).optional(),
  profile: z.unknown(),
});

/**
 * Canonicalize a submitted workspacePath so writer and reader key identically,
 * or throw the route's 400 with the validator's reason.
 */
function canonicalWorkspacePath(app: FastifyInstance, input: string): string {
  const validation = validateWorkspacePath(input);
  if (!validation.ok) {
    throw app.httpErrors.badRequest(validation.reason);
  }
  return validation.path;
}

export async function registerPolicyProfileRoutes(app: FastifyInstance) {
  // Agent-tier readable: the runner resolves the effective profile at
  // execution. Task row beats workspace row beats null.
  app.get("/profile", async (request) => {
    const query = scopeQuerySchema.parse(request.query);
    const workspacePath = canonicalWorkspacePath(app, query.workspacePath);

    const taskRecord = query.taskId
      ? await prisma.workspacePolicyProfile.findUnique({
          where: {
            workspacePath_taskScope: {
              workspacePath,
              taskScope: query.taskId,
            },
          },
        })
      : null;
    const record =
      taskRecord ??
      (await prisma.workspacePolicyProfile.findUnique({
        where: {
          workspacePath_taskScope: { workspacePath, taskScope: "" },
        },
      }));

    return {
      profile: record?.profile ?? null,
      scope: record ? (record.taskScope ? "task" : "workspace") : null,
      version: record?.version ?? 0,
    };
  });

  app.put("/profile", async (request) => {
    // GOVERN: policy authorship is a human act. An agent-tier caller is 403'd —
    // otherwise a dispatched sub-agent could widen its own posture (the exact
    // blanket-authority failure P0.4 forbids).
    requireOperator(app, request);
    const body = putBodySchema.parse(request.body);
    const workspacePath = canonicalWorkspacePath(app, body.workspacePath);
    // The strict schema IS the fence: `allow` on network/merge/ship fails to
    // parse here (guardedPostureSchema), so it can never reach storage.
    const profile = policyProfileSchema.parse(body.profile);
    const taskScope = body.taskId ?? "";

    const record = await prisma.workspacePolicyProfile.upsert({
      where: { workspacePath_taskScope: { workspacePath, taskScope } },
      create: {
        workspacePath,
        taskScope,
        profile: profile as Prisma.InputJsonValue,
      },
      update: {
        profile: profile as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });

    return {
      profile: policyProfileSchema.parse(record.profile),
      scope: taskScope ? "task" : "workspace",
      version: record.version,
    };
  });

  // Removing a row degrades that workspace back to today's ask-everything —
  // never a lockout, never an auto-allow.
  app.delete("/profile", async (request) => {
    requireOperator(app, request);
    const body = scopeQuerySchema.parse(request.body);
    const workspacePath = canonicalWorkspacePath(app, body.workspacePath);

    const result = await prisma.workspacePolicyProfile.deleteMany({
      where: { workspacePath, taskScope: body.taskId ?? "" },
    });

    return { deleted: result.count };
  });
}
