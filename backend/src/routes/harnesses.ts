import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { harnessConfigSchema } from "@muon/protocol";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { requestAuditColumns } from "../lib/event-audit.js";

const keyParamsSchema = z.object({ key: z.string().min(1) });

const upsertHarnessSchema = z.object({
  name: z.string().min(2),
  config: harnessConfigSchema,
  createdBy: z.string().min(2).default("human"),
});

export async function registerHarnessRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const harnesses = await prisma.harness.findMany({ orderBy: { key: "asc" } });
    return { harnesses };
  });

  app.get("/:key", async (request) => {
    const params = keyParamsSchema.parse(request.params);
    const harness = await prisma.harness.findUnique({
      where: { key: params.key },
    });
    if (!harness) {
      throw app.httpErrors.notFound("The requested harness does not exist.");
    }
    return { harness };
  });

  app.put("/:key", async (request) => {
    // GOVERN (P3-A / closes C2): a harness config carries executable command
    // specs, so defining one is an operator-tier act. A dispatched sub-agent
    // (agent tier) is rejected 403, it can no longer inject an arbitrary
    // command into the crew by writing a harness.
    requireOperator(app, request);
    const params = keyParamsSchema.parse(request.params);
    const payload = upsertHarnessSchema.parse(request.body);

    const harness = await prisma.harness.upsert({
      where: { key: params.key },
      create: {
        key: params.key,
        name: payload.name,
        config: payload.config as Prisma.InputJsonValue,
        createdBy: payload.createdBy,
      },
      update: {
        name: payload.name,
        config: payload.config as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });

    // Provenance: harness changes are ledger events too.
    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: `harness:${params.key}`,
        kind: "harness.updated",
        message: `harness '${params.key}' updated (v${harness.version})`,
        metadata: {
          harness: params.key,
          version: harness.version,
        } as Prisma.InputJsonValue,
      },
    });

    return { harness };
  });
}
