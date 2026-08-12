// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/renderer/chat.js";
import { App } from "../src/renderer/app.js";
import type { DesktopState } from "../src/shared/ipc.js";

beforeEach(() => {
  localStorage.setItem("muon.onboarded", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  // A fake-timer test that FAILS never reaches its own useRealTimers(), and the
  // next test then hangs on a clock nobody advances — a real failure reported as
  // an unrelated timeout. Restore here so each test's verdict is its own.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CHAT = {
  id: "chat-1",
  title: "Mission",
  workspacePath: "/repo",
} as never;

/** Two sequential root turns, as the brain persists them under taskId=chatId. */
const TWO_TURNS = [
  {
    seq: 1,
    kind: "user.message",
    laneId: "muon-chat",
    runId: "root-1",
    content: "[you] first message",
  },
  { seq: 2, kind: "output.message", runId: "root-1", content: "First answer." },
  {
    seq: 3,
    kind: "user.message",
    laneId: "muon-chat",
    runId: "root-2",
    content: "[you] second message",
  },
  { seq: 4, kind: "output.message", runId: "root-2", content: "Second answer." },
];

describe("mission chat across sequential root turns (U4)", () => {
  it("renders BOTH turns when the chat is idle", async () => {
    Object.assign(window, {
      muon: { streams: vi.fn().mockResolvedValue(TWO_TURNS) },
    });
    render(
      React.createElement(ChatView, {
        chat: CHAT,
        approvals: [],
        running: false,
        live: [],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      } as never)
    );
    expect(await screen.findByText("first message")).toBeTruthy();
    expect(screen.getByText("second message")).toBeTruthy();
  });

  it("keeps earlier turns visible while a NEW turn is running", async () => {
    // The founder's flow, and the exact demo shape: turn 1 has settled into the
    // brain, turn 2 is live, and this transcript mounted DURING turn 2 (a
    // workspace-tab switch back to Mission chat remounts it, as does a reload).
    // Before the fix this rendered turn 2 and nothing else.
    Object.assign(window, {
      muon: {
        streams: vi.fn().mockResolvedValue(TWO_TURNS.slice(0, 2)),
      },
    });
    render(
      React.createElement(ChatView, {
        chat: CHAT,
        approvals: [],
        running: true,
        activeRootJobId: "root-2",
        live: [{ role: "user", text: "second message" }],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      } as never)
    );
    expect(await screen.findByText("second message")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText("first message")).toBeTruthy()
    );
    expect(screen.getByText("First answer.")).toBeTruthy();
  });

  it("never double-prints the LIVE turn's own persisted rows", async () => {
    // The brain has already committed turn 2's trusted `[you]` row (the root
    // dispatch and that row land in one transaction), while the optimistic
    // mirror is still rendering the same message. Exactly one must reach the
    // screen.
    Object.assign(window, {
      muon: { streams: vi.fn().mockResolvedValue(TWO_TURNS) },
    });
    render(
      React.createElement(ChatView, {
        chat: CHAT,
        approvals: [],
        running: true,
        activeRootJobId: "root-2",
        live: [{ role: "user", text: "second message" }],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      } as never)
    );
    await screen.findByText("first message");
    await waitFor(() =>
      expect(screen.getAllByText("second message")).toHaveLength(1)
    );
    // The live turn's assistant reply is NOT pulled from history either — the
    // live mirror owns it until the turn settles.
    expect(screen.queryByText("Second answer.")).toBeNull();
  });

  it("absorbs nothing new mid-turn when the live root is unknown", async () => {
    // Fail-closed: not knowing where the live turn starts is not a licence to
    // print it twice.
    Object.assign(window, {
      muon: { streams: vi.fn().mockResolvedValue(TWO_TURNS) },
    });
    render(
      React.createElement(ChatView, {
        chat: CHAT,
        approvals: [],
        running: true,
        activeRootJobId: null,
        live: [{ role: "user", text: "second message" }],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      } as never)
    );
    await screen.findByText("second message");
    await waitFor(() =>
      expect(screen.getAllByText("second message")).toHaveLength(1)
    );
    expect(screen.queryByText("first message")).toBeNull();
  });

  it("never double-prints the turn a CORRECTION root re-rooted mid-flight", async () => {
    // The crew-contract correction (packages/orchestrator/src/chat.ts): the
    // coordinator answered without proving its governed crew contract, so ONE
    // bounded correction root was admitted INSIDE the same human turn. It
    // carries no human message and no continuation, so the brain stamps no
    // runId-bearing row for it ANYWHERE — `root-2` appears on none of these
    // rows, and its own "Root … was admitted" milestone has no runId either.
    //
    // Meanwhile the live mirror is still rendering the ORIGINATING turn, whose
    // rows ARE in this page. Cutting at the ACTIVE root would find no boundary
    // and absorb them underneath the mirror, printing the whole turn twice for
    // as long as the correction runs (minutes). The boundary is the root the
    // MIRROR belongs to, which stays root-1 for the whole logical turn.
    vi.useFakeTimers();
    const streams = vi.fn().mockResolvedValue(TWO_TURNS.slice(0, 2));
    Object.assign(window, { muon: { streams } });
    render(
      React.createElement(ChatView, {
        chat: CHAT,
        approvals: [],
        running: true,
        activeRootJobId: "root-2",
        liveTurnRootJobId: "root-1",
        live: [
          { role: "user", text: "first message" },
          { role: "assistant", text: "First answer." },
        ],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      } as never)
    );
    // Several history polls: every one of them must leave the page alone.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(screen.getAllByText("first message")).toHaveLength(1);
    expect(screen.getAllByText("First answer.")).toHaveLength(1);
    vi.useRealTimers();
  });
});

/**
 * The same defect at the level the founder hit it: a real App, one chat, and
 * the sequence of ROOT dispatch jobs a multi-turn mission actually produces.
 *
 * ADR-0024 — a mission is a CHAT, not a turn. Two roots in a row is the normal
 * shape of "I asked, then I asked again", and the transcript must be the whole
 * conversation with the live turn appended.
 */
function stateWithTwoRoots(): DesktopState {
  const job = (id: string, status: string, createdAt: string) => ({
    id,
    chatId: "chat-a",
    taskId: "task-a",
    parentJobId: null,
    vendor: "claude-code",
    capabilityMode: "orchestrator",
    kind: "session",
    status,
    createdAt,
    updatedAt: createdAt,
  });
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    gitnexus: { status: "ready", workspacePath: "/repo", symbolCount: 1 },
    fleet: { counts: {}, agents: [] },
    chats: [
      {
        id: "chat-a",
        title: "Mission",
        workspacePath: "/repo",
        taskId: "task-a",
        status: "active",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:05.000Z",
      },
    ],
    approvals: [],
    tasks: [],
    // Turn 1 finished; turn 2 is the live one — the founder's exact sequence.
    dispatchJobs: [
      job("root-1", "done", "2026-07-27T00:00:00.000Z"),
      job("root-2", "running", "2026-07-27T00:00:04.000Z"),
    ],
    workflowProposals: [],
    auditEvents: [],
    activeReceipts: [],
    readiness: [],
  } as unknown as DesktopState;
}

