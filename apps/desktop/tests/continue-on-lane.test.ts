import { describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord, HandoffDetail, TaskDetail } from "@muon/client";
import {
  continueOnLane,
  type ContinueOnLaneClient,
} from "../src/lib/continue-on-lane.js";

/**
 * H12 — the desktop half of one-gesture continue-on-lane, tested where the
 * decisions live (no Electron, no window).
 *
 * The claims that matter:
 *   * a continuation CITES the packet it was seeded from (`repairOf` — the
 *     0083 verb; the server derives the citation and composes the block),
 *     which is the only thing that makes the successor's report checkable;
 *   * a refusal reaches the operator in the COMPOSER'S OWN WORDS — a desk-local
 *     paraphrase is how the desk starts telling a different story from the CLI
 *     about the same machine;
 *   * the gesture is POWERLESS: it files an ordinary dispatch and nothing else.
 */

const PACKET = {
  taskGoal: "Cap the retries in charge()",
  whatChanged: "charge() now stops after 3 attempts",
  whatFailed: "nothing",
  nextLaneRequest: "Write the regression test for the ceiling",
  commandsRun: ["npm test"],
  checksStatus: ["tests: pass"],
  openQuestions: ["30s or 60s?"],
  provenance: { lane: "codex", createdAt: "2026-08-17T08:00:00.000Z" },
  changedFiles: ["src/pay/charge.ts"],
  degraded: { flag: false, reasons: [] },
};

function handoff(overrides: Partial<HandoffDetail> = {}): HandoffDetail {
  return {
    id: "handoff-typed",
    packetTitle: "Capped the retries",
    packetBody: "…",
    packetJson: PACKET,
    status: "delivered",
    createdAt: "2026-08-17T08:02:00.000Z",
    ...overrides,
  };
}

function taskDetail(handoffs: HandoffDetail[]): TaskDetail {
  return {
    id: "task-1",
    title: "Cap the retries",
    description: "",
    status: "in_progress",
    priority: "normal",
    createdAt: "2026-08-17T08:00:00.000Z",
    updatedAt: "2026-08-17T08:02:00.000Z",
    assignments: [],
    handoffs,
    approvals: [],
  };
}

function stubClient(
  handoffs: HandoffDetail[],
  enqueue = vi.fn(
    async () => ({ id: "job-successor" }) as unknown as DispatchJobRecord
  ),
  /** The chat's OWN mission task — what the route rebinds a chat job to. */
  chat: { id: string; status: string; taskId: string | null } = {
    id: "chat-1",
    status: "active",
    taskId: "task-1",
  }
): { client: ContinueOnLaneClient; enqueue: typeof enqueue } {
  return {
    client: {
      getChat: async () => chat,
      getTaskDetail: async () => taskDetail(handoffs),
      enqueueDispatch: enqueue,
    } as unknown as ContinueOnLaneClient,
    enqueue,
  };
}

