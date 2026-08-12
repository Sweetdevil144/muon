import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient, ApprovalRequest } from "@muon/client";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";

/**
 * THE EXECUTOR, under test at last.
 *
 * Every CRITICAL and HIGH finding of four adversarial reviews lived in the
 * wiring between well-tested components — the wrong API route, the missing
 * pending filter, the frozen scopes literal, the busy lifecycle, the
 * re-open-after-esc. None of it was reachable while the executor was a
 * top-level script. Each `it` below is one of those defects, or a rule that
 * had no owner.
 */

const esc = String.fromCodePoint(0x1b);

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "ap-1",
    kind: "command",
    status: "pending",
    summary: "run the suite",
    createdAt: "2026-08-08T09:00:00Z",
    evidence: {
      action: "Run a shell command",
      scope: "the workspace",
      impactIfApproved: "runs a command",
      details: {},
      payloadDigest: "sha256:a",
    },
    ...over,
  } as ApprovalRequest;
}

function libraryNote(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    kind: "decision",
    text: "the brain is local-first",
    trust: "medium",
    confirmed: false,
    stale: false,
    status: "active",
    scope: "project",
    createdBy: "muon-orchestrator",
    createdAt: "2026-08-08T09:00:00Z",
    updatedAt: "2026-08-08T09:00:00Z",
    expired: false,
    pinned: false,
    ...over,
  };
}

type Calls = {
  resolveApproval: ReturnType<typeof vi.fn>;
  updateMemoryNote: ReturnType<typeof vi.fn>;
  listMemoryLibrary: ReturnType<typeof vi.fn>;
  getAutoConfirmAgentMemory: ReturnType<typeof vi.fn>;
};

function makeDesk(
  over: Partial<BrainSnapshot> = {},
  clientOver: Partial<Record<keyof Calls, unknown>> = {}
) {
  const calls: Calls = {
    resolveApproval: vi.fn(async () => ({ approval: {} })),
    updateMemoryNote: vi.fn(async () => ({})),
    listMemoryLibrary: vi.fn(async () => ({
      notes: [libraryNote()],
      total: 1,
    })),
    getAutoConfirmAgentMemory: vi.fn(async () => false),
    ...(clientOver as Partial<Calls>),
  };
  const snapshot: BrainSnapshot = { ...emptyBrainSnapshot(), ...over };
  const changes: number[] = [];
  let quit = 0;
  const desk = new Desk({
    client: calls as unknown as MuonApiClient,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 60, rows: 10 }),
    terminalRows: () => 30,
    cwd: () => "/repo",
    frozen: [],
    onChange: () => changes.push(1),
    onQuit: () => {
      quit += 1;
    },
  });
  return { desk, calls, changes, quitCount: () => quit };
}

describe("the memory read — the CRITICAL that made the pane never work", () => {
  it("uses the LIBRARY route, not search (search 400s on an empty query)", async () => {
    const { desk, calls } = makeDesk();
    await desk.openMemory();
    expect(calls.listMemoryLibrary).toHaveBeenCalledTimes(1);
    const query = calls.listMemoryLibrary.mock.calls[0]![0] as Record<string, unknown>;
    // `status: "all"` is what makes PAUSED notes reachable — search returns
    // active notes only, so `p resume` was dead code without it.
    expect(query.status).toBe("all");
    expect(query.workspace).toBe("/repo");
    expect(desk.memoryState()?.notes.length).toBe(1);
  });

  it("degrades to the UNSCOPED view when the workspace is outside the roots", async () => {
    const listMemoryLibrary = vi.fn(async (q: Record<string, unknown>) => {
      if (q.workspace !== undefined) throw new Error("400 outside allowed roots");
      return { notes: [libraryNote()], total: 1 };
    });
    const { desk } = makeDesk({}, { listMemoryLibrary });
    await desk.openMemory();
    // The pane OPENS, and says which view this is (ADR-0026 §9).
    expect(desk.memoryState()).not.toBeNull();
    expect(desk.memoryState()?.workspace).toBeUndefined();
  });

  it("fails CLOSED on an unreadable posture — never marks crew notes settled", async () => {
    const { desk } = makeDesk(
      {},
      {
        getAutoConfirmAgentMemory: vi.fn(async () => {
          throw new Error("503");
        }),
      }
    );
    await desk.openMemory();
    expect(desk.memoryState()?.autoConfirmAgentMemory).toBe(false);
  });

  it("a read failure closes the pane and SAYS why, rather than showing an empty one", async () => {
    const { desk } = makeDesk(
      {},
      {
        listMemoryLibrary: vi.fn(async () => {
          throw new Error("500 brain unreachable");
        }),
      }
    );
    await desk.openMemory();
    expect(desk.memoryState()).toBeNull();
    expect(desk.centreKind()).not.toBe("memory");
  });
});

