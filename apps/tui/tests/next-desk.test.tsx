import React from "react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
import { render } from "ink-testing-library";
import {
  MuonApiClient,
  REMEMBER_ACTION_TTL_MS,
  terminalSafeBlock,
} from "@muon/client";
import type { BrainSnapshot, BrainStore } from "../src/lib/brain-store.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import { Desk } from "../src/next/Desk.js";

// The desk commit shipped with zero tests (review finding #4). These pin the
// four claimed properties: vendor output passes through terminalSafeBlock,
// Enter opens the governed-transcript tab, a lane leaving the fleet takes its
// tab with it, and an unported binding refuses BY NAME instead of dying.

const ESC = String.fromCharCode(27);
const CTRL_K = String.fromCharCode(11);
const HOSTILE_CHUNK = `hello${ESC}[2Jworld`;

function liveStore(initial: BrainSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const store = {
    client: new MuonApiClient("http://localhost:4000", async () => {
      throw new Error("no network in render tests");
    }),
    apiBase: "http://localhost:4000",
    apiToken: undefined,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
  } as unknown as BrainStore;
  return {
    store,
    set: (next: BrainSnapshot) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

function crewSnapshot(): BrainSnapshot {
  return {
    ...emptyBrainSnapshot(),
    agents: [
      {
        id: "agent-1",
        vendor: "codex",
        name: "codex-1",
        ordinal: 1,
        status: "working",
      } as BrainSnapshot["agents"][number],
    ],
    // A fresh empty dir: the custom-agent store reads a real file, and the
    // test must not depend on this machine's registered agents.
    target: {
      base: "http://localhost:4000",
      dataDir: (() => {
        const dir = mkdtempSync(path.join(tmpdir(), "muon-desk-test-"));
        TEMP_DIRS.push(dir);
        return dir;
      })(),
      source: "default" as const,
    },
  };
}

function stubClient(store: BrainStore) {
  vi.spyOn(store.client, "listHarnesses").mockResolvedValue([]);
  vi.spyOn(store.client, "listStreamChunks").mockResolvedValue([
    {
      seq: 1,
      taskId: "task-1",
      laneId: "lane-1",
      agentId: "agent-1",
      runId: "run-1",
      kind: "output",
      content: HOSTILE_CHUNK,
      timestamp: "2026-08-07T00:00:00.000Z",
    },
  ]);
}

async function flush(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the frame satisfies the predicate — fixed sleeps flake under a
 *  loaded parallel test run. Falls through after the timeout so the assert
 *  that follows reports the real frame. */
async function untilFrame(
  view: { lastFrame: () => string | undefined },
  predicate: (frame: string) => boolean,
  timeoutMs = 3000
) {
  const start = Date.now();
  while (!predicate(view.lastFrame() ?? "")) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Assert that a frame reaches a state, rather than merely waiting for it.
 *
 * `untilFrame` RETURNS SILENTLY on timeout — by design, so a following assert
 * can report the real frame. Used as a test's only check it proves nothing,
 * and review pass 11 F2 found three tests doing exactly that. Anything that is
 * the actual claim goes through this.
 */
async function expectFrame(
  view: { lastFrame: () => string | undefined },
  predicate: (frame: string) => boolean,
  description: string,
  timeoutMs = 3000
) {
  await untilFrame(view, predicate, timeoutMs);
  const frame = view.lastFrame() ?? "";
  expect(predicate(frame), `${description}\n--- frame ---\n${frame}`).toBe(true);
}

describe("the new desk (ADR-0042 D4)", () => {
  it("Enter on a crew row opens the governed transcript, and vendor bytes pass through terminalSafeBlock", async () => {
    const { store } = liveStore(crewSnapshot());
    stubClient(store);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\r"); // lane-stream on the selected crew row
    await untilFrame(view, (frame) => frame.includes(terminalSafeBlock(HOSTILE_CHUNK)));

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("governed transcript");
    expect(frame).toContain("2 codex-1"); // the tab strip ordinal IS the key
    // The control bytes must be neutralized exactly the way the shared
    // sanitizer does it — not raw, not ad-hoc-stripped.
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).toContain(terminalSafeBlock(HOSTILE_CHUNK));
    view.unmount();
  });

  it("a lane leaving the fleet takes its tab and transcript with it", async () => {
    const seeded = crewSnapshot();
    const { store, set } = liveStore(seeded);
    stubClient(store);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("governed transcript"));
    expect(view.lastFrame()).toContain("governed transcript");

    set({ ...seeded, agents: [] });
    await untilFrame(view, (frame) => !frame.includes("codex-1"));

    const frame = view.lastFrame() ?? "";
    expect(frame).not.toContain("governed transcript");
    expect(frame).not.toContain("codex-1");
    view.unmount();
  });

  it("an unported table binding refuses BY NAME, full-width in the footer", async () => {
    const { store } = liveStore(crewSnapshot());
    stubClient(store);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("s"); // lane-stop: declared in the keymap, not ported
    await flush(20);

    const frame = view.lastFrame() ?? "";
    // The WHOLE refusal, tail included — this is what pins that the footer no
    // longer truncates a refusal into noise (its full text fits 80 columns).
    expect(frame).toContain(
      "✗ stop the selected lane — not here yet; use npm run tui"
    );

    // ...and it clears on the NEXT keypress instead of replacing the hints
    // forever (round 6 #2: the one-way-door footer).
    view.stdin.write("j");
    await flush(20);
    expect(view.lastFrame()).not.toContain("not here yet");
    expect(view.lastFrame()).toContain("? keys");
    view.unmount();
  });

  it("ctrl+k opens the same catalogue as `/`, and `?` lists the live keys", async () => {
    const { store } = liveStore(crewSnapshot());
    stubClient(store);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write(CTRL_K);
    await flush(20);
    expect(view.lastFrame()).toContain("esc to close");

    view.stdin.write(ESC); // closes the palette
    await flush(20);
    view.stdin.write("?");
    await flush(20);
    // ≤76 chars, lists itself, survives an 80-column terminal whole.
    expect(view.lastFrame()).toContain(
      "/ cmds ⇥ zones jk move ⏎ stream o inbox 1-9][x tabs esc chat q quit ? this"
    );
    view.unmount();
  });
});

describe("the form scope (round-3 #1 remaining)", () => {
  it("/ task-new opens the create-task form; esc cancels without writing", async () => {
    const { store } = liveStore(crewSnapshot());
    stubClient(store);
    const createTask = vi.spyOn(store.client, "createTask");
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"));
    view.stdin.write("task-new");
    await untilFrame(view, (frame) => frame.includes("1 of "));
    view.stdin.write("\r"); // Enter on the selected catalogue entry
    await untilFrame(view, (frame) => frame.includes("Title"));

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Create task");
    expect(frame).toContain("Title");
    expect(frame).toContain("esc cancels");

    view.stdin.write(ESC);
    await untilFrame(view, (frame2) => frame2.includes("form cancelled"));
    expect(view.lastFrame()).toContain("nothing was written");
    expect(createTask).not.toHaveBeenCalled();
    view.unmount();
  });

  it("filling the form and submitting reaches the SAME governed client method", async () => {
    const { store } = liveStore(crewSnapshot());
    stubClient(store);
    const createTask = vi
      .spyOn(store.client, "createTask")
      .mockResolvedValue({ id: "task-9" } as never);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"));
    view.stdin.write("task-new");
    await untilFrame(view, (frame) => frame.includes("1 of "));
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("Title"));

    view.stdin.write("Ship the auth fix"); // Title
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("Close the session gate"); // Description
    view.stdin.write("\t"); // → Priority (prefilled medium)
    await flush(20);
    view.stdin.write("\t"); // → Repo folder (prefilled cwd)
    await flush(20);
    view.stdin.write("\r"); // submit on last field
    await untilFrame(view, (frame) => frame.includes("Task created"));

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ship the auth fix",
        description: "Close the session gate",
        priority: "medium",
      })
    );
    view.unmount();
  });
});