describe("App — a mission chat with two sequential root jobs (U4)", () => {
  it("renders BOTH turns while the second one is still running", async () => {
    const streams = vi.fn().mockResolvedValue(TWO_TURNS);
    Object.assign(window, {
      muon: {
        getState: vi.fn().mockResolvedValue(stateWithTwoRoots()),
        on: vi.fn(() => () => undefined),
        selectChat: vi.fn().mockResolvedValue(undefined),
        streams,
        gitnexusGraph: vi
          .fn()
          .mockResolvedValue({ nodes: [], relationships: [], truncated: false }),
        terminal: { open: vi.fn(), close: vi.fn() },
      },
    });

    render(React.createElement(App));

    // Turn 1 — the exchange that used to vanish the moment turn 2 started.
    expect(await screen.findByText("first message")).toBeTruthy();
    expect(screen.getByText("First answer.")).toBeTruthy();
    // Turn 2's persisted rows stay out of the transcript until it settles, so
    // the live mirror owns the running turn and nothing is printed twice.
    expect(screen.queryByText("Second answer.")).toBeNull();
    // And the transcript is read CHAT-wide, never scoped to the active root.
    await waitFor(() =>
      expect(streams).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "chat-a" })
      )
    );
    expect(streams).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: "root-2" })
    );
  });
});

/**
 * The correction defect end to end, through the REAL App: the human sends, the
 * brain admits root-1 and persists the turn, the coordinator's crew contract
 * fails, and a correction root takes over the SAME turn. Nothing in the
 * transcript may print twice while that happens.
 *
 * This is the wiring test: it renders no ChatView prop by hand, so it fails if
 * App stops deriving the mirror's root, stops pinning it across the re-root, or
 * stops passing it down.
 */