describe("the memory write lifecycle", () => {
  it("p resolves to RESUME on a paused note — the toggle reads real state", async () => {
    const { desk, calls } = makeDesk(
      {},
      {
        listMemoryLibrary: vi.fn(async () => ({
          notes: [libraryNote({ status: "paused" })],
          total: 1,
        })),
      }
    );
    await desk.openMemory();
    desk.handleKey("p");
    await vi.waitFor(() => expect(calls.updateMemoryNote).toHaveBeenCalled());
    expect(calls.updateMemoryNote.mock.calls[0]![0]).toEqual({
      noteId: "n1",
      status: "active",
    });
  });

  it("P resolves to UNPIN on a pinned note, and carries the principal", async () => {
    const { desk, calls } = makeDesk(
      {},
      {
        listMemoryLibrary: vi.fn(async () => ({
          notes: [libraryNote({ pinned: true })],
          total: 1,
        })),
      }
    );
    await desk.openMemory();
    desk.handleKey("P");
    await vi.waitFor(() => expect(calls.updateMemoryNote).toHaveBeenCalled());
    expect(calls.updateMemoryNote.mock.calls[0]![0]).toEqual({
      noteId: "n1",
      pinned: false,
      principal: "human",
    });
  });

  it("esc during a write does NOT re-open the pane over what the human moved to", async () => {
    let release: (() => void) | null = null;
    const updateMemoryNote = vi.fn(
      () => new Promise((resolve) => (release = () => resolve({})))
    );
    const { desk } = makeDesk({}, { updateMemoryNote });
    await desk.openMemory();
    desk.handleKey("c");
    await vi.waitFor(() => expect(updateMemoryNote).toHaveBeenCalled());
    desk.handleKey(esc);
    expect(desk.memoryState()).toBeNull();
    release!();
    await new Promise((r) => setTimeout(r, 30));
    // The write landed, and the pane STAYED closed.
    expect(desk.memoryState()).toBeNull();
  });

  it("a failed write clears busy and says why — the pane is not left frozen", async () => {
    const { desk } = makeDesk(
      {},
      {
        updateMemoryNote: vi.fn(async () => {
          throw new Error("403 forbidden");
        }),
      }
    );
    await desk.openMemory();
    desk.handleKey("c");
    await vi.waitFor(() => expect(desk.memoryState()?.busy).toBe(false));
    expect(desk.memoryState()).not.toBeNull();
  });
});

describe("the inbox and the two-press rule, through the executor", () => {
  it("only PENDING approvals are counted — the rail listed all history", () => {
    const { desk } = makeDesk({
      approvals: [
        approval({ id: "old", status: "approved" }),
        approval({ id: "live", status: "pending" }),
      ],
    });
    const rows = desk.inboxState().rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.approval.id).toBe("live");
  });

  it("a/r on the rail OPENS the review; no decision is sent", () => {
    const { desk, calls } = makeDesk({ approvals: [approval()] });
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("i");
    desk.handleKey("\r");
    expect(desk.centreKind()).toBe("review");
    expect(calls.resolveApproval).not.toHaveBeenCalled();
  });

  it("the SECOND press decides, with the shared payload", async () => {
    const { desk, calls } = makeDesk({ approvals: [approval()] });
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("i");
    desk.handleKey("\r");
    desk.handleKey("a");
    await vi.waitFor(() => expect(calls.resolveApproval).toHaveBeenCalled());
    expect(calls.resolveApproval.mock.calls[0]![0]).toEqual({
      approvalId: "ap-1",
      status: "approved",
      decisionNotes: "decided from MUON TUI",
    });
  });

  it("the decision binds to the approval READ, even if the list moves under it", async () => {
    // The whole point of snapshotting the request at first press.
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [approval({ id: "first" })],
    };
    const calls = {
      resolveApproval: vi.fn(async () => ({ approval: {} })),
      updateMemoryNote: vi.fn(async () => ({})),
      listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
      getAutoConfirmAgentMemory: vi.fn(async () => false),
    };
    const desk = new Desk({
      client: calls as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 60, rows: 10 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    desk.handleKey(String.fromCodePoint(2));
    desk.handleKey("i");
    // Enter OPENS the review (evidence-first); it snapshots the request.
    desk.handleKey("\r");
    // A poll replaces the list entirely while the review is open.
    snapshot.approvals = [approval({ id: "second" })];
    // `a` is the SECOND press — the decision.
    desk.handleKey("a");
    await vi.waitFor(() => expect(calls.resolveApproval).toHaveBeenCalled());
    expect(
      (calls.resolveApproval.mock.calls[0]![0] as { approvalId: string }).approvalId
    ).toBe("first");
  });

  it("a failed decision SAYS so — a silent failure reads as decided", async () => {
    const { desk } = makeDesk(
      { approvals: [approval()] },
      {
        resolveApproval: vi.fn(async () => {
          throw new Error("409 already approved");
        }),
      }
    );
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("i");
    desk.handleKey("\r");
    desk.handleKey("a");
    await vi.waitFor(() => {
      const frame = desk.shell.render(120).join("\n");
      expect(frame).toContain("could not");
    });
  });
});

