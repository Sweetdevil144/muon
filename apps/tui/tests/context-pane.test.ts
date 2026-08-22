import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient, PreEditView } from "@muon/client";
import { ContextPane } from "../src/shell/context-pane.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";

// ── ADR-0087 M6 — the pre-edit context pane, the last pane row ──────────────

const strip = (lines: string[]) =>
  lines
    .map((line) => line.replaceAll(/\u001b\[[0-9;]*m/g, "").replaceAll("\u001b", ""))
    .join("\n");

function view(over: Partial<PreEditView> = {}): PreEditView {
  return {
    phase: "ready",
    target: { module: "src/auth.ts" },
    targetLabel: "src/auth.ts",
    blastRadius: {
      modules: ["src/auth.ts", "src/session.ts"],
      symbols: ["src/auth.ts#login"],
      depth: 2,
      source: "code-graph",
      sourceLabel: "code-graph radius",
      degraded: false,
    },
    activity: [],
    activeLaneCount: 0,
    recentLaneCount: 0,
    onTargetLaneCount: 1,
    neighbourLaneCount: 0,
    hasLiveActivity: false,
    hasRecentActivity: false,
    hasOnTargetActivity: true,
    duplicateWork: [],
    duplicateWorkCount: 0,
    hasDuplicateWork: false,
    memories: [
      {
        note: { id: "n1", text: "sessions are server-side only" },
        onTarget: true,
        proximity: 1,
        proximityLabel: "on-target",
        kindLabel: "Decision",
        isDecision: true,
      },
      {
        note: { id: "n2", text: "a neighbour convention" },
        onTarget: false,
        proximity: 0.4,
        proximityLabel: "neighbor",
        kindLabel: "Convention",
        isDecision: false,
      },
    ],
    onTargetMemories: [],
    neighborMemories: [],
    warnings: [
      {
        kind: "contradicts",
        noteId: "n1",
        relatedNoteId: "n3",
        detail: "d",
        label: "a surfaced memory contradicts another on this anchor",
      },
    ],
    pendingProposals: [],
    hasGovernedMemory: true,
    hasWarnings: true,
    pendingCount: 2,
    coverage: null,
    notices: ["the gate looked and found 2 governed notes"],
    ...over,
  } as PreEditView;
}

describe("the context pane", () => {
  it("labels the radius source, orders on-target memory first, and renders the honest signals", () => {
    const text = strip(new ContextPane({ phase: "ready", view: view() }).render(240));
    expect(text).toContain("code-graph radius");
    expect(text).toContain("depth 2");
    expect(text).toContain("[Decision] sessions are server-side only");
    // On-target renders before the neighbour (the builder's order kept).
    expect(text.indexOf("sessions are server-side")).toBeLessThan(
      text.indexOf("a neighbour convention")
    );
    expect(text).toContain("1 other lane(s) on this exact target");
    expect(text).toContain("contradicts another on this anchor");
    expect(text).toContain("2 pending proposal(s)");
    expect(text).toContain("found 2 governed notes");
  });

  it("a degraded target-only radius says so; an error is a sanitized sentence", () => {
    const degraded = strip(
      new ContextPane({
        phase: "ready",
        view: view({
          blastRadius: {
            modules: ["src/auth.ts"],
            symbols: [],
            source: "target-only",
            sourceLabel: "no code-graph radius — target only",
            degraded: true,
          },
        }),
      }).render(240)
    );
    expect(degraded).toContain("no code-graph radius — target only");
    // RAW render (no strip helper): the sanitizer's job is removing the
    // ESC that ARMS a sequence — "[2J" without it is inert text.
    const rawError = new ContextPane({
      phase: "error",
      targetLabel: "src/x.ts",
      reason: "evil\u001b[2Jbrain unreachable",
    })
      .render(240)
      .join("\n");
    expect(rawError).toContain("brain unreachable");
    expect(rawError).not.toContain("\u001b[2J");
  });
});

describe("the desk flow", () => {
  const PREFIX = String.fromCodePoint(2);
  it("ctrl+b e opens the context form; submit runs ONE governed read (symbol vs module split) into the result surface", async () => {
    const preEditContext = vi.fn(async () => ({
      target: { symbol: "src/a.ts#fn" },
      blastRadius: { modules: [], symbols: [], source: "target-only" },
      memories: [],
      warnings: [],
      pendingProposals: [],
      crossAgent: { active: [], recent: [] },
    }));
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: { preEditContext } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 80, rows: 12 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    desk.handleKey(PREFIX);
    desk.handleKey("e");
    expect(desk.centreKind()).toBe("composer");
    for (const ch of "login") desk.handleKey(ch);
    desk.handleKey("\r");
    await vi.waitFor(() => expect(preEditContext).toHaveBeenCalled());
    // THE shared parseEditTarget rule: a bare name is a SYMBOL (the CLI's
    // own classification — an ad-hoc split disagreed and missed
    // symbol-anchored memory); the workspace fence rides the read.
    expect(preEditContext).toHaveBeenCalledWith({
      symbol: "login",
      workspace: "/repo",
    });
    await vi.waitFor(() => expect(desk.centreKind()).toBe("context"));
  });
});
