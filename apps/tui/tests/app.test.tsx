import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { MuonApiClient } from "@muon/client";
import type { MemoryNote, PreEditContext } from "@muon/client";
import type { BrainSnapshot, BrainStore } from "../src/lib/brain-store.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import { App } from "../src/components/App.js";

function stubStore(snapshot: BrainSnapshot): BrainStore {
  return {
    client: new MuonApiClient("http://localhost:4000", async () => {
      throw new Error("no network in render tests");
    }),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

const proposalContext: PreEditContext = {
  target: {
    module: "src/auth/guard.ts",
    symbol: "src/auth/guard.ts#authorize",
  },
  blastRadius: {
    modules: ["src/auth/guard.ts"],
    symbols: ["src/auth/guard.ts#authorize"],
    depth: 1,
    source: "provided",
  },
  memories: [],
  warnings: [],
  pendingProposals: [
    {
      proposalNoteId: "proposal-1",
      victimNoteId: "memory-1",
      modules: ["src/auth/guard.ts"],
      detail: "An unconfirmed proposal contests a governed decision.",
    },
  ],
  activity: [],
  duplicateWork: [],
};

const proposalNote: MemoryNote = {
  id: "proposal-1",
  kind: "attempt",
  text: "Replace the current authorization rule.",
  taskId: null,
  laneId: null,
  modules: ["src/auth/guard.ts"],
  topics: [],
  symbols: ["src/auth/guard.ts#authorize"],
  trust: "low",
  confirmed: false,
  stale: false,
  status: "active",
  createdBy: "agent:reviewer",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

const cleanContext: PreEditContext = {
  ...proposalContext,
  target: {
    module: "src/payments/billing.ts",
    symbol: "src/payments/billing.ts#charge",
  },
  blastRadius: {
    modules: ["src/payments/billing.ts"],
    symbols: ["src/payments/billing.ts#charge"],
    depth: 1,
    source: "provided",
  },
  pendingProposals: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openBrain(
  stdin: { write: (input: string) => void },
  lastFrame: () => string | undefined,
  target = "src/auth/guard.ts"
) {
  stdin.write("\u000b");
  await vi.waitFor(() =>
    expect(lastFrame() ?? "").toContain("Command palette")
  );
  stdin.write("brain");
  await vi.waitFor(() =>
    expect(lastFrame() ?? "").toContain("› Pre-edit context (Memory)")
  );
  stdin.write("\r");
  await vi.waitFor(() =>
    expect(lastFrame() ?? "").toContain("Symbol or file/module to edit:")
  );
  stdin.write(target);
  await vi.waitFor(() =>
    expect(lastFrame() ?? "").toContain(
      `Symbol or file/module to edit: ${target}`
    )
  );
  stdin.write("\r");
}

async function viewSelectedProposal(
  stdin: { write: (input: string) => void },
  lastFrame: () => string | undefined
) {
  stdin.write("v");
  await vi.waitFor(() =>
    expect(lastFrame() ?? "").toContain(
      "text: Replace the current authorization rule."
    )
  );
}

describe("App (chat-first cockpit)", () => {
  it("renders fleet, chat, and inbox zones from brain state", () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      health: {
        status: "ok",
        service: "muon-backend",
        timestamp: "2026-07-09T00:00:00.000Z",
      },
      lanes: [
        {
          id: "lane-1",
          key: "codex",
          name: "Codex",
          provider: "openai",
          role: "peer",
          status: "available",
        },
      ],
      agents: [
        {
          id: "agent-1",
          vendor: "codex",
          name: "codex-1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-abcdef12",
        },
        {
          id: "agent-2",
          vendor: "claude-code",
          name: "claude-code-1",
          ordinal: 1,
          status: "idle",
        },
      ],
      tasks: [
        {
          id: "task-abcdef12",
          title: "Ship TUI cockpit",
          description: "",
          status: "in_progress",
          priority: "high",
        },
      ],
      approvals: [
        {
          id: "ap-1",
          taskId: "task-abcdef12",
          requestedBy: "codex",
          kind: "command",
          reason: "muon run gate",
          status: "pending",
        },
      ],
      pendingApprovals: 1,
    };

    const { lastFrame } = render(
      React.createElement(App, { store: stubStore(snapshot), widthOverride: 140 })
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("MUON");
    expect(frame).toContain("HUB");
    expect(frame).toContain("FLEET");
    expect(frame).toContain("codex-1");
    expect(frame).toContain("ORCHESTRATOR");
    expect(frame).toContain("WORK");
    expect(frame).toContain("APPROVALS");
    expect(frame).toContain("HANDOFFS");
    expect(frame).toContain("Ctrl+K palette");
  });

  it("guides first-run: empty fleet hint and chat onboarding copy", () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      health: {
        status: "ok",
        service: "muon-backend",
        timestamp: "2026-07-09T00:00:00.000Z",
      },
    };

    const { lastFrame } = render(
      React.createElement(App, { store: stubStore(snapshot), widthOverride: 120 })
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("FLEET");
    expect(frame).toContain("no agents");
    expect(frame).toContain("Tell the crew what to do");
  });

  it("binds ! to the stop-all panic action", async () => {
    const store = stubStore(emptyBrainSnapshot());
    vi.spyOn(store.client, "listDispatchJobs").mockResolvedValue([]);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 120 })
    );

    stdin.write("!");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("stopped 0 dispatch lanes")
    );
    unmount();
  });

  it("renders the five-seat desk and stops only the selected live lane", async () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      agents: Array.from({ length: 5 }, (_, index) => ({
        id: `agent-${index + 1}`,
        vendor: "codex",
        name: `crew-${index + 1}`,
        ordinal: index + 1,
        status: "working",
        currentTaskId: `task-${index + 1}`,
        currentJobId: `job-${index + 1}`,
      })),
      tasks: Array.from({ length: 5 }, (_, index) => ({
        id: `task-${index + 1}`,
        title: `Feature ${index + 1}`,
        description: "",
        status: "in_progress",
        priority: "high",
      })),
      dispatchJobs: Array.from({ length: 5 }, (_, index) =>
        ({
          id: `job-${index + 1}`,
          agentId: `agent-${index + 1}`,
          taskId: `task-${index + 1}`,
          status: "running",
          interruptRequested: false,
          createdAt: new Date().toISOString(),
          currentActivity: `working feature ${index + 1}`,
        }) as import("@muon/client").DispatchJobRecord
      ),
    };
    const store = stubStore(snapshot);
    const interrupt = vi
      .spyOn(store.client, "interruptDispatchJob")
      .mockResolvedValue(undefined);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );

    // ADR-0032 D2: the desk is a TAB, not something a wide terminal forces.
    // Chat is the default front door and the desk is one keystroke away —
    // retiring the old behaviour where widening past 150 columns silently
    // replaced the conversation with the desk.
    expect(lastFrame() ?? "").toContain("1 chat");
    expect(lastFrame() ?? "").toContain("2 crew");
    stdin.write("2");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("CREW DESK")
    );
    expect(lastFrame() ?? "").toContain("crew-5");
    stdin.write("\t");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("› crew-1")
    );
    stdin.write("j");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("› crew-2")
    );
    stdin.write("s");
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith("job-2"));
    expect(interrupt).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("stopped crew-2 · job-2")
    );
    unmount();
  });

  it("requires visible approval evidence before one-key approval", async () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [
        {
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "Write authentication module",
          status: "pending",
          evidence: {
            action: "Write",
            scope: "/repo/src/auth.ts",
            riskLevel: "high",
            impactIfApproved: "Writes the selected authentication module.",
            payloadDigest: "a".repeat(64),
            details: { target: "/repo/src/auth.ts" },
          },
        },
      ],
      pendingApprovals: 1,
    };
    const store = stubStore(snapshot);
    const resolve = vi
      .spyOn(store.client, "resolveApproval")
      .mockResolvedValue({
        ...snapshot.approvals[0]!,
        status: "approved",
      });
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 120 })
    );

    stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("a");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("NEEDS YOUR APPROVAL · HIGH")
    );
    expect(resolve).not.toHaveBeenCalled();

    stdin.write("a");
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        approvalId: "approval-1",
        status: "approved",
        decisionNotes: "decided from MUON TUI",
      })
    );
    unmount();
  });

  it("A approves + doesn't ask again, only for receipt-eligible evidence", async () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [
        {
          id: "approval-edit",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "Edit the parser",
          status: "pending",
          evidence: {
            action: "Edit",
            scope: "/repo/src/parser.ts",
            riskLevel: "medium",
            impactIfApproved: "Edits the selected parser file.",
            payloadDigest: "b".repeat(64),
            details: { path: "/repo/src/parser.ts" },
          },
        },
      ],
      pendingApprovals: 1,
    };
    const store = stubStore(snapshot);
    const resolve = vi
      .spyOn(store.client, "resolveApproval")
      .mockResolvedValue({
        ...snapshot.approvals[0]!,
        status: "approved",
      });
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 120 })
    );

    stdin.write("\t");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    stdin.write("\t");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    stdin.write("a");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("A approve, don't ask again")
    );
    expect(resolve).not.toHaveBeenCalled();

    stdin.write("A");
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        approvalId: "approval-edit",
        status: "approved",
        decisionNotes: "decided from MUON TUI",
        receipt: { ttlMs: 900_000 },
      })
    );
    unmount();
  });

  it("A refuses to remember an ineligible action and files no decision", async () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [
        {
          id: "approval-network",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "Fetch the docs",
          status: "pending",
          evidence: {
            action: "WebFetch",
            scope: "https://example.com",
            riskLevel: "high",
            impactIfApproved: "Fetches a remote URL from the session.",
            payloadDigest: "b".repeat(64),
            details: { url: "https://example.com" },
          },
        },
      ],
      pendingApprovals: 1,
    };
    const store = stubStore(snapshot);
    const resolve = vi.spyOn(store.client, "resolveApproval");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 120 })
    );

    stdin.write("\t");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    stdin.write("\t");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    stdin.write("a");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("NEEDS YOUR APPROVAL · HIGH")
    );
    stdin.write("A");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("This one always asks")
    );
    expect(resolve).not.toHaveBeenCalled();
    unmount();
  });

  it("cannot approve a legacy command with missing evidence", async () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [
        {
          id: "approval-legacy",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "legacy command",
          status: "pending",
        },
      ],
      pendingApprovals: 1,
    };
    const store = stubStore(snapshot);
    const resolve = vi.spyOn(store.client, "resolveApproval");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 120 })
    );

    stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("a");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("r reject malformed request")
    );
    stdin.write("a");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain(
        "This command request has no structured evidence"
      )
    );
    expect(resolve).not.toHaveBeenCalled();
    unmount();
  });

  it.each([
    { key: "c", decision: "confirm", confirmed: true },
    { key: "x", decision: "reject", confirmed: false },
  ])(
    "requires viewed proposal text before $decision",
    async ({ key, confirmed }) => {
      const store = stubStore(emptyBrainSnapshot());
      vi.spyOn(store.client, "preEditContext").mockResolvedValue(
        proposalContext
      );
      let resolveProposalText!: (note: MemoryNote) => void;
      vi.spyOn(store.client, "getMemoryNote").mockReturnValue(
        new Promise((resolve) => {
          resolveProposalText = resolve;
        })
      );
      const updateMemoryNote = vi
        .spyOn(store.client, "updateMemoryNote")
        .mockResolvedValue(proposalNote);
      const { lastFrame, stdin, unmount } = render(
        React.createElement(App, { store, widthOverride: 140 })
      );

      stdin.write("\u000b");
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("Command palette")
      );
      stdin.write("brain");
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("› Pre-edit context (Memory)")
      );
      stdin.write("\r");
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain(
          "Symbol or file/module to edit:"
        )
      );
      stdin.write("src/auth/guard.ts");
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain(
          "Symbol or file/module to edit: src/auth/guard.ts"
        )
      );
      stdin.write("\r");
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain(
          "text: press v to view before confirm/reject"
        )
      );

      stdin.write(key);
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain(
          "press v to view proposal proposal-1 before confirming or rejecting"
        )
      );
      expect(updateMemoryNote).not.toHaveBeenCalled();

      stdin.write("v");
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("text: …")
      );
      stdin.write(key);
      expect(updateMemoryNote).not.toHaveBeenCalled();

      resolveProposalText(proposalNote);
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain(
          "text: Replace the current authorization rule."
        )
      );
      stdin.write(key);
      await vi.waitFor(() =>
        expect(updateMemoryNote).toHaveBeenCalledWith({
          noteId: "proposal-1",
          confirmed,
          principal: "human",
        })
      );

      unmount();
    }
  );

  it("rejects a memory note through the GOVERNED path (confirmed:false + status:rejected + human principal)", async () => {
    // Parity with `muon memory reject`: a bare `status:"rejected"` on an
    // unconfirmed agent note skipped the backend operator gate and left no
    // confirming principal on the ledger. The TUI must send the governed payload.
    const store = stubStore(emptyBrainSnapshot());
    const agentNote: MemoryNote = {
      ...proposalNote,
      id: "mem-33333333-3333-4333-8333-333333333333",
      text: "An unconfirmed agent note to reject.",
    };
    vi.spyOn(store.client, "searchMemory").mockResolvedValue([agentNote]);
    const updateMemoryNote = vi
      .spyOn(store.client, "updateMemoryNote")
      .mockResolvedValue({ ...agentNote, status: "rejected" });
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    stdin.write("");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Command palette")
    );
    stdin.write("search memory");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Search memory")
    );
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("Query"));
    stdin.write("guard");
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("MEMORY,"));

    stdin.write("x");
    await vi.waitFor(() =>
      expect(updateMemoryNote).toHaveBeenCalledWith({
        noteId: agentNote.id,
        confirmed: false,
        status: "rejected",
        principal: "human",
      })
    );
    unmount();
  });

  it("toggles R3 expired memory through the GOVERNED search and redeems a lapsed note", async () => {
    // Cross-surface parity with the desktop "Show expired" toggle: expired
    // hidden by DEFAULT, `e` re-asks the SAME governed read with the operator
    // flag (never a local filter), and a human confirm clears the expiry so the
    // marker disappears in place.
    const store = stubStore(emptyBrainSnapshot());
    const liveNote: MemoryNote = {
      ...proposalNote,
      id: "mem-live",
      text: "A live agent note.",
    };
    const expiredNote: MemoryNote = {
      ...proposalNote,
      id: "mem-expired",
      text: "The retry budget was probably three.",
      expiresAt: "2026-06-01T00:00:00.000Z",
      expired: true,
    };
    const searchMemory = vi
      .spyOn(store.client, "searchMemory")
      .mockImplementation(async (_query, options) =>
        // Lapsed first, so the panel's reset selection lands on it.
        options?.showExpired ? [expiredNote, liveNote] : [liveNote]
      );
    const updateMemoryNote = vi
      .spyOn(store.client, "updateMemoryNote")
      .mockResolvedValue({
        ...expiredNote,
        confirmed: true,
        expiresAt: null,
        expired: false,
      });
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    stdin.write("");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Command palette")
    );
    stdin.write("search memory");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Search memory")
    );
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("Query"));
    stdin.write("guard");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("guard"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("MEMORY,"));

    // ADR-0026 §9: the TUI now fences its search to the invoking workspace, and the
    // coordinate is part of the exact call shape rather than hidden behind an
    // `objectContaining` — a test that stopped asserting it would stop noticing if
    // the default were dropped, which is precisely how §1's leak went unnoticed.
    expect(searchMemory).toHaveBeenCalledWith("guard", {
      workspace: process.cwd(),
      showExpired: false,
    });
    expect(lastFrame() ?? "").not.toContain("EXPIRED");

    stdin.write("e");
    await vi.waitFor(() =>
      // The re-ask must carry the SAME workspace the view was built with, never a
      // freshly derived one: an expired-toggle that moved the partition would answer
      // a different question than the one on screen.
      expect(searchMemory).toHaveBeenCalledWith("guard", {
        workspace: process.cwd(),
        showExpired: true,
      })
    );
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("EXPIRED"));
    expect(lastFrame() ?? "").toContain(
      "The retry budget was probably three."
    );

    // Redeem it: the lapsed row is selected, confirm with the human principal.
    stdin.write("c");
    await vi.waitFor(() =>
      expect(updateMemoryNote).toHaveBeenCalledWith({
        noteId: "mem-expired",
        confirmed: true,
        principal: "human",
      })
    );
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("expiry cleared"));
    // Visibly un-expired, and the text is still there — expiry hides, it never
    // deletes.
    expect(lastFrame() ?? "").not.toContain("EXPIRED");
    expect(lastFrame() ?? "").toContain("The retry budget was probably three.");
    unmount();
  });

  it("does not reopen the Brain when a refresh settles after close", async () => {
    const store = stubStore(emptyBrainSnapshot());
    const staleRefresh = deferred<PreEditContext>();
    vi.spyOn(store.client, "preEditContext")
      .mockResolvedValueOnce(proposalContext)
      .mockReturnValueOnce(staleRefresh.promise);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    await openBrain(stdin, lastFrame);
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Pending proposals (1)")
    );

    stdin.write("r");
    await vi.waitFor(() =>
      expect(store.client.preEditContext).toHaveBeenCalledTimes(2)
    );
    stdin.write("\u001b");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").not.toContain("Pending proposals (1)")
    );

    staleRefresh.resolve(proposalContext);
    await staleRefresh.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(lastFrame() ?? "").not.toContain("src/auth/guard.ts#authorize");
    expect(lastFrame() ?? "").not.toContain("memory: refreshed");

    unmount();
  });

  it.each([
    { firstKey: "c", confirmed: true },
    { firstKey: "x", confirmed: false },
  ])(
    "keeps proposal adjudication single-flight after $firstKey",
    async ({ firstKey, confirmed }) => {
      const store = stubStore(emptyBrainSnapshot());
      const mutation = deferred<MemoryNote>();
      vi.spyOn(store.client, "preEditContext")
        .mockResolvedValueOnce(proposalContext)
        .mockResolvedValueOnce(cleanContext);
      vi.spyOn(store.client, "getMemoryNote").mockResolvedValue(proposalNote);
      const updateMemoryNote = vi
        .spyOn(store.client, "updateMemoryNote")
        .mockReturnValue(mutation.promise);
      const { lastFrame, stdin, unmount } = render(
        React.createElement(App, { store, widthOverride: 140 })
      );

      await openBrain(stdin, lastFrame);
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("Pending proposals (1)")
      );
      await viewSelectedProposal(stdin, lastFrame);

      stdin.write(firstKey);
      stdin.write(firstKey === "c" ? "x" : "c");
      stdin.write(firstKey);
      expect(updateMemoryNote).toHaveBeenCalledTimes(1);
      expect(updateMemoryNote).toHaveBeenCalledWith({
        noteId: "proposal-1",
        confirmed,
        principal: "human",
      });

      mutation.resolve(proposalNote);
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("Pending proposals (0)")
      );

      unmount();
    }
  );

  it("keeps a successful decision resolved locally when refresh fails", async () => {
    const store = stubStore(emptyBrainSnapshot());
    vi.spyOn(store.client, "preEditContext")
      .mockResolvedValueOnce(proposalContext)
      .mockRejectedValueOnce(new Error("refresh offline"));
    vi.spyOn(store.client, "getMemoryNote").mockResolvedValue(proposalNote);
    const updateMemoryNote = vi
      .spyOn(store.client, "updateMemoryNote")
      .mockResolvedValue(proposalNote);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    await openBrain(stdin, lastFrame);
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Pending proposals (1)")
    );
    await viewSelectedProposal(stdin, lastFrame);
    stdin.write("c");

    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Pending proposals (0)")
    );
    const frame = lastFrame() ?? "";
    expect(updateMemoryNote).toHaveBeenCalledTimes(1);
    expect(frame).not.toContain("Replace the current authorization rule.");
    expect(frame).toContain("refresh failed: refresh offline");
    expect(frame).not.toContain("confirm failed");

    unmount();
  });

  it("does not let a stale post-adjudication refresh overwrite a newer target", async () => {
    const store = stubStore(emptyBrainSnapshot());
    const staleRefresh = deferred<PreEditContext>();
    vi.spyOn(store.client, "preEditContext")
      .mockResolvedValueOnce(proposalContext)
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce(cleanContext);
    vi.spyOn(store.client, "getMemoryNote").mockResolvedValue(proposalNote);
    vi.spyOn(store.client, "updateMemoryNote").mockResolvedValue(proposalNote);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    await openBrain(stdin, lastFrame);
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Pending proposals (1)")
    );
    await viewSelectedProposal(stdin, lastFrame);
    stdin.write("c");
    await vi.waitFor(() =>
      expect(store.client.preEditContext).toHaveBeenCalledTimes(2)
    );

    stdin.write("\u001b");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").not.toContain("src/auth/guard.ts#authorize")
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await openBrain(stdin, lastFrame, "src/payments/billing.ts");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("src/payments/billing.ts#charge")
    );

    staleRefresh.resolve(proposalContext);
    await staleRefresh.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("src/payments/billing.ts#charge");
    expect(frame).not.toContain("src/auth/guard.ts#authorize");
    expect(frame).toContain("none, nothing to confirm");

    unmount();
  });
});

describe("App · CREW panel (cross-surface parity with `muon crew`)", () => {
  it("opens from the palette and fails closed, honestly, with no chat selected", async () => {
    const { stdin, lastFrame, unmount } = render(
      <App store={stubStore(emptyBrainSnapshot())} widthOverride={120} />
    );

    stdin.write("\u000b");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Command palette")
    );
    stdin.write("crew");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Crew roles + coordination")
    );
    stdin.write("\r");

    // No chat in this folder yet (listChats fails in this stub), so the panel
    // states the scope rule instead of rendering another chat or a blank frame.
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("No chat is selected in this folder yet")
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("scoped to exactly one chat");
    expect(frame).toContain("read-only");
    expect(frame).toContain("muon crew roles --assign");

    stdin.write("\u001b");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").not.toContain("No chat is selected in this folder yet")
    );

    unmount();
  });
});