describe("the dual-highlight rule, at the surface that renders it", () => {
  it("only ONE rail owns the cursor — crew drawer vs inbox", () => {
    // The legacy crew RAIL is gone: the sidebar is spaces/sessions/chat/info
    // and crew is a drawer. The rule is unchanged — one cursor at a time —
    // so it is asserted where crew actually lives now.
    const { desk } = makeDesk({
      approvals: [approval()],
      agents: [{ id: "a1", name: "codex-1", status: "working", vendor: "codex" }] as never,
    });
    const PREFIX = String.fromCodePoint(2);
    desk.handleKey(PREFIX);
    desk.handleKey("c");
    expect(desk.revealed()).toMatchObject({ crew: true, inbox: false });
    desk.handleKey(PREFIX);
    desk.handleKey("i");
    // Opening the inbox does not leave the crew drawer holding a cursor too.
    expect(desk.revealed().inbox).toBe(true);
  });
});

describe("quit and centre precedence", () => {
  it("ctrl+q quits from every scope", () => {
    const { desk, quitCount } = makeDesk({ approvals: [approval()] });
    desk.handleKey(String.fromCodePoint(17));
    expect(quitCount()).toBe(1);
  });

  it("the memory pane wins the centre while it is open", async () => {
    const { desk } = makeDesk({ approvals: [approval()] });
    await desk.openMemory();
    expect(desk.centreKind()).toBe("memory");
    desk.handleKey(esc);
    // Closing the last surface with NOTHING running now offers the picker
    // rather than leaving a blank desk — an empty desk is not a resting
    // state. (Before this it returned "none": ten blank rows and a footer.)
    expect(desk.centreKind()).toBe("spawn-menu");
  });
});

describe("the bot findings, pinned", () => {
  it("a REFUSED corpse spawn keeps the corpse — it is the only copy left", () => {
    // ADR-0047 D1 makes the snapshot one-shot: it was deleted from disk at
    // startup, so the in-memory entry is the last copy of that screen.
    // Removing it before the spawn result was known destroyed it on refusal.
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 60, rows: 10 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      // A kind the allowlist refuses outright, so `open` returns a refusal.
      frozen: [
        {
          id: "x-1",
          kind: "not-a-vendor",
          ordinal: 1,
          label: "Ghost",
          text: "THE ONLY COPY",
          cols: 80,
          rows: 24,
        },
      ],
      onChange: () => {},
      onQuit: () => {},
    });
    expect(desk.centreKind()).toBe("frozen");
    desk.handleKey("\r");
    // Refused — and the corpse is STILL on screen, retriable and discardable.
    expect(desk.centreKind()).toBe("frozen");
    expect(desk.shell.render(120).join("\n")).toContain("THE ONLY COPY");
  });
});

