import { buildContinuationDispatch } from "@muon/client";
import type { MuonApiClient } from "@muon/client";
import type { ContinueOnLaneResult } from "../shared/ipc.js";
import { requireActiveRendererChat } from "./renderer-chat-scope.js";

/**
 * H12 — the desktop half of one-gesture continue-on-lane.
 *
 * Extracted from the `muon:continueOnLane` IPC handler for the same reason
 * `ship-task.ts` exists: the interesting decisions (which packet seeds the
 * successor, which refusal the operator is shown, whether the selection is
 * still stable when the dispatch is filed) are testable without Electron.
 *
 * THREE THINGS THIS MUST NOT DO, stated so a later edit has to argue with them:
 *
 *  1. It must not compose the brief itself. `buildContinuationDispatch` in
 *     @muon/client is the ONE composer, and it lives there (not here) so a
 *     second surface can adopt it without a second contract. Measured
 *     2026-08-17: this desktop path is its ONLY caller — the TUI palette does
 *     not exist yet, and A12's MCP shape routes differently (a coordinator
 *     calls the `dispatch` tool with `sourcePacketId` and composes its own
 *     brief; the backend's citation guard is what fences it). Say "shared by
 *     construction", never "every surface routes through it".
 *  2. It must not rephrase a refusal. The composer's sentence names the missing
 *     thing ("no typed wrap packet…", "'codex' is not dispatch-ready…") and
 *     names the fix; a desk-local paraphrase is how a surface starts telling a
 *     different story from the CLI about the same machine.
 *  3. It must not ASK for anything extra. Its client surface is deliberately
 *     narrowed to the three methods it needs, so an edit that reached for
 *     `requestApproval` or `raiseDispatchBudget` here would not typecheck, and
 *     the plan's dispatch shape reaches `enqueueDispatch` with no role, no
 *     `maxWallMs`, no gate id and no action attached.
 *
 * ── WHAT THE SUCCESSOR ACTUALLY IS (do not describe it as anything else) ─────
 *
 * The plan carries `chatId`, and it MUST: the route's packet-citation guard
 * refuses a `sourcePacketId` whose task lives outside `dispatchFields.chatId`
 * (backend/src/routes/dispatch.ts), so a continuation with no chat cannot cite
 * the packet it is seeded from — and the citation is the whole point.
 *
 * Naming the chat has two consequences the UI copy has to tell the truth about
 * rather than paper over (found in adversarial review, 2026-08-17):
 *
 *  a. The successor is filed as this mission's CHAT ROOT — `capabilityMode:
 *     "orchestrator"`, the standard root turn budget, and the mission's normal
 *     delegation allowance. That is the SAME shape every turn in this mission
 *     already gets, and MUON's one-active-root rule means it cannot run beside
 *     the current turn. It is not a new tier, it is not a raised ceiling, and
 *     no approval is filed — but it is emphatically not "an ordinary worker
 *     dispatch", so nothing in this feature may say so.
 *  b. The route REBINDS the job's task to the chat's own (`dispatchFields.taskId
 *     = chat.taskId ?? chat.id`). Left alone, a continuation seeded from a
 *     sub-task's packet would land on a DIFFERENT task while the desk printed
 *     "citing packet <id>" — a citation that does not describe the job it is
 *     attached to. So this refuses that case outright instead of filing a job
 *     whose lineage is a lie. Fail-closed, and invisible in the ordinary case
 *     where the dock is showing the mission's own task.
 *
 * The ONE field this adds to the plan is `dispatchedBy: "operator"`, and it is
 * provenance rather than authority. The composer leaves it unset because it is
 * shared with the MCP verb, where the author IS a coordinator — but the route's
 * default is `"orchestrator"`, so an unstamped desktop press would be recorded
 * in the audit trail as an agent's act, which is simply false. Same stamp
 * `muon:resumeObjectiveLoop` already applies to its operator re-dispatch, and
 * it is not forgeable from here: the route re-derives the authoring principal
 * from the auth tier (`authoringPrincipal`), so this can only ever be as true
 * as the token main is holding.
 */
export type ContinueOnLaneInput = {
  taskId: string;
  chatId?: string;
  vendor: string;
};

export type ContinueOnLaneClient = Pick<
  MuonApiClient,
  "getChat" | "getTaskDetail" | "enqueueDispatch"
>;

export async function continueOnLane(
  client: ContinueOnLaneClient,
  input: ContinueOnLaneInput,
  /**
   * The caller's OWN dispatch-ready vendor set (main derives it from the same
   * readiness the state snapshot publishes). Passed to the composer so the
   * readiness verdict the operator is shown is the one MUON already computed,
   * never a second readiness model invented at the gesture.
   *
   * `undefined` means readiness could not be READ, which is not the same fact
   * as "no lane is ready" — it is forwarded as absent so the composer skips
   * the check and the dispatch route (un-cached, and the real authority)
   * answers instead. An empty ARRAY is a genuine "nothing is ready" and does
   * refuse.
   */
  readyVendors: string[] | undefined,
  /**
   * Called after the read and before the write; throw to abort. Main passes its
   * chat-selection-version check so a mission switch mid-flight cannot file a
   * continuation against the chat the window no longer shows.
   */
  assertSelectionStable: () => void = () => undefined
): Promise<ContinueOnLaneResult> {
  const vendor = input.vendor?.trim();
  if (!vendor) {
    return {
      ok: false,
      reason: "Name the lane to continue on before dispatching a successor.",
    };
  }
  // CITATION-vs-TASK COHERENCE (see (b) in the header). The route rebinds a
  // chat dispatch's task to the chat's own, so a continuation seeded from any
  // OTHER task's packet would be filed against a task the packet does not
  // describe. Refuse instead of shipping that mismatch: MUON must never print
  // "citing packet X" over a job that is not about X's task.
  if (input.chatId) {
    const chat = await requireActiveRendererChat(client, input.chatId);
    const missionTaskId = chat.taskId ?? chat.id;
    if (missionTaskId !== input.taskId) {
      return {
        ok: false,
        reason:
          `This dock is showing task '${input.taskId}', but continuing on a lane files this mission's next turn, which MUON binds to its own task '${missionTaskId}'. ` +
          "The successor would cite a packet from a task it is not working on, so it is refused. Continue from the mission's own review, or dispatch this task directly.",
      };
    }
  }
  const detail = await client.getTaskDetail(input.taskId);
  const plan = buildContinuationDispatch({
    taskId: input.taskId,
    chatId: input.chatId ?? null,
    vendor,
    handoffs: detail.handoffs,
    ...(readyVendors ? { readyVendors } : {}),
  });
  if (!plan.ok) {
    // VERBATIM. See (2) above.
    return { ok: false, reason: plan.reason };
  }
  assertSelectionStable();
  const job = await client.enqueueDispatch({
    ...plan.input,
    // A HUMAN pressed this. See the note above on why the stamp is here and
    // why it cannot be a forgery.
    dispatchedBy: "operator",
  });
  return {
    ok: true,
    jobId: job.id,
    packetId: plan.packetId,
    vendor: plan.input.vendor,
  };
}