describe("App — a crew-contract correction re-roots the live turn (U4)", () => {
  it("prints the human message and the reply exactly once each", async () => {
    vi.useFakeTimers();
    const rootJob = (id: string, status: string, createdAt: string) => ({
      id,
      chatId: "chat-a",
      taskId: "task-a",
      parentJobId: null,
      vendor: "claude-code",
      capabilityMode: "orchestrator",
      kind: "session",
      status,
      createdAt,
      updatedAt: createdAt,
    });
    // The brain's own two moving parts: which roots exist, and what the chat's
    // stream holds. Both start empty — this is the chat's FIRST turn.
    let jobs: ReturnType<typeof rootJob>[] = [];
    let rows: (typeof TWO_TURNS)[number][] = [];

    const base = stateWithTwoRoots();
    const handlers = new Map<string, (payload: never) => void>();
    const streams = vi.fn(
      async ({ afterSeq }: { afterSeq?: number }) =>
        rows.filter((row) => row.seq > (afterSeq ?? 0))
    );
    Object.assign(window, {
      muon: {
        getState: vi.fn(async () => ({ ...base, dispatchJobs: jobs })),
        on: vi.fn((channel: string, handler: (payload: never) => void) => {
          handlers.set(channel, handler);
          return () => undefined;
        }),
        selectChat: vi.fn().mockResolvedValue(undefined),
        streams,
        // The turn is IN FLIGHT for the whole test: this never settles, exactly
        // as a real minutes-long coordinator turn does not.
        sendMessage: vi.fn(() => new Promise(() => undefined)),
        gitnexusGraph: vi
          .fn()
          .mockResolvedValue({ nodes: [], relationships: [], truncated: false }),
        terminal: { open: vi.fn(), close: vi.fn() },
      },
    });

    render(React.createElement(App));
    await vi.advanceTimersByTimeAsync(0);

    // The human sends. The optimistic mirror opens; no root exists yet.
    const textarea = screen.getByLabelText("Message to MUON");
    fireEvent.change(textarea, { target: { value: "first message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The brain admits root-1 and persists the trusted [you] row plus the
    // coordinator's reply under it.
    jobs = [rootJob("root-1", "running", "2026-07-27T00:00:00.000Z")];
    rows = TWO_TURNS.slice(0, 2);
    await vi.advanceTimersByTimeAsync(2_000);
    act(() => {
      handlers.get("muon:assistant")?.({
        chatId: "chat-a",
        text: "First answer.",
        mode: "message",
      } as never);
    });

    // The crew contract was not proven: root-1 goes terminal and the bounded
    // correction root takes over the SAME human turn.
    jobs = [
      rootJob("root-1", "failed", "2026-07-27T00:00:00.000Z"),
      rootJob("root-2", "running", "2026-07-27T00:00:09.000Z"),
    ];
    await vi.advanceTimersByTimeAsync(6_000);

    expect(screen.getAllByText("first message")).toHaveLength(1);
    expect(screen.getAllByText("First answer.")).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("the mid-turn backfill stops once it has reached the live turn", () => {
  it("does not re-read the live turn on every poll", async () => {
    vi.useFakeTimers();
    const streams = vi.fn().mockResolvedValue(TWO_TURNS);
    Object.assign(window, { muon: { streams } });
    render(
      React.createElement(ChatView, {
        chat: CHAT,
        approvals: [],
        running: true,
        activeRootJobId: "root-2",
        live: [{ role: "user", text: "second message" }],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      } as never)
    );
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstTick = streams.mock.calls.length;
    expect(afterFirstTick).toBeGreaterThan(0);

    // Several poll intervals later, the backfill is done and the poll is quiet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(streams.mock.calls.length).toBe(afterFirstTick);
    vi.useRealTimers();
  });

  it("keeps polling while the live root is not yet known", async () => {
    vi.useFakeTimers();
    const streams = vi.fn().mockResolvedValue(TWO_TURNS);
    Object.assign(window, { muon: { streams } });
    render(
      React.createElement(ChatView, {
        chat: CHAT,
        approvals: [],
        running: true,
        activeRootJobId: null,
        live: [],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      } as never)
    );
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstTick = streams.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    // Still asking: the boundary becomes knowable the moment the root lands.
    expect(streams.mock.calls.length).toBeGreaterThan(afterFirstTick);
    vi.useRealTimers();
  });
});