describe("H12 — continue-on-lane files this mission's next turn, citing its packet", () => {
  it("seeds the successor from the newest typed packet and cites it", async () => {
    const { client, enqueue } = stubClient([handoff()]);
    const result = await continueOnLane(
      client,
      { taskId: "task-1", chatId: "chat-1", vendor: "claude-code" },
      ["claude-code", "codex"]
    );

    expect(result).toEqual({
      ok: true,
      jobId: "job-successor",
      packetId: "handoff-typed",
      vendor: "claude-code",
    });
    const sent = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    // THE citation. Without it the successor is a new mission in the old one's
    // coat, and nothing downstream can check its report against a source.
    expect(sent.repairOf).toBe("handoff-typed");
    expect(sent.vendor).toBe("claude-code");
    expect(sent.taskId).toBe("task-1");
    expect(sent.chatId).toBe("chat-1");
    // 0083 A2: the packet id rides the TYPED verb; the SERVER's composed
    // block names it in the brief — this client brief points at
    // handoff_read and quotes nothing.
    expect(String(sent.brief)).toContain("handoff_read");
    expect(String(sent.brief)).not.toContain("handoff-typed");
    // A HUMAN pressed this. Without the stamp the route's default records the
    // press as `orchestrator` — an agent's act in the audit trail.
    expect(sent.dispatchedBy).toBe("operator");
  });

  it("REFUSES when the dock's task is not the mission task the route binds to", async () => {
    // The route overwrites a chat dispatch's task with `chat.taskId`
    // (backend/src/routes/dispatch.ts). Filing anyway would attach the packet's
    // citation to a job about a DIFFERENT task — "citing packet X" printed over
    // work that is not X's. Fail closed instead.
    const { client, enqueue } = stubClient([handoff()], undefined, {
      id: "chat-1",
      status: "active",
      taskId: "task-mission-root",
    });
    const result = await continueOnLane(
      client,
      { taskId: "task-1", chatId: "chat-1", vendor: "codex" },
      ["codex"]
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("task-1");
    expect(result.reason).toContain("task-mission-root");
    expect(result.reason).toMatch(/cite a packet from a task it is not working on/i);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("asks for no authority: no role, no budget, no gate, no action", async () => {
    const { client, enqueue } = stubClient([handoff()]);
    await continueOnLane(
      client,
      { taskId: "task-1", vendor: "codex" },
      ["codex"]
    );
    const sent = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    for (const widening of [
      "role",
      "maxWallMs",
      "maxDescendantWallMs",
      "maxIterations",
      "gateApprovalId",
      "egressOptIn",
      "action",
    ]) {
      expect(sent[widening]).toBeUndefined();
    }
    expect(sent.kind).toBe("oneshot");
    // HONESTY BOUND on this test, so nobody reads it as more than it is: it
    // proves the DESK asked for no authority. It cannot prove the successor
    // received none — naming `chatId` (which the packet-citation guard
    // requires) makes the route file a chat ROOT with the mission's standard
    // turn budget and delegation allowance. That is stated in the section's
    // copy rather than denied here.
  });

  it("repeats the composer's readiness refusal verbatim and dispatches nothing", async () => {
    const { client, enqueue } = stubClient([handoff()]);
    const result = await continueOnLane(
      client,
      { taskId: "task-1", vendor: "codex" },
      ["claude-code"]
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // The vendor is named and the fix is named — the preflight's own framing.
    expect(result.reason).toContain("codex");
    expect(result.reason).toMatch(/did not report dispatch-ready/i);
    expect(result.reason).toMatch(/doctor/i);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses when no typed packet exists — a prose row seeds nothing", async () => {
    const { client, enqueue } = stubClient([
      handoff({ id: "handoff-prose", packetJson: undefined }),
    ]);
    const result = await continueOnLane(
      client,
      { taskId: "task-1", vendor: "codex" },
      ["codex"]
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toMatch(/no typed wrap packet/i);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("unreadable readiness is not 'no lane is ready': the check is skipped, not failed", async () => {
    // `undefined` = the probe could not answer. Refusing here would be the desk
    // asserting something it did not observe; the dispatch route decides.
    const { client, enqueue } = stubClient([handoff()]);
    const result = await continueOnLane(
      client,
      { taskId: "task-1", vendor: "codex" },
      undefined
    );

    expect(result.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("an EMPTY ready set is a genuine 'nothing is ready' and does refuse", async () => {
    const { client, enqueue } = stubClient([handoff()]);
    const result = await continueOnLane(
      client,
      { taskId: "task-1", vendor: "codex" },
      []
    );

    expect(result.ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a mission switch between the read and the write aborts the dispatch", async () => {
    const { client, enqueue } = stubClient([handoff()]);
    await expect(
      continueOnLane(client, { taskId: "task-1", vendor: "codex" }, ["codex"], () => {
        throw new Error("The selected mission changed before the continuation was filed.");
      })
    ).rejects.toThrow(/selected mission changed/i);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("names the lane it needs rather than dispatching a blank vendor", async () => {
    const { client, enqueue } = stubClient([handoff()]);
    const result = await continueOnLane(
      client,
      { taskId: "task-1", vendor: "  " },
      ["codex"]
    );
    expect(result.ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
