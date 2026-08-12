import { describe, expect, it, vi } from "vitest";
import { evasionPayloads, residualDanger } from "@muon/client";
import type { ApprovalRequest, MuonApiClient } from "@muon/client";
import { buildGateBand, renderGateBand } from "../src/shell/gate-band.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";

/**
 * THE ARRIVING GATE — the product moment.
 *
 * Everything else on this desk is furniture a multiplexer could offer. The one
 * thing MUON knows that nothing else does is when an agent needs a human, and
 * before this it whispered that in a badge nobody had a reason to look at.
 *
 * These defend the three properties that make an interruption GOOD: it
 * arrives without being asked for, it does not take the keyboard from the
 * child, and it never decides on one press.
 */

const PREFIX = String.fromCodePoint(2);
const ESC = String.fromCodePoint(0x1b);

function plain(text: string): string {
  const csi = new RegExp(`${ESC}\\[[0-9;:]*m`, "g");
  return text.replace(csi, "");
}

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "ap-1",
    kind: "command",
    status: "pending",
    createdAt: "2026-08-09T10:00:00Z",
    summary: "run it",
    evidence: {
      action: "Run a shell command",
      scope: "the workspace",
      impactIfApproved: "runs an arbitrary command",
      details: {},
      payloadDigest: "sha256:a",
    },
    ...over,
  } as ApprovalRequest;
}

function makeDesk(approvals: ApprovalRequest[] = []) {
  const snapshot: BrainSnapshot = { ...emptyBrainSnapshot(), approvals };
  const resolveApproval = vi.fn(async () => ({}));
  const desk = new Desk({
    client: {
      resolveApproval,
      listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
      getAutoConfirmAgentMemory: vi.fn(async () => false),
    } as unknown as MuonApiClient,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 40, rows: 8 }),
    terminalRows: () => 30,
    cwd: () => "/repo",
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
  });
  return { desk, snapshot, resolveApproval };
}

describe("the gate ARRIVES — nobody has to go looking", () => {
  it("appears in the frame the moment an approval is pending", () => {
    const { desk, snapshot } = makeDesk();
    desk.render();
    expect(plain(desk.shell.render(120).join("\n"))).not.toContain("GATE");

    // An agent blocks. No key is pressed, no drawer is opened.
    snapshot.approvals = [approval()];
    desk.render();
    const frame = plain(desk.shell.render(120).join("\n"));
    expect(frame, "the gate must announce itself").toContain("GATE");
    expect(frame, "and say what it is").toContain("Run a shell command");
    expect(frame, "and its scope").toContain("the workspace");
    expect(frame, "and how to answer").toContain("ctrl+b");
  });

  it("announces the OLDEST pending gate — the queue's own order", () => {
    // Announcing the newest makes a human answer backwards, and the one that
    // has blocked an agent longest is the one costing them time.
    const state = buildGateBand([
      approval({ id: "newer", createdAt: "2026-08-09T12:00:00Z" }),
      approval({ id: "older", createdAt: "2026-08-09T09:00:00Z" }),
    ]);
    expect(state?.next.id).toBe("older");
    expect(state?.total).toBe(2);
  });

  it("says how many are queued behind it", () => {
    const state = buildGateBand([
      approval({ id: "a" }),
      approval({ id: "b" }),
      approval({ id: "c" }),
    ])!;
    expect(plain(renderGateBand(state, 200))).toContain("+2 waiting");
  });

  it("shows RISK when the evidence carries it", () => {
    const state = buildGateBand([
      approval({
        evidence: {
          action: "Run a shell command",
          scope: "the workspace",
          impactIfApproved: "runs",
          details: {},
          riskLevel: "high",
          payloadDigest: "d",
        },
      } as never),
    ])!;
    expect(plain(renderGateBand(state, 200))).toContain("high");
  });

  it("a DECIDED approval does not announce anything", () => {
    expect(buildGateBand([approval({ status: "approved" })])).toBeNull();
    expect(buildGateBand([])).toBeNull();
  });

  it("goes quiet while the review it would announce is already open", () => {
    // Announcing what is on screen is noise.
    const { desk } = makeDesk([approval()]);
    desk.render();
    expect(plain(desk.shell.render(120).join("\n"))).toContain("GATE");
    desk.handleKey(PREFIX);
    desk.handleKey("\r");
    desk.render();
    expect(desk.centreKind()).toBe("review");
    expect(plain(desk.shell.render(120).join("\n"))).not.toContain("⏵ GATE");
  });
});

