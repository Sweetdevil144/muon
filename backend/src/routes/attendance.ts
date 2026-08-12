import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  clampUnattendedHorizon,
  evaluateUnattendedHorizon,
} from "@muon/protocol";
import { requireOperator } from "../lib/auth.js";
import {
  daemonAttachState,
  isAttendingSurface,
  lastAttendingSurface,
  noteHumanPresent,
  ATTENDING_SURFACES,
} from "../lib/surface-attendance.js";
import {
  persistAttendance,
  readConfiguredHorizonMs,
  setConfiguredHorizonMs,
} from "../lib/unattended-horizon.js";

/**
 * ADR-0040 D3a — where a surface ASSERTS that a human is present.
 *
 * The whole point of this route existing at all: attendance used to be
 * inferred from operator-tier traffic, and that inference was wrong in both
 * directions (a desktop polling with every window shut read as attended; a
 * human at an attached terminal read as absent). A poll proves a process is
 * running. Only a surface can say a person is there, so only a surface does.
 *
 * OPERATOR TIER ONLY. An agent asserting human presence would be an agent
 * granting itself an unbounded runtime — the single most valuable lie
 * available on this surface.
 */
export async function registerAttendanceRoutes(app: FastifyInstance) {
  const presenceSchema = z.object({
    surface: z.string().min(1).max(32),
  });

  app.post("/", async (request) => {
    requireOperator(app, request);
    const body = presenceSchema.parse(request.body ?? {});
    if (!isAttendingSurface(body.surface)) {
      throw app.httpErrors.badRequest(
        `surface must be one of ${ATTENDING_SURFACES.join(", ")} — a surface MUON does not know cannot vouch for a human.`
      );
    }
    const now = Date.now();
    // Persist only when the clock actually MOVED. A focused desktop window
    // ticks on an interval; writing the database every tick would be a steady
    // write load for no added durability.
    if (noteHumanPresent(body.surface, now)) {
      await persistAttendance(now);
    }
    return { attended: true, surface: body.surface, at: now };
  });

  /** What the daemon currently believes, for an operator surface to render. */
  app.get("/", async (request) => {
    requireOperator(app, request);
    const now = Date.now();
    const state = daemonAttachState(now);
    const horizonMs = await readConfiguredHorizonMs();
    const verdict = evaluateUnattendedHorizon(state, horizonMs, now);
    return {
      attended: state.attached,
      lastAttendedAt: state.lastAttachedAt,
      lastSurface: lastAttendingSurface(),
      horizonMs,
      verdict,
    };
  });

  /**
   * WRITE the horizon. This is what makes "operator-configurable" true — until
   * it existed the only way to change the value was editing SQLite by hand,
   * which is not configuration, it is a workaround.
   */
  app.put("/horizon", async (request) => {
    requireOperator(app, request);
    const body = z
      .object({ horizonMs: z.number().finite() })
      .parse(request.body ?? {});
    const stored = await setConfiguredHorizonMs(body.horizonMs);
    return {
      horizonMs: stored,
      // Say so when the request was clamped, rather than silently storing
      // something other than what was asked for.
      clamped: stored !== clampUnattendedHorizon(body.horizonMs)
        ? false
        : stored !== body.horizonMs,
    };
  });
}
