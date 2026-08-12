import type { ApprovalRequest, MuonApiClient } from "@muon/client";
import type { ShipTaskResult } from "../shared/ipc.js";
import { requireRendererDispatchJob } from "./renderer-chat-scope.js";

/**
 * The desktop's `muon ship` — FILE the governed `kind:"merge"` approval for
 * one finished dispatch. Extracted from the `muon:shipTask` IPC handler so the
 * authorization spine is unit-testable without Electron (the same reason
 * terminal-workspace-resolver.ts exists).
 *
 * FILING ONLY. This function must never decide the gate it files: with gates
 * on the operator decides in Review, and under Full Auto the standing consent
 * decides it on the auto-approver's next poll — ONE consent site, like every
 * other gate. Its client surface deliberately does not include
 * `resolveApproval`, so a future edit that tried to auto-approve here would
 * not typecheck.
 */
export type ShipTaskInput = {
  jobId: string;
  taskId: string;
  requestedBy: string;
  kind: "merge";
  reason: string;
};

export type ShipGateClient = Pick<
  MuonApiClient,
  "getChat" | "getDispatchJob"
> & {
  requestApproval(input: {
    taskId: string;
    requestedBy: string;
    kind: "merge";
    reason: string;
    jobId: string;
  }): Promise<ApprovalRequest>;
};

const SHIP_REASON_MAX = 300;

export async function fileShipGate(
  client: ShipGateClient,
  boundChatId: string | null,
  input: ShipTaskInput,
  /**
   * Called just before the gate is filed; throw to abort. Main passes its
   * chat-selection-version check so an archive/switch race cannot file a gate
   * against a chat the window no longer shows.
   */
  assertSelectionStable: () => void = () => undefined
): Promise<ShipTaskResult> {
  if (!boundChatId) {
    throw new Error("Select a chat before landing a dispatch's work.");
  }
  // The renderer is untrusted: only the one governed kind exists here.
  if (input.kind !== "merge") {
    throw new Error("The desktop can file only a merge gate.");
  }
  const reason = input.reason?.trim().slice(0, SHIP_REASON_MAX);
  if (!reason) {
    throw new Error("A merge gate needs a reason for the audit record.");
  }
  const job = await requireRendererDispatchJob(client, boundChatId, input.jobId);
  if (job.taskId !== input.taskId) {
    throw new Error("That task does not belong to the dispatch being landed.");
  }
  // Attribution is not authority, but it must still be TRUE: the gate's
  // author is the lane that ran the work (lane keys are vendor ids), not
  // whatever string a renderer chose to send.
  if (input.requestedBy !== job.vendor) {
    throw new Error(
      "A merge gate is attributed to the lane that produced the work."
    );
  }
  assertSelectionStable();
  const approval = await client.requestApproval({
    taskId: input.taskId,
    requestedBy: input.requestedBy,
    kind: "merge",
    reason,
    jobId: input.jobId,
  });
  return { approvalId: approval.id, pending: true };
}
