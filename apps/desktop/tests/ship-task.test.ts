import { describe, expect, it, vi } from "vitest";
import { fileShipGate, type ShipTaskInput } from "../src/lib/ship-task.js";

// The desktop `muon ship` filing spine (the `muon:shipTask` handler's body).
// Two properties matter more than the rest: every refusal is a REFUSAL with
// its own sentence, and this path can only ever FILE a gate — deciding it
// belongs to Review or Full Auto's standing consent, never to the filer.

function shipClient(overrides: Record<string, unknown> = {}) {
  return {
    getChat: vi.fn(async (chatId: string) => ({
      id: chatId,
      status: "active",
    })),
    getDispatchJob: vi.fn(async (jobId: string) => ({
      id: jobId,
      chatId: "chat-a",
      taskId: "task-1",
      vendor: "codex",
    })),
    requestApproval: vi.fn(async () => ({
      id: "approval-9",
      status: "pending",
    })),
    // NOT part of ShipGateClient — present only to prove it is never touched.
    resolveApproval: vi.fn(),
    ...overrides,
  };
}

const INPUT: ShipTaskInput = {
  jobId: "job-1",
  taskId: "task-1",
  requestedBy: "codex",
  kind: "merge",
  reason: "ship requested from MUON desktop: 2 files changed",
};

describe("fileShipGate", () => {
  it("files the merge gate with the job riding along, and returns pending", async () => {
    const client = shipClient();
    const result = await fileShipGate(client as never, "chat-a", INPUT);
    expect(result).toEqual({ approvalId: "approval-9", pending: true });
    expect(client.requestApproval).toHaveBeenCalledWith({
      taskId: "task-1",
      requestedBy: "codex",
      kind: "merge",
      reason: INPUT.reason,
      jobId: "job-1",
    });
  });

  it("NEVER decides the gate it files (one consent site)", async () => {
    const client = shipClient();
    await fileShipGate(client as never, "chat-a", INPUT);
    expect(client.resolveApproval).not.toHaveBeenCalled();
  });

  it("refuses any kind other than merge, before touching the brain", async () => {
    const client = shipClient();
    await expect(
      fileShipGate(client as never, "chat-a", {
        ...INPUT,
        kind: "command" as never,
      })
    ).rejects.toThrow(/only a merge gate/);
    expect(client.getDispatchJob).not.toHaveBeenCalled();
    expect(client.requestApproval).not.toHaveBeenCalled();
  });

  it("refuses a job owned by another chat", async () => {
    const client = shipClient({
      getDispatchJob: vi.fn(async () => ({
        id: "job-1",
        chatId: "chat-b",
        taskId: "task-1",
        vendor: "codex",
      })),
    });
    await expect(
      fileShipGate(client as never, "chat-a", INPUT)
    ).rejects.toThrow(/selected chat/);
    expect(client.requestApproval).not.toHaveBeenCalled();
  });

  it("refuses with no bound chat, a task mismatch, and a foreign lane attribution", async () => {
    await expect(
      fileShipGate(shipClient() as never, null, INPUT)
    ).rejects.toThrow(/Select a chat/);
    await expect(
      fileShipGate(shipClient() as never, "chat-a", {
        ...INPUT,
        taskId: "task-other",
      })
    ).rejects.toThrow(/does not belong to the dispatch/);
    // requestedBy must be the lane that RAN the work — a renderer cannot
    // attribute the gate to an arbitrary author.
    await expect(
      fileShipGate(shipClient() as never, "chat-a", {
        ...INPUT,
        requestedBy: "claude-code",
      })
    ).rejects.toThrow(/attributed to the lane/);
  });

  it("refuses an empty reason and bounds a runaway one at 300 chars", async () => {
    await expect(
      fileShipGate(shipClient() as never, "chat-a", { ...INPUT, reason: "  " })
    ).rejects.toThrow(/needs a reason/);
    const client = shipClient();
    await fileShipGate(client as never, "chat-a", {
      ...INPUT,
      reason: "x".repeat(1_000),
    });
    const call = client.requestApproval.mock.calls[0]![0] as { reason: string };
    expect(call.reason).toHaveLength(300);
  });

  it("aborts when the selection-stability fence throws — nothing is filed", async () => {
    const client = shipClient();
    await expect(
      fileShipGate(client as never, "chat-a", INPUT, () => {
        throw new Error("The selected chat changed before the gate was filed.");
      })
    ).rejects.toThrow(/selected chat changed/);
    expect(client.requestApproval).not.toHaveBeenCalled();
  });
});