describe("the approval decision surface", () => {
  function approval(overrides: Record<string, unknown> = {}) {
    return {
      id: "approval-1",
      taskId: "task-1",
      requestedBy: "claude-code",
      kind: "command",
      reason: "session tool request",
      status: "pending",
      createdAt: "2026-08-08T00:00:00.000Z",
      evidence: {
        action: "Write",
        scope: "session s-1 · /repo/src/auth.ts",
        riskLevel: "high",
        impactIfApproved: "Writes the requested authentication module.",
        payloadDigest: "a".repeat(64),
        details: { path: "/repo/src/auth.ts" },
      },
      ...overrides,
    } as BrainSnapshot["approvals"][number];
  }

  function inboxSnapshot(approvals: BrainSnapshot["approvals"]): BrainSnapshot {
    return { ...crewSnapshot(), approvals };
  }

  it("the first press OPENS the evidence and decides NOTHING", async () => {
    const { store } = liveStore(inboxSnapshot([approval()]));
    stubClient(store);
    const resolve = vi.spyOn(store.client, "resolveApproval");
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\t"); // cycle to the inbox zone
    await flush(20);
    view.stdin.write("a"); // FIRST press
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));

    // Contiguous fragments only — the overlay wraps inside its box.
    expect(view.lastFrame()).toContain("Scope: session s-1");
    expect(resolve).not.toHaveBeenCalled(); // evidence only
    view.unmount();
  });

  it("the second press decides, through the SAME governed client method", async () => {
    const { store } = liveStore(inboxSnapshot([approval()]));
    stubClient(store);
    const resolve = vi
      .spyOn(store.client, "resolveApproval")
      .mockResolvedValue({ id: "approval-1", status: "approved" } as never);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));
    view.stdin.write("a"); // SECOND press
    await untilFrame(view, (frame) => frame.includes("approved approval-1"));

    expect(resolve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      status: "approved",
      decisionNotes: "decided from MUON TUI",
    });
    view.unmount();
  });

  it("A mints the receipt, and a plain approve never does", async () => {
    const { store } = liveStore(inboxSnapshot([approval()]));
    stubClient(store);
    const resolve = vi
      .spyOn(store.client, "resolveApproval")
      .mockResolvedValue({ id: "approval-1", status: "approved" } as never);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));
    view.stdin.write("A");
    await untilFrame(view, (frame) => frame.includes("approved approval-1"));

    expect(resolve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      status: "approved",
      decisionNotes: "decided from MUON TUI",
      receipt: { ttlMs: REMEMBER_ACTION_TTL_MS },
    });
    // Standing consent is affirmed, not silent.
    expect(view.lastFrame()).toContain("receipt minted");
    view.unmount();
  });

  it("refuses A on an action that cannot be remembered — parity with the classic desk", async () => {
    // No classifiable target ⇒ not receipt-eligible. The classic desk refuses
    // locally rather than sending a receipt the server would skip; this desk
    // must make the same refusal or the two surfaces send different payloads.
    const { store } = liveStore(
      inboxSnapshot([
        approval({
          evidence: {
            action: "Bash",
            scope: "Command: rm -rf /",
            riskLevel: "high",
            impactIfApproved: "Runs a shell command.",
            details: {},
          },
        }),
      ])
    );
    stubClient(store);
    const resolve = vi.spyOn(store.client, "resolveApproval");
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));
    view.stdin.write("A");
    await untilFrame(view, (frame) => frame.includes("always asks"));

    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it("refuses to APPROVE a request that is not safely bound", async () => {
    // `buildApprovalReview` marks a command approval unapprovable when its
    // structured evidence is missing — the classic desk refuses that approve
    // and so must this one.
    const { store } = liveStore(
      inboxSnapshot([approval({ evidence: undefined, gateTag: undefined })])
    );
    stubClient(store);
    const resolve = vi.spyOn(store.client, "resolveApproval");
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));
    view.stdin.write("a");
    await flush(60);

    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it("escape closes without deciding, and says so", async () => {
    const { store } = liveStore(inboxSnapshot([approval()]));
    stubClient(store);
    const resolve = vi.spyOn(store.client, "resolveApproval");
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("r");
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));
    view.stdin.write(ESC);
    await untilFrame(view, (frame) => frame.includes("no decision was recorded"));

    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it("a poll that REORDERS the inbox cannot move the decision to another request", async () => {
    // The reason the review binds an APPROVAL and not an index: `needsYou`
    // is re-read every 2s, and a decision must land on the request the human
    // actually read.
    const seeded = inboxSnapshot([approval(), approval({ id: "approval-2" })]);
    const { store, set } = liveStore(seeded);
    stubClient(store);
    const resolve = vi
      .spyOn(store.client, "resolveApproval")
      .mockResolvedValue({ id: "approval-1", status: "approved" } as never);
    const view = render(<Desk store={store} workspace="/repo" />);

    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("a"); // opens approval-1 (index 0)
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));

    // The list reorders under the cursor while the human is reading.
    set(inboxSnapshot([approval({ id: "approval-2" }), approval()]));
    await flush(40);

    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("approved approval-1"));
    expect(resolve).toHaveBeenCalledWith({
      approvalId: "approval-1", // NOT approval-2, now at index 0
      status: "approved",
      decisionNotes: "decided from MUON TUI",
    });
    view.unmount();
  });
});

