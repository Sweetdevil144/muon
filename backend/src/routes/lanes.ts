import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/db.js";
import { availableLaneWhere } from "../lib/vendor-lanes.js";

export async function registerLaneRoutes(app: FastifyInstance) {
  // THE "what lanes exist" surface — CLI `lane list`, TUI, desktop presets, the
  // MCP dispatch lane lookup and the runner's own lane resolution all read it.
  // Scoped to the registry (vendor-lanes.ts), so a vendor MUON no longer names
  // stops being offered here even though its row is kept for history.
  app.get("/", async () => {
    const lanes = await prisma.lane.findMany({
      where: availableLaneWhere(),
      orderBy: { createdAt: "asc" },
    });

    return { lanes };
  });
}