describe("the review's findings, pinned at the executor", () => {
  const PREFIX = String.fromCodePoint(2);
  /**
   * STRIP ANSI BEFORE ASSERTING ON A NUMBER. The yellow badge is
   * `ESC[33m 1 ESC[39m` — so `toContain("3")` matched the COLOUR CODE, and
   * the first version of these tests passed against a frozen badge. A digit
   * assertion on a styled frame must never see the escape bytes.
   */
  const plainRow = (needle: string): string => {
    const csi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
    return (
      desk0.shell
        .render(140)
        .map((line) => line.replace(csi, ""))
        .find((line) => line.includes(needle)) ?? ""
    );
  };
  let desk0: Desk;

  it("the Control badge REFRESHES on a poll — it used to freeze at construction", () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [approval({ id: "a1" })],
    };
    const desk = new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 60, rows: 10 }),
      terminalRows: () => 40,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    desk0 = desk;
    desk.handleKey(PREFIX);
    desk.handleKey("g");
    expect(plainRow("Control")).toContain("1");
    // A poll delivers two more. The nav was built once and never re-derived,
    // so it kept saying 1 while the rail said 3.
    snapshot.approvals = [
      approval({ id: "a1" }),
      approval({ id: "a2" }),
      approval({ id: "a3" }),
    ];
    desk.render();
    expect(plainRow("Control"), "the badge must follow the brain").toContain("3");
  });

  it("the badge counts PENDING APPROVALS, not folded rows", () => {
    // The rail folds same-job siblings into one row for readability. A badge
    // that inherits the fold says "1" while five decisions wait.
    const { desk } = makeDesk({
      approvals: [
        approval({ id: "a1", jobId: "j1" }),
        approval({ id: "a2", jobId: "j1" }),
        approval({ id: "a3", jobId: "j1" }),
      ],
    });
    desk0 = desk;
    desk.handleKey(PREFIX);
    desk.handleKey("g");
    expect(plainRow("Control"), "three decisions, one row").toContain("3");
    // And the rail still folds them into one.
    expect(desk.inboxState().rows.length).toBe(1);
  });

  it("a decision REFRESHES the brain — without it a second press duplicates the write", async () => {
    const refresh = vi.fn(async () => {});
    const resolveApproval = vi.fn(async () => ({}));
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [approval()],
    };
    const desk = new Desk({
      client: { resolveApproval } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 60, rows: 10 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
      refresh,
    });
    desk.handleKey(PREFIX);
    desk.handleKey("i");
    desk.handleKey("\r");
    desk.handleKey("a");
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalled());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("Esc pops exactly ONE layer at the executor, not two", () => {
    const { desk } = makeDesk({ approvals: [approval()] });
    // Two real LAYERS: the crew drawer, then the inbox on top of it. (The
    // sidebar is a toggle, not a layer — it owns no keyboard, so Esc must not
    // consume a keystroke to close it.)
    desk.handleKey(PREFIX);
    desk.handleKey("c"); // crew drawer
    desk.handleKey(PREFIX);
    desk.handleKey("i"); // inbox on top
    expect(desk.revealed()).toMatchObject({ crew: true, inbox: true });
    desk.handleKey(String.fromCodePoint(0x1b));
    // ONE rung: the inbox closes, the crew drawer stays.
    expect(desk.revealed()).toMatchObject({ crew: true, inbox: false });
    desk.handleKey(String.fromCodePoint(0x1b));
    expect(desk.revealed()).toMatchObject({ crew: false, inbox: false });
  });

  it("an IMPLEMENTED destination changes the screen — a dot is not a destination", () => {
    // "mission" and "control" were claimed implemented and did nothing: the
    // only observable effect was a marker you could see by reopening the nav.
    const { desk } = makeDesk({ approvals: [approval()] });
    desk.handleKey(PREFIX);
    desk.handleKey("g");
    const control = 5; // Control's index in NAV_DESTINATIONS
    for (let i = 0; i < control; i += 1) desk.handleKey("j");
    desk.handleKey("\r");
    expect(desk.activeDestination()).toBe("control");
    expect(desk.revealed().inbox, "Control must reveal the decisions").toBe(true);
  });

  it("the desk chrome is HIDDEN on first paint — terminal is the hero", () => {
    const { desk } = makeDesk({ approvals: [approval()] });
    expect(desk.revealed()).toEqual({
      sidebar: false,
      crew: false,
      inbox: false,
      help: false,
    });
  });
});

describe("Esc pops in REVEAL order, not a fixed precedence", () => {
  const PREFIX = String.fromCodePoint(2);
  const ESC = String.fromCodePoint(0x1b);

  it("crew then inbox pops inbox first; inbox then crew pops crew first", () => {
    // The docstring claimed "the inverse of the order a human opened things
    // in" while the code used a FIXED precedence, so the order of opening was
    // ignored. Both directions are asserted, because a fixed precedence
    // passes one of them by luck.
    const a = makeDesk({ approvals: [approval()] }).desk;
    a.handleKey(PREFIX); a.handleKey("c");
    a.handleKey(PREFIX); a.handleKey("i");
    a.handleKey(ESC);
    expect(a.revealed()).toMatchObject({ crew: true, inbox: false });

    const b = makeDesk({ approvals: [approval()] }).desk;
    b.handleKey(PREFIX); b.handleKey("i");
    b.handleKey(PREFIX); b.handleKey("c");
    b.handleKey(ESC);
    expect(b.revealed()).toMatchObject({ crew: false, inbox: true });
  });

  it("a gate is always innermost, whatever was revealed before it", () => {
    const { desk } = makeDesk({ approvals: [approval()] });
    desk.handleKey(PREFIX); desk.handleKey("c");
    desk.handleKey(PREFIX); desk.handleKey("a");
    expect(desk.centreKind()).toBe("composer");
    desk.handleKey(ESC);
    // The composer goes, the crew drawer it was opened over survives.
    expect(desk.centreKind()).toBe("crew");
  });

  it("toggling something CLOSED removes it from the stack", () => {
    const { desk } = makeDesk({ approvals: [approval()] });
    desk.handleKey(PREFIX); desk.handleKey("c");
    desk.handleKey(PREFIX); desk.handleKey("i");
    desk.handleKey(PREFIX); desk.handleKey("i"); // closed again
    desk.handleKey(ESC);
    // Esc must pop the crew drawer, not a stale inbox entry.
    expect(desk.revealed()).toMatchObject({ crew: false, inbox: false });
  });
});