describe("the merge gate — the highest-stakes decision on this desk", () => {
  function mergeApproval() {
    return {
      id: "merge-1",
      taskId: "task-1",
      requestedBy: "claude-code",
      kind: "merge",
      reason: "merge the feature branch",
      status: "pending",
      createdAt: "2026-08-08T00:00:00.000Z",
    } as BrainSnapshot["approvals"][number];
  }

  function mergeStore(cert: {
    resolve?: unknown;
    reject?: Error;
    hang?: boolean;
  }) {
    const { store } = liveStore({
      ...crewSnapshot(),
      approvals: [mergeApproval()],
    });
    stubClient(store);
    const spy = vi.spyOn(store.client, "getApprovalReviewCertification");
    if (cert.hang) spy.mockImplementation(() => new Promise(() => {}));
    else if (cert.reject) spy.mockRejectedValue(cert.reject);
    else spy.mockResolvedValue(cert.resolve as never);
    return { store, resolve: vi.spyOn(store.client, "resolveApproval") };
  }

  async function openMerge(store: BrainStore) {
    const view = render(<Desk store={store} workspace="/repo" />);
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("NEEDS YOUR APPROVAL"));
    return view;
  }

  it("refuses to approve while the coverage certification is still LOADING", async () => {
    // The hole this replaces: the desk teaches "a opens, a decides", so a
    // fast second press landed a merge before MUON knew whether the graph
    // could see the changed files — while the overlay was not even offering
    // approve.
    const { store, resolve } = mergeStore({ hang: true });
    const view = await openMerge(store);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("still loading"));
    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it("refuses to approve when the certification FAILED to load", async () => {
    const { store, resolve } = mergeStore({
      reject: new Error("graph unavailable"),
    });
    const view = await openMerge(store);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("graph unavailable"));
    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it("refuses a review-blind merge and points at the surface that can attest", async () => {
    const { store, resolve } = mergeStore({
      resolve: {
        status: "blocked",
        blockCode: "review-blind",
        reason: "1 file is not in the graph",
        artifactDigest: "c".repeat(64),
        changedFiles: ["src/a.ts"],
        blindFiles: ["src/a.ts"],
      },
    });
    const view = await openMerge(store);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("review-blind merge"));
    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it("approves a CERTIFIED merge — the gate opens when the evidence says so", async () => {
    const { store, resolve } = mergeStore({
      resolve: {
        status: "certified",
        verdict: "graph-certified",
        artifactDigest: "d".repeat(64),
        changedFiles: ["src/a.ts"],
      },
    });
    resolve.mockResolvedValue({ id: "merge-1", status: "approved" } as never);
    const view = await openMerge(store);
    await untilFrame(view, (frame) => frame.includes("Merge review"));
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("approved merge-1"));
    expect(resolve).toHaveBeenCalledWith({
      approvalId: "merge-1",
      status: "approved",
      decisionNotes: "decided from MUON TUI",
    });
    view.unmount();
  });

  it("m refuses instead of falling through to a plain approve", async () => {
    // The classic desk once shipped `m` as an unadvertised fourth approve
    // key. Deleting this desk's `m` branch must break a test.
    const { store, resolve } = mergeStore({
      resolve: {
        status: "certified",
        verdict: "graph-certified",
        artifactDigest: "e".repeat(64),
        changedFiles: [],
      },
    });
    const view = await openMerge(store);
    view.stdin.write("m");
    await untilFrame(view, (frame) => frame.includes("attest"));
    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });

  it("a decision refuses once another surface has already decided it", async () => {
    const seeded = { ...crewSnapshot(), approvals: [mergeApproval()] };
    const { store, set } = liveStore(seeded);
    stubClient(store);
    vi.spyOn(store.client, "getApprovalReviewCertification").mockResolvedValue({
      status: "certified",
      verdict: "graph-certified",
      artifactDigest: "f".repeat(64),
      changedFiles: [],
    } as never);
    const resolve = vi.spyOn(store.client, "resolveApproval");
    const view = await openMerge(store);

    // Desktop/CLI decides it while this review is open.
    set({ ...seeded, approvals: [] });
    await flush(40);
    view.stdin.write("a");
    await untilFrame(view, (frame) => frame.includes("no longer pending"));

    expect(resolve).not.toHaveBeenCalled();
    view.unmount();
  });
});



describe("memory search — the last catalogue command that refused", () => {
  function note(over: Record<string, unknown> = {}) {
    return {
      id: "note-1",
      kind: "decision",
      text: "the runner owns lane liveness",
      status: "active",
      confirmed: true,
      createdBy: "human:founder",
      createdAt: "2026-08-01T00:00:00.000Z",
      ...over,
    };
  }

  function memStore() {
    const { store } = liveStore(crewSnapshot());
    stubClient(store);
    vi.spyOn(store.client, "getAutoConfirmAgentMemory").mockResolvedValue(
      false as never
    );
    return store;
  }

  async function openSearch(store: BrainStore) {
    const view = render(<Desk store={store} workspace="/repo" />);
    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"));
    // The exact key, not "memory": both memory commands land in the same
    // ranking band and "Add memory note…" sorts first by label, so a bare
    // "memory" highlights the one that still refuses.
    view.stdin.write("memory-search");
    await untilFrame(view, (frame) => frame.includes(" of "));
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("Search memory"));
    return view;
  }

  it("searches with the WORKSPACE fence and renders the notes", async () => {
    const store = memStore();
    const search = vi
      .spyOn(store.client, "searchMemory")
      .mockResolvedValue([note()] as never);

    const view = await openSearch(store);
    view.stdin.write("lane");
    await flush(20);
    view.stdin.write("\r");
    await expectFrame(
      view,
      (frame) => frame.includes("the runner owns lane liveness"),
      "the note should render"
    );
    // ADR-0026 §1: a TUI search that sends NO partition coordinate reads every
    // repo on the machine. The workspace rides every call.
    expect(search).toHaveBeenCalledWith(
      "lane",
      expect.objectContaining({ workspace: expect.any(String), showExpired: false })
    );
    expect(search.mock.calls[0]![1]!.workspace).toBeTruthy();
    view.unmount();
  }, 20_000);

  it("a slow FIRST response cannot overwrite a fast second one", async () => {
    // The classic desk's `memorySearchVersion`, ported. Without it, two
    // searches in flight resolve in ARRIVAL order, so the pane can end up
    // showing results for a query the human already replaced — with no sign
    // that anything went wrong.
    const store = memStore();
    let releaseFirst: ((value: unknown) => void) | null = null;
    const search = vi
      .spyOn(store.client, "searchMemory")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }) as never
      )
      .mockResolvedValue([note({ id: "n2", text: "SECOND QUERY RESULT" })] as never);

    const view = await openSearch(store);
    view.stdin.write("first");
    await flush(20);
    view.stdin.write("\r");
    await flush(60);

    // Second search, from the still-open form, while the first is in flight.
    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"), 3000);
    view.stdin.write("memory-search");
    await untilFrame(view, (frame) => frame.includes(" of "), 3000);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("Search memory"), 3000);
    view.stdin.write("second");
    await flush(20);
    view.stdin.write("\r");
    await expectFrame(
      view,
      (frame) => frame.includes("SECOND QUERY RESULT"),
      "the second search should have landed"
    );

    // NOW let the first one answer. It must be ignored.
    releaseFirst?.([note({ id: "n1", text: "STALE FIRST RESULT" })]);
    await flush(120);
    expect(
      view.lastFrame(),
      "a stale response must not replace newer results"
    ).not.toContain("STALE FIRST RESULT");
    expect(search).toHaveBeenCalledTimes(2);
    view.unmount();
  }, 25_000);

  it("e re-asks the SERVER for expired notes instead of filtering on screen", async () => {
    // R3 TTL parity: expiry is a SERVER parameter on the governed search.
    // Filtering what is already on screen would show a different set from
    // what the backend considers expired.
    const store = memStore();
    const search = vi
      .spyOn(store.client, "searchMemory")
      .mockResolvedValue([note()] as never);

    const view = await openSearch(store);
    view.stdin.write("lane");
    await flush(20);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("the runner owns lane"), 3000);

    view.stdin.write("e");
    await flush(150);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]![1]).toMatchObject({ showExpired: true });
    // The SAME query and the SAME workspace — re-deriving either would let a
    // toggle silently move the partition.
    expect(search.mock.calls[1]![0]).toBe("lane");
    expect(search.mock.calls[1]![1]!.workspace).toBe(
      search.mock.calls[0]![1]!.workspace
    );
    view.unmount();
  }, 20_000);

  it("a governed memory WRITE refuses by name rather than doing nothing", async () => {
    // `c` confirms and `p` pauses on the classic desk. Both are governed
    // writes this desk has not earned parity for; a key that silently does
    // nothing is how a human concludes it worked.
    const store = memStore();
    vi.spyOn(store.client, "searchMemory").mockResolvedValue([note()] as never);
    const update = vi.spyOn(store.client, "updateMemoryNote");

    const view = await openSearch(store);
    view.stdin.write("lane");
    await flush(20);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("the runner owns lane"), 3000);

    view.stdin.write("c");
    await expectFrame(
      view,
      (frame) => frame.includes("writes to memory"),
      "the refusal must name what the key would have done"
    );
    expect(update).not.toHaveBeenCalled();
    view.unmount();
  }, 20_000);

  it("esc closes the pane and invalidates a response still in flight", async () => {
    const store = memStore();
    let release: ((value: unknown) => void) | null = null;
    vi.spyOn(store.client, "searchMemory").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as never
    );

    const view = await openSearch(store);
    view.stdin.write("lane");
    await flush(20);
    view.stdin.write("\r");
    await flush(60);
    view.stdin.write(ESC);
    await flush(60);

    release?.([note({ text: "LATE ARRIVAL" })]);
    await flush(150);
    expect(
      view.lastFrame(),
      "a response that lands after esc must not reopen the pane"
    ).not.toContain("LATE ARRIVAL");
    view.unmount();
  }, 20_000);

  it("an UNCONFIRMED note is marked as owing a decision", async () => {
    // Reuses the classic desk's MemoryPanel precisely so the confirmed /
    // vouched / review markers cannot drift between the two desks.
    const store = memStore();
    vi.spyOn(store.client, "searchMemory").mockResolvedValue([
      note({
        id: "n-open",
        text: "auto captured claim",
        confirmed: false,
        createdBy: "muon-extractor",
      }),
    ] as never);

    const view = await openSearch(store);
    view.stdin.write("lane");
    await flush(20);
    view.stdin.write("\r");
    await expectFrame(
      view,
      (frame) => frame.includes("auto captured claim"),
      "the note should render"
    );
    expect(view.lastFrame()).toContain("review");
    view.unmount();
  }, 20_000);
});

