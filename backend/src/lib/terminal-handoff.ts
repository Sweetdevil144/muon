import { renderHandoffPacketMarkdown } from "@muon/core";
import type { HandoffPacket } from "@muon/protocol";
import type { prisma } from "./db.js";

/**
 * FILE THE TERMINAL HANDOFF. A finished child's typed packet has to become a
 * row the coordinator can read.
 *
 * WHY THIS EXISTS. `handoff_read(taskId)` reads `Task.handoffs`, and until this
 * function the ONLY writer of that table was the agent/CLI-facing
 * `POST /api/tasks/:taskId/handoffs` — which the dispatch path never calls. The
 * runner built a correct typed packet for every emitting terminal and stored it
 * on `DispatchJob.packetJson`, where nothing the orchestrator can reach ever
 * looked. In the founder's mission both children finished clean, both had a
 * fully parsed packet on their job row, and the Handoff table held ZERO rows
 * for the entire life of the brain — so the coordinator reported "typed handoff
 * packets were absent for both children (handoffCount 0)" and fell back to
 * reading stream prose, which is precisely the guessing a governance product
 * must not do.
 *
 * WHY IN THE TERMINAL TRANSACTION. The packet and the terminal status are one
 * fact. Filing afterwards would reintroduce a window where a job is `done` and
 * its handoff is missing — indistinguishable, to a reader, from "no work done".
 *
 * ABSENCE IS A RECORD, NOT A GAP. A terminal that emitted no packet (an
 * interrupted run, a packet build that failed) still files a row that SAYS the
 * packet is absent and why the row exists. `handoff_read` reports it as
 * `prose_only`; nothing is silently missing.
 */

/** The subset of the client this needs, so it works on `prisma` or a `tx`. */
type HandoffWriter = Pick<
  typeof prisma,
  "handoff" | "lane" | "dispatchJob" | "task"
>;

export type TerminalHandoffJob = {
  id: string;
  taskId: string;
  vendor: string;
  chatId?: string | null;
  parentJobId?: string | null;
  rootJobId?: string | null;
};

export type FiledTerminalHandoff = {
  id: string;
  taskId: string;
  fromLaneId: string;
  toLaneId: string;
  status: string;
  createdAt: Date;
};

/**
 * Auto-filed rows are provenance, not a queue. `pending` is what the dashboard
 * counts as "handoffs awaiting pickup", and a terminal record is not waiting on
 * anyone, so it gets its own value rather than inflating that number forever.
 */
const TERMINAL_HANDOFF_STATUS = "filed";

/**
 * A mission ROOT coordinator turn is not a handoff to anyone: its report is the
 * chat itself. Filing one row per turn on the chat's session task would also
 * push a real child's packet out of `handoff_read`'s bounded window, which is
 * the exact failure being fixed. Everything else — every governed child, and
 * every chat-less `muon dispatch` — files.
 */
function isMissionRoot(job: TerminalHandoffJob): boolean {
  return Boolean(job.chatId) && !job.parentJobId && !job.rootJobId;
}

function title(job: TerminalHandoffJob, toVendor: string, status: string): string {
  return `Terminal handoff: ${job.vendor} → ${toVendor} (job ${job.id.slice(
    0,
    8
  )}, ${status})`;
}

/**
 * The body written when a terminal emitted no typed packet. Server-authored
 * prose — it states MUON's own observation, never anything the vendor said.
 */
function absentPacketBody(job: TerminalHandoffJob, status: string): string {
  return [
    `## No typed handoff packet`,
    ``,
    `Dispatch job \`${job.id}\` (${job.vendor}) reached terminal status ` +
      `\`${status}\` without emitting a typed packet.`,
    ``,
    `MUON files this row so the absence is READABLE. An absent handoff is ` +
      `indistinguishable from "no work was done"; this one says which it is. ` +
      `An interrupted run emits no packet by design — there is no completed ` +
      `thought to report — so treat this as unverified work, not as evidence.`,
  ].join("\n");
}

/**
 * File the terminal handoff for one dispatch job. Returns the filed row (for
 * graph mirroring) or `undefined` when nothing was filed.
 *
 * Never throws for a resolvable-lane reason: the lanes are looked up BEFORE the
 * write, and a vendor with no lane row (impossible for a job that actually ran,
 * since the runner resolves its lane from the same table) simply files nothing
 * rather than aborting the terminal transaction it rides in.
 */
export async function fileTerminalHandoff(
  db: HandoffWriter,
  job: TerminalHandoffJob,
  packet: HandoffPacket | null,
  status: string
): Promise<FiledTerminalHandoff | undefined> {
  if (isMissionRoot(job)) {
    return undefined;
  }

  // Both foreign keys are checked BEFORE the insert. `Handoff` references Task
  // and Lane; `DispatchJob.taskId` does not, so a job can legitimately outlive
  // (or predate) its task row. A rejected insert here would abort the whole
  // terminal transaction and strand a finished job as `running` — the handoff
  // record is never worth that.
  const [fromLane, task] = await Promise.all([
    db.lane.findUnique({ where: { key: job.vendor }, select: { id: true, key: true } }),
    db.task.findUnique({ where: { id: job.taskId }, select: { id: true } }),
  ]);
  if (!fromLane || !task) {
    return undefined;
  }

  // The destination is whoever asked for the work: the coordinator that
  // dispatched this child. Same-vendor crews are ordinary (a claude-code
  // coordinator dispatching a claude-code implementer), so from === to is a
  // truthful outcome here and is allowed. The agent-facing POST route still
  // refuses a self-handoff — that rule stops an AGENT filing a meaningless one,
  // and this row is derived by the server from the stored lineage.
  const coordinatorJobId = job.parentJobId ?? job.rootJobId;
  const coordinator = coordinatorJobId
    ? await db.dispatchJob.findUnique({
        where: { id: coordinatorJobId },
        select: { vendor: true },
      })
    : null;
  const toLane =
    coordinator && coordinator.vendor !== job.vendor
      ? (await db.lane.findUnique({
          where: { key: coordinator.vendor },
          select: { id: true, key: true },
        })) ?? fromLane
      : fromLane;

  const filed = await db.handoff.create({
    data: {
      taskId: job.taskId,
      fromLaneId: fromLane.id,
      toLaneId: toLane.id,
      packetTitle: title(job, toLane.key, status),
      packetBody: packet
        ? renderHandoffPacketMarkdown(packet)
        : absentPacketBody(job, status),
      ...(packet ? { packetJson: packet } : {}),
      status: TERMINAL_HANDOFF_STATUS,
    },
    select: {
      id: true,
      taskId: true,
      fromLaneId: true,
      toLaneId: true,
      status: true,
      createdAt: true,
    },
  });
  return filed;
}
