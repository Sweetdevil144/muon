import { describe, expect, it } from "vitest";
import type {
  DispatchJobRecord,
  OrchestratorChatRecord,
} from "@muon/client";
import { selectWorkspaceReviewTargets } from "../src/renderer/lib/workspace-review-state.js";

describe("workspace review targets", () => {
  it("selects one root review job per chat without crossing chat scope", () => {
    const chats = [
      { id: "chat-a", taskId: "task-a" },
      { id: "chat-b", taskId: "task-b" },
    ] as OrchestratorChatRecord[];
    const jobs = [
      {
        id: "child-a",
        chatId: "chat-a",
        taskId: "task-a",
        status: "running",
        capabilityMode: "delegate",
      },
      {
        id: "root-a",
        chatId: "chat-a",
        taskId: "task-a",
        status: "done",
        capabilityMode: "orchestrator",
      },
      {
        id: "root-b",
        chatId: "chat-b",
        taskId: "task-b",
        status: "queued",
        capabilityMode: "orchestrator",
      },
      {
        id: "other",
        chatId: "chat-other",
        taskId: "task-b",
        status: "running",
        capabilityMode: "orchestrator",
      },
    ] as DispatchJobRecord[];

    expect(selectWorkspaceReviewTargets(chats, jobs)).toEqual([
      { chatId: "chat-a", jobId: "root-a", status: "done" },
      { chatId: "chat-b", jobId: "root-b", status: "queued" },
    ]);
  });
});
