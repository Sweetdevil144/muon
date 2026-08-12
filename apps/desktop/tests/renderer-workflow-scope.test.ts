import { describe, expect, it, vi } from "vitest";
import { requireRendererWorkflowRun } from "../src/lib/renderer-workflow-scope.js";

describe("requireRendererWorkflowRun", () => {
  it("accepts only a run owned by the selected chat", async () => {
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getWorkflowRun: vi.fn(async () => ({
        run: { id: "run-a", chatId: "chat-a" },
        tasks: [],
      })),
    };

    await expect(
      requireRendererWorkflowRun(client as never, "chat-a", "run-a")
    ).resolves.toEqual(expect.objectContaining({ id: "run-a" }));
  });

  it("rejects an unscoped or foreign run", async () => {
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getWorkflowRun: vi.fn(async () => ({
        run: { id: "run-b", chatId: "chat-b" },
        tasks: [],
      })),
    };

    await expect(
      requireRendererWorkflowRun(client as never, null, "run-b")
    ).rejects.toThrow(/Select a chat/);
    await expect(
      requireRendererWorkflowRun(client as never, "chat-a", "run-b")
    ).rejects.toThrow(/selected chat/);
  });
});
