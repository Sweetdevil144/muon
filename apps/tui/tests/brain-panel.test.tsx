import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  buildConvergencePreflight,
  buildPreEditView,
  type PreEditActivity,
  type PreEditContext,
  type PreEditMemory,
} from "@muon/client";
import { BrainPanel } from "../src/components/BrainPanel.js";

const contextFixture: PreEditContext = {
  target: {
    module: "src/auth/guard.ts",
    symbol: "src/auth/guard.ts#authorize",
  },
  blastRadius: {
    modules: ["src/auth/guard.ts", "src/auth/session.ts"],
    symbols: ["src/auth/guard.ts#authorize"],
    depth: 1,
    source: "provided",
  },
  memories: [],
  warnings: [],
  pendingProposals: [],
  activity: [],
  duplicateWork: [],
};

function renderFrame(
  context: PreEditContext,
  options: {
    preflight?: ReturnType<typeof buildConvergencePreflight>;
    selectedProposalIndex?: number;
    proposalText?: Record<string, string | undefined>;
  } = {}
): string {
  const view = buildPreEditView(context);
  const { lastFrame } = render(
    <BrainPanel
      view={view}
      preflight={options.preflight}
      selectedProposalIndex={options.selectedProposalIndex ?? 0}
      proposalText={options.proposalText ?? {}}
    />
  );
  return lastFrame() ?? "";
}

