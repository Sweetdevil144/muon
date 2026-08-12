import { describe, expect, it } from "vitest";
import type { LaneEvent } from "@muon/protocol";
import {
  createMemoryToolEvidenceCollector,
  groundMemoryToolEvidence,
} from "../src/memory-tool-evidence.js";

function toolEvent(input: {
  phase: string;
  itemId: string;
  tool?: string;
  paths?: string[];
  fileMutation?: boolean;
  detail?: Record<string, unknown>;
}): LaneEvent {
  return {
    id: `${input.itemId}-${input.phase}`,
    laneId: "lane-1",
    taskId: "task-1",
    kind: input.phase === "failed" ? "task.blocked" : "task.progress",
    message: `Edit ${input.phase}`,
    timestamp: "2026-08-01T00:00:00.000Z",
    metadata: {
      controlPlane: true,
      toolActivity: {
        provider: "claude-code",
        phase: input.phase,
        itemId: input.itemId,
        tool: input.tool ?? "Edit",
        ...(input.paths ? { paths: input.paths } : {}),
        ...(input.fileMutation ? { fileMutation: true } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
      },
    },
  };
}

describe("memory tool evidence", () => {
  it("joins started args to a completed mutation and redacts before retention", () => {
    const collector = createMemoryToolEvidenceCollector();
    collector.observe(
      toolEvent({
        phase: "started",
        itemId: "edit-1",
        paths: ["src/auth.ts"],
        fileMutation: true,
        detail: { args: "file_path: src/auth.ts\ntoken=sk-secret-value" },
      }),
    );
    collector.observe(
      toolEvent({
        phase: "completed",
        itemId: "edit-1",
        detail: { result: "updated" },
      }),
    );

    const [observation] = collector.snapshot();
    expect(observation).toMatchObject({
      itemId: "edit-1",
      phase: "completed",
      paths: ["src/auth.ts"],
      detail: { result: "updated" },
    });
    expect(observation!.detail!.args).not.toContain("sk-secret-value");
  });

  it("does not treat approval or start as proof that a write happened", () => {
    const collector = createMemoryToolEvidenceCollector();
    collector.observe(
      toolEvent({
        phase: "started",
        itemId: "edit-pending",
        paths: ["src/pending.ts"],
        fileMutation: true,
      }),
    );
    collector.observe(
      toolEvent({
        phase: "approved",
        itemId: "edit-pending",
        paths: ["src/pending.ts"],
        fileMutation: true,
      }),
    );
    expect(collector.snapshot()).toEqual([]);
  });

  it("keeps args from a completed-only Codex file-change event", () => {
    const collector = createMemoryToolEvidenceCollector();
    collector.observe(
      toolEvent({
        phase: "completed",
        itemId: "codex-change-1",
        tool: "Codex file change",
        paths: ["src/codex.ts"],
        fileMutation: true,
        detail: { args: "path: src/codex.ts\nkind: update" },
      }),
    );
    expect(collector.snapshot()[0]?.detail?.args).toContain("src/codex.ts");
  });

  it("requires containment and exact git-changed-file agreement", () => {
    const evidence = groundMemoryToolEvidence({
      worktreeCwd: "/repo/worktree",
      changedFiles: ["src/real.ts", "src/failed.ts"],
      observations: [
        {
          provider: "codex",
          tool: "Codex file change",
          phase: "completed",
          paths: ["src/real.ts", "src/not-changed.ts", "../escape.ts"],
          detail: { args: "changes: src/real.ts" },
        },
        {
          provider: "claude-code",
          tool: "Edit",
          phase: "failed",
          paths: ["/repo/worktree/src/failed.ts"],
          detail: { result: "partial write then failure" },
        },
      ],
    });

    expect(evidence).toEqual([
      {
        tool: "Codex file change",
        outcome: "completed",
        modules: ["src/real.ts"],
        args: "changes: src/real.ts",
      },
      {
        tool: "Edit",
        outcome: "failed",
        modules: ["src/failed.ts"],
        result: "partial write then failure",
      },
    ]);
  });
});