describe("the palette shows AUTHORITY, not just a self-description", () => {
  it("renders MUON's authority sentence beside a harness that grants power", async () => {
    // Pass 11 F4. `CatalogueEntry.authority` had ZERO consumers: the palette
    // rendered label, kind, badge and `effect` only — and `effect` is the
    // harness's OWN description. A harness granting full filesystem access
    // with pre-authorized Bash could call itself "Read-only audit." and this
    // surface, whose Enter executes, agreed with it.
    const { store } = liveStore(crewSnapshot());
    stubClient(store);
    vi.spyOn(store.client, "listHarnesses").mockResolvedValue([
      {
        id: "h1",
        key: "audit",
        name: "Security audit",
        version: 1,
        createdBy: "muon",
        createdAt: "",
        updatedAt: "",
        config: {
          description: "Read-only audit.",
          profileOverlay: { sandbox: "danger-full-access" },
          preauthorizedTools: ["Bash", "Write"],
        },
      },
    ] as never);

    const view = render(<Desk store={store} workspace="/repo" />);
    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"));
    view.stdin.write("audit");
    await expectFrame(
      view,
      (frame) => frame.includes("Security audit"),
      "the harness should be listed"
    );
    await expectFrame(
      view,
      (frame) => frame.includes("PRE-AUTHORIZES"),
      "the palette must say what running this GRANTS, not only what it calls itself"
    );
    expect(view.lastFrame()).toContain("WITHOUT asking you");
    view.unmount();
  }, 20_000);
});

