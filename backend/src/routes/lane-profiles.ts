import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { laneProfileSchema } from "@muon/protocol";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { requestAuditColumns } from "../lib/event-audit.js";

const paramsSchema = z.object({ laneId: z.string().min(1) });

export async function registerLaneProfileRoutes(app: FastifyInstance) {
  app.get("/:laneId/profile", async (request) => {
    const params = paramsSchema.parse(request.params);

    const lane = await prisma.lane.findUnique({ where: { id: params.laneId } });
    if (!lane) {
      throw app.httpErrors.notFound("The requested lane does not exist.");
    }

    const record = await prisma.laneProfile.findUnique({
      where: { laneId: params.laneId },
    });

    return {
      profile: laneProfileSchema.parse(record?.config ?? {}),
      version: record?.version ?? 0,
    };
  });

  app.put("/:laneId/profile", async (request) => {
    // GOVERN (P3-A / closes F1, the SAME command-injection class as harnesses):
    // a lane profile carries mcpServers[].command/args, extraArgs (raw CLI flags
    // appended verbatim), env, rawConfig, and the guardrail knobs
    // permissionMode/sandbox. The runner loads this stored profile for every
    // dispatched job and the profile compiler SPAWNS those commands as the user,
    // so defining one is an operator-tier act. A dispatched sub-agent (agent tier)
    // is rejected 403; it can no longer plant a malicious command (or strip
    // permissions) that the next session in the lane executes.
    requireOperator(app, request);
    const params = paramsSchema.parse(request.params);
    const profile = laneProfileSchema.parse(request.body);

    const lane = await prisma.lane.findUnique({ where: { id: params.laneId } });
    if (!lane) {
      throw app.httpErrors.notFound("The requested lane does not exist.");
    }

    const record = await prisma.laneProfile.upsert({
      where: { laneId: params.laneId },
      create: {
        laneId: params.laneId,
        config: profile as Prisma.InputJsonValue,
      },
      update: {
        config: profile as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });

    // Provenance: configuration changes are ledger events too.
    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: params.laneId,
        taskId: "lane-config",
        kind: "lane.profile.updated",
        message: `lane profile updated (v${record.version})`,
        metadata: { laneProfile: true, version: record.version } as Prisma.InputJsonValue,
      },
    });

    return { profile: laneProfileSchema.parse(record.config), version: record.version };
  });
}
