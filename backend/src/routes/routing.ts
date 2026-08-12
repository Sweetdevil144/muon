import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { getGraph } from "../lib/graph.js";
import { availableLaneWhere } from "../lib/vendor-lanes.js";

export async function registerRoutingRoutes(app: FastifyInstance) {
  /**
   * Evidence-based lane recommendation. Returns ranked lanes with reasons;
   * assignment stays a separate, human-approved action.
   */
  app.get("/suggest", async (request) => {
    const query = z
      .object({
        taskId: z.string().min(1).optional(),
        // Pre-task routing (planning): score note-topic overlap against the
        // request text instead of a task's touched modules.
        text: z.string().min(3).optional(),
      })
      .parse(request.query);

    const [lanes, graphSuggestions] = await Promise.all([
      // A suggestion is an offer of work, so only lanes that still exist may be
      // ranked. Graph history for a retired lane is left alone; it simply has no
      // ledger row to be joined onto below.
      prisma.lane.findMany({ where: availableLaneWhere() }),
      getGraph()
        .suggestLanes(query.taskId, query.text)
        .catch(() => []),
    ]);

    const byLaneId = new Map(graphSuggestions.map((s) => [s.laneId, s]));

    // Every ledger lane appears even before it has graph history.
    const suggestions = lanes
      .map((lane) => {
        const known = byLaneId.get(lane.id);
        return (
          known ?? {
            laneId: lane.id,
            laneKey: lane.key,
            laneName: lane.name,
            score: 0.5,
            reason: "no history yet",
          }
        );
      })
      .sort((a, b) => b.score - a.score || a.laneName.localeCompare(b.laneName));

    return { suggestions };
  });
}
