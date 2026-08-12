import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { workflowDefinitionSchema } from "@muon/protocol";
import { authoringPrincipal } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { requestAuditColumns } from "../lib/event-audit.js";

const keyParamsSchema = z.object({ key: z.string().min(1) });

const upsertTemplateSchema = z.object({
  name: z.string().min(2),
  definition: workflowDefinitionSchema,
  createdBy: z.string().min(2).default("human"),
});

export async function registerWorkflowTemplateRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const templates = await prisma.workflowTemplate.findMany({
      orderBy: { key: "asc" },
    });
    return { templates };
  });

  app.get("/:key", async (request) => {
    const params = keyParamsSchema.parse(request.params);
    const template = await prisma.workflowTemplate.findUnique({
      where: { key: params.key },
    });
    if (!template) {
      throw app.httpErrors.notFound(
        "The requested workflow template does not exist."
      );
    }
    return { template };
  });

  app.put("/:key", async (request) => {
    const params = keyParamsSchema.parse(request.params);
    const payload = upsertTemplateSchema.parse(request.body);
    // PROVENANCE FROM AUTH (P3-A / closes F5, the H2 forgery class): `createdBy`
    // is derived from the authenticated tier, not the free-form body, an
    // agent-tier caller claiming "human:*" is downgraded to the agent principal,
    // so it cannot stamp a forged human author on a workflow template.
    const createdBy = authoringPrincipal(request.tier, payload.createdBy);

    const template = await prisma.workflowTemplate.upsert({
      where: { key: params.key },
      create: {
        key: params.key,
        name: payload.name,
        definition: payload.definition as Prisma.InputJsonValue,
        createdBy,
      },
      update: {
        name: payload.name,
        definition: payload.definition as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });

    // Provenance: template changes are ledger events too.
    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: `workflow-template:${params.key}`,
        kind: "workflow.template.updated",
        message: `workflow template '${params.key}' updated (v${template.version})`,
        metadata: {
          template: params.key,
          version: template.version,
        } as Prisma.InputJsonValue,
      },
    });

    return { template };
  });
}