describe("the run form — a dispatch, not a ledger write", () => {
  function runStore() {
    const snap: BrainSnapshot = {
      ...crewSnapshot(),
      lanes: [
        { id: "lane-db-1", key: "codex", name: "Codex" },
      ] as BrainSnapshot["lanes"],
    };
    const { store } = liveStore(snap);
    stubClient(store);
    vi.spyOn(store.client, "getTaskDetail").mockResolvedValue({
      id: "task-1",
      workspacePath: "/repo",
    } as never);
    return store;
  }

  async function openRunForm(store: BrainStore) {
    const view = render(<Desk store={store} workspace="/repo" />);
    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"));
    view.stdin.write("run task");
    await untilFrame(view, (frame) => frame.includes(" of "));
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("Run task on lane"));
    return view;
  }

  async function fill(view: { stdin: { write: (s: string) => void } }) {
    view.stdin.write("task-1");
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("codex");
    await flush(20);
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("do the thing");
    await flush(20);
  }

  it("refuses a lane the fleet does not have, without dispatching", async () => {
    const store = runStore();
    const runner = vi.spyOn(store.client, "getRunner");
    const view = await openRunForm(store);

    view.stdin.write("task-1");
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("nope");
    await flush(20);
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("brief");
    await flush(20);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("not found"));

    expect(runner).not.toHaveBeenCalled(); // never reached the dispatch seam
    view.unmount();
  });

  it("dispatches through the shared seam and reports the outcome", async () => {
    const store = runStore();
    vi.spyOn(store.client, "getRunner").mockResolvedValue({
      live: true,
    } as never);
    vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
    const enqueue = vi
      .spyOn(store.client, "enqueueDispatch")
      .mockResolvedValue({ id: "job-1" } as never);
    vi.spyOn(store.client, "getDispatchJob").mockResolvedValue({
      id: "job-1",
      status: "done",
      exitCode: 0,
    } as never);

    const view = await openRunForm(store);
    await fill(view);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("run finished"), 3000);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-1",
        brief: "do the thing",
        // The task's workspace, resolved via getTaskDetail. Deleting that hop
        // used to leave every dispatch running in the runner's default cwd —
        // where the agent writes files — with every test still green.
        workspacePath: "/repo",
      })
    );
    // The live-event line is AGENT-AUTHORED and must arrive sanitized.
    expect(view.lastFrame()).not.toContain(`${ESC}[2J`);
    view.unmount();
  });

  it("refuses a second run while one is in flight", async () => {
    // `runningRef` had ZERO coverage: deleting the guard left 424/424 green
    // while two dispatches could enqueue against the same task. The guard is
    // per-DESK, so this drives one desk twice rather than two desks once.
    const store = runStore();
    vi.spyOn(store.client, "getRunner").mockResolvedValue({ live: true } as never);
    vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
    const enqueue = vi
      .spyOn(store.client, "enqueueDispatch")
      .mockResolvedValue({ id: "job-1" } as never);
    // Never terminal, so the first run stays in flight.
    vi.spyOn(store.client, "getDispatchJob").mockResolvedValue({
      id: "job-1",
      status: "running",
    } as never);

    const view = await openRunForm(store);
    await fill(view);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("running codex"), 3000);

    // Same desk: reopen the form and submit again.
    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"), 3000);
    view.stdin.write("run task");
    await untilFrame(view, (frame) => frame.includes(" of "), 3000);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("Run task on lane"), 3000);
    await fill(view);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("already active"), 3000);

    expect(enqueue).toHaveBeenCalledTimes(1);
    view.unmount();
  }, 20_000);

  it("refuses an empty brief — an agent is never started without an instruction", async () => {
    const store = runStore();
    // MOCK THE RUNNER LIVE. Without this, `dispatchRun` rejects at its own
    // runner check before `enqueueDispatch` is ever reached, so
    // `expect(enqueue).not.toHaveBeenCalled()` passed with the required-field
    // guard deleted — the test for a HIGH finding proved nothing (pass 11 F2).
    vi.spyOn(store.client, "getRunner").mockResolvedValue({ live: true } as never);
    vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
    const enqueue = vi
      .spyOn(store.client, "enqueueDispatch")
      .mockResolvedValue({ id: "job-1" } as never);
    const view = await openRunForm(store);

    view.stdin.write("task-1");
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("codex");
    await flush(20);
    view.stdin.write("\t"); // brief left empty
    await flush(20);
    view.stdin.write("\r");
    await expectFrame(
      view,
      (frame) => frame.includes("brief required"),
      "the form must say WHICH field is missing"
    );
    expect(enqueue).not.toHaveBeenCalled();
    view.unmount();
  });

  it("an unknown lane NAMES the lanes it searched", async () => {
    const store = runStore();
    const view = await openRunForm(store);
    view.stdin.write("task-1");
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("nope");
    await flush(20);
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("brief");
    await flush(20);
    view.stdin.write("\r");
    // "codex" alone was NOT discriminating: the left rail renders the crew row
    // `codex-1` unconditionally, so the old assertion passed with the naming
    // reverted entirely (pass 11 F2). Assert the error's own sentence.
    await expectFrame(
      view,
      (frame) => frame.includes("available: codex"),
      "the refusal must NAME the lanes it searched — this desk lists them nowhere else"
    );
    view.unmount();
  });

  it("the live-event line is sanitized WHILE it is on screen", async () => {
    // The old assertion ran after `run finished` had already replaced the
    // live line, so the frame under test never contained the payload either
    // way — deleting `terminalSafe` left every test green (pass 11 F2). This
    // holds the job non-terminal so the ▶ line is what is actually rendered.
    const store = runStore();
    vi.spyOn(store.client, "getRunner").mockResolvedValue({ live: true } as never);
    vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
    vi.spyOn(store.client, "enqueueDispatch").mockResolvedValue({
      id: "job-1",
    } as never);
    vi.spyOn(store.client, "getDispatchJob").mockResolvedValue({
      id: "job-1",
      status: "running",
    } as never);
    // NOT `ESC[2J`: Ink's own ANSI-aware renderer swallows an escape sequence
    // before `lastFrame()` sees it, so asserting on one cannot tell a
    // sanitized frame from an unsanitized one — measured, and it is why the
    // first attempt at this test passed with `terminalSafe` deleted. A bidi
    // override is carried through verbatim by Ink and stripped by
    // `terminalSafe`, so it discriminates.
    const RLO = String.fromCodePoint(0x202e);
    vi.spyOn(store.client, "listStreamChunks").mockResolvedValue([
      {
        seq: 1,
        taskId: "task-1",
        laneId: "lane-1",
        agentId: "agent-1",
        runId: "run-1",
        kind: "output",
        content: `ok${RLO}reversed`,
        timestamp: "2026-08-07T00:00:00.000Z",
      },
    ] as never);

    const view = await openRunForm(store);
    await fill(view);
    view.stdin.write("\r");
    await expectFrame(
      view,
      (frame) => frame.includes("▶ codex ·"),
      "the live-event line should be the visible status"
    );
    expect(
      view.lastFrame(),
      "a bidi override in agent output must not reach the terminal"
    ).not.toContain(RLO);
    view.unmount();
  }, 20_000);

  it("a finished run does NOT erase an open gate's refusal", async () => {
    // Pass 11 F1. The guard was placed inside `onLiveEvent` only, so the ✓
    // finished line still overwrote the merge gate's refusal — a GREEN tick
    // under an open gate, which reads as "it went through" even harder than
    // the progress line that was fixed.
    const snap: BrainSnapshot = {
      ...crewSnapshot(),
      lanes: [{ id: "lane-db-1", key: "codex", name: "Codex" }] as BrainSnapshot["lanes"],
      approvals: [
        {
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "merge",
          reason: "ship review passed",
          status: "pending",
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      ] as BrainSnapshot["approvals"],
    };
    const { store } = liveStore(snap);
    stubClient(store);
    vi.spyOn(store.client, "getTaskDetail").mockResolvedValue({
      id: "task-1",
      workspacePath: "/repo",
    } as never);
    vi.spyOn(store.client, "getRunner").mockResolvedValue({ live: true } as never);
    vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
    vi.spyOn(store.client, "enqueueDispatch").mockResolvedValue({
      id: "job-1",
    } as never);
    // Certification never resolves: the gate stays refused-and-open.
    vi.spyOn(store.client, "getApprovalReviewCertification").mockReturnValue(
      new Promise(() => {}) as never
    );
    let jobStatus = "running";
    vi.spyOn(store.client, "getDispatchJob").mockImplementation(
      async () => ({ id: "job-1", status: jobStatus, exitCode: 0 }) as never
    );

    const view = await openRunForm(store);
    await fill(view);
    view.stdin.write("\r");
    await expectFrame(
      view,
      (frame) => frame.includes("▶ codex ·") || frame.includes("running codex"),
      "the run should be in flight"
    );

    // Open the merge gate and try to decide it — it must refuse while the
    // certification is loading.
    view.stdin.write("\t");
    await flush(20);
    view.stdin.write("a");
    await expectFrame(
      view,
      (frame) => frame.includes("NEEDS YOUR APPROVAL"),
      "the review should be open"
    );
    view.stdin.write("a");
    await flush(60);

    // Now let the run finish underneath the open gate.
    jobStatus = "done";
    await flush(400);

    expect(
      view.lastFrame(),
      "a green ✓ must not appear while a merge gate is open and refused"
    ).not.toContain("✓ run finished");
    view.unmount();
  }, 25_000);

  it("a second run refuses on the status line and does not re-open the form", async () => {
    // Pass 11 F6. The refusal used to re-open the form, wedging the desk in
    // the modal scope while a run was in flight — and escaping then printed
    // "form cancelled — nothing was written", which was false.
    const store = runStore();
    vi.spyOn(store.client, "getRunner").mockResolvedValue({ live: true } as never);
    vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
    const enqueue = vi
      .spyOn(store.client, "enqueueDispatch")
      .mockResolvedValue({ id: "job-1" } as never);
    vi.spyOn(store.client, "getDispatchJob").mockResolvedValue({
      id: "job-1",
      status: "running",
    } as never);

    const view = await openRunForm(store);
    await fill(view);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("codex"), 3000);

    view.stdin.write("/");
    await untilFrame(view, (frame) => frame.includes("esc to close"), 3000);
    view.stdin.write("run task");
    await untilFrame(view, (frame) => frame.includes(" of "), 3000);
    view.stdin.write("\r");
    await untilFrame(view, (frame) => frame.includes("Run task on lane"), 3000);
    await fill(view);
    view.stdin.write("\r");

    await expectFrame(
      view,
      (frame) => frame.includes("already active"),
      "the second run must be refused"
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The form is GONE — not re-opened with an error inside it.
    expect(
      view.lastFrame(),
      "the refusal must dismiss the form, not wedge the desk in the modal scope"
    ).not.toContain("Run task on lane");
    view.unmount();
  }, 25_000);

it("a hostile task id cannot repaint the footer", async () => {
  // PR #36 review (greptile P1, security): a submitted task id reached the
  // footer with only `.trim()` applied. Enumerating that one line then found
  // a certification error and an executeAction result doing the same, so the
  // fix went to the render boundary rather than to three writers — this desk
  // has ~40 `setStatus` callers and the next one would have been found by
  // the next review.
  const RLO = String.fromCodePoint(0x202e);
  const store = runStore();
  vi.spyOn(store.client, "getRunner").mockResolvedValue({ live: true } as never);
  vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
  vi.spyOn(store.client, "enqueueDispatch").mockResolvedValue({
    id: "job-1",
  } as never);
  vi.spyOn(store.client, "getDispatchJob").mockResolvedValue({
    id: "job-1",
    status: "running",
  } as never);

  const view = await openRunForm(store);
  view.stdin.write(`task${RLO}1`);
  view.stdin.write("\t");
  await flush(20);
  view.stdin.write("codex");
  await flush(20);
  view.stdin.write("\t");
  await flush(20);
  view.stdin.write("do the thing");
  await flush(20);
  view.stdin.write("\r");
  await untilFrame(view, (frame) => frame.includes("running"), 3000);

  expect(
    view.lastFrame(),
    "a bidi override in a task id must not reach the terminal"
  ).not.toContain(RLO);
  view.unmount();
}, 20_000);

  it("a POLL failure is MUON's failure, not the vendor's", async () => {
    // Greptile P1, round 2. Three stages were tagged (runner/assign/enqueue)
    // and the polling stage was missed, so a `getDispatchJob` rejection — the
    // control plane going away while the job runs fine — was handed to
    // `classifyVendorFailure` and rendered as a vendor login problem.
    const snap: BrainSnapshot = {
      ...crewSnapshot(),
      lanes: [{ id: "lane-db-1", key: "codex", name: "Codex" }] as BrainSnapshot["lanes"],
      readiness: [
        {
          vendor: "codex",
          installed: false,
          authenticated: false,
          fixHint: "install the codex CLI",
        },
      ] as BrainSnapshot["readiness"],
    };
    const { store } = liveStore(snap);
    stubClient(store);
    vi.spyOn(store.client, "getTaskDetail").mockResolvedValue({
      id: "task-1",
      workspacePath: "/repo",
    } as never);
    vi.spyOn(store.client, "getRunner").mockResolvedValue({ live: true } as never);
    vi.spyOn(store.client, "assignTask").mockResolvedValue({} as never);
    vi.spyOn(store.client, "enqueueDispatch").mockResolvedValue({
      id: "job-1",
    } as never);
    vi.spyOn(store.client, "getDispatchJob").mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:4000")
    );

    const view = await openRunForm(store);
    await fill(view);
    view.stdin.write("\r");
    await expectFrame(
      view,
      (frame) => frame.includes("MUON could not read dispatch"),
      "a control-plane read failure must be reported as MUON's, not the vendor's"
    );
    expect(view.lastFrame()).not.toContain("isn't connected");
    view.unmount();
  }, 20_000);

  it("a runner that is not live refuses BEFORE anything is enqueued", async () => {
    // READINESS MATTERS TO THIS TEST. Without it the classifier falls through
    // to its generic run-failed branch and echoes the message anyway, so the
    // test passed with the fix reverted. The finding needs the precondition
    // that makes the misdiagnosis happen: readiness says the vendor is not
    // installed, which is exactly a fresh machine — the case where "start the
    // runner" is the right advice and "install codex" is not.
    const snap: BrainSnapshot = {
      ...crewSnapshot(),
      lanes: [{ id: "lane-db-1", key: "codex", name: "Codex" }] as BrainSnapshot["lanes"],
      readiness: [
        {
          vendor: "codex",
          installed: false,
          authenticated: false,
          fixHint: "install the codex CLI",
        },
      ] as BrainSnapshot["readiness"],
    };
    const { store } = liveStore(snap);
    stubClient(store);
    vi.spyOn(store.client, "getTaskDetail").mockResolvedValue({
      id: "task-1",
      workspacePath: "/repo",
    } as never);
    vi.spyOn(store.client, "getRunner").mockResolvedValue({
      live: false,
    } as never);
    const enqueue = vi.spyOn(store.client, "enqueueDispatch");

    const view = await openRunForm(store);
    await fill(view);
    view.stdin.write("\r");
    // MUON'S OWN failure, stated as itself. Handing this to
    // `classifyVendorFailure` replaced the only actionable sentence in the
    // commonest first-run failure with vendor onboarding copy — "Codex isn't
    // installed yet, connect it" — for a vendor that is fine (pass 11 F5).
    await expectFrame(
      view,
      (frame) => frame.includes("muon runner"),
      "a runner-offline failure must keep its own fix, not become vendor onboarding copy"
    );
    expect(view.lastFrame()).not.toContain("isn't connected");
    expect(enqueue).not.toHaveBeenCalled();
    view.unmount();
  });
});