describe("it interrupts WELL — it does not take the keyboard", () => {
  it("adds no reserved key: the answer chord rides the existing prefix", async () => {
    const { routeKey } = await import("../src/shell/keys.js");
    const live = {
      reviewOpen: false,
      reviewApprovable: true,
      reviewResolving: false,
      memoryOpen: false,
      memoryBusy: false,
      helpOpen: false,
      navOpen: false,
      spawnMenuOpen: false,
      crewOpen: false,
      sidebarOpen: false,
      inboxFocused: false,
      inboxHasRows: true,
      livePane: true,
      governedOpen: false,
      corpseOnScreen: false,
      prefixArmed: false,
      composerOpen: false,
      composerBusy: false,
    };
    // With a gate pending, a bare Enter is STILL the child's.
    expect(routeKey("\r", live)).toEqual({ kind: "to-child", data: "\r" });
    // Only after the prefix does it mean "answer".
    expect(routeKey("\r", { ...live, prefixArmed: true })).toEqual({
      kind: "answer-gate",
    });
  });

  it("the band costs ONE row and never displaces the footer", () => {
    const { desk, snapshot } = makeDesk();
    desk.render();
    const before = desk.shell.render(120);
    snapshot.approvals = [approval()];
    desk.render();
    const after = desk.shell.render(120);
    expect(after.length, "the frame keeps its height").toBe(before.length);
    // The footer is still the last line.
    expect(plain(after.at(-1)!)).toContain("ctrl+q quit");
    expect(plain(after.at(-2)!), "the band sits directly above it").toContain(
      "GATE"
    );
  });
});

describe("it never decides on one press", () => {
  it("the chord OPENS the review; no decision is sent", () => {
    const { desk, resolveApproval } = makeDesk([approval()]);
    desk.handleKey(PREFIX);
    desk.handleKey("\r");
    expect(desk.centreKind()).toBe("review");
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("the SECOND press decides, bound to the announced gate", async () => {
    const { desk, resolveApproval } = makeDesk([
      approval({ id: "older", createdAt: "2026-08-09T09:00:00Z" }),
      approval({ id: "newer", createdAt: "2026-08-09T12:00:00Z" }),
    ]);
    desk.handleKey(PREFIX);
    desk.handleKey("\r");
    desk.handleKey("a");
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalled());
    // The one the band NAMED, not whatever happened to be first in the list.
    expect(
      (resolveApproval.mock.calls[0]![0] as { approvalId: string }).approvalId
    ).toBe("older");
  });

  it("answering with nothing pending says so instead of opening an empty gate", () => {
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("\r");
    expect(desk.centreKind()).not.toBe("review");
    expect(plain(desk.shell.render(120).join("\n"))).toContain("no gate");
  });
});

describe("the band is agent-authored text", () => {
  it("replays the corpus", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const state = buildGateBand([
        approval({
          evidence: {
            action: payload.text,
            scope: payload.text,
            impactIfApproved: payload.text,
            details: {},
            payloadDigest: "d",
          },
        } as never),
      ])!;
      const line = plain(renderGateBand(state, 200));
      expect(residualDanger(line, []), payload.id).toEqual([]);
    }
  });
});

describe("it only announces what THIS desk can answer", () => {
  it("a gate the review pane would refuse is never announced", () => {
    // A legacy approval with no structured evidence is `approvable: false`,
    // and the review pane refuses BOTH keys. Announcing it produced a
    // permanent banner promising an answer the desk structurally cannot give,
    // redrawn every paint for the rest of the session, with no way to clear
    // it. If this desk cannot act on it, it must not claim it can.
    const legacy = {
      id: "legacy-1",
      kind: "command",
      status: "pending",
      createdAt: "2026-08-09T09:00:00Z",
      summary: "an old request with no evidence",
    } as never as ApprovalRequest;
    expect(buildGateBand([legacy]), "unanswerable → silent").toBeNull();
  });

  it("it still announces the answerable one behind an unanswerable one", () => {
    const legacy = {
      id: "legacy-1",
      kind: "command",
      status: "pending",
      createdAt: "2026-08-09T08:00:00Z",
      summary: "no evidence",
    } as never as ApprovalRequest;
    const state = buildGateBand([legacy, approval({ id: "good" })]);
    expect(state?.next.id).toBe("good");
    expect(state?.total, "and counts only what it can answer").toBe(1);
  });
});
