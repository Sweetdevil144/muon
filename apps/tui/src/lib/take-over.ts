import type { LaneSession } from "@muon/client";
import { isVendorId } from "@muon/client/vendors";
import { takeOverArgv } from "@muon/core";

/**
 * The exact argv a HUMAN types to continue a session in the vendor CLI itself.
 *
 * WAVE D: a TOTAL `Record<VendorId, …>`, so a new vendor must state whether it
 * has a take-over command; `null` is the statement, not an omission.
 *
 * This stays per-vendor DATA rather than a registry field on purpose
 * (ADR-0022 §6.1): the resume argv is vendor lore with three different shapes
 * across three vendors, and a generic "argv template" field in the registry is
 * exactly the thing a profile patch could later widen.
 *
 * It is also NOT gated on `session.canResume`. That boolean is about whether
 * MUON drives a resume; this is a string MUON prints for a human to run in their
 * own terminal, which grants MUON nothing and is why Cursor has one despite
 * `canResume: false`.
 */

/**
 * Take-over affordance (WIKI §8.1): hand the human the exact native command
 * to continue an agent session in the vendor tool.
 */
export function takeOverCommand(session: LaneSession): string | null {
  const laneKey = session.lane?.key ?? session.laneId;
  if (!session.vendorSessionId || !isVendorId(laneKey)) {
    return null;
  }
  // ADR-0030: the argv itself lives in @muon/core (one home; the CLI's
  // `muon session take-over` prints the SAME string).
  return takeOverArgv(laneKey, session.vendorSessionId);
}

export function latestTakeOver(sessions: LaneSession[]): {
  session: LaneSession;
  command: string;
} | null {
  for (const session of sessions) {
    const command = takeOverCommand(session);
    if (command) {
      return { session, command };
    }
  }
  return null;
}

/**
 * ADR-0030's round trip, as the TUI needs it.
 *
 * `latestTakeOver` finds a session with a NATIVE resume command, which is the
 * right pick for take-over — the whole point is handing the human a command to
 * run. `latestOwnedByHuman` is its counterpart for RETURN, and it deliberately
 * does not require a native command: a session can be human-owned with no argv
 * (the CLI takes those over by explicit id, and the governed transcript stays
 * the record), and such a session must still be returnable or ownership is
 * stuck at `human` with no way back from this surface.
 */
export function latestOwnedByHuman(
  sessions: LaneSession[]
): LaneSession | null {
  return sessions.find((session) => session.owner === "human") ?? null;
}