function activity(
  index: number,
  patch: Partial<PreEditActivity> = {}
): PreEditActivity {
  return {
    laneId: `lane-${index}`,
    vendor: "codex",
    taskId: `task-${index}`,
    jobId: `job-${index}`,
    kind: "editing",
    anchor: `src/auth/neighbour-${index}.ts`,
    anchorKind: "module",
    at: `2026-07-14T00:00:0${index}.000Z`,
    state: "live",
    onSymbol: false,
    onTarget: false,
    proximity: 0.5,
    ...patch,
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function governedMemory(
  id: string,
  text: string,
  overrides: Partial<PreEditMemory> = {}
): PreEditMemory {
  return {
    id,
    kind: "decision",
    text,
    taskId: null,
    laneId: null,
    modules: ["src/auth/guard.ts"],
    topics: [],
    symbols: [],
    trust: "high",
    confirmed: true,
    stale: false,
    status: "active",
    createdBy: "human:reviewer",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    proximity: 1,
    onTarget: true,
    onSymbol: false,
    ...overrides,
  };
}

describe("TUI BrainPanel", () => {
  it("renders the shared four-section order and concise posture", () => {
    const view = buildPreEditView(contextFixture);
    const preflight = buildConvergencePreflight({
      view,
      intent: { vendor: "codex", action: "model" },
    });
    const frame = renderFrame(contextFixture, { preflight });

    const intentIndex = frame.indexOf("INTENT");
    const evidenceIndex = frame.indexOf("EVIDENCE");
    const coordinationIndex = frame.indexOf("COORDINATION");
    const authorityIndex = frame.indexOf("AUTHORITY");

    expect(intentIndex).toBeGreaterThanOrEqual(0);
    expect(intentIndex).toBeLessThan(evidenceIndex);
    expect(evidenceIndex).toBeLessThan(coordinationIndex);
    expect(coordinationIndex).toBeLessThan(authorityIndex);
    expect(frame).toContain("Preflight clear");
    expect(frame).toContain("/model");
  });

  it("caps module and symbol evidence separately, preserving the target symbol", () => {
    const context: PreEditContext = {
      ...contextFixture,
      blastRadius: {
        modules: [
          "src/auth/guard.ts",
          "src/auth/session.ts",
          "src/auth/policy.ts",
          "src/auth/token.ts",
          "src/auth/audit.ts",
          "src/auth/claims.ts",
          "src/auth/roles.ts",
          "src/auth/scopes.ts",
        ],
        symbols: [
          "src/auth/session.ts#loadSession",
          "src/auth/policy.ts#evaluate",
          "src/auth/token.ts#verify",
          "src/auth/audit.ts#record",
          "src/auth/claims.ts#parse",
          "src/auth/roles.ts#resolve",
          "src/auth/scopes.ts#allows",
          "src/auth/guard.ts#authorize",
        ],
        depth: 2,
        source: "provided",
      },
    };

    const frame = renderFrame(context);

    expect(frame).toContain("module: src/auth/session.ts");
    expect(frame).toContain("symbol: src/auth/guard.ts#authorize");
    expect(frame).toContain("… 2 more module coordinates omitted");
    expect(frame).toContain("… 2 more symbol coordinates omitted");
  });

  it("prioritizes exact-symbol governed evidence before capped module rows", () => {
    const moduleMemories = Array.from({ length: 7 }, (_, index) =>
      governedMemory(
        `module-memory-${index + 1}`,
        `module governed memory ${index + 1}`
      )
    );
    const context: PreEditContext = {
      ...contextFixture,
      memories: [
        ...moduleMemories,
        governedMemory(
          "exact-symbol-memory",
          "exact-symbol governed memory",
          {
            symbols: ["src/auth/guard.ts#authorize"],
            onSymbol: true,
          }
        ),
      ],
    };

    const frame = renderFrame(context);
    const exactIndex = frame.indexOf("exact-symbol governed memory");
    const moduleIndexes = Array.from({ length: 5 }, (_, index) =>
      frame.indexOf(`module governed memory ${index + 1}`)
    );

    expect(exactIndex).toBeGreaterThanOrEqual(0);
    expect(exactIndex).toBeLessThan(moduleIndexes[0]!);
    for (let index = 1; index < moduleIndexes.length; index += 1) {
      expect(moduleIndexes[index - 1]).toBeLessThan(moduleIndexes[index]!);
    }
    expect(frame).not.toContain("module governed memory 6");
    expect(frame).not.toContain("module governed memory 7");
    expect(frame).toContain("… 2 more evidence rows omitted");
  });

  it("prioritizes warning collisions and discloses omitted coordination rows", () => {
    const context: PreEditContext = {
      ...contextFixture,
      activity: [
        ...Array.from({ length: 7 }, (_, index) => activity(index)),
        activity(7, {
          anchor: "src/auth/guard.ts#authorize",
          anchorKind: "symbol",
          onSymbol: true,
          onTarget: true,
          proximity: 1,
        }),
      ],
      duplicateWork: [
        {
          jobId: "job-duplicate",
          taskId: "task-duplicate",
          vendor: "claude-code",
          similarity: 0.92,
          state: "live",
        },
      ],
    };

    const frame = renderFrame(context);

    expect(frame).toContain("src/auth/guard.ts#authorize");
    expect(frame).toContain("job job-duplicate");
    expect(frame).toContain("… 3 more coordination rows omitted");
    expect(frame).not.toContain("src/auth/neighbour-6.ts");
  });

  it("builds the shared preflight when the App call site omits it", () => {
    const frame = renderFrame(contextFixture);
    const postureIndex = frame.indexOf("Preflight clear");
    const actionIndex = frame.indexOf("Proceed with the edit");

    expect(frame).toContain("Preflight clear");
    expect(actionIndex).toBeGreaterThan(postureIndex);
    expect(frame).toContain(
      "No overlapping work or pending review was found"
    );
    expect(frame).toContain("principal:human");
    expect(frame).not.toContain("principal:not-supplied");
    expect(frame).toContain("INTENT");
    expect(frame).toContain("EVIDENCE");
    expect(frame).toContain("COORDINATION");
    expect(frame).toContain("AUTHORITY");
  });

  it("renders proposal summaries once while retaining warnings and controls", () => {
    const context: PreEditContext = {
      ...contextFixture,
      warnings: [
        {
          kind: "contradicts",
          noteId: "memory-1",
          relatedNoteId: "memory-2",
          detail: "Confirmed contradiction remains visible.",
        },
      ],
      pendingProposals: [
        {
          proposalNoteId: "proposal-1",
          victimNoteId: "memory-1",
          modules: ["src/auth/guard.ts"],
          detail: "An unconfirmed proposal contests a governed decision.",
        },
      ],
    };

    const frame = renderFrame(context);

    expect(
      countOccurrences(frame, "A proposal contests trusted memory")
    ).toBe(1);
    expect(frame).toContain("Confirmed contradiction remains visible.");
    expect(frame).toContain("AUTHORITY (2)");
    expect(frame).toContain("principal:human");
    expect(frame).not.toContain("principal:not-supplied");
    expect(frame).toContain("v view text");
    expect(frame).toContain("c confirm");
    expect(frame).toContain("x reject");
  });

  it("preserves proposal selection, on-demand text, and keyboard controls", () => {
    const context: PreEditContext = {
      ...contextFixture,
      pendingProposals: [
        {
          proposalNoteId: "proposal-1",
          victimNoteId: "memory-1",
          modules: ["src/auth/guard.ts"],
          detail: "An unconfirmed proposal contests a governed decision.",
        },
      ],
    };

    const hiddenFrame = renderFrame(context);
    expect(hiddenFrame).toContain("› proposal-1 contests memory-1");
    expect(hiddenFrame).not.toContain("Human-requested proposal text");
    expect(hiddenFrame).toContain("press v to view before confirm/reject");

    const revealedFrame = renderFrame(context, {
      proposalText: {
        "proposal-1": "Human-requested proposal text",
      },
    });
    expect(revealedFrame).toContain("text: Human-requested proposal text");
    expect(revealedFrame).toContain("j/k select");
    expect(revealedFrame).toContain("v view text first");
    expect(revealedFrame).toContain("c confirm after view");
    expect(revealedFrame).toContain("x reject after view");
    expect(revealedFrame).toContain("r refresh");
    expect(revealedFrame).toContain("Esc close");
  });
});
