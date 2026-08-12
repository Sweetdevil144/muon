import { classifyHandoffPacket } from "@muon/client/handoff-view";
import type { TaskHandoffPage } from "../shared/ipc.js";

/** Exactly the fields the projection reads, so a test needs no Prisma row. */
export type HandoffRow = {
  id: string;
  packetTitle: string;
  packetBody: string;
  /** Optional exactly as the route types it: absent is `prose_only`. */
  packetJson?: unknown;
  status: string;
  createdAt: string;
  fromLane?: { key: string } | null;
  toLane?: { key: string } | null;
};

/** Rows per page, matching `handoff_read`'s bound for agents. */
export const HANDOFF_PAGE_LIMIT = 20;
/** Changed files kept per packet, likewise. */
const CHANGED_FILES_LIMIT = 20;

/**
 * Project a task's handoffs for the desk: bounded, newest first, classified.
 *
 * Extracted from the IPC handler because the two decisions that live here are
 * exactly the ones that were wrong and untestable inside it (cubic):
 *
 *  - WHICH ROWS SURVIVE THE BOUND. The route returns handoffs OLDEST-FIRST.
 *    Taking the first 20 kept the oldest and reported the newest as "older
 *    handoffs not shown" — on a long-running task that hid the wrap the human
 *    had just watched, which is the only one they opened the panel for.
 *  - WHERE THE OMISSION LIVES. On the envelope, describing the collection,
 *    rather than stamped on whichever row happened to land last.
 *
 * The packet is UNTRUSTED agent JSON; classification never throws and a
 * failure to parse is reported as its own contract, never as "no packet".
 */
export function projectHandoffPage(
  handoffs: readonly HandoffRow[]
): TaskHandoffPage {
  const omitted = Math.max(0, handoffs.length - HANDOFF_PAGE_LIMIT);
  const newestFirst = handoffs.slice(-HANDOFF_PAGE_LIMIT).reverse();
  return {
    omitted,
    items: newestFirst.map((row) => {
      // ONE classifier, shared with handoff_read (MCP).
      const classified = classifyHandoffPacket(row.packetJson);
      return {
        id: row.id,
        packetTitle: row.packetTitle,
        packetBody: row.packetBody,
        contract: classified.contract,
        status: row.status,
        createdAt: row.createdAt,
        fromLane: row.fromLane?.key ?? null,
        toLane: row.toLane?.key ?? null,
        changedFiles:
          classified.packet?.changedFiles?.slice(0, CHANGED_FILES_LIMIT) ?? [],
        changedFilesOmitted: Math.max(
          0,
          (classified.packet?.changedFiles?.length ?? 0) - CHANGED_FILES_LIMIT
        ),
        // The packet's own vocabulary: a check has an OUTCOME
        // (passed / failed / error / skipped / passed-but-uncovering), not a
        // boolean. Collapsing it would erase exactly the states a reviewer
        // needs — "skipped" is not "passed".
        checks:
          classified.packet?.checks?.map((check) => ({
            name: check.name,
            outcome: check.outcome,
          })) ?? [],
        degradedReasons: classified.packet?.degraded?.reasons ?? [],
        diffVerified: classified.packet?.diffVerified ?? false,
      };
    }),
  };
}

/**
 * Read a task's handoffs for the desk — the two rules the IPC handler had to
 * remember, and got wrong (gitnexus-check on PR #42).
 *
 *  - A FAILED READ IS NOT AN ABSENCE. The handler wrapped the fetch in
 *    `.catch(() => null)` and returned an empty page, which the panel renders
 *    as "this session has not wrapped" — a definite claim about the work,
 *    manufactured from an unreachable brain. The panel's error branch already
 *    exists for exactly this and was tested; nothing could reach it.
 *
 *  - THE SELECTION CAN CHANGE ACROSS THE AWAIT. The neighbouring
 *    review-certification handler re-checks its binding after loading and this
 *    one did not, so a human switching sessions mid-read could be shown the
 *    previous session's wrap packets under the new session's name.
 *
 * `stillBound` is evaluated AFTER the read, against live state, which is why it
 * is a callback rather than a captured boolean.
 */
export async function readTaskHandoffPage(input: {
  read: () => Promise<{ handoffs: HandoffRow[] } | null>;
  stillBound: () => boolean;
}): Promise<TaskHandoffPage> {
  const detail = await input.read();
  if (!input.stillBound()) {
    throw new Error("The selected chat changed before the handoff loaded.");
  }
  // A brain that answers with no task at all is a genuine absence, not a
  // failure: the read resolved.
  if (!detail) return { items: [], omitted: 0 };
  return projectHandoffPage(detail.handoffs);
}
